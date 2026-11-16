import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, type AuthSession } from '@cuddly/db'
import { mcpPersonalTokenPattern, type CreatedMcpPersonalToken } from '@cuddly/contracts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BifrostClient, redact } from '../../mcp-server/src/client'
import { createControlApp } from './app'
import { FeishuOAuthClient, oauthRandomToken } from './auth'

const servers: Server[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function fixture() {
  let now = Date.now()
  const store = new MemoryStore(() => now)
  async function login(kind: AuthSession['kind'] = 'browser', tenantKey = 'test') {
    const cookie = oauthRandomToken()
    const session = await store.createAuthSession({
      token: cookie,
      kind,
      tenantKey,
      openId: randomUUID(),
      unionId: '',
      name: 'Private Provider Name',
      avatarUrl: '',
      csrfToken: oauthRandomToken(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600000).toISOString(),
    })
    return { cookie, session }
  }
  const alice = await login()
  const bob = await login()
  const server = createServer()
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  function makeApp() {
    return createControlApp({
      store,
      internalApiToken: 'internal-test',
      settingsSecret: 'test-secret',
      auth: {
        publicOrigin: origin,
        client: new FeishuOAuthClient({
          appId: 'fake',
          appSecret: 'fake',
          redirectUri: `${origin}/callback`,
        }),
      },
      mcp: { apiOrigin: origin },
    })
  }
  server.on('request', makeApp())
  async function request(
    path = '/api/v1/me/mcp-tokens',
    method = 'GET',
    body?: unknown,
    who: typeof alice | null = alice,
    headers: Record<string, string> = {}
  ) {
    return fetch(origin + path, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(who
          ? { cookie: `cuddly_session=${who.cookie}`, 'x-cuddly-csrf': who.session.csrfToken }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function generate(who = alice) {
    const response = await request(undefined, 'POST', { name: 'Workstation' }, who)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return (await response.json()) as CreatedMcpPersonalToken
  }
  async function level(session: AuthSession, permissionLevel: number, roles: string[] = []) {
    const user = (await store.getUserAccount(session))!
    await store.updateUserPermissions(
      user.id,
      { permissionLevel, roles, expectedRevision: user.revision },
      'fixture'
    )
  }
  return {
    store,
    alice,
    bob,
    login,
    origin,
    request,
    generate,
    level,
    advance: () => {
      now += 400 * 86400000
    },
    restart: () => {
      server.removeAllListeners('request')
      server.on('request', makeApp())
    },
  }
}

describe('persistent personal MCP tokens', () => {
  it('lets level 0 generate a one-time token, stores only its digest, and limits management to its owner', async () => {
    const f = await fixture()
    await f.level(f.alice.session, 0)
    await f.level(f.bob.session, 999, ['owner', 'administrator'])
    const created = await f.generate()
    expect(created.token).toMatch(mcpPersonalTokenPattern)
    const listed = await (await f.request()).json()
    expect(listed).toMatchObject({ items: [{ id: created.item.id, prefix: created.item.prefix }] })
    expect(JSON.stringify(listed)).not.toContain(created.token)
    const records = (f.store as unknown as { mcpTokens: Map<string, unknown> }).mcpTokens
    expect([...records.keys()][0]).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify([...records])).not.toContain(created.token)
    expect(await (await f.request(undefined, 'GET', undefined, f.bob)).json()).toEqual({
      items: [],
    })
    expect(
      (await f.request(`/api/v1/me/mcp-tokens/${created.item.id}`, 'DELETE', undefined, f.bob))
        .status
    ).toBe(404)
    expect(
      (
        await f.request(
          `/api/v1/me/mcp-tokens?userId=${f.alice.session.userId}`,
          'GET',
          undefined,
          f.bob
        )
      ).status
    ).toBe(400)
    expect(
      (await f.request(undefined, 'POST', { name: 'fake', userId: f.bob.session.userId })).status
    ).toBe(400)
    expect(
      (await f.request(undefined, 'POST', { name: 'fake' }, f.alice, { 'x-cuddly-csrf': 'wrong' }))
        .status
    ).toBe(403)
  })

  it.each(['legacy', 'pc', 'mcp'] as const)(
    'requires interactive browser login instead of %s credentials for token management',
    async (kind) => {
      const f = await fixture()
      const identity = await f.login(kind)
      expect((await f.request(undefined, 'POST', { name: 'Denied' }, identity)).status).toBe(403)
      expect((await f.request(undefined, 'GET', undefined, identity)).status).toBe(403)
    }
  )

  it('rejects guest, anonymous and Bearer-only token issuance', async () => {
    const f = await fixture()
    const guest = await f.login('browser', 'bifrost-pc-guest')
    expect((await f.request(undefined, 'POST', { name: 'Denied' }, guest)).status).toBe(403)
    expect((await f.request(undefined, 'POST', { name: 'Denied' }, null)).status).toBe(401)
    expect(
      (
        await f.request(undefined, 'POST', { name: 'Denied' }, null, {
          authorization: `Bearer ${f.alice.cookie}`,
        })
      ).status
    ).toBe(401)
  })

  it('survives browser logout, session expiry and app restart; uses current identity and permissions', async () => {
    const f = await fixture()
    const { token } = await f.generate()
    const client = new BifrostClient({ origin: f.origin, token: async () => token })
    await f.store.deleteAuthSession(f.alice.cookie)
    f.advance()
    f.restart()
    expect(await client.request({ path: '/api/v1/auth/session' })).toMatchObject({
      authenticated: true,
      userId: f.alice.session.userId,
      permissionLevel: 2,
    })
    await f.store.updateOwnProfile(f.alice.session, 'Public Name')
    await f.level(f.alice.session, 0)
    expect(await client.request({ path: '/api/v1/auth/session' })).toMatchObject({
      permissionLevel: 0,
      identity: { name: 'Public Name' },
    })
    await expect(client.request({ path: '/api/v1/build-queue' })).rejects.toMatchObject({
      status: 403,
    })
    await f.level(f.alice.session, 1)
    await expect(client.request({ path: '/api/v1/build-queue' })).resolves.toHaveProperty('running')
    expect(
      await f.store.getOwnPrivateProfile((await f.store.getMcpTokenSession(token))!)
    ).toBeNull()
  })

  it('supports real HTTP MCP without OAuth registration or refresh, then revokes immediately', async () => {
    const f = await fixture()
    const created = await f.generate()
    const client = new Client({ name: 'static-token-fixture', version: '1' })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.origin}/api/v1/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${created.token}` } },
      })
    )
    expect((await client.listTools()).tools.length).toBe(29)
    const whoami = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
    expect(whoami.isError).not.toBe(true)
    expect(JSON.stringify(whoami)).not.toContain('Private Provider Name')
    expect(JSON.stringify(whoami)).not.toContain(created.token)
    await f.level(f.alice.session, 0)
    expect((await client.listTools()).tools.length).toBe(2)
    expect((await f.request(`/api/v1/me/mcp-tokens/${created.item.id}`, 'DELETE')).status).toBe(204)
    await expect(client.listTools()).rejects.toThrow()
    expect(await f.store.getMcpTokenSession(created.token)).toBeNull()
    expect(await (await f.request()).json()).toEqual({ items: [] })
  })

  it('allows business writes with explicit Bearer auth while denying cookie auth, privacy and credential minting', async () => {
    const f = await fixture()
    const { token } = await f.generate()
    const api = new BifrostClient({ origin: f.origin, token: async () => token })
    const target = (await f.store.getBuildTarget('webapp'))!
    await f.store.saveBuildTarget(
      { ...target, enabled: true, repositoryUrl: 'https://example.test/repo.git' },
      'fixture'
    )
    const env = (await f.store.getEnvironment('shared'))!
    const config = (await f.store.getProjectEnvironmentConfig(env.id, target.id))!
    await f.store.saveProjectEnvironmentConfig({ ...config, enabled: true }, 'fixture')
    expect(
      await api.request({
        path: '/api/v1/build-jobs',
        method: 'POST',
        body: { targetId: 'webapp', environmentSlug: 'shared', branch: 'main' },
      })
    ).toMatchObject({ requestedById: f.alice.session.userId })
    for (const [path, method] of [
      ['/api/v1/me/private-profile', 'GET'],
      ['/api/v1/me/mcp-tokens', 'POST'],
      ['/api/v1/auth/pc-login', 'POST'],
      ['/api/v1/auth/mcp-http/consent', 'POST'],
      ['/api/v1/me', 'PATCH'],
      ['/api/v1/auth/logout', 'POST'],
    ]) {
      expect(
        (await f.request(path, method, undefined, null, { authorization: `Bearer ${token}` }))
          .status
      ).toBe(403)
    }
    const cookieOnly = await f.request('/api/v1/auth/session', 'GET', undefined, null, {
      cookie: `cuddly_session=${token}`,
    })
    expect(await cookieOnly.json()).toMatchObject({ authenticated: false })
    expect(
      (
        await f.request('/api/v1/auth/session', 'GET', undefined, null, {
          authorization: 'Bearer bfpat_bad',
        })
      ).status
    ).toBe(401)
    expect(
      redact({ message: `credential ${token}`, config: `Authorization: Bearer ${token}` })
    ).toEqual({ message: 'credential [REDACTED]', config: 'Authorization: Bearer [REDACTED]' })
  })

  it('bounds issuance to 20 active tokens and frees a slot on revocation', async () => {
    const f = await fixture()
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.store.createMcpPersonalToken(f.alice.session, `Client ${i}`)
      )
    )
    expect((await f.request(undefined, 'POST', { name: 'Overflow' })).status).toBe(409)
    await f.store.revokeMcpPersonalToken(f.alice.session, created[0]!.item.id)
    expect((await f.request(undefined, 'POST', { name: 'Replacement' })).status).toBe(201)
  })
})
