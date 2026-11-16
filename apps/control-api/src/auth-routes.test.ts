import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MemoryStore } from '@cuddly/db'
import { afterEach, describe, expect, it } from 'vitest'

import { createControlApp } from './app'
import {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  FeishuOAuthClient,
  oauthRandomToken,
  pkceChallenge,
} from './auth'

const INTERNAL_API_TOKEN = 'internal-test-token'
const PUBLIC_ORIGIN = 'https://bifrost.vanillacake.cn'
const CALLBACK_URI = `${PUBLIC_ORIGIN}/api/v1/auth/feishu/callback`
const COMPLETE_PATH = '/api/v1/auth/feishu/complete'
const SHARED_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'

interface OAuthFetchCall {
  url: string
  init?: RequestInit
}

interface TestServer {
  origin: string
  server: Server
}

const runningServers: Server[] = []

it('completes PC login across independent browser and cookieless plugin clients', async () => {
  const { fetchImpl } = createFakeOAuthFetch()
  const store = new MemoryStore()
  const { origin } = startControlApi(store, fetchImpl)
  const verifier = oauthRandomToken()
  const initialized = await fetch(`${origin}/api/v1/auth/pc-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
    body: JSON.stringify({ challenge: pkceChallenge(verifier) }),
  })
  expect(initialized.status).toBe(201)
  const login = (await initialized.json()) as { id: string; authorizationUrl: string }
  const url = new URL(login.authorizationUrl)
  const returnTo = url.pathname + url.search
  const completed = await completeOAuth(origin, returnTo)
  expect(completed.response.headers.get('location')).toBe(returnTo)
  const session = await store.getAuthSession(completed.sessionToken)
  const approved = await fetch(`${origin}${url.pathname}`, {
    method: 'POST',
    headers: {
      cookie: completed.sessionCookie,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ request: login.id, csrf: session!.csrfToken, decision: 'approve' }),
  })
  expect(approved.status).toBe(200)
  const claimed = await fetch(`${origin}/api/v1/auth/pc-login/${login.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verifier }),
  })
  expect(claimed.status).toBe(200)
  const { token } = (await claimed.json()) as { token: string }
  expect(token).not.toBe(completed.sessionToken)
  const pcSession = await fetch(`${origin}/api/v1/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(await pcSession.json()).toMatchObject({ authenticated: true, permissionLevel: 2 })
})

it('returns remote MCP OAuth to consent after Feishu authentication', async () => {
  const { fetchImpl } = createFakeOAuthFetch()
  const { origin } = startControlApi(new MemoryStore(), fetchImpl)
  const returnTo = `/api/v1/auth/mcp-http/consent?request=${oauthRandomToken()}`
  const completed = await completeOAuth(origin, returnTo)
  expect(completed.response.headers.get('location')).toBe(returnTo)
})

it('returns MCP login to the validated consent page after Feishu authentication', async () => {
  const { fetchImpl } = createFakeOAuthFetch()
  const { origin } = startControlApi(new MemoryStore(), fetchImpl)
  const query = new URLSearchParams({
    redirect_uri: 'http://127.0.0.1:54321/callback',
    state: oauthRandomToken(),
    code_challenge: pkceChallenge(oauthRandomToken()),
  })
  const returnTo = `/api/v1/auth/mcp/authorize?${query}`
  const completed = await completeOAuth(origin, returnTo)
  expect(completed.response.headers.get('location')).toBe(returnTo)
})

afterEach(async () => {
  await Promise.all(
    runningServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  )
})

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (getSetCookie) return getSetCookie.call(headers)
  const combined = headers.get('set-cookie')
  return combined ? combined.split(/,(?=\s*[!#$%&'*+.^_`|~\w-]+=)/) : []
}

function cookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf('='))
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

function cookieValue(setCookie: string): string {
  const pair = cookiePair(setCookie)
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1))
}

function cookieHeader(setCookies: string[], names?: string[]): string {
  const allowed = names ? new Set(names) : null
  return setCookies
    .filter((cookie) => !allowed || allowed.has(cookieName(cookie)))
    .map(cookiePair)
    .join('; ')
}

function findCookie(setCookies: string[], name: string): string {
  const cookie = setCookies.find((candidate) => cookieName(candidate) === name)
  if (!cookie) throw new Error(`Missing ${name} Set-Cookie header`)
  return cookie
}

function createFakeOAuthFetch() {
  const calls: OAuthFetchCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url === FEISHU_TOKEN_URL) {
      return Response.json({ access_token: 'feishu-access-token-for-test' })
    }
    if (url === FEISHU_USER_INFO_URL) {
      return Response.json({
        code: 0,
        data: {
          tenant_key: 'tenant-test',
          open_id: 'ou_feishu_operator',
          union_id: 'on_feishu_operator',
          name: '飞书测试用户',
          avatar_middle: 'https://example.test/avatar.png',
        },
      })
    }
    throw new Error(`Unexpected OAuth request: ${url}`)
  }) as typeof fetch
  return { calls, fetchImpl }
}

function startControlApi(
  store: MemoryStore,
  fetchImpl: typeof fetch,
  sessionMaxAgeMs = 60 * 60 * 1_000
): TestServer {
  const client = new FeishuOAuthClient({
    appId: 'cli_test_app',
    appSecret: 'test-app-secret',
    redirectUri: CALLBACK_URI,
    fetchImpl,
  })
  const server = createControlApp({
    store,
    internalApiToken: INTERNAL_API_TOKEN,
    settingsSecret: 'test-settings-secret',
    auth: { client, publicOrigin: PUBLIC_ORIGIN, sessionMaxAgeMs },
  }).listen(0)
  runningServers.push(server)
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}` }
}

async function startOAuth(
  origin: string,
  returnTo = '/'
): Promise<{
  response: Response
  location: URL
  setCookies: string[]
  callbackCookie: string
  state: string
  verifier: string
}> {
  const response = await fetch(
    `${origin}/api/v1/auth/feishu/start?return_to=${encodeURIComponent(returnTo)}`,
    { redirect: 'manual' }
  )
  const location = new URL(response.headers.get('location')!)
  const setCookies = setCookieHeaders(response.headers)
  return {
    response,
    location,
    setCookies,
    callbackCookie: cookieHeader(setCookies, [
      'cuddly_oauth_state',
      'cuddly_oauth_verifier',
      'cuddly_oauth_return',
    ]),
    state: cookieValue(findCookie(setCookies, 'cuddly_oauth_state')),
    verifier: cookieValue(findCookie(setCookies, 'cuddly_oauth_verifier')),
  }
}

async function completeOAuth(
  origin: string,
  returnTo = '/'
): Promise<{
  response: Response
  sessionCookie: string
  sessionToken: string
  start: Awaited<ReturnType<typeof startOAuth>>
}> {
  const start = await startOAuth(origin, returnTo)
  const response = await fetch(
    `${origin}/api/v1/auth/feishu/callback?code=test-auth-code&state=${encodeURIComponent(start.state)}`,
    {
      headers: { cookie: start.callbackCookie },
      redirect: 'manual',
    }
  )
  const setCookies = setCookieHeaders(response.headers)
  const sessionSetCookie = findCookie(setCookies, 'cuddly_session')
  return {
    response,
    sessionCookie: cookiePair(sessionSetCookie),
    sessionToken: cookieValue(sessionSetCookie),
    start,
  }
}

async function configureBuildableWebapp(store: MemoryStore) {
  const target = await store.getBuildTarget('webapp')
  if (!target) throw new Error('Missing webapp target fixture')
  await store.saveBuildTarget(
    {
      ...target,
      enabled: true,
      repositoryUrl: 'https://git.example.test/webapp.git',
      configurationSource: 'database',
    },
    'fixture'
  )
  const config = await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'webapp')
  if (!config) throw new Error('Missing webapp environment fixture')
  await store.saveProjectEnvironmentConfig({ ...config, enabled: true }, 'fixture')
}

describe('control API Feishu OAuth routes', () => {
  it('keeps health public, protects human APIs, and leaves internal Bearer auth independent', async () => {
    const store = new MemoryStore()
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(store, oauth.fetchImpl)

    const live = await fetch(`${origin}/health/live`)
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ ok: true })

    const protectedRequest = await fetch(`${origin}/api/v1/build-queue`)
    expect(protectedRequest.status).toBe(401)
    expect(protectedRequest.headers.get('www-authenticate')).toBe('Session realm="cuddly"')
    expect(await protectedRequest.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      required: { permissionLevel: 1, roles: [] },
    })
    expect(await fetch(`${origin}/api/v1/config-groups`)).toMatchObject({ status: 401 })

    const internalWithoutToken = await fetch(`${origin}/api/v1/internal/auto-ssl-config`)
    expect(internalWithoutToken.status).toBe(401)
    expect(internalWithoutToken.headers.get('www-authenticate')).toBe(
      'Bearer realm="cuddly-internal"'
    )

    const internal = await fetch(`${origin}/api/v1/internal/auto-ssl-config`, {
      headers: { authorization: `Bearer ${INTERNAL_API_TOKEN}` },
    })
    expect(internal.status).toBe(200)
    expect(await internal.json()).toEqual({
      autoSslEnabled: false,
      autoSslEmail: '',
      hostnames: [],
    })
    expect(oauth.calls).toHaveLength(0)
  })

  it('starts Authorization Code + PKCE with callback-scoped secure state cookies', async () => {
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(new MemoryStore(), oauth.fetchImpl)
    const started = await startOAuth(origin, '/builds?tab=queue#running')

    expect(started.response.status).toBe(302)
    expect(started.response.headers.get('cache-control')).toBe('no-store')
    expect(started.response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(`${started.location.origin}${started.location.pathname}`).toBe(FEISHU_AUTHORIZE_URL)
    expect(started.location.searchParams.get('client_id')).toBe('cli_test_app')
    expect(started.location.searchParams.get('response_type')).toBe('code')
    expect(started.location.searchParams.get('redirect_uri')).toBe(CALLBACK_URI)
    expect(started.location.searchParams.get('state')).toBe(started.state)
    expect(started.location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(started.location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(started.location.searchParams.has('scope')).toBe(false)
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(started.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)

    expect(started.setCookies.map(cookieName).sort()).toEqual([
      'cuddly_oauth_return',
      'cuddly_oauth_state',
      'cuddly_oauth_verifier',
    ])
    for (const cookie of started.setCookies) {
      expect(cookie).toContain('Max-Age=600')
      expect(cookie).toContain('Path=/api/v1/auth/feishu/callback')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).not.toContain('Domain=')
    }
    expect(cookieValue(findCookie(started.setCookies, 'cuddly_oauth_return'))).toBe(
      '/builds?tab=queue#running'
    )
    expect(oauth.calls).toHaveLength(0)
  })

  it('rejects an invalid state, clears transient cookies, and never contacts Feishu', async () => {
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(new MemoryStore(), oauth.fetchImpl)
    const started = await startOAuth(origin, '/builds?tab=queue#running')

    const callback = await fetch(
      `${origin}/api/v1/auth/feishu/callback?code=must-not-be-used&state=wrong-state`,
      {
        headers: { cookie: started.callbackCookie },
        redirect: 'manual',
      }
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe(
      '/builds?tab=queue&auth_error=invalid_state#running'
    )
    expect(callback.headers.get('cache-control')).toBe('no-store')
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer')
    const cleared = setCookieHeaders(callback.headers)
    expect(cleared.map(cookieName).sort()).toEqual([
      'cuddly_oauth_return',
      'cuddly_oauth_state',
      'cuddly_oauth_verifier',
    ])
    for (const cookie of cleared) {
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
      expect(cookie).toContain('Path=/api/v1/auth/feishu/callback')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
    }
    expect(oauth.calls).toHaveLength(0)
  })

  it('creates an opaque session, enforces CSRF, trusts only Feishu identity, and revokes logout', async () => {
    const store = new MemoryStore()
    await configureBuildableWebapp(store)
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(store, oauth.fetchImpl)
    const completed = await completeOAuth(origin, '/?tab=queue#active')

    expect(completed.response.status).toBe(303)
    expect(completed.response.headers.get('location')).toBe(COMPLETE_PATH)
    expect(completed.response.headers.get('cache-control')).toBe('no-store')
    expect(completed.response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(completed.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(completed.sessionToken).not.toContain('feishu')
    expect(completed.sessionToken).not.toContain('ou_feishu_operator')
    const sessionSetCookie = findCookie(
      setCookieHeaders(completed.response.headers),
      'cuddly_session'
    )
    expect(sessionSetCookie).toContain('Max-Age=3600')
    expect(sessionSetCookie).toContain('Path=/')
    expect(sessionSetCookie).toContain('HttpOnly')
    expect(sessionSetCookie).toContain('Secure')
    expect(sessionSetCookie).toContain('SameSite=None')
    expect(sessionSetCookie).not.toContain('Domain=')

    const completion = await fetch(`${origin}${COMPLETE_PATH}`)
    expect(completion.status).toBe(200)
    expect(completion.headers.get('content-type')).toContain('text/html')
    expect(completion.headers.get('cache-control')).toBe('no-store')
    expect(completion.headers.get('referrer-policy')).toBe('no-referrer')
    expect(completion.headers.get('x-content-type-options')).toBe('nosniff')
    expect(completion.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const completionHtml = await completion.text()
    expect(completionHtml).toContain('飞书登录已完成')
    expect(completionHtml).toContain('window.close()')
    expect(completionHtml).toContain('返回刚才的界面')
    expect(completionHtml).not.toContain('window.location')

    expect(oauth.calls).toHaveLength(2)
    expect(oauth.calls[0]?.url).toBe(FEISHU_TOKEN_URL)
    expect(oauth.calls[0]?.init?.method).toBe('POST')
    expect(new Headers(oauth.calls[0]?.init?.headers).get('content-type')).toBe(
      'application/json; charset=utf-8'
    )
    const tokenBody = JSON.parse(String(oauth.calls[0]?.init?.body))
    expect(tokenBody).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cli_test_app',
      client_secret: 'test-app-secret',
      code: 'test-auth-code',
      redirect_uri: CALLBACK_URI,
      code_verifier: completed.start.verifier,
    })
    expect(oauth.calls[1]?.url).toBe(FEISHU_USER_INFO_URL)
    expect(new Headers(oauth.calls[1]?.init?.headers).get('authorization')).toBe(
      'Bearer feishu-access-token-for-test'
    )

    const sessionResponse = await fetch(`${origin}/api/v1/auth/session`, {
      headers: { cookie: completed.sessionCookie },
    })
    expect(sessionResponse.status).toBe(200)
    expect(sessionResponse.headers.get('cache-control')).toBe('no-store')
    const session = (await sessionResponse.json()) as {
      authenticated: boolean
      userId: string
      identity: { name: string; avatarUrl: string }
      csrfToken: string
    }
    expect(session).toMatchObject({
      authenticated: true,
      permissionLevel: 2,
      roles: [],
      identity: {
        name: expect.stringMatching(/^用户-/),
        avatarUrl: 'https://example.test/avatar.png',
      },
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })

    const noCsrf = await fetch(`${origin}/api/v1/build-jobs`, {
      method: 'POST',
      headers: {
        cookie: completed.sessionCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        environmentSlug: 'shared',
        targetId: 'webapp',
        branch: 'feature/without-csrf',
      }),
    })
    expect(noCsrf.status).toBe(403)
    expect(await noCsrf.json()).toMatchObject({ code: 'CSRF_INVALID' })

    const configurationGroupWithoutCsrf = await fetch(
      `${origin}/api/v1/config-groups/${'a'.repeat(32)}`,
      {
        method: 'DELETE',
        headers: { cookie: completed.sessionCookie },
      }
    )
    expect(configurationGroupWithoutCsrf.status).toBe(403)
    expect(await configurationGroupWithoutCsrf.json()).toMatchObject({ code: 'CSRF_INVALID' })

    const build = await fetch(`${origin}/api/v1/build-jobs`, {
      method: 'POST',
      headers: {
        cookie: completed.sessionCookie,
        'content-type': 'application/json',
        'x-cuddly-csrf': session.csrfToken,
        'x-cuddly-actor': 'spoofed-operator',
      },
      body: JSON.stringify({
        environmentSlug: 'shared',
        targetId: 'webapp',
        branch: 'feature/verified-operator',
      }),
    })
    expect(build.status).toBe(202)
    expect(await build.json()).toMatchObject({
      branch: 'feature/verified-operator',
      requestedBy: session.identity.name,
    })
    expect((await store.listBuildJobs('webapp', SHARED_ENVIRONMENT_ID))[0]).toMatchObject({
      requestedBy: `user:${session.userId}`,
    })

    const badLogout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: completed.sessionCookie, 'x-cuddly-csrf': 'wrong-token' },
    })
    expect(badLogout.status).toBe(403)
    expect(await store.getAuthSession(completed.sessionToken)).not.toBeNull()

    const logout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: completed.sessionCookie,
        'x-cuddly-csrf': session.csrfToken,
      },
    })
    expect(logout.status).toBe(204)
    expect(findCookie(setCookieHeaders(logout.headers), 'cuddly_session')).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    )
    expect(await store.getAuthSession(completed.sessionToken)).toBeNull()

    const revoked = await fetch(`${origin}/api/v1/auth/session`, {
      headers: { cookie: completed.sessionCookie },
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({
      authenticated: false,
      permissionLevel: 0,
      roles: [],
    })
  })

  it('hands an authenticated session to the PC panel without relying on third-party cookies', async () => {
    const store = new MemoryStore()
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(store, oauth.fetchImpl)
    const nonce = 'pc-login-nonce-1234567890'
    const completed = await completeOAuth(
      origin,
      `/api/v1/auth/pc-complete?nonce=${encodeURIComponent(nonce)}`
    )

    expect(completed.response.headers.get('location')).toBe(
      `/api/v1/auth/pc-complete?nonce=${encodeURIComponent(nonce)}`
    )
    const handoff = await fetch(`${origin}${completed.response.headers.get('location')}`, {
      headers: { cookie: completed.sessionCookie },
    })
    expect(handoff.status).toBe(200)
    expect(handoff.headers.get('cache-control')).toBe('no-store')
    expect(handoff.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await handoff.text()
    expect(html).toContain(`bifrost-pc-auth:${nonce}`)
    expect(html).not.toContain(completed.sessionToken)
    const pcToken = /token: "([A-Za-z0-9_-]+)"/.exec(html)![1]!
    expect(await store.getAuthSession(pcToken)).toMatchObject({ kind: 'pc' })
    expect(html).toContain("type: 'session'")
    expect(html).toContain('window.opener.postMessage')
    expect(html).toContain('}, "https://bifrost.vanillacake.cn");')

    const bearerSession = await fetch(`${origin}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${completed.sessionToken}` },
    })
    expect(bearerSession.status).toBe(200)
    const session = (await bearerSession.json()) as { csrfToken: string }
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const logout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${completed.sessionToken}`,
        'x-cuddly-csrf': session.csrfToken,
      },
    })
    expect(logout.status).toBe(204)
    expect(await store.getAuthSession(completed.sessionToken)).toBeNull()

    const missingCookie = await fetch(
      `${origin}/api/v1/auth/pc-complete?nonce=${encodeURIComponent(nonce)}`
    )
    expect(missingCookie.status).toBe(401)
    expect(await missingCookie.text()).not.toContain(completed.sessionToken)
  })

  it('issues a short-lived PC Guest bearer session with an explicit API allowlist', async () => {
    const store = new MemoryStore()
    await configureBuildableWebapp(store)
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(store, oauth.fetchImpl)

    const unmarked = await fetch(`${origin}/api/v1/auth/pc-guest`, { method: 'POST' })
    expect(unmarked.status).toBe(403)
    expect(await unmarked.json()).toMatchObject({ code: 'PC_GUEST_CLIENT_REQUIRED' })

    const issuedAfter = Date.now()
    const issued = await fetch(`${origin}/api/v1/auth/pc-guest`, {
      method: 'POST',
      headers: { 'x-bifrost-client': 'kook-pc-plugin' },
    })
    expect(issued.status).toBe(201)
    expect(issued.headers.get('cache-control')).toBe('no-store')
    expect(issued.headers.get('set-cookie')).toBeNull()
    const guest = (await issued.json()) as {
      authenticated: boolean
      guest: boolean
      token: string
      csrfToken: string
      expiresAt: string
      identity: { name: string; avatarUrl: string }
    }
    expect(guest).toMatchObject({
      authenticated: true,
      guest: true,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      identity: { name: '游客', avatarUrl: '' },
    })
    expect(Date.parse(guest.expiresAt) - issuedAfter).toBeGreaterThan(23 * 60 * 60 * 1_000)
    expect(Date.parse(guest.expiresAt) - issuedAfter).toBeLessThanOrEqual(
      24 * 60 * 60 * 1_000 + 5_000
    )

    const authorization = { authorization: `Bearer ${guest.token}` }
    const session = await fetch(`${origin}/api/v1/auth/session`, {
      headers: authorization,
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      authenticated: true,
      guest: true,
      csrfToken: guest.csrfToken,
      identity: { name: '游客' },
    })
    expect(await fetch(`${origin}/api/v1/build-queue`, { headers: authorization })).toMatchObject({
      status: 403,
    })

    const buildWithoutCsrf = await fetch(`${origin}/api/v1/build-jobs`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        environmentSlug: 'shared',
        targetId: 'webapp',
        branch: 'feature/guest-without-csrf',
      }),
    })
    expect(buildWithoutCsrf.status).toBe(403)
    expect(await buildWithoutCsrf.json()).toMatchObject({ code: 'CSRF_INVALID' })

    const build = await fetch(`${origin}/api/v1/build-jobs`, {
      method: 'POST',
      headers: {
        ...authorization,
        'content-type': 'application/json',
        'x-cuddly-csrf': guest.csrfToken,
      },
      body: JSON.stringify({
        environmentSlug: 'shared',
        targetId: 'webapp',
        branch: 'feature/guest-build',
      }),
    })
    expect(build.status).toBe(403)
    expect(await build.json()).toMatchObject({ code: 'PERMISSION_DENIED' })

    for (const forbidden of [
      await fetch(`${origin}/api/v1/admin/system-settings`, { headers: authorization }),
      await fetch(`${origin}/api/v1/environments/shared/revisions`, {
        method: 'POST',
        headers: { ...authorization, 'x-cuddly-csrf': guest.csrfToken },
      }),
    ]) {
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({
        code: 'PERMISSION_DENIED',
      })
    }

    const feishu = await completeOAuth(origin)
    expect(
      await fetch(`${origin}/api/v1/admin/system-settings`, {
        headers: { cookie: feishu.sessionCookie },
      })
    ).toMatchObject({ status: 403 })

    const logout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { ...authorization, 'x-cuddly-csrf': guest.csrfToken },
    })
    expect(logout.status).toBe(204)
    expect(await store.getAuthSession(guest.token)).toBeNull()
    expect(await fetch(`${origin}/api/v1/auth/session`, { headers: authorization })).toMatchObject({
      status: 200,
    })
  })

  it('allows credentialed Chrome extension requests and answers preflight before auth', async () => {
    const oauth = createFakeOAuthFetch()
    const { origin } = startControlApi(new MemoryStore(), oauth.fetchImpl)
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

    const preflight = await fetch(`${origin}/api/v1/build-jobs`, {
      method: 'OPTIONS',
      headers: {
        origin: extensionOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'content-type, idempotency-key, x-cuddly-csrf, x-cuddly-actor',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(extensionOrigin)
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type, idempotency-key, x-cuddly-csrf'
    )
    expect(preflight.headers.get('vary')).toContain('Origin')

    const completed = await completeOAuth(origin)
    const session = (await fetch(`${origin}/api/v1/auth/session`, {
      headers: {
        cookie: completed.sessionCookie,
        origin: extensionOrigin,
      },
    }).then((response) => {
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe(extensionOrigin)
      expect(response.headers.get('access-control-allow-credentials')).toBe('true')
      return response.json()
    })) as { csrfToken: string }
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const webOrigin = await fetch(`${origin}/api/v1/auth/session`, {
      headers: { cookie: completed.sessionCookie, origin: 'https://untrusted.example.test' },
    })
    expect(webOrigin.status).toBe(200)
    expect(webOrigin.headers.get('access-control-allow-origin')).toBeNull()
    expect(webOrigin.headers.get('access-control-allow-credentials')).toBeNull()
  })
})
