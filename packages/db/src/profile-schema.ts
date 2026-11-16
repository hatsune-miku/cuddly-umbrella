// Additive migration: original actor values are retained only in a server-side archive.
export const profileSchemaSql = `
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS username_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'legacy';
CREATE TABLE IF NOT EXISTS user_private_profiles (
  user_id uuid PRIMARY KEY REFERENCES user_accounts(id),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_actor_values (
  table_name text NOT NULL, record_id text NOT NULL, field_name text NOT NULL, value text NOT NULL,
  PRIMARY KEY(table_name, record_id, field_name)
);
DO $profile_migration$
DECLARE target record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authorization_migrations WHERE id = '20261106-public-profile-v1') THEN
    INSERT INTO user_private_profiles(user_id, fields)
      SELECT id, jsonb_build_object('feishu', jsonb_build_object('realName', name) ||
        CASE WHEN username_source = 'bifrost' THEN '{}'::jsonb ELSE jsonb_build_object('username', username) END)
      FROM user_accounts ON CONFLICT (user_id) DO NOTHING;
    UPDATE user_accounts SET display_name = '用户-' || id::text, name = '用户-' || id::text,
      username = CASE WHEN username_source = 'bifrost' THEN username ELSE '' END;
    UPDATE auth_sessions s SET name = u.display_name FROM user_accounts u
      WHERE s.tenant_key = u.tenant_key AND s.open_id = u.open_id;
    UPDATE auth_sessions SET name = '游客' WHERE tenant_key = 'bifrost-pc-guest';
    FOR target IN SELECT * FROM (VALUES
      ('build_jobs', 'id', 'requested_by'), ('artifacts', 'id', 'created_by'),
      ('preview_sessions', 'token', 'created_by'), ('configuration_groups', 'token', 'created_by'),
      ('configuration_groups', 'token', 'updated_by'), ('runtime_settings', 'key', 'updated_by'),
      ('environment_revisions', 'id', 'created_by')
    ) AS t(tbl, pk, col) LOOP
      EXECUTE format('INSERT INTO legacy_actor_values SELECT %L, %I::text, %L, %I FROM %I WHERE %I NOT LIKE ''user:%%'' ON CONFLICT DO NOTHING', target.tbl, target.pk, target.col, target.col, target.tbl, target.col);
      EXECUTE format('UPDATE %I SET %I = ''history'' WHERE %I NOT LIKE ''user:%%''', target.tbl, target.col, target.col);
    END LOOP;
    INSERT INTO authorization_migrations(id) VALUES ('20261106-public-profile-v1');
  END IF;
END $profile_migration$;
ALTER TABLE user_accounts ALTER COLUMN display_name SET NOT NULL;
CREATE OR REPLACE FUNCTION bifrost_actor_name(actor text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT display_name FROM user_accounts WHERE 'user:' || id::text = actor),
    CASE WHEN actor = 'system' THEN '系统' ELSE '历史用户' END)
$$;
`
