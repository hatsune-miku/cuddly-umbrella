import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

import {
  authorizationPolicySchema,
  permissionRequirementSchema,
  permissionLevelSchema,
  saveAuthorizationPolicySchema,
  updateUserPermissionsSchema,
  USER_MANAGEMENT,
  PERMISSION_MANAGEMENT,
  type AuthorizationPolicy,
  type SaveAuthorizationPolicy,
  type UpdateUserPermissions,
  type UserAccount,
} from '@cuddly/contracts'

import { hashAuthSessionToken } from './auth-session'
import { defaultDisplayName } from './public-identity'
import { privateProfileSchema, updateOwnProfileSchema } from '@cuddly/contracts'
import { assertPermissionMutation } from './authorization-guards'
import { AuthorizationUpdateError, type AuthSession, type UserPage } from './store'

function mapUser(row: QueryResultRow): UserAccount {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    openId: row.open_id,
    username: row.username_source === 'bifrost' ? row.username : '',
    name: row.display_name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    ...permissionRequirementSchema.parse({
      permissionLevel: Number(row.permission_level),
      roles: row.roles,
    }),
    revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function mapPolicy(row: QueryResultRow): AuthorizationPolicy {
  return authorizationPolicySchema.parse({
    revision: Number(row.revision),
    defaultUserPermissionLevel: Number(row.default_user_permission_level),
    requirements: row.requirements,
  })
}

async function audit(
  client: PoolClient,
  actor: string,
  action: string,
  subject: string,
  payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
     VALUES ($1, $2, $3, 'authorization', $4, $5::jsonb)`,
    [randomUUID(), actor, action, subject, JSON.stringify(payload)]
  )
}

export class PostgresAuthorization {
  constructor(private readonly pool: Pool) {}

  async getUserAccount(session: AuthSession): Promise<UserAccount | null> {
    if (session.tenantKey === 'bifrost-pc-guest') return null
    const existing = await this.pool.query(
      'SELECT * FROM user_accounts WHERE tenant_key = $1 AND open_id = $2',
      [session.tenantKey, session.openId]
    )
    if (existing.rows[0]) return mapUser(existing.rows[0])
    const id = randomUUID()
    const inserted = await this.pool.query(
      `INSERT INTO user_accounts (id, tenant_key, open_id, name, display_name, avatar_url, permission_level)
       SELECT $1, $2, $3, $4, $4, $5, default_user_permission_level FROM authorization_policy WHERE singleton
       ON CONFLICT (tenant_key, open_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [id, session.tenantKey, session.openId, defaultDisplayName(id), session.avatarUrl]
    )
    if (!inserted.rows[0]) throw new Error('Authorization policy is missing')
    await this.pool.query(
      `INSERT INTO user_private_profiles(user_id, fields) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING`,
      [inserted.rows[0].id, JSON.stringify({ feishu: { realName: session.name } })]
    )
    return mapUser(inserted.rows[0])
  }

  async listUserAccounts(query: string, page: number, pageSize: number): Promise<UserPage> {
    const escaped = query.replace(/[\\%_]/g, '\\$&')
    const parameters = [`%${escaped}%`]
    const filter = `(display_name ILIKE $1 OR (username_source = 'bifrost' AND username ILIKE $1) OR open_id ILIKE $1 OR id::text ILIKE $1)`
    const count = await this.pool.query(
      `SELECT count(*) AS total FROM user_accounts WHERE ${filter}`,
      parameters
    )
    const result = await this.pool.query(
      `SELECT * FROM user_accounts WHERE ${filter} ORDER BY display_name, id LIMIT $2 OFFSET $3`,
      [...parameters, pageSize, (page - 1) * pageSize]
    )
    return {
      items: result.rows.map(mapUser),
      total: Number(count.rows[0]?.total || 0),
      page,
      pageSize,
    }
  }

  async syncUserIdentity(session: AuthSession) {
    const user = await this.getUserAccount(session)
    if (!user) return null
    await this.pool.query(
      `INSERT INTO user_private_profiles(user_id, fields) VALUES ($1, $2::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET fields = jsonb_set(user_private_profiles.fields, '{feishu,realName}', $3::jsonb), updated_at = now()`,
      [
        user.id,
        JSON.stringify({ feishu: { realName: session.name } }),
        JSON.stringify(session.name),
      ]
    )
    await this.pool.query('UPDATE user_accounts SET avatar_url = $2 WHERE id = $1', [
      user.id,
      session.avatarUrl,
    ])
    return { ...user, avatarUrl: session.avatarUrl }
  }

  async updateOwnProfile(session: AuthSession, displayName: string) {
    const input = updateOwnProfileSchema.parse({ displayName })
    const user = await this.getUserAccount(session)
    if (!user) throw new AuthorizationUpdateError('USER_NOT_FOUND')
    const result = await this.pool.query(
      `UPDATE user_accounts SET display_name = $2, name = $2,
      revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [user.id, input.displayName]
    )
    return mapUser(result.rows[0])
  }

  async getOwnPrivateProfile(session: AuthSession) {
    if (session.kind !== 'browser') return null
    const user = await this.getUserAccount(session)
    if (!user) return null
    const result = await this.pool.query(
      'SELECT fields FROM user_private_profiles WHERE user_id = $1',
      [user.id]
    )
    return privateProfileSchema.parse(result.rows[0]?.fields || { feishu: { realName: '' } })
  }

  async getPublicActorNames(ids: string[]): Promise<Record<string, string>> {
    const result = await this.pool.query(
      'SELECT id, display_name FROM user_accounts WHERE id = ANY($1::uuid[])',
      [ids]
    )
    return Object.fromEntries(result.rows.map((row) => [row.id, row.display_name]))
  }

  async updateUserPermissions(
    id: string,
    value: UpdateUserPermissions,
    actor: string,
    actorSession?: AuthSession
  ): Promise<UserAccount> {
    const input = updateUserPermissionsSchema.parse(value)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize manager demotions, including two concurrent attempts to remove the last managers.
      await client.query('SELECT singleton FROM authorization_policy WHERE singleton FOR UPDATE')
      const result = await client.query('SELECT * FROM user_accounts WHERE id = $1 FOR UPDATE', [
        id,
      ])
      if (!result.rows[0]) throw new AuthorizationUpdateError('USER_NOT_FOUND')
      const before = mapUser(result.rows[0])
      if (actorSession) {
        const operator = await client.query(
          'SELECT * FROM user_accounts WHERE tenant_key = $1 AND open_id = $2 FOR UPDATE',
          [actorSession.tenantKey, actorSession.openId]
        )
        assertPermissionMutation(
          operator.rows[0] ? mapUser(operator.rows[0]) : null,
          actorSession,
          USER_MANAGEMENT.permissionLevel,
          before.permissionLevel,
          input.permissionLevel
        )
      }
      if (before.revision !== input.expectedRevision)
        throw new AuthorizationUpdateError('REVISION_CONFLICT')
      if (
        before.permissionLevel >= USER_MANAGEMENT.permissionLevel &&
        input.permissionLevel < USER_MANAGEMENT.permissionLevel
      ) {
        const managers = await client.query(
          'SELECT count(*) AS total FROM user_accounts WHERE permission_level >= $1',
          [USER_MANAGEMENT.permissionLevel]
        )
        if (Number(managers.rows[0]?.total) <= 1)
          throw new AuthorizationUpdateError('LAST_PERMISSION_MANAGER')
      }
      const saved = await client.query(
        `UPDATE user_accounts SET permission_level = $2, roles = $3::jsonb,
         revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, input.permissionLevel, JSON.stringify(input.roles)]
      )
      const after = mapUser(saved.rows[0]!)
      await audit(client, actor, 'user.permissions.update', id, {
        before: { permissionLevel: before.permissionLevel, roles: before.roles },
        after: { permissionLevel: after.permissionLevel, roles: after.roles },
      })
      await client.query('COMMIT')
      return after
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getAuthorizationPolicy(): Promise<AuthorizationPolicy> {
    const result = await this.pool.query('SELECT * FROM authorization_policy WHERE singleton')
    if (!result.rows[0]) throw new Error('Authorization policy is missing')
    return mapPolicy(result.rows[0])
  }

  async saveAuthorizationPolicy(
    value: SaveAuthorizationPolicy,
    actor: string,
    actorSession?: AuthSession
  ): Promise<AuthorizationPolicy> {
    const input = saveAuthorizationPolicySchema.parse(value)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        'SELECT * FROM authorization_policy WHERE singleton FOR UPDATE'
      )
      const before = mapPolicy(current.rows[0]!)
      if (actorSession) {
        const operator = await client.query(
          'SELECT * FROM user_accounts WHERE tenant_key = $1 AND open_id = $2 FOR UPDATE',
          [actorSession.tenantKey, actorSession.openId]
        )
        assertPermissionMutation(
          operator.rows[0] ? mapUser(operator.rows[0]) : null,
          actorSession,
          PERMISSION_MANAGEMENT.permissionLevel,
          before.defaultUserPermissionLevel,
          input.defaultUserPermissionLevel
        )
      }
      if (before.revision !== input.expectedRevision)
        throw new AuthorizationUpdateError('REVISION_CONFLICT')
      const saved = await client.query(
        `UPDATE authorization_policy SET default_user_permission_level = $1, requirements = $2::jsonb,
         revision = revision + 1, updated_at = now() WHERE singleton RETURNING *`,
        [input.defaultUserPermissionLevel, JSON.stringify(input.requirements)]
      )
      const after = mapPolicy(saved.rows[0]!)
      await audit(client, actor, 'authorization.policy.update', 'policy', { before, after })
      await client.query('COMMIT')
      return after
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async limitAuthSession(token: string, ceiling: number): Promise<void> {
    permissionLevelSchema.parse(ceiling)
    await this.pool.query(
      `UPDATE auth_sessions SET permission_ceiling = LEAST(COALESCE(permission_ceiling, $2), $2)
       WHERE session_token_hash = $1`,
      [hashAuthSessionToken(token), ceiling]
    )
  }
}
