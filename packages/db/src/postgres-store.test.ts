import { createHash } from 'node:crypto'

import type { Artifact, BuildJob, BuildTarget, EnvironmentRecord } from '@cuddly/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PostgresStore } from './postgres-store'
import { schemaSql } from './schema'

const environment: EnvironmentRecord = {
  id: '00000000-0000-4000-8000-000000000002',
  slug: 'staging',
  name: '测试环境',
  status: 'ACTIVE',
  backendOrigin: 'https://staging-api.example.test',
  useInternalProxy: true,
  resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
  currentRevisionId: null,
}

const target: BuildTarget = {
  id: 'webapp',
  name: '网页端',
  kind: 'webapp',
  repositoryUrl: 'https://git.example.test/webapp.git',
  defaultBranch: 'master',
  installCommand: 'pnpm install',
  buildCommand: 'pnpm build',
  outputDirectory: 'dist',
  siteAdapter: 'generic-static-v1',
  enabled: true,
  required: false,
  configurationSource: 'database',
}

const artifact: Artifact = {
  id: '00000000-0000-4000-8000-000000000010',
  buildJobId: '00000000-0000-4000-8000-000000000011',
  environmentId: environment.id,
  environmentSlug: environment.slug,
  targetId: target.id,
  branch: 'feature/latest',
  status: 'READY',
  storageKey: 'ready/webapp/latest',
  manifest: {
    schemaVersion: 1,
    artifactId: '00000000-0000-4000-8000-000000000010',
    target: target.id,
    branch: 'feature/latest',
    builtAt: '2026-08-25T08:00:00.000Z',
    serve: {
      siteAdapter: 'generic-static-v1',
      entrypoints: ['index.html'],
      publicBase: '/artifacts/latest/',
    },
    files: [],
  },
  builtAt: '2026-08-25T08:00:00.000Z',
  createdBy: 'gz',
}

const activeJob: BuildJob = {
  id: '00000000-0000-4000-8000-000000000012',
  environmentId: environment.id,
  environmentSlug: environment.slug,
  targetId: target.id,
  branch: 'feature/building',
  profile: 'qa-web',
  status: 'BUILDING',
  requestedBy: 'gz',
  createdAt: '2026-08-25T09:00:00.000Z',
  startedAt: '2026-08-25T09:00:01.000Z',
  finishedAt: null,
  failureCode: null,
  failureMessage: null,
  logPath: null,
  targetSnapshot: null,
}

function artifactRow(value: Artifact) {
  return {
    id: value.id,
    build_job_id: value.buildJobId,
    environment_id: value.environmentId,
    environment_slug: value.environmentSlug,
    target_id: value.targetId,
    branch: value.branch,
    status: value.status,
    storage_key: value.storageKey,
    manifest: value.manifest,
    built_at: value.builtAt,
    created_by: value.createdBy,
  }
}

function jobRow(value: BuildJob) {
  return {
    id: value.id,
    environment_id: value.environmentId,
    environment_slug: value.environmentSlug,
    target_id: value.targetId,
    branch: value.branch,
    profile: value.profile,
    status: value.status,
    requested_by: value.requestedBy,
    created_at: value.createdAt,
    started_at: value.startedAt,
    finished_at: value.finishedAt,
    failure_code: value.failureCode,
    failure_message: value.failureMessage,
    log_path: value.logPath,
    target_snapshot: value.targetSnapshot,
  }
}

function configurationGroupRow(overrides: Record<string, unknown> = {}) {
  return {
    token: 'share-token',
    preview_slug: '0123456789abcdef0123456789abcdef',
    preview_hostname_prefix: 'party-week',
    name: '频道权限重构',
    environment_id: environment.id,
    environment_slug: environment.slug,
    site_binding_id: 'main',
    schema_version: 1,
    items: [{ targetId: 'webapp', mode: 'official' as const }],
    revision: 1,
    created_by: 'gz',
    created_at: '2026-08-25T12:34:56.000Z',
    updated_by: 'gz',
    updated_at: '2026-08-25T12:34:56.000Z',
    ...overrides,
  }
}

describe('PostgresStore matrix queries', () => {
  const stores: PostgresStore[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(stores.splice(0).map((store) => store.close()))
  })

  it('uses two environment-scoped latest-row queries instead of loading history per project', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    stores.push(store)
    vi.spyOn(store, 'getEnvironment').mockResolvedValue(environment)
    vi.spyOn(store, 'listBuildTargets').mockResolvedValue([target])
    vi.spyOn(store, 'listProjectEnvironmentConfigs').mockResolvedValue([
      {
        targetId: target.id,
        environmentId: environment.id,
        enabled: true,
        required: false,
        installCommand: 'pnpm install --staging',
        buildCommand: 'pnpm build --staging',
        outputDirectory: 'staging-dist',
      },
    ])
    const listArtifacts = vi.spyOn(store, 'listArtifacts')
    const listJobs = vi.spyOn(store, 'listBuildJobs')
    const queries: string[] = []
    vi.spyOn(store.pool, 'query').mockImplementation((async (query: unknown) => {
      const sql = String(query)
      queries.push(sql)
      if (sql.includes('FROM artifacts')) return { rows: [artifactRow(artifact)] }
      if (sql.includes('FROM build_jobs')) return { rows: [jobRow(activeJob)] }
      throw new Error(`Unexpected matrix query: ${sql}`)
    }) as typeof store.pool.query)

    const matrix = await store.getEnvironmentMatrix(environment.slug)

    expect(matrix?.rows).toEqual([
      expect.objectContaining({
        latestArtifact: { id: artifact.id, branch: artifact.branch, builtAt: artifact.builtAt },
        activeJob: expect.objectContaining({ id: activeJob.id, status: 'BUILDING' }),
      }),
    ])
    expect(listArtifacts).not.toHaveBeenCalled()
    expect(listJobs).not.toHaveBeenCalled()
    expect(queries).toHaveLength(2)
    expect(queries.every((sql) => sql.includes('DISTINCT ON (target_id)'))).toBe(true)
    expect(queries.every((sql) => sql.includes('environment_id = $1'))).toBe(true)
  })
})

describe('PostgresStore build history pagination', () => {
  it('pushes filters, stable ordering, counting, and page bounds into PostgreSQL', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const failedJob: BuildJob = {
      ...activeJob,
      status: 'FAILED',
      branch: 'feature/history-search',
      finishedAt: '2026-08-25T09:05:00.000Z',
      failureCode: 'BUILD_FAILED',
      failureMessage: 'failed',
    }
    vi.spyOn(store.pool, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('count(*)')) return { rows: [{ total: '5' }] }
      return { rows: [jobRow(failedJob)] }
    }) as typeof store.pool.query)

    try {
      await expect(
        store.listBuildJobPage({
          environmentId: environment.id,
          targetId: target.id,
          status: 'FAILED',
          query: 'HISTORY-SEARCH',
          page: 2,
          pageSize: 2,
        })
      ).resolves.toMatchObject({
        items: [{ id: failedJob.id, status: 'FAILED' }],
        page: 2,
        pageSize: 2,
        total: 5,
        totalPages: 3,
      })

      const pageStatement = statements.find(({ sql }) => sql.includes('SELECT * FROM build_jobs'))!
      const countStatement = statements.find(({ sql }) => sql.includes('count(*)'))!
      expect(pageStatement.sql).toContain('environment_id = $1::uuid')
      expect(pageStatement.sql).toContain('target_id = $2')
      expect(pageStatement.sql).toContain('status = $3')
      expect(pageStatement.sql).toContain('strpos(lower(branch), $4) > 0')
      expect(pageStatement.sql).toContain('ORDER BY created_at DESC, id DESC')
      expect(pageStatement.sql).toContain('LIMIT $5 OFFSET $6')
      expect(pageStatement.values).toEqual([
        environment.id,
        target.id,
        'FAILED',
        'history-search',
        2,
        2,
      ])
      expect(countStatement.values).toEqual([environment.id, target.id, 'FAILED', 'history-search'])
    } finally {
      await store.close()
    }
  })
})

describe('Postgres environment migration', () => {
  it('maps the per-environment internal proxy switch', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    vi.spyOn(store.pool, 'query').mockResolvedValue({
      rows: [
        {
          id: environment.id,
          slug: environment.slug,
          name: environment.name,
          status: environment.status,
          backend_origin: environment.backendOrigin,
          use_internal_proxy: true,
          resource_proxy_prefixes: environment.resourceProxyPrefixes,
          current_revision_id: null,
        },
      ],
    } as never)

    try {
      await expect(store.getEnvironment(environment.slug)).resolves.toEqual({
        ...environment,
        sortOrder: 0,
      })
    } finally {
      await store.close()
    }
  })

  it('persists environment resource proxy prefixes and includes them in the audit event', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const release = vi.fn()
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('SELECT id, slug FROM environments')) return { rows: [] }
      if (sql.includes('INSERT INTO environments')) {
        return {
          rows: [
            {
              id: environment.id,
              slug: environment.slug,
              name: environment.name,
              status: environment.status,
              backend_origin: environment.backendOrigin,
              use_internal_proxy: environment.useInternalProxy,
              resource_proxy_prefixes: environment.resourceProxyPrefixes,
              current_revision_id: environment.currentRevisionId,
            },
          ],
        }
      }
      return { rows: [] }
    })
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release } as never)

    try {
      await expect(store.saveEnvironment(environment, 'gz')).resolves.toEqual({
        ...environment,
        sortOrder: 0,
      })
      const saveStatement = statements.find(({ sql }) => sql.includes('INSERT INTO environments'))!
      expect(saveStatement.sql).toContain('resource_proxy_prefixes')
      expect(saveStatement.values?.[6]).toBe(JSON.stringify(environment.resourceProxyPrefixes))
      expect(saveStatement.values?.[8]).toBeNull()
      expect(saveStatement.sql).toContain(
        'sort_order = COALESCE($9::integer, environments.sort_order)'
      )
      const auditStatement = statements.find(({ sql }) => sql.includes('INSERT INTO audit_events'))!
      expect(JSON.parse(String(auditStatement.values?.[3]))).toMatchObject({
        resourceProxyPrefixes: environment.resourceProxyPrefixes,
      })
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await store.close()
    }
  })

  it('backfills without overwriting origins and enforces paired environment identity', () => {
    expect(schemaSql).toContain('ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0')
    expect(schemaSql).toContain("setting.key = 'system.webapp_upstream'")
    expect(schemaSql).toContain('WHERE backend_origin IS NULL')
    expect(schemaSql).toContain(
      "ALTER TABLE environments ALTER COLUMN backend_origin SET DEFAULT 'https://www.kookapp.cn'"
    )
    expect(schemaSql).toContain(
      'ADD COLUMN IF NOT EXISTS use_internal_proxy boolean NOT NULL DEFAULT false'
    )
    expect(schemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS resource_proxy_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb"
    )
    expect(schemaSql).toContain('environments_resource_proxy_prefixes_array')
    expect(schemaSql).toMatch(
      /INSERT INTO environments \(id, slug, name, status, backend_origin\)[\s\S]+?'https:\/\/www\.kookapp\.cn'/
    )
    expect(
      schemaSql.indexOf('ALTER TABLE environments ADD COLUMN IF NOT EXISTS backend_origin text')
    ).toBeLessThan(
      schemaSql.indexOf('INSERT INTO environments (id, slug, name, status, backend_origin)')
    )
    expect(schemaSql).toContain('environments_id_slug_unique_idx')
    expect(schemaSql).toContain(
      'FOREIGN KEY (environment_id, environment_slug) REFERENCES environments(id, slug)'
    )
    expect(schemaSql).toContain('pg_get_constraintdef(constraint_row.oid)')
    expect(schemaSql).not.toContain(
      'ALTER TABLE build_jobs DROP CONSTRAINT IF EXISTS build_jobs_environment_identity_fkey'
    )
    expect(schemaSql).not.toContain(
      'ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_environment_identity_fkey'
    )
    expect(schemaSql).not.toContain(
      'ALTER TABLE preview_sessions DROP CONSTRAINT IF EXISTS preview_sessions_environment_identity_fkey'
    )
  })

  it('keeps old site origin writes synchronized and seeds only the shared environment', () => {
    expect(schemaSql).toContain('cuddly_sync_site_binding_origins')
    expect(schemaSql).toContain("WHERE environment.slug = 'shared'")
    expect(schemaSql).toContain('ON CONFLICT (environment_id, target_id) DO NOTHING')
    expect(schemaSql).toContain('site_bindings_official_environment_unique_idx')
  })

  it('indexes bounded matrix lookups and environment-scoped Artifact retention', () => {
    expect(schemaSql).toContain('build_jobs_environment_active_idx')
    expect(schemaSql).toContain('build_jobs_environment_history_idx')
    expect(schemaSql).toContain('artifacts_environment_catalog_idx')
  })

  it('creates upgrade-safe versioned V1 configuration groups with structured JSON items', () => {
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS configuration_groups')
    expect(schemaSql).toContain('configuration_groups_schema_version_v1')
    expect(schemaSql).toContain("CHECK (jsonb_typeof(items) = 'array')")
    expect(schemaSql).toContain('ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1')
    expect(schemaSql).toContain('SET updated_by = created_by')
    expect(schemaSql).toContain('SET updated_at = created_at')
    expect(schemaSql).toContain('cuddly_fill_configuration_group_audit')
    expect(schemaSql).toContain(
      "NEW.updated_by := COALESCE(NULLIF(BTRIM(NEW.updated_by), ''), NEW.created_by)"
    )
    expect(schemaSql).toContain('BEFORE INSERT ON configuration_groups')
    expect(schemaSql).toContain('configuration_groups_revision_positive')
    expect(schemaSql).toContain('configuration_groups_preview_hostname_prefix_valid')
    expect(schemaSql).toContain('configuration_groups_preview_hostname_prefix_idx')
    expect(schemaSql).toContain('ON configuration_groups(created_at DESC, token DESC)')
    expect(schemaSql).toMatch(
      /configuration_groups_environment_identity_fkey\s+FOREIGN KEY \(environment_id, environment_slug\) REFERENCES environments\(id, slug\)/
    )
    expect(schemaSql).toContain('site_binding_id text NOT NULL REFERENCES site_bindings(id)')
  })
})

describe('PostgresStore configuration groups', () => {
  it('maps persisted JSON items without exposing the row array', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const items = [
      { targetId: 'webapp', mode: 'official' as const },
      { targetId: 'base', mode: 'branch' as const, branch: 'feature/permissions' },
    ]
    const query = vi.spyOn(store.pool, 'query').mockResolvedValue({
      rows: [
        {
          token: 'share-token',
          preview_slug: '0123456789abcdef0123456789abcdef',
          preview_hostname_prefix: 'party-week',
          name: '频道权限重构',
          environment_id: environment.id,
          environment_slug: environment.slug,
          site_binding_id: 'main',
          schema_version: 1,
          items,
          revision: 3,
          created_by: 'gz',
          created_at: '2026-08-25T12:34:56.000Z',
          updated_by: 'qa',
          updated_at: '2026-08-25T13:34:56.000Z',
        },
      ],
    } as never)

    try {
      const group = await store.getConfigurationGroup('share-token')
      expect(query).toHaveBeenCalledWith('SELECT * FROM configuration_groups WHERE token = $1', [
        'share-token',
      ])
      expect(group).toEqual({
        token: 'share-token',
        previewSlug: '0123456789abcdef0123456789abcdef',
        previewHostnamePrefix: 'party-week',
        name: '频道权限重构',
        environmentId: environment.id,
        environmentSlug: environment.slug,
        siteBindingId: 'main',
        schemaVersion: 1,
        items,
        revision: 3,
        createdBy: 'gz',
        createdAt: '2026-08-25T12:34:56.000Z',
        updatedBy: 'qa',
        updatedAt: '2026-08-25T13:34:56.000Z',
      })
      group!.items.length = 0
      expect(items).toHaveLength(2)
    } finally {
      await store.close()
    }
  })

  it('lists lightweight records in deterministic newest-first order', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const query = vi.spyOn(store.pool, 'query').mockResolvedValue({
      rows: [
        configurationGroupRow({ token: 'newer', created_at: '2026-08-25T13:00:00.000Z' }),
        configurationGroupRow({ token: 'older' }),
      ],
    } as never)

    try {
      await expect(store.listConfigurationGroups()).resolves.toEqual([
        expect.objectContaining({ token: 'newer' }),
        expect.objectContaining({ token: 'older' }),
      ])
      expect(query).toHaveBeenCalledWith(
        'SELECT * FROM configuration_groups ORDER BY created_at DESC, token DESC'
      )
    } finally {
      await store.close()
    }
  })

  it('audits creation with the verified actor and initial snapshot', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const release = vi.fn()
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('FROM environments')) return { rows: [{ status: 'ACTIVE' }] }
      if (sql.includes('FROM site_bindings')) return { rows: [{ enabled: true }] }
      if (sql.includes('INSERT INTO configuration_groups')) {
        return { rows: [configurationGroupRow()] }
      }
      return { rows: [] }
    })
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release } as never)

    try {
      await expect(
        store.createConfigurationGroup({
          token: 'share-token',
          name: '频道权限重构',
          environmentId: environment.id,
          environmentSlug: environment.slug,
          siteBindingId: 'main',
          schemaVersion: 1,
          items: [{ targetId: 'webapp', mode: 'official' }],
          createdBy: 'gz',
        })
      ).resolves.toMatchObject({ token: 'share-token', revision: 1, updatedBy: 'gz' })
      const insert = statements.find(({ sql }) => sql.includes('INSERT INTO configuration_groups'))!
      expect(insert.sql).toContain('created_by, updated_by')
      const audit = statements.find(({ sql }) => sql.includes("'configuration-group.create'"))!
      expect(audit.values?.[1]).toBe('gz')
      expect(JSON.parse(String(audit.values?.[3]))).toMatchObject({
        revision: 1,
        environmentSlug: environment.slug,
      })
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await store.close()
    }
  })

  it('updates with an atomic revision check and writes an audit event', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const release = vi.fn()
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('SELECT revision FROM configuration_groups')) {
        return { rows: [{ revision: 1 }] }
      }
      if (sql.includes('FROM environments')) return { rows: [{ status: 'ACTIVE' }] }
      if (sql.includes('FROM site_bindings')) return { rows: [{ enabled: true }] }
      if (sql.includes('UPDATE configuration_groups')) {
        return {
          rows: [
            configurationGroupRow({
              name: '编辑后的需求',
              revision: 2,
              updated_by: 'qa',
              updated_at: '2026-08-25T13:00:00.000Z',
            }),
          ],
        }
      }
      return { rows: [] }
    })
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release } as never)

    try {
      await expect(
        store.updateConfigurationGroup(
          'share-token',
          {
            name: '编辑后的需求',
            environmentId: environment.id,
            environmentSlug: environment.slug,
            siteBindingId: 'main',
            schemaVersion: 1,
            items: [{ targetId: 'webapp', mode: 'official' }],
          },
          1,
          'qa'
        )
      ).resolves.toEqual({
        outcome: 'UPDATED',
        group: expect.objectContaining({ revision: 2, updatedBy: 'qa' }),
      })
      const update = statements.find(({ sql }) => sql.includes('UPDATE configuration_groups'))!
      expect(update.sql).toContain('revision = revision + 1')
      const audit = statements.find(({ sql }) => sql.includes("'configuration-group.update'"))!
      expect(audit.values?.[1]).toBe('qa')
      expect(JSON.parse(String(audit.values?.[3]))).toMatchObject({
        previousRevision: 1,
        revision: 2,
      })
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await store.close()
    }
  })

  it('distinguishes missing and conflicting updates before writing', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const release = vi.fn()
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT revision FROM configuration_groups')) {
        return { rows: values?.[0] === 'missing' ? [] : [{ revision: 4 }] }
      }
      return { rows: [] }
    })
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release } as never)
    const snapshot = {
      name: '需求',
      environmentId: environment.id,
      environmentSlug: environment.slug,
      siteBindingId: 'main',
      schemaVersion: 1 as const,
      items: [{ targetId: 'webapp', mode: 'official' as const }],
    }

    try {
      await expect(store.updateConfigurationGroup('missing', snapshot, 1, 'qa')).resolves.toEqual({
        outcome: 'NOT_FOUND',
      })
      await expect(
        store.updateConfigurationGroup('share-token', snapshot, 3, 'qa')
      ).resolves.toEqual({ outcome: 'CONFLICT', currentRevision: 4 })
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes('UPDATE configuration_groups'))
      ).toBe(false)
    } finally {
      await store.close()
    }
  })

  it('deletes once and audits only the successful deletion', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const statements: Array<{ sql: string; values?: unknown[] }> = []
    const release = vi.fn()
    let exists = true
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values })
      if (sql.includes('DELETE FROM configuration_groups')) {
        if (!exists) return { rows: [] }
        exists = false
        return { rows: [{ revision: 2 }] }
      }
      return { rows: [] }
    })
    vi.spyOn(store.pool, 'connect').mockResolvedValue({ query, release } as never)

    try {
      await expect(store.deleteConfigurationGroup('share-token', 'qa')).resolves.toBe(true)
      await expect(store.deleteConfigurationGroup('share-token', 'qa')).resolves.toBe(false)
      const audits = statements.filter(({ sql }) => sql.includes("'configuration-group.delete'"))
      expect(audits).toHaveLength(1)
      expect(audits[0]!.values?.[1]).toBe('qa')
      expect(JSON.parse(String(audits[0]!.values?.[3]))).toEqual({ revision: 2 })
    } finally {
      await store.close()
    }
  })
})

describe('PostgresStore Remote runtime authorization', () => {
  it('uses only active Preview sessions and ignores legacy Revision references', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const query = vi.spyOn(store.pool, 'query').mockResolvedValue({
      rows: [{ referenced: false }],
    } as never)

    try {
      expect(await store.isRemoteArtifactReferenced(artifact.id)).toBe(false)
      const sql = String(query.mock.calls[0]?.[0])
      expect(sql).toContain('FROM preview_sessions')
      expect(sql).not.toContain('environment_artifact_refs')
    } finally {
      await store.close()
    }
  })
})

describe('PostgresStore auth sessions', () => {
  const token = 'opaque-session-token'
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
  const row = {
    session_token_hash: tokenHash,
    tenant_key: 'tenant-1',
    open_id: 'open-1',
    union_id: '',
    name: '测试用户',
    avatar_url: '',
    csrf_token: 'csrf-token',
    created_at: '2026-08-25T12:00:00.000Z',
    expires_at: '2026-08-25T13:00:00.000Z',
  }

  it('persists and looks up only the SHA-256 token hash', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    vi.spyOn(store, 'getUserAccount').mockResolvedValue({
      id: 'public-id',
      name: '公开名字',
      displayName: '公开名字',
      avatarUrl: '',
    } as never)
    const query = vi.spyOn(store.pool, 'query')
    query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    try {
      const created = await store.createAuthSession({
        token,
        tenantKey: row.tenant_key,
        openId: row.open_id,
        unionId: row.union_id,
        name: row.name,
        avatarUrl: row.avatar_url,
        csrfToken: row.csrf_token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })
      expect(created).not.toHaveProperty('token')
      expect(created).not.toHaveProperty('tokenHash')
      expect(query.mock.calls[0]?.[1]).toEqual([
        tokenHash,
        row.tenant_key,
        row.open_id,
        row.union_id,
        '公开名字',
        row.avatar_url,
        row.csrf_token,
        row.created_at,
        row.expires_at,
        null,
        'legacy',
      ])
      expect(query.mock.calls[0]?.[1]).not.toContain(token)

      await expect(store.getAuthSession(token)).resolves.toEqual({
        tenantKey: row.tenant_key,
        openId: row.open_id,
        unionId: row.union_id,
        name: '公开名字',
        userId: 'public-id',
        kind: 'legacy',
        avatarUrl: row.avatar_url,
        csrfToken: row.csrf_token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      })
      expect(String(query.mock.calls[1]?.[0])).toContain('DELETE FROM auth_sessions')
      expect(String(query.mock.calls[1]?.[0])).toContain('expires_at <= now()')
      expect(String(query.mock.calls[1]?.[0])).toContain('expires_at > now()')
      expect(query.mock.calls[1]?.[1]).toEqual([tokenHash])

      await expect(store.deleteAuthSession(token)).resolves.toBe(true)
      expect(query.mock.calls[2]?.[1]).toEqual([tokenHash])
    } finally {
      await store.close()
    }
  })

  it('declares hashed session storage and expiry cleanup indexes', () => {
    const table = schemaSql.match(/CREATE TABLE IF NOT EXISTS auth_sessions \(([\s\S]*?)\n\);/)?.[1]
    expect(table).toContain('session_token_hash text PRIMARY KEY')
    expect(table).toContain("CHECK (session_token_hash ~ '^[0-9a-f]{64}$')")
    expect(table).not.toMatch(/^\s*(?:session_)?token\s/m)
    expect(schemaSql).toContain('auth_sessions_subject_idx')
    expect(schemaSql).toContain('auth_sessions_expires_idx')
  })
})
