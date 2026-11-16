import { defaultAuthorizationPolicy } from '@cuddly/contracts'

// Verified against the existing Bifrost Feishu session. Never bootstrap by a mutable display name.
export const BOOTSTRAP_OWNER = {
  tenantKey: '2d520188228f175d',
  openId: 'ou_b90387bbc052a050b857a68ed5d68b54',
  username: 'guanzhen',
  name: '关镇',
} as const

const initialRequirements = JSON.stringify(defaultAuthorizationPolicy().requirements).replaceAll(
  "'",
  "''"
)

export const authorizationSchemaSql = `
CREATE TABLE IF NOT EXISTS authorization_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  default_user_permission_level bigint NOT NULL DEFAULT 2 CHECK (default_user_permission_level BETWEEN 0 AND 9007199254740991),
  requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO authorization_policy (requirements) VALUES ('${initialRequirements}'::jsonb)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  open_id text NOT NULL,
  username text NOT NULL DEFAULT '',
  name text NOT NULL,
  avatar_url text NOT NULL DEFAULT '',
  permission_level bigint NOT NULL DEFAULT 2 CHECK (permission_level BETWEEN 0 AND 9007199254740991),
  roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(roles) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, open_id)
);

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS permission_ceiling bigint
  CHECK (permission_ceiling BETWEEN 0 AND 9007199254740991);

CREATE TABLE IF NOT EXISTS authorization_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $permissions_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authorization_migrations WHERE id = '20261030-user-permissions-v1') THEN
    INSERT INTO user_accounts (tenant_key, open_id, name, avatar_url, created_at)
      SELECT DISTINCT ON (tenant_key, open_id) tenant_key, open_id, name, avatar_url, created_at
      FROM auth_sessions WHERE tenant_key <> 'bifrost-pc-guest'
      ORDER BY tenant_key, open_id, created_at DESC
      ON CONFLICT (tenant_key, open_id) DO NOTHING;
    INSERT INTO user_accounts (tenant_key, open_id, username, name, permission_level, roles)
      VALUES ('${BOOTSTRAP_OWNER.tenantKey}', '${BOOTSTRAP_OWNER.openId}', '${BOOTSTRAP_OWNER.username}', '${BOOTSTRAP_OWNER.name}', 8, '["owner","administrator"]'::jsonb)
      ON CONFLICT (tenant_key, open_id) DO UPDATE SET username = EXCLUDED.username,
        permission_level = 8, roles = EXCLUDED.roles, revision = user_accounts.revision + 1, updated_at = now();
    INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
      VALUES (gen_random_uuid(), 'migration', 'permissions.bootstrap', 'user', '${BOOTSTRAP_OWNER.username}',
        '{"permissionLevel":8,"roles":["owner","administrator"]}'::jsonb);
    INSERT INTO authorization_migrations (id) VALUES ('20261030-user-permissions-v1');
  END IF;
END $permissions_migration$;

DO $permissions_levels_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authorization_migrations WHERE id = '20261030-permission-levels-v2') THEN
    UPDATE authorization_policy SET
      requirements = requirements || '{"system.read":{"permissionLevel":4,"roles":[]},"system.manage":{"permissionLevel":4,"roles":[]},"permissions.manage":{"permissionLevel":4,"roles":[]},"users.manage":{"permissionLevel":6,"roles":[]}}'::jsonb,
      revision = revision + 1, updated_at = now()
      WHERE requirements->'users.manage' IS NULL
        OR requirements->'permissions.manage'->>'permissionLevel' = '8';
    INSERT INTO authorization_migrations (id) VALUES ('20261030-permission-levels-v2');
  END IF;
END $permissions_levels_migration$;
`
