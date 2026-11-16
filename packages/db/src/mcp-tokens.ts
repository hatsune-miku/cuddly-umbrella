import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, QueryResultRow } from 'pg'
import {
  createMcpPersonalTokenSchema,
  mcpPersonalTokenPattern,
  type McpPersonalToken,
  type UserAccount,
} from '@cuddly/contracts'
import type { AuthSession } from './store'
import { hashAuthSessionToken } from './auth-session'

export const mcpTokensSchemaSql = `
CREATE TABLE IF NOT EXISTS mcp_personal_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_personal_tokens_owner_idx ON mcp_personal_tokens(user_id, created_at DESC) WHERE revoked_at IS NULL;
`

export function newMcpToken(name: string, now = Date.now()) {
  const input = createMcpPersonalTokenSchema.parse({ name })
  const token = `bfpat_${randomBytes(32).toString('base64url')}`
  const item: McpPersonalToken = {
    id: randomUUID(),
    name: input.name,
    prefix: token.slice(0, 14),
    createdAt: new Date(now).toISOString(),
    lastUsedAt: null,
  }
  return { token, item, hash: hashAuthSessionToken(token) }
}

export function mcpTokenSession(
  user: Pick<UserAccount, 'id' | 'tenantKey' | 'openId' | 'displayName' | 'avatarUrl'>,
  createdAt: string
): AuthSession {
  return {
    kind: 'mcp-token',
    userId: user.id,
    tenantKey: user.tenantKey,
    openId: user.openId,
    unionId: '',
    name: user.displayName,
    avatarUrl: user.avatarUrl,
    csrfToken: '',
    createdAt,
    expiresAt: '9999-12-31T23:59:59.999Z',
  }
}

function mapToken(row: QueryResultRow): McpPersonalToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }
}

export class McpTokenLimitError extends Error {}

export class PostgresMcpTokens {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, name: string) {
    const generated = newMcpToken(name)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM user_accounts WHERE id = $1 FOR UPDATE', [userId])
      const count = await client.query(
        'SELECT count(*) FROM mcp_personal_tokens WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      )
      if (Number(count.rows[0].count) >= 20)
        throw new McpTokenLimitError('最多保留 20 个 Token，请先撤销不再使用的 Token')
      await client.query(
        'INSERT INTO mcp_personal_tokens(id, user_id, name, token_hash, prefix, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          generated.item.id,
          userId,
          generated.item.name,
          generated.hash,
          generated.item.prefix,
          generated.item.createdAt,
        ]
      )
      await client.query('COMMIT')
      return { token: generated.token, item: generated.item }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async list(userId: string) {
    const result = await this.pool.query(
      'SELECT id, name, prefix, created_at, last_used_at FROM mcp_personal_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id',
      [userId]
    )
    return result.rows.map(mapToken)
  }

  async revoke(userId: string, id: string) {
    const result = await this.pool.query(
      'UPDATE mcp_personal_tokens SET revoked_at = now() WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL',
      [userId, id]
    )
    return (result.rowCount || 0) > 0
  }

  async resolve(token: string): Promise<AuthSession | null> {
    if (!mcpPersonalTokenPattern.test(token)) return null
    const hash = hashAuthSessionToken(token)
    const result = await this.pool.query(
      `SELECT u.id, u.tenant_key, u.open_id, u.display_name, u.avatar_url, t.created_at FROM mcp_personal_tokens t
      JOIN user_accounts u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [hash]
    )
    const row = result.rows[0]
    if (!row) return null
    await this.pool.query(
      `UPDATE mcp_personal_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [hash]
    )
    return mcpTokenSession(
      {
        id: row.id,
        tenantKey: row.tenant_key,
        openId: row.open_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
      new Date(row.created_at).toISOString()
    )
  }
}
