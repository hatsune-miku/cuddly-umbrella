import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, publicIdentityData, type AuthSession } from '@cuddly/db'
import { createControlApp } from './app'
import { FeishuOAuthClient } from './auth'

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
  async function login(
    name: string,
    kind: AuthSession['kind'] = 'browser',
    openId: string = randomUUID()
  ) {
    const token: string = randomUUID()
    const session = await store.createAuthSession({
      token,
      kind,
      tenantKey: 'privacy-test',
      openId,
      unionId: '',
      name,
      avatarUrl: 'https://example.test/avatar',
      csrfToken: randomUUID(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
    return { token, session, user: (await store.getUserAccount(session))! }
  }
  const alice = await login('Alice Private Real Name')
  const bob = await login('Bob Private Real Name')
  await store.updateUserPermissions(
    alice.user.id,
    { permissionLevel: 0, roles: [], expectedRevision: alice.user.revision },
    'test'
  )
  await store.updateUserPermissions(
    bob.user.id,
    {
      permissionLevel: 999,
      roles: ['owner', 'administrator'],
      expectedRevision: bob.user.revision,
    },
    'test'
  )
  const server = createControlApp({
    store,
    settingsSecret: 'test',
    internalApiToken: 'internal-test',
    auth: {
      publicOrigin: 'https://bifrost.test',
      client: new FeishuOAuthClient({
        appId: 'fake',
        appSecret: 'fake',
        redirectUri: 'https://bifrost.test/callback',
      }),
    },
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function request(
    path: string,
    who: typeof alice | null = alice,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    return fetch(origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(who
          ? { cookie: `cuddly_session=${who.token}`, 'x-cuddly-csrf': who.session.csrfToken }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  return { store, alice, bob, login, request }
}

describe('public profiles and owner-only privacy', () => {
  it('allows level zero to change only their own public name without changing identity or private profile', async () => {
    const f = await fixture()
    const response = await f.request('/api/v1/me', f.alice, 'PATCH', {
      displayName: '  Public Alice  ',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: f.alice.user.id,
      name: 'Public Alice',
      displayName: 'Public Alice',
      permissionLevel: 0,
    })
    expect(await f.store.getAuthSession(f.alice.token)).toMatchObject({
      userId: f.alice.user.id,
      name: 'Public Alice',
    })
    expect(await (await f.request('/api/v1/me/private-profile')).json()).toEqual({
      feishu: { realName: 'Alice Private Real Name' },
    })
    for (const input of [
      { displayName: '' },
      { displayName: 'x'.repeat(81) },
      { displayName: 'x\ny' },
      { displayName: 'x', userId: f.bob.user.id },
      { displayName: 'x', privateProfile: {} },
    ]) {
      expect((await f.request('/api/v1/me', f.alice, 'PATCH', input)).status).toBe(400)
    }
    expect(
      (
        await f.request(
          '/api/v1/me',
          f.alice,
          'PATCH',
          { displayName: 'x' },
          { 'x-cuddly-csrf': 'bad' }
        )
      ).status
    ).toBe(403)
    expect((await f.request('/api/v1/me', null, 'PATCH', { displayName: 'x' })).status).toBe(401)
  })

  it('never grants an administrator access to another user private profile', async () => {
    const f = await fixture()
    const response = await f.request('/api/v1/me/private-profile', f.bob)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ feishu: { realName: 'Bob Private Real Name' } })
    for (const path of [
      `/api/v1/me/private-profile?userId=${f.alice.user.id}`,
      `/api/v1/admin/users/${f.alice.user.id}/private-profile`,
      `/api/v1/users/${f.alice.user.id}/private-profile`,
    ]) {
      const denied = await f.request(path, f.bob)
      expect(denied.status).toBeGreaterThanOrEqual(400)
      expect(await denied.text()).not.toContain('Alice Private Real Name')
    }
    expect(
      (
        await f.request('/api/v1/me/private-profile', f.alice, 'GET', undefined, {
          authorization: `Bearer ${f.alice.token}`,
        })
      ).status
    ).toBe(401)
  })

  it.each(['mcp', 'pc', 'legacy'] as const)(
    'does not let a %s credential masquerade as an interactive browser',
    async (kind) => {
      const f = await fixture()
      const session = await f.login('Alice Private Real Name', kind, f.alice.session.openId)
      expect((await f.request('/api/v1/me/private-profile', session)).status).toBe(403)
      expect(await f.store.getOwnPrivateProfile(session.session)).toBeNull()
    }
  )

  it('keeps real names out of session, admin search, actor outputs and OAuth refresh', async () => {
    const f = await fixture()
    expect(f.alice.user.displayName).toBe(`用户-${f.alice.user.id}`)
    for (const path of ['/api/v1/auth/session', '/api/v1/me', '/api/v1/admin/users']) {
      const response = await f.request(path, f.bob)
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toContain('Private Real Name')
      expect(body).not.toContain('realName')
    }
    expect(
      await (await f.request('/api/v1/admin/users?query=Private%20Real%20Name', f.bob)).json()
    ).toMatchObject({ total: 0, items: [] })
    await f.store.updateOwnProfile(f.alice.session, 'Public Alice')
    await f.store.syncUserIdentity({ ...f.alice.session, name: 'Alice New Private Name' })
    expect((await f.store.getAuthSession(f.alice.token))?.name).toBe('Public Alice')
    expect(await f.store.getOwnPrivateProfile(f.alice.session)).toEqual({
      feishu: { realName: 'Alice New Private Name' },
    })
    expect(
      await publicIdentityData(f.store, {
        requestedBy: `user:${f.alice.user.id}`,
        nested: {
          createdBy: 'Alice Private Real Name',
          autoSslEmail: 'not-for-display@example.test',
        },
      })
    ).toEqual({
      requestedBy: 'Public Alice',
      requestedById: f.alice.user.id,
      nested: { createdBy: '历史用户', createdById: null },
    })
    await f.store.updateOwnProfile(f.alice.session, 'Renamed')
    expect(
      await publicIdentityData(f.store, { createdBy: `user:${f.alice.user.id}` })
    ).toMatchObject({ createdBy: 'Renamed', createdById: f.alice.user.id })
  })

  it('denies Guest profile access and projects only explicitly registered private fields', async () => {
    const f = await fixture()
    const guest = await f.store.createAuthSession({
      ...f.alice.session,
      token: 'guest',
      tenantKey: 'bifrost-pc-guest',
    })
    const identity = { ...f.alice, token: 'guest', session: guest }
    expect(
      (await f.request('/api/v1/me', identity, 'PATCH', { displayName: 'Guest name' })).status
    ).toBe(401)
    expect((await f.request('/api/v1/me/private-profile', identity)).status).toBe(403)
    const privateMap = (f.store as unknown as { privateProfiles: Map<string, unknown> })
      .privateProfiles
    privateMap.set(f.alice.user.id, {
      feishu: {
        realName: 'Alice Private Real Name',
        username: 'provider-username',
        email: 'unused@example.test',
        futurePrivate: 'not-reviewed',
      },
      futureSecret: 'not-reviewed',
    })
    expect(await (await f.request('/api/v1/me/private-profile')).json()).toEqual({
      feishu: { realName: 'Alice Private Real Name', username: 'provider-username' },
    })
  })
})
