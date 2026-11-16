import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { BifrostApiError, BifrostClient, normalizeOrigin, redact } from './client'
import { createMcpServer } from './server'

const SESSION = 'a'.repeat(43)
const JOB = '00000000-0000-4000-8000-000000000001'
const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function connect(permissionLevel = 2, handler?: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/api/v1/auth/session')
      return Response.json({ identity: { name: '测试用户' }, csrfToken: 'csrf-secret', permissionLevel, roles: [] })
    return handler?.(url, init) || Response.json({ ok: true })
  })
  const api = new BifrostClient({ origin: 'https://bifrost.example.test', token: async () => SESSION, fetchImpl })
  const server = createMcpServer(api, { permissionLevel, roles: [] })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  servers.push(client, server)
  return { client, calls, api, fetchImpl }
}

describe('real MCP protocol', () => {
  it('advertises all schemas, annotations, guides and prompts', async () => {
    const { client } = await connect(8)
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThanOrEqual(38)
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    expect(tools.find((tool) => tool.name === 'bifrost_save_site')?.inputSchema.properties).toHaveProperty('config')
    expect(tools.find((tool) => tool.name === 'bifrost_create_build')?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    })
    expect(tools.find((tool) => tool.name === 'bifrost_cancel_build')?.annotations?.destructiveHint).toBe(true)
    expect((await client.listResources()).resources).toHaveLength(2)
    expect((await client.readResource({ uri: 'bifrost://guide' })).contents[0]).toHaveProperty('text')
    expect((await client.getPrompt({ name: 'diagnose-build', arguments: { jobId: JOB } })).messages).toHaveLength(1)
  })

  it('hides and rejects write tools in read mode and admin tools in operate mode', async () => {
    const read = await connect(1)
    const { tools } = await read.client.listTools()
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
    expect((await read.client.callTool({ name: 'bifrost_create_build', arguments: {} })).isError).toBe(true)
    expect(read.calls).toHaveLength(0)
    const operate = await connect()
    expect((await operate.client.listTools()).tools.some((tool) => tool.name === 'bifrost_save_project')).toBe(false)
  })

  it('requires explicit environment/idempotency and preserves CSRF/actor identity without trusting actor input', async () => {
    const { client, calls } = await connect()
    expect(
      (
        await client.callTool({
          name: 'bifrost_create_build',
          arguments: { targetId: 'voice_runtime', branch: 'feature/中文' },
        })
      ).isError
    ).toBe(true)
    expect(calls).toHaveLength(0)
    const result = await client.callTool({
      name: 'bifrost_create_build',
      arguments: {
        environmentSlug: 'qa',
        targetId: 'voice_runtime',
        branch: 'feature/中文',
        idempotencyKey: 'qa-feature-001',
        requestedBy: 'forged',
      },
    })
    expect(result.isError).not.toBe(true)
    const request = calls.at(-1)!
    expect(request.url.pathname).toBe('/api/v1/build-jobs')
    expect(request.init.headers).toMatchObject({
      authorization: `Bearer ${SESSION}`,
      'x-cuddly-csrf': 'csrf-secret',
      'idempotency-key': 'qa-feature-001',
    })
    expect(JSON.parse(String(request.init.body))).toEqual({
      environmentSlug: 'qa',
      targetId: 'voice_runtime',
      branch: 'feature/中文',
      profile: 'qa-web',
    })
    expect(request.init.redirect).toBe('error')
  })

  it('preserves pagination, status and URL encoding', async () => {
    const { client, calls } = await connect()
    await client.callTool({
      name: 'bifrost_list_builds',
      arguments: { environment: 'qa', status: 'FAILED', query: '中文 & #', page: 2, pageSize: 10 },
    })
    expect(calls[0]?.url.searchParams.get('query')).toBe('中文 & #')
    expect(calls[0]?.url.searchParams.get('page')).toBe('2')
    expect(calls[0]?.url.searchParams.get('status')).toBe('FAILED')
  })

  it('bounds logs and never exposes session/CSRF secrets', async () => {
    const { client } = await connect(2, () =>
      Response.json({
        content: `line1\nBearer ${SESSION}\nline3\nline4`,
        csrfToken: 'must-not-leak',
      })
    )
    const result = await client.callTool({ name: 'bifrost_get_build_log', arguments: { jobId: JOB, tailLines: 2 } })
    expect(result.structuredContent).toEqual({
      data: { content: 'line3\nline4', csrfToken: '[REDACTED]', mcpTruncated: true },
    })
    const identity = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
    expect(JSON.stringify(identity)).not.toContain('csrf-secret')
    expect(identity.structuredContent).toMatchObject({ data: { session: { identity: { name: '测试用户' } } } })
  })

  it('reports API errors as tool errors and never retries writes', async () => {
    const { client, calls } = await connect(2, () =>
      Response.json(
        {
          code: 'CONFIG_GROUP_REVISION_CONFLICT',
          message: '已由其他人修改',
          currentRevision: 8,
        },
        { status: 409 }
      )
    )
    const result = await client.callTool({
      name: 'bifrost_delete_requirement',
      arguments: { token: 'a'.repeat(32), confirm: true },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'CONFIG_GROUP_REVISION_CONFLICT', status: 409 } })
    expect(calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(1)
  })

  it('requires confirmation on destructive actions', async () => {
    const { client, calls } = await connect()
    expect((await client.callTool({ name: 'bifrost_cancel_build', arguments: { jobId: JOB } })).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('retries only failed/canceled builds with the original environment and branch', async () => {
    let status = 'BUILDING'
    const { client, calls } = await connect(2, (url) =>
      url.pathname.endsWith(JOB)
        ? Response.json({
            status,
            targetId: 'discover',
            branch: 'feature/x',
            environmentSlug: 'tttt',
            profile: 'qa-web',
          })
        : Response.json({ id: JOB })
    )
    const args = { name: 'bifrost_retry_build', arguments: { jobId: JOB, idempotencyKey: 'retry-job-001' } }
    expect((await client.callTool(args)).isError).toBe(true)
    expect(calls.some((call) => call.init.method === 'POST')).toBe(false)
    status = 'FAILED'
    expect((await client.callTool(args)).isError).not.toBe(true)
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      targetId: 'discover',
      branch: 'feature/x',
      environmentSlug: 'tttt',
      profile: 'qa-web',
    })
  })

  it('waits return immediately for terminal jobs and never submit a build', async () => {
    const { client, calls } = await connect(1, () => Response.json({ id: JOB, status: 'FAILED' }))
    const result = await client.callTool({ name: 'bifrost_wait_build', arguments: { jobId: JOB } })
    expect(result.structuredContent).toMatchObject({ data: { timedOut: false, job: { status: 'FAILED' } } })
    expect(calls).toHaveLength(1)
  })

  it('returns an unfinished job after the bounded wait without canceling it', async () => {
    const { client, calls } = await connect(1, () => Response.json({ id: JOB, status: 'BUILDING' }))
    const result = await client.callTool({
      name: 'bifrost_wait_build',
      arguments: { jobId: JOB, timeoutSeconds: 1 },
    })
    expect(result.structuredContent).toMatchObject({ data: { timedOut: true, job: { status: 'BUILDING' } } })
    expect(calls.every((call) => call.init.method === 'GET')).toBe(true)
  })
})

describe('HTTP boundary', () => {
  it('preserves public identity names and redacts explicitly private fields without mutating source', () => {
    const source = {
      session: { identity: { name: '公开名字', realName: '真实姓名' }, permissionLevel: 2, roles: [] },
      projects: [{ name: '保留项目名' }],
      details: [{ identity: { providerUsername: '飞书用户名' } }],
    }
    expect(redact(source)).toEqual({
      session: { identity: { name: '公开名字', realName: '[REDACTED]' }, permissionLevel: 2, roles: [] },
      projects: [{ name: '保留项目名' }],
      details: [{ identity: { providerUsername: '[REDACTED]' } }],
    })
    expect(source.session.identity.realName).toBe('真实姓名')
  })
  it('allows only HTTPS or loopback origins', () => {
    expect(normalizeOrigin('https://bifrost.example.test')).toBe('https://bifrost.example.test')
    expect(normalizeOrigin('http://127.0.0.1:9888')).toBe('http://127.0.0.1:9888')
    for (const origin of [
      'http://remote.test',
      'https://user:pass@server.test',
      'https://server.test/path',
      'file:///etc/passwd',
    ]) {
      expect(() => normalizeOrigin(origin)).toThrow()
    }
  })
  it('does not send credentials when the route escapes the API prefix', async () => {
    const { api, calls } = await connect()
    for (const route of [
      'https://evil.test',
      '/api/v1/../internal',
      '//evil.test/api/v1/',
      '/api/v1/x?redirect=evil',
    ]) {
      await expect(api.request({ path: route })).rejects.toBeInstanceOf(BifrostApiError)
    }
    expect(calls).toHaveLength(0)
  })
  it('redacts sensitive fields but preserves public preview tokens', () => {
    expect(redact({ subscriptionUrl: 'secret', nested: { password: 'pw' }, token: 'public-preview-token' })).toEqual({
      subscriptionUrl: '[REDACTED]',
      nested: { password: '[REDACTED]' },
      token: 'public-preview-token',
    })
  })
  it('redacts command credentials and refuses writing redaction placeholders back', async () => {
    expect(redact('NPM_TOKEN=secret pnpm build --password secret')).not.toContain('secret')
    expect(redact('https://name:password@git.test/repo')).not.toContain('password')
    const { api, calls } = await connect()
    await expect(
      api.request({
        method: 'PUT',
        path: '/api/v1/admin/build-targets/webapp',
        body: { buildCommand: 'NPM_TOKEN=[REDACTED] build' },
      })
    ).rejects.toMatchObject({ code: 'REDACTED_INPUT' })
    expect(calls).toHaveLength(0)
  })
})
