import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'

import { authorizationSchemaSql, BOOTSTRAP_OWNER } from './authorization-schema'
import { hashAuthSessionToken } from './auth-session'
import { PostgresStore } from './postgres-store'
import { legacySchemaSql } from './schema'

// Uses an isolated, disposable schema. Never uses DATABASE_URL implicitly.
it.skipIf(!process.env.CUDDLY_PERMISSION_TEST_DATABASE_URL)(
  'migrates existing sessions once and persists transactional permissions',
  async () => {
    const connectionString = process.env.CUDDLY_PERMISSION_TEST_DATABASE_URL
    const schema = `permissions_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const isolatedUrl = new URL(connectionString!)
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`)
    const store = new PostgresStore(isolatedUrl.href)
    const pool = store.pool
    try {
      await pool.query(legacySchemaSql)
      for (const [tenant, openId, token] of [
        ['existing', 'ordinary', 'ordinary'],
        ['bifrost-pc-guest', 'guest', 'guest'],
        [BOOTSTRAP_OWNER.tenantKey, BOOTSTRAP_OWNER.openId, 'owner'],
      ]) {
        await pool.query(
          `INSERT INTO auth_sessions (session_token_hash, tenant_key, open_id, union_id, name, avatar_url, csrf_token, created_at, expires_at)
        VALUES ($1, $2, $3, '', 'Existing user', '', 'csrf', now(), now() + interval '1 day')`,
          [hashAuthSessionToken(token!), tenant, openId]
        )
      }
      // Simulate an installation with the previous combined level-8 policy.
      await pool.query(authorizationSchemaSql.split('DO $permissions_levels_migration$')[0]!)
      await pool.query(
        "INSERT INTO runtime_settings(key, value, updated_by) VALUES ('privacy-test', '{}'::jsonb, 'Legacy private actor')"
      )
      await pool.query(`UPDATE authorization_policy SET requirements = (requirements - 'users.manage') ||
        '{"system.read":{"permissionLevel":8,"roles":[]},"system.manage":{"permissionLevel":8,"roles":[]},"permissions.manage":{"permissionLevel":8,"roles":[]}}'::jsonb`)
      await store.initialize()
      expect(
        (await pool.query("SELECT updated_by FROM runtime_settings WHERE key = 'privacy-test'"))
          .rows[0].updated_by
      ).toBe('history')
      expect(
        (
          await pool.query(
            "SELECT value FROM legacy_actor_values WHERE table_name = 'runtime_settings' AND record_id = 'privacy-test'"
          )
        ).rows[0].value
      ).toBe('Legacy private actor')
      expect(
        (await pool.query("SELECT name FROM auth_sessions WHERE open_id = 'ordinary'")).rows[0].name
      ).toMatch(/^用户-/)
      expect((await store.getAuthorizationPolicy()).requirements).toMatchObject({
        'system.read': { permissionLevel: 4, roles: [] },
        'system.manage': { permissionLevel: 4, roles: [] },
        'permissions.manage': { permissionLevel: 4, roles: [] },
        'users.manage': { permissionLevel: 6, roles: [] },
      })
      const users = await store.listUserAccounts('', 1, 20)
      expect(users.total).toBe(2)
      let owner = users.items.find((user) => user.openId === BOOTSTRAP_OWNER.openId)!
      let ordinary = users.items.find((user) => user.openId === 'ordinary')!
      expect(owner).toMatchObject({ permissionLevel: 8, roles: ['owner', 'administrator'] })
      expect(ordinary).toMatchObject({ permissionLevel: 2, roles: [] })
      expect(await store.getUserAccount((await store.getAuthSession('guest'))!)).toBeNull()

      const ownerSession = (await store.getAuthSession('owner'))!
      const managerSession = (await store.getAuthSession('ordinary'))!
      expect(await store.getOwnPrivateProfile(managerSession)).toBeNull()
      expect(await store.getOwnPrivateProfile({ ...managerSession, kind: 'browser' })).toEqual({
        feishu: { realName: 'Existing user', username: '' },
      })
      expect(await store.listUserAccounts('Existing user', 1, 20)).toMatchObject({ total: 0 })
      ordinary = await store.updateUserPermissions(
        ordinary.id,
        { permissionLevel: 6, roles: [], expectedRevision: ordinary.revision },
        'test',
        ownerSession
      )
      owner = await store.updateUserPermissions(
        owner.id,
        { permissionLevel: 8, roles: ['owner', 'custom'], expectedRevision: owner.revision },
        'test',
        managerSession
      )
      await expect(
        store.updateUserPermissions(
          ordinary.id,
          { permissionLevel: 7, roles: ['administrator'], expectedRevision: ordinary.revision },
          'test',
          managerSession
        )
      ).rejects.toMatchObject({ code: 'PERMISSION_LEVEL_EXCEEDED' })
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT singleton FROM authorization_policy WHERE singleton FOR UPDATE')
        const pending = store.updateUserPermissions(
          owner.id,
          { permissionLevel: 8, roles: ['administrator'], expectedRevision: owner.revision },
          'test',
          managerSession
        )
        const denied = expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        await blocker.query(
          'UPDATE user_accounts SET permission_level = 2, revision = revision + 1 WHERE id = $1',
          [ordinary.id]
        )
        await blocker.query('COMMIT')
        await denied
      } finally {
        blocker.release()
      }
      ordinary = (await store.getUserAccount(managerSession))!

      owner = await store.updateUserPermissions(
        owner.id,
        { permissionLevel: 9, roles: ['owner'], expectedRevision: owner.revision },
        'test'
      )
      ordinary = await store.updateUserPermissions(
        ordinary.id,
        { permissionLevel: 8, roles: [], expectedRevision: ordinary.revision },
        'test'
      )
      await store.initialize()
      expect((await store.listUserAccounts(owner.id, 1, 20)).items[0]).toMatchObject({
        permissionLevel: 9,
        roles: ['owner'],
        revision: owner.revision,
      })
      expect(
        (await pool.query('SELECT count(*) FROM authorization_migrations')).rows[0].count
      ).toBe('3')
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM audit_events WHERE action = 'permissions.bootstrap'"
          )
        ).rows[0].count
      ).toBe('1')
      await expect(
        store.updateUserPermissions(
          owner.id,
          { permissionLevel: 9, roles: [], expectedRevision: owner.revision - 1 },
          'test'
        )
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

      const demotions = await Promise.allSettled(
        [owner, ordinary].map((user) =>
          store.updateUserPermissions(
            user.id,
            { permissionLevel: 2, roles: [], expectedRevision: user.revision },
            'test'
          )
        )
      )
      expect(demotions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(demotions.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'LAST_PERMISSION_MANAGER' },
      })

      const { revision, ...policy } = await store.getAuthorizationPolicy()
      await store.saveAuthorizationPolicy(
        { ...policy, expectedRevision: revision, defaultUserPermissionLevel: 1 },
        'test'
      )
      await store.initialize()
      expect(await store.getAuthorizationPolicy()).toMatchObject({
        revision: revision + 1,
        defaultUserPermissionLevel: 1,
      })
      await expect(
        store.saveAuthorizationPolicy({ ...policy, expectedRevision: revision }, 'test')
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      const session = await store.createAuthSession({
        token: 'new-user',
        tenantKey: 'new',
        openId: 'new',
        unionId: '',
        name: 'New',
        avatarUrl: '',
        csrfToken: 'csrf',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      expect(await store.getUserAccount(session)).toMatchObject({ permissionLevel: 1, roles: [] })
      const freshUser = (await store.getUserAccount(session))!
      expect(freshUser.displayName).toBe(`用户-${freshUser.id}`)
      await store.updateOwnProfile(session, 'Public database user')
      await store.syncUserIdentity({ ...session, name: 'New private name' })
      expect(await store.getAuthSession('new-user')).toMatchObject({
        name: 'Public database user',
        userId: freshUser.id,
      })
      expect(await store.getOwnPrivateProfile({ ...session, kind: 'browser' })).toEqual({
        feishu: { realName: 'New private name' },
      })
      expect(await store.getOwnPrivateProfile({ ...session, kind: 'mcp' })).toBeNull()
      expect(await store.listUserAccounts('New private name', 1, 20)).toMatchObject({ total: 0 })
      await store.initialize()
      expect((await store.getUserAccount(session))?.displayName).toBe('Public database user')
      await store.limitAuthSession('new-user', 1)
      await store.limitAuthSession('new-user', 0)
      await store.limitAuthSession('new-user', 8)
      expect(await store.getAuthSession('new-user')).toMatchObject({ permissionCeiling: 0 })
      expect(
        (await pool.query("SELECT count(*) FROM audit_events WHERE subject_type = 'authorization'"))
          .rows[0].count
      ).toBe('6')
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
  30_000
)
