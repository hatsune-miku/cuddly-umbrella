import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MemoryStore } from '@cuddly/db'
import { afterEach, describe, expect, it } from 'vitest'

import { createControlApp } from './app'
import { FeishuOAuthClient, oauthRandomToken } from './auth'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function fixture() {
  const store = new MemoryStore()
  const owner = (await store.listUserAccounts('', 1, 20)).items.find((user) =>
    user.roles.includes('owner')
  )!
  async function login(
    identity = { tenantKey: 'test', openId: oauthRandomToken(), name: 'User' },
    permissionCeiling?: number
  ) {
    const token = oauthRandomToken()
    const session = await store.createAuthSession({
      ...identity,
      token,
      unionId: '',
      avatarUrl: '',
      csrfToken: oauthRandomToken(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ...(permissionCeiling === undefined ? {} : { permissionCeiling }),
    })
    return { token, session, user: (await store.getUserAccount(session))! }
  }
  const admin = await login(owner)
  const ordinary = await login()
  const server = createControlApp({
    store,
    internalApiToken: 'fixture-internal-token',
    settingsSecret: 'fixture-settings-secret',
    auth: {
      publicOrigin: 'https://bifrost.example.test',
      client: new FeishuOAuthClient({
        appId: 'fixture',
        appSecret: 'fixture',
        redirectUri: 'https://bifrost.example.test/api/v1/auth/feishu/callback',
      }),
    },
  }).listen(0)
  servers.push(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function request(
    path: string,
    identity: typeof admin | null = ordinary,
    method = 'GET',
    body?: unknown,
    csrf = true
  ) {
    return fetch(origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(identity
          ? {
              authorization: `Bearer ${identity.token}`,
              ...(csrf ? { 'x-cuddly-csrf': identity.session.csrfToken } : {}),
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  return { store, owner, admin, ordinary, login, request }
}

describe('server-side permission enforcement', () => {
  it('separates level-4 system settings from level-6 user management', async () => {
    const f = await fixture()
    await f.store.updateUserPermissions(
      f.ordinary.user.id,
      { permissionLevel: 4, roles: [], expectedRevision: 1 },
      'test'
    )
    expect((await f.request('/api/v1/admin/system-settings')).status).toBe(200)
    expect((await f.request('/api/v1/admin/permissions')).status).toBe(200)
    expect((await f.request('/api/v1/admin/users')).status).toBe(403)
    await f.store.updateUserPermissions(
      f.ordinary.user.id,
      { permissionLevel: 6, roles: [], expectedRevision: 2 },
      'test'
    )
    expect((await f.request('/api/v1/admin/users')).status).toBe(200)
  })

  it('allows level-6 managers to assign any roles, but never levels above themselves', async () => {
    const f = await fixture()
    const manager = await f.store.updateUserPermissions(
      f.ordinary.user.id,
      { permissionLevel: 6, roles: [], expectedRevision: 1 },
      'test'
    )
    const target = await f.login()
    const targetPath = `/api/v1/admin/users/${target.user.id}`
    const granted = await f.request(targetPath, f.ordinary, 'PATCH', {
      permissionLevel: 6,
      roles: ['owner', 'administrator', 'new-user'],
      expectedRevision: 1,
    })
    expect(granted.status).toBe(200)
    expect(await granted.json()).toMatchObject({
      permissionLevel: 6,
      roles: ['owner', 'administrator', 'new-user'],
    })
    const rejected = await f.request(targetPath, f.ordinary, 'PATCH', {
      permissionLevel: 7,
      roles: [],
      expectedRevision: 2,
    })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ code: 'PERMISSION_LEVEL_EXCEEDED' })
    expect(
      (
        await f.request(`/api/v1/admin/users/${manager.id}`, f.ordinary, 'PATCH', {
          permissionLevel: 7,
          roles: ['owner'],
          expectedRevision: manager.revision,
        })
      ).status
    ).toBe(403)
    // A role edit is permitted even if the target's unchanged level is higher than the actor's.
    const ownerPath = `/api/v1/admin/users/${f.owner.id}`
    const roleEdit = await f.request(ownerPath, f.ordinary, 'PATCH', {
      permissionLevel: 8,
      roles: ['owner', 'custom-role'],
      expectedRevision: f.owner.revision,
    })
    expect(roleEdit.status).toBe(200)
    const updatedOwner = (await roleEdit.json()) as { revision: number }
    expect(
      (
        await f.request(ownerPath, f.ordinary, 'PATCH', {
          permissionLevel: 7,
          roles: [],
          expectedRevision: updatedOwner.revision,
        })
      ).status
    ).toBe(403)
    expect(
      (
        await f.request(ownerPath, f.ordinary, 'PATCH', {
          permissionLevel: 6,
          roles: ['administrator'],
          expectedRevision: updatedOwner.revision,
        })
      ).status
    ).toBe(200)
    const removedRoles = await f.request(targetPath, f.ordinary, 'PATCH', {
      permissionLevel: 6,
      roles: [],
      expectedRevision: 2,
    })
    expect(removedRoles.status).toBe(200)
    expect(await removedRoles.json()).toMatchObject({ roles: [] })
  })

  it('uses the effective OAuth ceiling and prevents bypass through new-user defaults', async () => {
    const f = await fixture()
    const delegated = await f.login(f.owner, 6)
    expect(
      (
        await f.request(`/api/v1/admin/users/${f.ordinary.user.id}`, delegated, 'PATCH', {
          permissionLevel: 7,
          roles: ['owner'],
          expectedRevision: 1,
        })
      ).status
    ).toBe(403)
    const { revision, ...policy } = await f.store.getAuthorizationPolicy()
    expect(
      (
        await f.request('/api/v1/admin/permissions', delegated, 'PUT', {
          ...policy,
          expectedRevision: revision,
          defaultUserPermissionLevel: 7,
        })
      ).status
    ).toBe(403)
    expect(
      (
        await f.request('/api/v1/admin/permissions', delegated, 'PUT', {
          ...policy,
          expectedRevision: revision,
          defaultUserPermissionLevel: 6,
        })
      ).status
    ).toBe(200)
  })

  it.each(['owner', 'administrator'])('denies a level-9 feature to level-8 %s', async (role) => {
    const f = await fixture()
    await f.store.updateUserPermissions(
      f.ordinary.user.id,
      { permissionLevel: 8, roles: [role], expectedRevision: 1 },
      'test'
    )
    const { revision, ...policy } = await f.store.getAuthorizationPolicy()
    policy.requirements['build.read'] = { permissionLevel: 9, roles: ['some-other-role'] }
    await f.store.saveAuthorizationPolicy({ ...policy, expectedRevision: revision }, 'test')
    const denied = await f.request('/api/v1/build-queue')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      reason: 'permissionLevel',
      required: { permissionLevel: 9 },
    })
  })
  it('gives visitors level zero and allows a feature made public without login', async () => {
    const f = await fixture()
    expect(await (await f.request('/api/v1/auth/session', null)).json()).toMatchObject({
      authenticated: false,
      permissionLevel: 0,
      roles: [],
    })
    expect((await f.request('/api/v1/build-queue', null)).status).toBe(401)
    const { revision, ...policy } = await f.store.getAuthorizationPolicy()
    policy.requirements['build.read'].permissionLevel = 0
    await f.store.saveAuthorizationPolicy({ ...policy, expectedRevision: revision }, 'test')
    expect((await f.request('/api/v1/build-queue', null)).status).toBe(200)
  })

  it('requires every role even at high levels; special roles never bypass levels', async () => {
    const f = await fixture()
    const { revision, ...policy } = await f.store.getAuthorizationPolicy()
    policy.requirements['build.read'] = { permissionLevel: 1, roles: ['new-user', 'qa'] }
    await f.store.saveAuthorizationPolicy({ ...policy, expectedRevision: revision }, 'test')
    let user = await f.store.updateUserPermissions(
      f.ordinary.user.id,
      { expectedRevision: 1, permissionLevel: 9, roles: ['qa'] },
      'test'
    )
    expect(await (await f.request('/api/v1/build-queue')).json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'roles',
    })
    user = await f.store.updateUserPermissions(
      user.id,
      { expectedRevision: user.revision, permissionLevel: 9, roles: ['new-user', 'qa'] },
      'test'
    )
    expect((await f.request('/api/v1/build-queue')).status).toBe(200)
    for (const role of ['owner', 'administrator']) {
      user = await f.store.updateUserPermissions(
        user.id,
        { expectedRevision: user.revision, permissionLevel: 1, roles: [role] },
        'test'
      )
      expect((await f.request('/api/v1/build-queue')).status).toBe(200)
      expect((await f.request('/api/v1/admin/users')).status).toBe(403)
    }
  })

  it('edits users through management with CSRF, revision and last-manager safeguards', async () => {
    const f = await fixture()
    expect((await f.request('/api/v1/admin/users')).status).toBe(403)
    const path = `/api/v1/admin/users/${f.ordinary.user.id}`
    const input = { permissionLevel: 0, roles: ['new-user'], expectedRevision: 1 }
    expect((await f.request(path, f.admin, 'PATCH', input, false)).status).toBe(403)
    expect((await f.request(path, f.admin, 'PATCH', input)).status).toBe(200)
    expect((await f.request(path, f.admin, 'PATCH', input)).status).toBe(409)
    expect((await f.request('/api/v1/build-queue')).status).toBe(403)
    expect(await (await f.request('/api/v1/auth/session')).json()).toMatchObject({
      permissionLevel: 0,
      roles: ['new-user'],
    })
    const last = await f.request(`/api/v1/admin/users/${f.owner.id}`, f.admin, 'PATCH', {
      ...input,
      roles: [],
      expectedRevision: f.owner.revision,
    })
    expect(await last.json()).toMatchObject({ code: 'LAST_PERMISSION_MANAGER' })
    const search = await f.request(`/api/v1/admin/users?query=${f.admin.user.id}`, f.admin)
    expect(await search.json()).toMatchObject({
      total: 1,
      items: [{ username: '', permissionLevel: 8, roles: ['owner', 'administrator'] }],
    })
  })

  it('validates policy, keeps management fixed and applies new defaults only to new users', async () => {
    const f = await fixture()
    const { revision, ...policy } = await f.store.getAuthorizationPolicy()
    const input = { ...policy, expectedRevision: revision, defaultUserPermissionLevel: 1 }
    expect((await f.request('/api/v1/admin/permissions', f.admin, 'PUT', input)).status).toBe(200)
    expect((await f.login()).user.permissionLevel).toBe(1)
    expect((await f.store.getUserAccount(f.ordinary.session))!.permissionLevel).toBe(2)
    input.requirements['permissions.manage'].permissionLevel = 0
    expect(
      (
        await f.request('/api/v1/admin/permissions', f.admin, 'PUT', {
          ...input,
          expectedRevision: 2,
        })
      ).status
    ).toBe(400)
    expect(
      (
        await f.request(`/api/v1/admin/users/${f.ordinary.user.id}`, f.admin, 'PATCH', {
          permissionLevel: -1,
          roles: [],
          expectedRevision: 1,
        })
      ).status
    ).toBe(400)
  })

  it('never lets delegated sessions exceed consent, even after an account upgrade', async () => {
    const f = await fixture()
    const delegated = await f.login(f.owner, 1)
    expect(await (await f.request('/api/v1/auth/session', delegated)).json()).toMatchObject({
      permissionLevel: 1,
      roles: ['owner', 'administrator'],
    })
    expect((await f.request('/api/v1/admin/users', delegated)).status).toBe(403)
    await f.store.limitAuthSession(delegated.token, 0)
    await f.store.limitAuthSession(delegated.token, 8)
    expect((await f.request('/api/v1/build-queue', delegated)).status).toBe(403)
  })
})
