import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore } from '@cuddly/db'
import { type OAuthClientProvider, auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { createControlApp } from './app'
import { FeishuOAuthClient, oauthRandomToken, pkceChallenge } from './auth'
import { isMcpHttpReturnPath } from './mcp-http'
import { MCP_CONSENT_PATH, MCP_OAUTH_PATH, MCP_PATH } from './mcp-provider'

const servers: Server[] = []
const clients: Client[] = []
const directories: string[] = []
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
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bifrost-mcp-http-'))
  directories.push(directory)
  const statePath = join(directory, 'oauth.json')
  const store = new MemoryStore()
  const session = oauthRandomToken()
  const csrf = oauthRandomToken()
  await store.createAuthSession({
    token: session,
    csrfToken: csrf,
    tenantKey: 'tenant',
    openId: 'test-user',
    unionId: '',
    name: '<测试操作者>',
    avatarUrl: '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  })
  const account = (await store.getUserAccount((await store.getAuthSession(session))!))!
  await store.updateUserPermissions(
    account.id,
    { permissionLevel: 8, roles: [], expectedRevision: account.revision },
    'fixture'
  )
  const server = createServer()
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const resource = `${origin}${MCP_PATH}`
  function makeApp() {
    return createControlApp({
      store,
      settingsSecret: 'test-secret',
      internalApiToken: 'test-internal',
      auth: {
        publicOrigin: origin,
        client: new FeishuOAuthClient({
          appId: 'test',
          appSecret: 'test',
          redirectUri: `${origin}/api/v1/auth/feishu/callback`,
          fetchImpl: async () => {
            throw new Error('No external network allowed')
          },
        }),
      },
      mcp: { apiOrigin: origin, statePath },
    })
  }
  server.on('request', makeApp())
  async function request(path: string, init: RequestInit = {}) {
    return fetch(new URL(path, origin), { ...init, redirect: 'manual' })
  }
  async function form(path: string, fields: Record<string, string>, authenticated = false) {
    return request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(authenticated ? { cookie: `cuddly_session=${session}` } : {}),
      },
      body: new URLSearchParams(fields),
    })
  }
  const registration = await request(`${MCP_OAUTH_PATH}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: '<script>client</script>',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  expect(registration.status).toBe(201)
  const registered = (await registration.json()) as { client_id: string; redirect_uris: string[] }
  const verifier = oauthRandomToken()
  const params = {
    client_id: registered.client_id,
    redirect_uri: registered.redirect_uris[0]!,
    response_type: 'code',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    resource,
    state: 'test-state',
    scope: 'bifrost:admin',
  }
  async function begin(overrides: Record<string, string> = {}) {
    return request(
      `${MCP_OAUTH_PATH}/authorize?${new URLSearchParams({ ...params, ...overrides })}`
    )
  }
  async function approve(permissionLevel = '2') {
    const auth = await begin()
    expect(auth.status).toBe(303)
    const consent = auth.headers.get('location')!
    const id = new URL(consent, origin).searchParams.get('request')!
    const approved = await form(
      MCP_CONSENT_PATH,
      { request: id, csrf, permissionLevel, decision: 'approve' },
      true
    )
    expect(approved.status).toBe(303)
    const callback = new URL(approved.headers.get('location')!)
    expect(callback.searchParams.get('state')).toBe('test-state')
    return callback.searchParams.get('code')!
  }
  async function exchange(code: string, overrides: Record<string, string> = {}) {
    return form(`${MCP_OAUTH_PATH}/token`, {
      grant_type: 'authorization_code',
      client_id: params.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: params.redirect_uri,
      resource,
      ...overrides,
    })
  }
  async function token(permissionLevel = '2') {
    const response = await exchange(await approve(permissionLevel))
    expect(response.status).toBe(200)
    return response.json() as Promise<{
      access_token: string
      refresh_token: string
      scope: string
    }>
  }
  async function connect(accessToken: string) {
    const client = new Client({ name: 'http-test', version: '1' })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      })
    )
    return client
  }
  return {
    store,
    session,
    csrf,
    server,
    origin,
    resource,
    params,
    statePath,
    request,
    form,
    begin,
    approve,
    exchange,
    token,
    connect,
    restart: () => {
      server.removeAllListeners('request')
      server.on('request', makeApp())
    },
  }
}

describe('remote MCP OAuth and Streamable HTTP', () => {
  it('does not let spoofed forwarded prefixes bypass OAuth rate limits behind the two ingress proxies', async () => {
    const f = await fixture()
    const remaining = []
    for (const spoof of ['192.0.2.11', '192.0.2.12']) {
      const response = await f.request(`${MCP_OAUTH_PATH}/authorize`, {
        headers: { 'x-forwarded-for': `${spoof}, 198.51.100.7, 172.18.0.1` },
      })
      expect(response.status).toBe(400)
      remaining.push(Number(response.headers.get('ratelimit-remaining')))
    }
    expect(remaining).toEqual([99, 98])
  })

  it('connects from only a URL using the SDK automatic OAuth discovery, registration and PKCE flow', async () => {
    const f = await fixture()
    let information: OAuthClientInformationMixed | undefined
    let savedTokens: OAuthTokens | undefined
    let verifier = ''
    let authorizationUrl = ''
    const provider: OAuthClientProvider = {
      redirectUrl: 'http://127.0.0.1:45678/callback',
      clientMetadata: {
        client_name: 'Zero install client',
        redirect_uris: ['http://127.0.0.1:45678/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      state: () => 'sdk-state',
      clientInformation: () => information,
      saveClientInformation: (value) => {
        information = value
      },
      tokens: () => savedTokens,
      saveTokens: (value) => {
        savedTokens = value
      },
      saveCodeVerifier: (value) => {
        verifier = value
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: (value) => {
        authorizationUrl = value.href
      },
    }
    expect(await auth(provider, { serverUrl: f.resource })).toBe('REDIRECT')
    const started = await f.request(authorizationUrl)
    expect(started.status).toBe(303)
    const id = new URL(started.headers.get('location')!, f.origin).searchParams.get('request')!
    const approved = await f.form(
      MCP_CONSENT_PATH,
      {
        request: id,
        csrf: f.csrf,
        decision: 'approve',
        permissionLevel: '2',
      },
      true
    )
    const callback = new URL(approved.headers.get('location')!)
    expect(callback.searchParams.get('state')).toBe('sdk-state')
    expect(
      await auth(provider, {
        serverUrl: f.resource,
        authorizationCode: callback.searchParams.get('code')!,
      })
    ).toBe('AUTHORIZED')
    const client = new Client({ name: 'automatic-oauth-test', version: '1' })
    clients.push(client)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.resource), { authProvider: provider })
    )
    expect((await client.listTools()).tools).toHaveLength(29)
    const identity = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
    expect(identity.isError).not.toBe(true)
    expect(savedTokens?.scope).toBe('bifrost:level:2')
  })

  it('publishes discovery; rejects anonymous, cookie, legacy session and hostile origin access', async () => {
    const f = await fixture()
    const metadata = await (
      await f.request(`/.well-known/oauth-protected-resource${MCP_PATH}`)
    ).json()
    expect(metadata).toMatchObject({ resource: f.resource, authorization_servers: [f.origin] })
    const oauth = await (await f.request('/.well-known/oauth-authorization-server')).json()
    expect(oauth).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      token_endpoint: `${f.origin}${MCP_OAUTH_PATH}/token`,
    })
    const authHeaders: Record<string, string>[] = [
      {},
      { cookie: `cuddly_session=${f.session}` },
      { authorization: `Bearer ${f.session}` },
    ]
    for (const headers of authHeaders) {
      const result = await f.request(MCP_PATH, { headers })
      expect(result.status).toBe(401)
      expect(result.headers.get('www-authenticate')).toContain('resource_metadata=')
    }
    expect(
      (await f.request(MCP_PATH, { headers: { origin: 'https://evil.example' } })).status
    ).toBe(403)
  })

  it('requires login, escapes consent, checks CSRF and handles denial without a code', async () => {
    const f = await fixture()
    const start = await f.begin()
    const consent = start.headers.get('location')!
    const login = await f.request(consent)
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toContain('/api/v1/auth/feishu/start?return_to=')
    expect(isMcpHttpReturnPath(consent)).toBe(true)
    expect(isMcpHttpReturnPath(`//evil.example${consent}`)).toBe(false)
    const page = await f.request(consent, { headers: { cookie: `cuddly_session=${f.session}` } })
    const markup = await page.text()
    expect(markup).toContain('&lt;script&gt;client&lt;/script&gt;')
    expect(markup).toContain('name="permissionLevel"')
    const id = new URL(consent, f.origin).searchParams.get('request')!
    expect(
      (
        await f.form(
          MCP_CONSENT_PATH,
          { request: id, csrf: 'wrong', permissionLevel: '8', decision: 'approve' },
          true
        )
      ).status
    ).toBe(403)
    const denied = await f.form(
      MCP_CONSENT_PATH,
      { request: id, csrf: f.csrf, permissionLevel: '1', decision: 'deny' },
      true
    )
    expect(denied.headers.get('location')).toContain('error=access_denied')
    expect(denied.headers.get('location')).not.toContain('code=')
    expect((await f.request(consent)).status).toBe(400)
  })

  it('validates callback registration, PKCE, resource, redirect URI and single use codes', async () => {
    const f = await fixture()
    expect((await f.begin({ redirect_uri: 'https://evil.example/callback' })).status).toBe(400)
    expect(
      (await f.begin({ resource: 'https://elsewhere.example/mcp' })).headers.get('location')
    ).toContain('error=invalid_target')
    expect((await f.begin({ scope: 'unknown' })).headers.get('location')).toContain(
      'error=invalid_scope'
    )
    const code = await f.approve()
    expect((await f.exchange(code, { code_verifier: oauthRandomToken() })).status).toBe(400)
    expect((await f.exchange(code, { resource: 'https://evil.example/mcp' })).status).toBe(400)
    expect(
      (await f.exchange(code, { redirect_uri: 'http://127.0.0.1:9999/callback' })).status
    ).toBe(400)
    expect((await f.exchange(code)).status).toBe(200)
    expect((await f.exchange(code)).status).toBe(400)
  })

  it.each([
    ['1', 20],
    ['2', 29],
    ['4', 45],
    ['6', 47],
    ['8', 47],
  ] as const)(
    'negotiates real HTTP MCP in %s permissionLevel, preserves identity and rejects unavailable tools',
    async (permissionLevel, count) => {
      const f = await fixture()
      const tokens = await f.token(permissionLevel)
      expect(tokens.scope).toBe(`bifrost:level:${permissionLevel}`)
      const client = await f.connect(tokens.access_token)
      expect((await client.listTools()).tools).toHaveLength(count)
      const identity = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
      expect(identity.isError).not.toBe(true)
      expect(JSON.stringify(identity)).not.toContain('<测试操作者>')
      expect(JSON.stringify(identity)).toContain('用户-')
      expect((await client.listResources()).resources).toHaveLength(2)
      expect((await client.readResource({ uri: 'bifrost://guide' })).contents).toHaveLength(1)
      expect(
        (
          await client.getPrompt({
            name: 'diagnose-build',
            arguments: { jobId: '12345678-1234-4234-8234-123456789012' },
          })
        ).messages
      ).toHaveLength(1)
      if (Number(permissionLevel) < 4)
        expect(
          (await client.callTool({ name: 'bifrost_save_project', arguments: {} })).isError
        ).toBe(true)
      if (permissionLevel === '1')
        expect(
          (await client.callTool({ name: 'bifrost_create_build', arguments: {} })).isError
        ).toBe(true)
      // MCP-only tokens cannot authenticate to the regular API.
      const direct = await f.request('/api/v1/auth/session', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      expect(await direct.json()).toMatchObject({
        authenticated: false,
        permissionLevel: 0,
        roles: [],
      })
      expect(readFileSync(f.statePath, 'utf8')).not.toContain(tokens.access_token)
      expect(readFileSync(f.statePath, 'utf8')).not.toContain(tokens.refresh_token)
    }
  )

  it('persists clients/tokens, rotates refresh tokens, prevents escalation and revokes replayed families', async () => {
    const f = await fixture()
    const first = await f.token('1')
    f.restart()
    const client = await f.connect(first.access_token)
    expect((await client.listTools()).tools).toHaveLength(20)
    const fields = {
      client_id: f.params.client_id,
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      resource: f.resource,
    }
    expect(
      (await f.form(`${MCP_OAUTH_PATH}/token`, { ...fields, scope: 'bifrost:admin' })).status
    ).toBe(400)
    const refreshed = await f.form(`${MCP_OAUTH_PATH}/token`, fields)
    expect(refreshed.status).toBe(200)
    const second = await refreshed.json()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(
      (await f.request(MCP_PATH, { headers: { authorization: `Bearer ${first.access_token}` } }))
        .status
    ).toBe(401)
    expect((await f.form(`${MCP_OAUTH_PATH}/token`, fields)).status).toBe(400)
    expect(
      (await f.request(MCP_PATH, { headers: { authorization: `Bearer ${second.access_token}` } }))
        .status
    ).toBe(401)
  })

  it('revokes connections through the standard revocation endpoint', async () => {
    const f = await fixture()
    const tokens = await f.token()
    const revoked = await f.form(`${MCP_OAUTH_PATH}/revoke`, {
      client_id: f.params.client_id,
      token: tokens.refresh_token,
    })
    expect(revoked.status).toBe(200)
    expect(
      (await f.request(MCP_PATH, { headers: { authorization: `Bearer ${tokens.access_token}` } }))
        .status
    ).toBe(401)
  })

  it('executes scoped writes against the real API with CSRF, actor and idempotency intact', async () => {
    const f = await fixture()
    const project = (await f.store.getBuildTarget('webapp'))!
    await f.store.saveBuildTarget(
      { ...project, enabled: true, repositoryUrl: 'https://git.example.test/webapp.git' },
      'fixture'
    )
    const environment = (await f.store.getEnvironment('shared'))!
    const config = (await f.store.getProjectEnvironmentConfig(environment.id, 'webapp'))!
    await f.store.saveProjectEnvironmentConfig({ ...config, enabled: true }, 'fixture')
    const tokens = await f.token()
    const client = await f.connect(tokens.access_token)
    const args = {
      targetId: 'webapp',
      environmentSlug: 'shared',
      branch: 'feature/http',
      idempotencyKey: 'http-build-1',
    }
    const result = await client.callTool({ name: 'bifrost_create_build', arguments: args })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const job = (result.structuredContent as { data: { id: string; requestedBy: string } }).data
    expect(job.requestedBy).toMatch(/^用户-/)
    const repeated = await client.callTool({ name: 'bifrost_create_build', arguments: args })
    expect((repeated.structuredContent as { data: { id: string } }).data.id).toBe(job.id)
    const canceled = await client.callTool({
      name: 'bifrost_cancel_build',
      arguments: { jobId: job.id, confirm: true },
    })
    expect(canceled.isError).not.toBe(true)
    expect((canceled.structuredContent as { data: { status: string } }).data.status).toBe(
      'CANCELED'
    )
  })

  it('rejects unsafe client redirect URLs and preserves a read-only request at consent', async () => {
    const f = await fixture()
    for (const uri of [
      'http://evil.example/cb',
      'javascript:alert(1)',
      'https://user:password@example.com/cb',
      'https://example.com/cb#fragment',
    ]) {
      const result = await f.request(`${MCP_OAUTH_PATH}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }),
      })
      expect(result.status).toBe(400)
    }
    const result = await f.begin({ scope: 'bifrost:read' })
    const id = new URL(result.headers.get('location')!, f.origin).searchParams.get('request')!
    expect(
      (
        await f.form(
          MCP_CONSENT_PATH,
          { request: id, csrf: f.csrf, permissionLevel: '8', decision: 'approve' },
          true
        )
      ).status
    ).toBe(400)
  })
})
