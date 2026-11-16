export const schemaSql = String.raw`
CREATE TABLE IF NOT EXISTS build_targets (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  repository_url text,
  default_branch text NOT NULL,
  install_command text NOT NULL DEFAULT 'corepack pnpm install --frozen-lockfile',
  build_command text NOT NULL DEFAULT 'corepack pnpm run build',
  output_directory text NOT NULL DEFAULT 'build',
  site_adapter text NOT NULL DEFAULT 'kook-online-h5-v1',
  enabled boolean NOT NULL DEFAULT true,
  required boolean NOT NULL DEFAULT false,
  configuration_source text NOT NULL DEFAULT 'template',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS install_command text NOT NULL DEFAULT 'corepack pnpm install --frozen-lockfile';
ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS build_command text NOT NULL DEFAULT 'corepack pnpm run build';
ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS output_directory text NOT NULL DEFAULT 'build';
ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS site_adapter text NOT NULL DEFAULT 'kook-online-h5-v1';
ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS configuration_source text NOT NULL DEFAULT 'template';
ALTER TABLE build_targets ALTER COLUMN configuration_source SET DEFAULT 'template';
UPDATE build_targets
SET configuration_source = CASE WHEN repository_url IS NULL THEN 'template' ELSE 'database' END
WHERE configuration_source = 'environment';
ALTER TABLE build_targets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS build_jobs (
  id uuid PRIMARY KEY,
  target_id text NOT NULL REFERENCES build_targets(id),
  branch text NOT NULL,
  profile text NOT NULL,
  status text NOT NULL,
  requested_by text NOT NULL,
  idempotency_key text UNIQUE,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_message text,
  log_path text,
  target_snapshot jsonb
);

ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS target_snapshot jsonb;

CREATE INDEX IF NOT EXISTS build_jobs_queue_idx ON build_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS build_jobs_target_branch_idx ON build_jobs(target_id, branch, created_at DESC);

CREATE TABLE IF NOT EXISTS build_job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS build_job_events_job_idx
  ON build_job_events(job_id, created_at, id);

INSERT INTO build_job_events (job_id, status, created_at)
SELECT id, status, COALESCE(finished_at, started_at, created_at)
FROM build_jobs AS job
WHERE NOT EXISTS (
  SELECT 1 FROM build_job_events AS event WHERE event.job_id = job.id
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  build_job_id uuid NOT NULL UNIQUE REFERENCES build_jobs(id),
  target_id text NOT NULL REFERENCES build_targets(id),
  branch text NOT NULL,
  status text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  built_at timestamptz NOT NULL,
  created_by text NOT NULL,
  deletion_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deletion_started_at timestamptz;

CREATE INDEX IF NOT EXISTS artifacts_catalog_idx ON artifacts(target_id, branch, built_at DESC)
  WHERE status = 'READY';

CREATE INDEX IF NOT EXISTS artifacts_deleting_idx ON artifacts(deletion_started_at)
  WHERE status = 'DELETING';

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  backend_origin text NOT NULL DEFAULT 'https://www.kookapp.cn',
  use_internal_proxy boolean NOT NULL DEFAULT false,
  resource_proxy_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT environments_resource_proxy_prefixes_array
    CHECK (jsonb_typeof(resource_proxy_prefixes) = 'array')
);

CREATE TABLE IF NOT EXISTS environment_revisions (
  id uuid PRIMARY KEY,
  environment_id uuid NOT NULL REFERENCES environments(id),
  revision_no integer NOT NULL,
  message text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment_id, revision_no)
);

ALTER TABLE environments
  DROP CONSTRAINT IF EXISTS environments_current_revision_id_fkey;
ALTER TABLE environments
  ADD CONSTRAINT environments_current_revision_id_fkey
  FOREIGN KEY (current_revision_id) REFERENCES environment_revisions(id);

CREATE TABLE IF NOT EXISTS environment_revision_items (
  revision_id uuid NOT NULL REFERENCES environment_revisions(id),
  target_id text NOT NULL REFERENCES build_targets(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  branch text NOT NULL,
  built_at timestamptz NOT NULL,
  PRIMARY KEY(revision_id, target_id)
);

CREATE TABLE IF NOT EXISTS environment_artifact_refs (
  environment_id uuid NOT NULL REFERENCES environments(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  first_revision_id uuid NOT NULL REFERENCES environment_revisions(id),
  last_revision_id uuid NOT NULL REFERENCES environment_revisions(id),
  last_referenced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS environment_artifact_refs_artifact_idx
  ON environment_artifact_refs(artifact_id);

CREATE TABLE IF NOT EXISTS site_bindings (
  id text PRIMARY KEY,
  name text NOT NULL,
  hostname text NOT NULL UNIQUE,
  target_id text NOT NULL REFERENCES build_targets(id),
  environment_slug text NOT NULL REFERENCES environments(slug),
  upstream_origin text NOT NULL,
  fallback_origin text NOT NULL,
  official_origin text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  remote_target_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource_proxy_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_bindings_remote_target_ids_array
    CHECK (jsonb_typeof(remote_target_ids) = 'array'),
  CONSTRAINT site_bindings_resource_proxy_prefixes_array
    CHECK (jsonb_typeof(resource_proxy_prefixes) = 'array')
);

ALTER TABLE site_bindings
  ADD COLUMN IF NOT EXISTS resource_proxy_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE site_bindings ADD COLUMN IF NOT EXISTS fallback_origin text;
UPDATE site_bindings SET fallback_origin = upstream_origin WHERE fallback_origin IS NULL;
ALTER TABLE site_bindings ALTER COLUMN fallback_origin SET NOT NULL;

CREATE OR REPLACE FUNCTION cuddly_sync_site_binding_origins()
RETURNS trigger AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.upstream_origin IS DISTINCT FROM OLD.upstream_origin
     AND NEW.fallback_origin IS NOT DISTINCT FROM OLD.fallback_origin THEN
    NEW.fallback_origin := NEW.upstream_origin;
  END IF;
  IF NEW.fallback_origin IS NULL THEN
    NEW.fallback_origin := NEW.upstream_origin;
  END IF;
  IF NEW.upstream_origin IS NULL OR NEW.upstream_origin IS DISTINCT FROM NEW.fallback_origin THEN
    NEW.upstream_origin := NEW.fallback_origin;
  END IF;
  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS site_bindings_sync_origins ON site_bindings;
CREATE TRIGGER site_bindings_sync_origins
BEFORE INSERT OR UPDATE OF upstream_origin, fallback_origin ON site_bindings
FOR EACH ROW EXECUTE FUNCTION cuddly_sync_site_binding_origins();

ALTER TABLE site_bindings DROP CONSTRAINT IF EXISTS site_bindings_official_origin_key;
CREATE UNIQUE INDEX IF NOT EXISTS site_bindings_official_environment_unique_idx
  ON site_bindings(official_origin, environment_slug);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'site_bindings_resource_proxy_prefixes_array'
      AND conrelid = 'site_bindings'::regclass
  ) THEN
    ALTER TABLE site_bindings
      ADD CONSTRAINT site_bindings_resource_proxy_prefixes_array
      CHECK (jsonb_typeof(resource_proxy_prefixes) = 'array');
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS site_bindings_enabled_hostname_idx
  ON site_bindings(hostname) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS site_bindings_enabled_official_origin_idx
  ON site_bindings(official_origin) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS preview_sessions (
  token text PRIMARY KEY,
  created_by text NOT NULL,
  site_binding_id text REFERENCES site_bindings(id) ON DELETE SET NULL,
  site_artifact_id uuid REFERENCES artifacts(id),
  selections jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE preview_sessions
  ADD COLUMN IF NOT EXISTS site_binding_id text REFERENCES site_bindings(id) ON DELETE SET NULL;
ALTER TABLE preview_sessions
  ADD COLUMN IF NOT EXISTS site_artifact_id uuid REFERENCES artifacts(id);
ALTER TABLE preview_sessions
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS preview_sessions_expires_idx ON preview_sessions(expires_at);

CREATE INDEX IF NOT EXISTS preview_sessions_site_artifact_idx
  ON preview_sessions(site_artifact_id, expires_at);

CREATE INDEX IF NOT EXISTS preview_sessions_selections_gin_idx
  ON preview_sessions USING gin(selections jsonb_path_ops);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_token_hash text PRIMARY KEY,
  tenant_key text NOT NULL,
  open_id text NOT NULL,
  union_id text NOT NULL,
  name text NOT NULL,
  avatar_url text NOT NULL,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT auth_sessions_token_hash_sha256
    CHECK (session_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS auth_sessions_subject_idx
  ON auth_sessions(tenant_key, open_id);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx
  ON auth_sessions(expires_at);

INSERT INTO build_targets
  (id, name, kind, repository_url, default_branch, install_command, build_command,
   output_directory, site_adapter, enabled, required, configuration_source)
VALUES
  ('online-h5', '在线 H5', 'h5-site', NULL, 'master',
   'corepack pnpm@9.15.9 install --frozen-lockfile', 'corepack pnpm@9.15.9 run build', 'build',
   'kook-online-h5-v1', false, false, 'template'),
  ('webapp', '网页端', 'webapp', NULL, 'master',
   'npm run i', 'npm run build_fast', 'build',
   'generic-static-v1', false, false, 'template'),
  ('biz', '商户后台', 'spa-site', NULL, 'master',
   'npm install --legacy-peer-deps --verbose', 'npm run build', 'build',
   'generic-static-v1', false, false, 'template')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE environments ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN IF NOT EXISTS backend_origin text;
ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS use_internal_proxy boolean NOT NULL DEFAULT false;
ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS resource_proxy_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'environments_resource_proxy_prefixes_array'
      AND conrelid = 'environments'::regclass
  ) THEN
    ALTER TABLE environments
      ADD CONSTRAINT environments_resource_proxy_prefixes_array
      CHECK (jsonb_typeof(resource_proxy_prefixes) = 'array');
  END IF;
END
$migration$;

INSERT INTO environments (id, slug, name, status, backend_origin)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'shared',
  '公共调试环境',
  'ACTIVE',
  'https://www.kookapp.cn'
)
ON CONFLICT (slug) DO NOTHING;

UPDATE environments
SET backend_origin = COALESCE(
  (
    SELECT CASE
      WHEN jsonb_typeof(setting.value) = 'string' THEN setting.value #>> '{}'
      ELSE NULL
    END
    FROM runtime_settings AS setting
    WHERE setting.key = 'system.webapp_upstream'
  ),
  'https://www.kookapp.cn'
)
WHERE backend_origin IS NULL;
ALTER TABLE environments ALTER COLUMN backend_origin SET NOT NULL;
ALTER TABLE environments ALTER COLUMN backend_origin SET DEFAULT 'https://www.kookapp.cn';
CREATE UNIQUE INDEX IF NOT EXISTS environments_id_slug_unique_idx
  ON environments(id, slug);

CREATE TABLE IF NOT EXISTS project_environment_configs (
  target_id text NOT NULL REFERENCES build_targets(id),
  environment_id uuid NOT NULL REFERENCES environments(id),
  enabled boolean NOT NULL DEFAULT false,
  required boolean NOT NULL DEFAULT false,
  install_command text NOT NULL,
  build_command text NOT NULL,
  output_directory text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id, target_id),
  CONSTRAINT project_environment_configs_required_enabled
    CHECK (NOT required OR enabled)
);

INSERT INTO project_environment_configs
  (target_id, environment_id, enabled, required, install_command, build_command, output_directory)
SELECT target.id, environment.id, target.enabled, target.required,
       target.install_command, target.build_command, target.output_directory
FROM build_targets AS target
CROSS JOIN environments AS environment
WHERE environment.slug = 'shared'
ON CONFLICT (environment_id, target_id) DO NOTHING;

ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS environment_id uuid;
ALTER TABLE build_jobs ADD COLUMN IF NOT EXISTS environment_slug text;
UPDATE build_jobs
SET environment_id = environment.id,
    environment_slug = environment.slug
FROM environments AS environment
WHERE environment.slug = 'shared'
  AND build_jobs.environment_id IS NULL
  AND build_jobs.environment_slug IS NULL;
UPDATE build_jobs AS job
SET environment_slug = environment.slug
FROM environments AS environment
WHERE job.environment_id = environment.id
  AND job.environment_slug IS NULL;
UPDATE build_jobs AS job
SET environment_id = environment.id
FROM environments AS environment
WHERE job.environment_slug = environment.slug
  AND job.environment_id IS NULL;
ALTER TABLE build_jobs ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE build_jobs ALTER COLUMN environment_slug SET NOT NULL;
ALTER TABLE build_jobs ALTER COLUMN environment_id DROP DEFAULT;
ALTER TABLE build_jobs ALTER COLUMN environment_slug DROP DEFAULT;
DO $migration$
DECLARE
  current_definition text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_jobs_environment_id_fkey'
      AND conrelid = 'build_jobs'::regclass
  ) THEN
    ALTER TABLE build_jobs DROP CONSTRAINT build_jobs_environment_id_fkey;
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO current_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'build_jobs_environment_identity_fkey'
    AND constraint_row.conrelid = 'build_jobs'::regclass;

  IF current_definition IS DISTINCT FROM
     'FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug)' THEN
    IF current_definition IS NOT NULL THEN
      ALTER TABLE build_jobs DROP CONSTRAINT build_jobs_environment_identity_fkey;
    END IF;
    ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_environment_identity_fkey
      FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug);
  END IF;
END
$migration$;
CREATE INDEX IF NOT EXISTS build_jobs_environment_target_branch_idx
  ON build_jobs(environment_id, target_id, branch, created_at DESC);
CREATE INDEX IF NOT EXISTS build_jobs_environment_history_idx
  ON build_jobs(environment_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS build_jobs_id_environment_unique_idx
  ON build_jobs(id, environment_id, environment_slug);
CREATE INDEX IF NOT EXISTS build_jobs_environment_active_idx
  ON build_jobs(environment_id, target_id, created_at DESC)
  WHERE status IN (
    'QUEUED', 'LEASED', 'CHECKOUT', 'INSTALLING', 'BUILDING',
    'VALIDATING', 'UPLOADING', 'CANCELING'
  );

UPDATE build_jobs AS job
SET target_snapshot = job.target_snapshot || jsonb_build_object(
  'environment', jsonb_build_object(
    'id', environment.id,
    'slug', environment.slug,
    'name', environment.name,
    'backendOrigin', environment.backend_origin
  )
)
FROM environments AS environment
WHERE job.environment_id = environment.id
  AND job.target_snapshot IS NOT NULL
  AND NOT (job.target_snapshot ? 'environment');

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS environment_id uuid;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS environment_slug text;
UPDATE artifacts AS artifact
SET environment_id = job.environment_id,
    environment_slug = job.environment_slug
FROM build_jobs AS job
WHERE artifact.build_job_id = job.id
  AND (artifact.environment_id IS NULL OR artifact.environment_slug IS NULL);
ALTER TABLE artifacts ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN environment_slug SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN environment_id DROP DEFAULT;
ALTER TABLE artifacts ALTER COLUMN environment_slug DROP DEFAULT;
DO $migration$
DECLARE
  identity_definition text;
  job_definition text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_environment_id_fkey'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    ALTER TABLE artifacts DROP CONSTRAINT artifacts_environment_id_fkey;
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO identity_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'artifacts_environment_identity_fkey'
    AND constraint_row.conrelid = 'artifacts'::regclass;

  IF identity_definition IS DISTINCT FROM
     'FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug)' THEN
    IF identity_definition IS NOT NULL THEN
      ALTER TABLE artifacts DROP CONSTRAINT artifacts_environment_identity_fkey;
    END IF;
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_environment_identity_fkey
      FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug);
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO job_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'artifacts_build_job_environment_fkey'
    AND constraint_row.conrelid = 'artifacts'::regclass;

  IF job_definition IS DISTINCT FROM
     'FOREIGN KEY (build_job_id, environment_id, environment_slug) REFERENCES build_jobs(id, environment_id, environment_slug)' THEN
    IF job_definition IS NOT NULL THEN
      ALTER TABLE artifacts DROP CONSTRAINT artifacts_build_job_environment_fkey;
    END IF;
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_build_job_environment_fkey
      FOREIGN KEY (build_job_id, environment_id, environment_slug)
      REFERENCES build_jobs(id, environment_id, environment_slug);
  END IF;
END
$migration$;
CREATE INDEX IF NOT EXISTS artifacts_environment_catalog_idx
  ON artifacts(environment_id, target_id, branch, built_at DESC)
  WHERE status = 'READY';

ALTER TABLE preview_sessions ADD COLUMN IF NOT EXISTS environment_id uuid;
ALTER TABLE preview_sessions ADD COLUMN IF NOT EXISTS environment_slug text;
UPDATE preview_sessions AS preview
SET environment_slug = environment.slug
FROM environments AS environment
WHERE preview.environment_id = environment.id
  AND preview.environment_slug IS NULL;
UPDATE preview_sessions AS preview
SET environment_id = environment.id
FROM environments AS environment
WHERE preview.environment_slug = environment.slug
  AND preview.environment_id IS NULL;
UPDATE preview_sessions AS preview
SET environment_id = environment.id,
    environment_slug = environment.slug
FROM environments AS environment
WHERE environment.slug = 'shared'
  AND preview.environment_id IS NULL
  AND preview.environment_slug IS NULL
  AND (
    preview.site_binding_id IS NULL
    OR EXISTS (
      SELECT 1 FROM site_bindings AS binding
      WHERE binding.id = preview.site_binding_id
        AND binding.environment_slug = 'shared'
    )
  );
ALTER TABLE preview_sessions ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE preview_sessions ALTER COLUMN environment_slug SET NOT NULL;
ALTER TABLE preview_sessions ALTER COLUMN environment_id DROP DEFAULT;
ALTER TABLE preview_sessions ALTER COLUMN environment_slug DROP DEFAULT;
DO $migration$
DECLARE
  current_definition text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'preview_sessions_environment_id_fkey'
      AND conrelid = 'preview_sessions'::regclass
  ) THEN
    ALTER TABLE preview_sessions DROP CONSTRAINT preview_sessions_environment_id_fkey;
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid)
  INTO current_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conname = 'preview_sessions_environment_identity_fkey'
    AND constraint_row.conrelid = 'preview_sessions'::regclass;

  IF current_definition IS DISTINCT FROM
     'FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug)' THEN
    IF current_definition IS NOT NULL THEN
      ALTER TABLE preview_sessions DROP CONSTRAINT preview_sessions_environment_identity_fkey;
    END IF;
    ALTER TABLE preview_sessions ADD CONSTRAINT preview_sessions_environment_identity_fkey
      FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug);
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION cuddly_fill_build_job_environment()
RETURNS trigger AS $function$
BEGIN
  IF NEW.environment_id IS NULL AND NEW.environment_slug IS NULL THEN
    SELECT environment.id, environment.slug
    INTO NEW.environment_id, NEW.environment_slug
    FROM environments AS environment
    WHERE environment.slug = 'shared';
  ELSIF NEW.environment_id IS NULL THEN
    SELECT environment.id INTO NEW.environment_id
    FROM environments AS environment
    WHERE environment.slug = NEW.environment_slug;
  ELSIF NEW.environment_slug IS NULL THEN
    SELECT environment.slug INTO NEW.environment_slug
    FROM environments AS environment
    WHERE environment.id = NEW.environment_id;
  END IF;
  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS build_jobs_fill_environment ON build_jobs;
CREATE TRIGGER build_jobs_fill_environment
BEFORE INSERT ON build_jobs
FOR EACH ROW EXECUTE FUNCTION cuddly_fill_build_job_environment();

CREATE OR REPLACE FUNCTION cuddly_fill_artifact_environment()
RETURNS trigger AS $function$
DECLARE
  job_environment_id uuid;
  job_environment_slug text;
BEGIN
  IF NEW.environment_id IS NULL OR NEW.environment_slug IS NULL THEN
    SELECT job.environment_id, job.environment_slug
    INTO job_environment_id, job_environment_slug
    FROM build_jobs AS job
    WHERE job.id = NEW.build_job_id;
    NEW.environment_id := COALESCE(NEW.environment_id, job_environment_id);
    NEW.environment_slug := COALESCE(NEW.environment_slug, job_environment_slug);
  END IF;
  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifacts_fill_environment ON artifacts;
CREATE TRIGGER artifacts_fill_environment
BEFORE INSERT ON artifacts
FOR EACH ROW EXECUTE FUNCTION cuddly_fill_artifact_environment();

CREATE OR REPLACE FUNCTION cuddly_fill_preview_environment()
RETURNS trigger AS $function$
DECLARE
  binding_environment_slug text;
BEGIN
  IF NEW.environment_id IS NULL AND NEW.environment_slug IS NULL THEN
    IF NEW.site_binding_id IS NOT NULL THEN
      SELECT binding.environment_slug INTO binding_environment_slug
      FROM site_bindings AS binding
      WHERE binding.id = NEW.site_binding_id;
      IF binding_environment_slug IS DISTINCT FROM 'shared' THEN
        RAISE EXCEPTION 'Legacy Preview without environment identity requires a shared binding';
      END IF;
    ELSE
      binding_environment_slug := 'shared';
    END IF;
    SELECT environment.id, environment.slug
    INTO NEW.environment_id, NEW.environment_slug
    FROM environments AS environment
    WHERE environment.slug = binding_environment_slug;
  ELSIF NEW.environment_id IS NULL THEN
    SELECT environment.id INTO NEW.environment_id
    FROM environments AS environment
    WHERE environment.slug = NEW.environment_slug;
  ELSIF NEW.environment_slug IS NULL THEN
    SELECT environment.slug INTO NEW.environment_slug
    FROM environments AS environment
    WHERE environment.id = NEW.environment_id;
  END IF;
  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS preview_sessions_fill_environment ON preview_sessions;
CREATE TRIGGER preview_sessions_fill_environment
BEFORE INSERT ON preview_sessions
FOR EACH ROW EXECUTE FUNCTION cuddly_fill_preview_environment();

CREATE TABLE IF NOT EXISTS configuration_groups (
  token text PRIMARY KEY,
  preview_slug text,
  preview_hostname_prefix text,
  name text NOT NULL,
  environment_id uuid NOT NULL,
  environment_slug text NOT NULL,
  site_binding_id text NOT NULL REFERENCES site_bindings(id),
  schema_version integer NOT NULL DEFAULT 1,
  items jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_groups_schema_version_v1 CHECK (schema_version = 1),
  CONSTRAINT configuration_groups_items_array CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT configuration_groups_revision_positive CHECK (revision >= 1),
  CONSTRAINT configuration_groups_environment_identity_fkey
    FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug)
);

ALTER TABLE configuration_groups ADD COLUMN IF NOT EXISTS preview_slug text;
UPDATE configuration_groups SET preview_slug = md5(token) WHERE preview_slug IS NULL;
ALTER TABLE configuration_groups ALTER COLUMN preview_slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS configuration_groups_preview_slug_idx
  ON configuration_groups(preview_slug);

ALTER TABLE configuration_groups ADD COLUMN IF NOT EXISTS preview_hostname_prefix text;
UPDATE configuration_groups
SET preview_hostname_prefix = 'p-' || preview_slug
WHERE preview_hostname_prefix IS NULL;
ALTER TABLE configuration_groups ALTER COLUMN preview_hostname_prefix SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS configuration_groups_preview_hostname_prefix_idx
  ON configuration_groups(preview_hostname_prefix);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'configuration_groups_preview_hostname_prefix_valid'
      AND conrelid = 'configuration_groups'::regclass
  ) THEN
    ALTER TABLE configuration_groups
      ADD CONSTRAINT configuration_groups_preview_hostname_prefix_valid
      CHECK (preview_hostname_prefix ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
  END IF;
END
$migration$;

ALTER TABLE configuration_groups
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE configuration_groups
  ADD COLUMN IF NOT EXISTS updated_by text;
UPDATE configuration_groups
SET updated_by = created_by
WHERE updated_by IS NULL;
ALTER TABLE configuration_groups
  ALTER COLUMN updated_by SET NOT NULL;
ALTER TABLE configuration_groups
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE configuration_groups
SET updated_at = created_at
WHERE updated_at IS NULL;
ALTER TABLE configuration_groups
  ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE configuration_groups
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION cuddly_fill_configuration_group_audit()
RETURNS trigger AS $function$
BEGIN
  -- Keep rollback images writable: the original Control API only supplied
  -- created_by when inserting an immutable configuration group.
  NEW.updated_by := COALESCE(NULLIF(BTRIM(NEW.updated_by), ''), NEW.created_by);
  NEW.updated_at := COALESCE(NEW.updated_at, NEW.created_at, now());
  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS configuration_groups_fill_audit ON configuration_groups;
CREATE TRIGGER configuration_groups_fill_audit
BEFORE INSERT ON configuration_groups
FOR EACH ROW EXECUTE FUNCTION cuddly_fill_configuration_group_audit();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'configuration_groups_revision_positive'
      AND conrelid = 'configuration_groups'::regclass
  ) THEN
    ALTER TABLE configuration_groups
      ADD CONSTRAINT configuration_groups_revision_positive CHECK (revision >= 1);
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS configuration_groups_created_idx
  ON configuration_groups(created_at DESC, token DESC);
`
