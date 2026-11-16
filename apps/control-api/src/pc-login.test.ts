import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MemoryStore } from '@cuddly/db'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { oauthRandomToken, parseCookieHeader, pkceChallenge } from './auth'
import { isPcLoginReturnPath, PC_LOGIN_PATH, registerPcLogin } from './pc-login'

const publicOrigin = 'https://bifrost.vanillacake.cn'
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
  const session = {
    token,
    csrfToken: csrf,
    tenantKey: 'tenant',
    openId: 'user',
    unionId: 'union',
    name: '<script>测试用户</script>',
    avatarUrl: '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }
  await store.createAuthSession(session)
  await store.updateOwnProfile(session, '<script>公开名字</script>')
  const guest = oauthRandomToken()
  await store.createAuthSession({ ...session, token: guest, tenantKey: 'guest' })
  let now = Date.now()
  const app = express()
  app.use(express.json())
  registerPcLogin(app, {
    store,
    publicOrigin,
    now: () => now,
    browserToken: (req) => parseCookieHeader(req.get('cookie')).test_session || '',
    isGuest: (value) => value.tenantKey === 'guest',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const verifier = oauthRandomToken()
  async function create(headers: Record<string, string> = {}) {
    return fetch(`${origin}${PC_LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: publicOrigin, ...headers },
      body: JSON.stringify({ challenge: pkceChallenge(verifier) }),
    })
  }
  const created = await create()
  expect(created.status).toBe(201)
  expect((await created.clone().json()).expiresInMs).toBe(300_000)
  const login = (await created.json()) as {
    id: string
    code: string
    expiresAt: number
    authorizationUrl: string
  }
  async function approve(
    body: Record<string, string> = {},
    browserToken = token,
    originHeader = publicOrigin
  ) {
    return fetch(`${origin}${PC_LOGIN_PATH}/authorize`, {
      method: 'POST',
      headers: {
        cookie: `test_session=${browserToken}`,
        origin: originHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ request: login.id, csrf, decision: 'approve', ...body }),
    })
  }
  async function claim(value = verifier) {
    // Deliberately separate from the browser: no cookies or Authorization header.
    return fetch(`${origin}${PC_LOGIN_PATH}/${login.id}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: publicOrigin },
      body: JSON.stringify({ verifier: value }),
    })
  }
  return {
    store,
    token,
    csrf,
    guest,
    session,
    origin,
    verifier,
    login,
    create,
    approve,
    claim,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('PC cross-browser authorization', () => {
  it('requires browser login and explicit approval, escapes identity and never exposes credentials in HTML', async () => {
    const f = await fixture()
    const url = `${f.origin}${PC_LOGIN_PATH}/authorize?request=${f.login.id}`
    const anonymous = await fetch(url, { redirect: 'manual' })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('location')).toContain('/api/v1/auth/feishu/start?return_to=')
    const page = await fetch(url, { headers: { cookie: `test_session=${f.token}` } })
    const html = await page.text()
    expect(html).toContain('&lt;script&gt;公开名字&lt;/script&gt;')
    expect(html).not.toContain('测试用户')
    expect(html).toContain(f.login.code)
    expect(html).not.toContain(f.token)
    expect(html).not.toContain(f.verifier)
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await f.claim()).status).toBe(202)
  })

  it('issues one separate session to the cookieless PC client with current permission ceiling and bounded expiry', async () => {
    const f = await fixture()
    expect((await f.approve()).status).toBe(200)
    await f.store.limitAuthSession(f.token, 1)
    const response = await f.claim()
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBe(null)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = (await response.json()) as { token: string; expiresAt: string }
    expect(result.token).not.toBe(f.token)
    const session = await f.store.getAuthSession(result.token)
    expect(session).toMatchObject({ tenantKey: 'tenant', openId: 'user', permissionCeiling: 1 })
    expect(session?.csrfToken).not.toBe(f.csrf)
    expect(result.expiresAt).toBe(f.session.expiresAt)
    expect((await f.claim()).status).toBe(410)
    expect((await f.approve()).status).toBe(410)
  })

  it('rejects incorrect verifiers without consuming the real request', async () => {
    const f = await fixture()
    await f.approve()
    expect((await f.claim(oauthRandomToken())).status).toBe(403)
    expect((await f.claim()).status).toBe(200)
  })

  it('prevents parallel claims from creating two sessions', async () => {
    const f = await fixture()
    await f.approve()
    const claims = await Promise.all([f.claim(), f.claim()])
    expect(claims.map((response) => response.status).sort()).toEqual([200, 410])
  })

  it('requires browser cookie, CSRF and non-Guest identity while accepting privacy-stripped Origin', async () => {
    const f = await fixture()
    expect((await f.approve({}, '')).status).toBe(401)
    expect((await f.approve({}, f.guest)).status).toBe(401)
    expect((await f.approve({ csrf: 'wrong' })).status).toBe(403)
    expect((await f.approve({ csrf: 'wrong' }, f.token, 'https://other.example')).status).toBe(403)
    expect((await f.claim()).status).toBe(202)
    expect((await f.approve({}, f.token, 'null')).status).toBe(200)
  })

  it('expires requests and denies cancelled grants', async () => {
    const f = await fixture()
    expect((await f.approve({ decision: 'deny' })).status).toBe(200)
    const denied = await f.claim()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'PC_LOGIN_DENIED' })
    expect((await f.claim()).status).toBe(410)
    const expired = await fixture()
    expired.advance(300_001)
    expect((await expired.claim()).status).toBe(410)
    expect((await expired.approve()).status).toBe(410)
  })

  it('revalidates the browser session at redemption', async () => {
    const f = await fixture()
    await f.approve()
    await f.store.deleteAuthSession(f.token)
    expect((await f.claim()).status).toBe(401)
    expect((await f.claim()).status).toBe(410)
  })

  it('rejects cross-origin and simple-form initialization, and bounds pending requests', async () => {
    const f = await fixture()
    expect((await f.create({ origin: 'https://other.example' })).status).toBe(403)
    expect((await f.create({ 'content-type': 'text/plain' })).status).toBe(403)
    for (let index = 1; index < 30; index += 1) expect((await f.create()).status).toBe(201)
    expect((await f.create()).status).toBe(429)
    f.advance(60_001)
    expect((await f.create()).status).toBe(201)
  })

  it('only permits the exact PC consent return path', () => {
    const path = `${PC_LOGIN_PATH}/authorize?request=${oauthRandomToken()}`
    expect(isPcLoginReturnPath(path)).toBe(true)
    for (const bad of [
      publicOrigin + path,
      path + '&redirect=https://other.example',
      path + '#x',
      `${PC_LOGIN_PATH}/authorize?request=short`,
    ]) {
      expect(isPcLoginReturnPath(bad)).toBe(false)
    }
  })
})
