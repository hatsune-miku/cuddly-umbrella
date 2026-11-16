import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore } from '@cuddly/db'

import { oauthRandomToken, pkceChallenge } from './auth'
import {
  MCP_AUTHORIZE_PATH,
  isMcpAuthorizationReturnPath,
  registerMcpAuthorization,
} from './mcp-auth'

const servers: Server[] = []
afterEach(async () => {
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
  const store = new MemoryStore()
  const token = oauthRandomToken()
  const csrf = oauthRandomToken()
  const expiresAt = new Date(Date.now() + 3600000).toISOString()
  await store.createAuthSession({
    token,
    csrfToken: csrf,
    tenantKey: 'tenant',
    openId: 'user',
    unionId: 'union',
    name: '<script>测试用户</script>',
    avatarUrl: '',
    createdAt: new Date().toISOString(),
    expiresAt,
  })
  const guest = oauthRandomToken()
  await store.updateOwnProfile((await store.getAuthSession(token))!, '<script>公开名字</script>')
  await store.createAuthSession({
    token: guest,
    csrfToken: csrf,
    tenantKey: 'guest',
    openId: 'guest',
    unionId: '',
    name: 'Guest',
    avatarUrl: '',
    createdAt: new Date().toISOString(),
    expiresAt,
  })
  let now = Date.now()
  const app = express()
  app.use(express.json())
  registerMcpAuthorization(app, {
    store,
    authenticate: async (req) =>
      req.get('x-test-session') ? store.getAuthSession(req.get('x-test-session')!) : null,
    isGuest: (session) => session.tenantKey === 'guest',
    now: () => now,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const verifier = oauthRandomToken()
  const request = {
    redirect_uri: 'http://127.0.0.1:54321/callback',
    state: oauthRandomToken(),
    code_challenge: pkceChallenge(verifier),
  }
  async function approve(overrides: Record<string, string> = {}, session = token) {
    return fetch(`${origin}${MCP_AUTHORIZE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-session': session },
      body: new URLSearchParams({ ...request, csrf, decision: 'approve', ...overrides }),
      redirect: 'manual',
    })
  }
  async function exchange(code: string, overrides: Record<string, string> = {}) {
    return fetch(`${origin}/api/v1/auth/mcp/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        redirect_uri: request.redirect_uri,
        ...overrides,
      }),
    })
  }
  return {
    store,
    token,
    csrf,
    guest,
    origin,
    expiresAt,
    request,
    approve,
    exchange,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('MCP browser authorization', () => {
  it('preserves a parent session permission ceiling when issuing a stdio credential', async () => {
    const f = await fixture()
    await f.store.limitAuthSession(f.token, 1)
    const callback = new URL((await f.approve()).headers.get('location')!)
    const response = await f.exchange(callback.searchParams.get('code')!)
    expect(response.status).toBe(200)
    const result = (await response.json()) as { token: string }
    expect(await f.store.getAuthSession(result.token)).toMatchObject({ permissionCeiling: 1 })
  })
  it('requires login then explicit approval and safely renders identity', async () => {
    const f = await fixture()
    const url = `${f.origin}${MCP_AUTHORIZE_PATH}?${new URLSearchParams(f.request)}`
    const anonymous = await fetch(url, { redirect: 'manual' })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('location')).toContain('/api/v1/auth/feishu/start?return_to=')
    const page = await fetch(url, { headers: { 'x-test-session': f.token } })
    const html = await page.text()
    expect(html).toContain('&lt;script&gt;公开名字&lt;/script&gt;')
    expect(html).not.toContain('测试用户')
    expect(html).toContain('decision')
    expect(html).not.toContain(f.token)
    expect(page.headers.get('content-security-policy')).toContain('http://127.0.0.1:54321')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('cache-control')).toBe('no-store')
  })
  it('issues a separate session with the same identity, one-time PKCE code and bounded expiry', async () => {
    const f = await fixture()
    const approval = await f.approve()
    expect(approval.status).toBe(303)
    const callback = new URL(approval.headers.get('location')!)
    expect(callback.searchParams.get('state')).toBe(f.request.state)
    const code = callback.searchParams.get('code')!
    expect(callback.href).not.toContain(f.token)
    expect((await f.exchange(code, { code_verifier: oauthRandomToken() })).status).toBe(400)
    expect(
      (await f.exchange(code, { redirect_uri: 'http://127.0.0.1:54322/callback' })).status
    ).toBe(400)
    const response = await f.exchange(code)
    expect(response.status).toBe(200)
    const result = (await response.json()) as { token: string; expiresAt: string }
    expect(result.token).not.toBe(f.token)
    expect(result.expiresAt).toBe(f.expiresAt)
    const session = await f.store.getAuthSession(result.token)
    expect(session).toMatchObject({
      tenantKey: 'tenant',
      openId: 'user',
      name: '<script>公开名字</script>',
    })
    expect(session?.csrfToken).not.toBe(f.csrf)
    expect((await f.exchange(code)).status).toBe(400)
    await f.store.deleteAuthSession(result.token)
    expect(await f.store.getAuthSession(f.token)).not.toBeNull()
  })
  it('rejects guest sessions, missing CSRF, remote callbacks and malformed state', async () => {
    const f = await fixture()
    expect((await f.approve({}, f.guest)).status).toBe(403)
    expect((await f.approve({ csrf: '' })).status).toBe(403)
    for (const callback of [
      'https://evil.test/callback',
      'http://localhost:54321/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:54321/callback?extra=1',
      'http://user@127.0.0.1:54321/callback',
      'http://127.0.0.1:54321/other',
    ]) {
      expect((await f.approve({ redirect_uri: callback })).status).toBe(400)
    }
    expect((await f.approve({ state: 'invalid' })).status).toBe(400)
  })
  it('honors cancellation and code expiry', async () => {
    const f = await fixture()
    const canceled = new URL((await f.approve({ decision: 'deny' })).headers.get('location')!)
    expect(canceled.searchParams.get('error')).toBe('access_denied')
    expect(canceled.searchParams.has('code')).toBe(false)
    const callback = new URL((await f.approve()).headers.get('location')!)
    f.advance(61000)
    expect((await f.exchange(callback.searchParams.get('code')!)).status).toBe(400)
  })
  it('only permits the exact MCP consent route as an OAuth return target', async () => {
    const f = await fixture()
    expect(
      isMcpAuthorizationReturnPath(`${MCP_AUTHORIZE_PATH}?${new URLSearchParams(f.request)}`)
    ).toBe(true)
    expect(
      isMcpAuthorizationReturnPath(
        `https://evil.test${MCP_AUTHORIZE_PATH}?${new URLSearchParams(f.request)}`
      )
    ).toBe(false)
    expect(isMcpAuthorizationReturnPath('/api/v1/auth/mcp/token')).toBe(false)
  })
})
