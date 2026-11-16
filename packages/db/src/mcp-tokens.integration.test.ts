import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { PostgresStore } from './postgres-store'
import { hashAuthSessionToken } from './auth-session'

it.skipIf(!process.env.CUDDLY_PERMISSION_TEST_DATABASE_URL)(
  'persists personal tokens independently of sessions and across store restarts',
  async () => {
    const connectionString = process.env.CUDDLY_PERMISSION_TEST_DATABASE_URL!
    const schema = `mcp_tokens_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const store = new PostgresStore(url.href)
    const reopened = new PostgresStore(url.href)
    try {
      await store.initialize()
      const session = await store.createAuthSession({
        kind: 'browser',
        token: 'browser-fixture',
        tenantKey: 'test',
        openId: 'user',
        unionId: '',
        name: 'Private provider name',
        avatarUrl: '',
        csrfToken: 'csrf',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      })
      const generated = await store.createMcpPersonalToken(session, 'Persistent test')
      const row = (
        await store.pool.query('SELECT * FROM mcp_personal_tokens WHERE id = $1', [
          generated.item.id,
        ])
      ).rows[0]
      expect(row.token_hash).toBe(hashAuthSessionToken(generated.token))
      expect(JSON.stringify(row)).not.toContain(generated.token)
      await store.deleteAuthSession('browser-fixture')
      await reopened.initialize()
      expect(await reopened.getMcpTokenSession(generated.token)).toMatchObject({
        kind: 'mcp-token',
        userId: session.userId,
      })
      await reopened.updateOwnProfile(session, 'Changed public name')
      expect(await store.getMcpTokenSession(generated.token)).toMatchObject({
        name: 'Changed public name',
      })
      expect((await reopened.listMcpPersonalTokens(session))[0]?.lastUsedAt).not.toBeNull()
      const other = await store.createAuthSession({
        ...session,
        token: 'other-fixture',
        openId: 'other',
      })
      expect(await reopened.revokeMcpPersonalToken(other, generated.item.id)).toBe(false)
      const attempts = await Promise.allSettled(
        Array.from({ length: 21 }, (_, i) =>
          reopened.createMcpPersonalToken(session, `Concurrent ${i}`)
        )
      )
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(19)
      expect(await store.listMcpPersonalTokens(session)).toHaveLength(20)
      expect(await store.revokeMcpPersonalToken(session, generated.item.id)).toBe(true)
      expect(await reopened.getMcpTokenSession(generated.token)).toBeNull()
      expect(await reopened.getAuthSession(generated.token)).toBeNull()
      await expect(
        reopened.createMcpPersonalToken({ ...session, kind: 'mcp-token' }, 'forbidden')
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await reopened.initialize()
      expect(await store.getMcpTokenSession(generated.token)).toBeNull()
    } finally {
      await store.close()
      await reopened.close()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
  60000
)
