import { createHash, randomUUID } from 'node:crypto'

import type {
  Artifact,
  ArtifactManifest,
  BranchCatalogItem,
  BuildJob,
  BuildJobEvent,
  BuildJobStatus,
  BuildTarget,
  ConfigurationGroup,
  EnvironmentMatrix,
  EnvironmentRecord,
  EnvironmentRevision,
  ProjectEnvironmentConfig,
  PreviewSession,
  SiteBinding,
} from '@cuddly/contracts'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'

import { schemaSql } from './schema'
import { hashAuthSessionToken } from './auth-session'
import { PROJECT_TEMPLATES } from './project-templates'
import {
  type AuthSession,
  type BuildJobPage,
  type BuildJobPageQuery,
  type BuildJobUpdate,
  type CompleteBuildJobRecord,
  type CreateAuthSessionRecord,
  type CreateBuildJobRecord,
  type CreateConfigurationGroupRecord,
  type CreatePreviewSessionRecord,
  type CuddlyStore,
  InvalidSelectionError,
  PREVIEW_REVOKE_GRACE_MS,
  type PublishRevisionRecord,
  RevisionConflictError,
  type RuntimeSettingChange,
  type RuntimeSettingRecord,
  type UpdateConfigurationGroupRecord,
  type UpdateConfigurationGroupResult,
} from './store'

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapTarget(row: QueryResultRow): BuildTarget {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    repositoryUrl: row.repository_url,
    defaultBranch: row.default_branch,
    installCommand: row.install_command,
    buildCommand: row.build_command,
    outputDirectory: row.output_directory,
    siteAdapter: row.site_adapter,
    enabled: row.enabled,
    required: row.required,
    configurationSource: row.configuration_source,
  }
}

function mapJob(row: QueryResultRow): BuildJob {
  return {
    id: row.id,
    environmentId: row.environment_id,
    environmentSlug: row.environment_slug,
    targetId: row.target_id,
    branch: row.branch,
    profile: row.profile,
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    logPath: row.log_path,
    targetSnapshot: row.target_snapshot ?? null,
  }
}

function mapJobEvent(row: QueryResultRow): BuildJobEvent {
  return {
    id: String(row.id),
    jobId: row.job_id,
    status: row.status,
    createdAt: iso(row.created_at)!,
  }
}

function mapArtifact(row: QueryResultRow): Artifact {
  return {
    id: row.id,
    buildJobId: row.build_job_id,
    environmentId: row.environment_id,
    environmentSlug: row.environment_slug,
    targetId: row.target_id,
    branch: row.branch,
    status: row.status,
    storageKey: row.storage_key,
    manifest: row.manifest as ArtifactManifest,
    builtAt: iso(row.built_at)!,
    createdBy: row.created_by,
  }
}

function mapEnvironment(row: QueryResultRow): EnvironmentRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    status: row.status,
    backendOrigin: row.backend_origin,
    useInternalProxy: row.use_internal_proxy === true,
    resourceProxyPrefixes: [...((row.resource_proxy_prefixes as string[] | null) ?? [])],
    currentRevisionId: row.current_revision_id,
  }
}

function mapProjectEnvironmentConfig(row: QueryResultRow): ProjectEnvironmentConfig {
  return {
    targetId: row.target_id,
    environmentId: row.environment_id,
    enabled: row.enabled,
    required: row.required,
    installCommand: row.install_command,
    buildCommand: row.build_command,
    outputDirectory: row.output_directory,
  }
}

function mapPreviewSession(row: QueryResultRow): PreviewSession {
  return {
    token: row.token,
    environmentId: row.environment_id,
    environmentSlug: row.environment_slug,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
    siteBindingId: row.site_binding_id ?? undefined,
    siteArtifactId: row.site_artifact_id ?? undefined,
    selections: row.selections as PreviewSession['selections'],
  }
}

function mapConfigurationGroup(row: QueryResultRow): ConfigurationGroup {
  const previewSlug =
    typeof row.preview_slug === 'string' && row.preview_slug
      ? row.preview_slug
      : createHash('md5').update(String(row.token)).digest('hex')
  return {
    token: row.token,
    previewSlug,
    previewHostnamePrefix: row.preview_hostname_prefix ?? `p-${previewSlug}`,
    name: row.name,
    environmentId: row.environment_id,
    environmentSlug: row.environment_slug,
    siteBindingId: row.site_binding_id,
    schemaVersion: row.schema_version as 1,
    items: (row.items as ConfigurationGroup['items']).map((item) => ({ ...item })),
    revision: Number(row.revision ?? 1),
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedBy: row.updated_by ?? row.created_by,
    updatedAt: iso(row.updated_at ?? row.created_at)!,
  }
}

function mapAuthSession(row: QueryResultRow): AuthSession {
  return {
    tenantKey: row.tenant_key,
    openId: row.open_id,
    unionId: row.union_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    csrfToken: row.csrf_token,
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
  }
}

function mapSiteBinding(row: QueryResultRow): SiteBinding {
  const fallbackOrigin = row.fallback_origin ?? row.upstream_origin
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    targetId: row.target_id,
    environmentSlug: row.environment_slug,
    fallbackOrigin,
    upstreamOrigin: row.upstream_origin ?? fallbackOrigin,
    officialOrigin: row.official_origin,
    enabled: row.enabled,
    remoteTargetIds: [...(row.remote_target_ids as string[])],
    resourceProxyPrefixes: [...(row.resource_proxy_prefixes as string[])],
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

export class PostgresStore implements CuddlyStore {
  readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('cuddly-schema-v1'))")
      await client.query(schemaSql)
      for (const target of PROJECT_TEMPLATES) {
        await client.query(
          `INSERT INTO build_targets
            (id, name, kind, repository_url, default_branch, install_command, build_command,
             output_directory, site_adapter, enabled, required, configuration_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            target.id,
            target.name,
            target.kind,
            target.repositoryUrl,
            target.defaultBranch,
            target.installCommand,
            target.buildCommand,
            target.outputDirectory,
            target.siteAdapter,
            target.enabled,
            target.required,
            target.configurationSource,
          ]
        )
      }
      await client.query(
        `INSERT INTO project_environment_configs
          (target_id, environment_id, enabled, required, install_command, build_command, output_directory)
         SELECT target.id, environment.id, target.enabled, target.required,
                target.install_command, target.build_command, target.output_directory
         FROM build_targets AS target
         CROSS JOIN environments AS environment
         WHERE environment.slug = 'shared'
         ON CONFLICT (environment_id, target_id) DO NOTHING`
      )
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('cuddly-schema-v1'))")
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async listBuildTargets(includeDisabled = false): Promise<BuildTarget[]> {
    const result = await this.pool.query(
      `SELECT * FROM build_targets
       ${includeDisabled ? '' : 'WHERE enabled = true'}
       ORDER BY created_at, id`
    )
    return result.rows.map(mapTarget)
  }

  async getBuildTarget(id: string): Promise<BuildTarget | null> {
    const result = await this.pool.query('SELECT * FROM build_targets WHERE id = $1', [id])
    return result.rows[0] ? mapTarget(result.rows[0]) : null
  }

  async saveBuildTarget(target: BuildTarget, actor: string): Promise<BuildTarget> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `INSERT INTO build_targets
          (id, name, kind, repository_url, default_branch, install_command, build_command,
           output_directory, site_adapter, enabled, required, configuration_source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           kind = EXCLUDED.kind,
           repository_url = EXCLUDED.repository_url,
           default_branch = EXCLUDED.default_branch,
           install_command = EXCLUDED.install_command,
           build_command = EXCLUDED.build_command,
           output_directory = EXCLUDED.output_directory,
           site_adapter = EXCLUDED.site_adapter,
           enabled = EXCLUDED.enabled,
           required = EXCLUDED.required,
           configuration_source = EXCLUDED.configuration_source,
           updated_at = now()
         RETURNING *`,
        [
          target.id,
          target.name,
          target.kind,
          target.repositoryUrl,
          target.defaultBranch,
          target.installCommand,
          target.buildCommand,
          target.outputDirectory,
          target.siteAdapter,
          target.enabled,
          target.required,
          target.configurationSource,
        ]
      )
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'build-target.save', 'build-target', $3, $4::jsonb)`,
        [
          randomUUID(),
          actor,
          target.id,
          JSON.stringify({
            source: target.configurationSource,
            enabled: target.enabled,
            required: target.required,
          }),
        ]
      )
      await client.query(
        `INSERT INTO project_environment_configs
          (target_id, environment_id, enabled, required, install_command, build_command, output_directory)
         SELECT $1, environment.id, $2, $3, $4, $5, $6
         FROM environments AS environment
         WHERE environment.slug = 'shared'
         ON CONFLICT (environment_id, target_id) DO NOTHING`,
        [
          target.id,
          target.enabled,
          target.required,
          target.installCommand,
          target.buildCommand,
          target.outputDirectory,
        ]
      )
      await client.query('COMMIT')
      return mapTarget(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listEnvironments(includeArchived = false): Promise<EnvironmentRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM environments
       ${includeArchived ? '' : "WHERE status <> 'ARCHIVED'"}
       ORDER BY sort_order, name, slug, id`
    )
    return result.rows.map(mapEnvironment)
  }

  async getEnvironment(idOrSlug: string): Promise<EnvironmentRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM environments WHERE id::text = $1 OR slug = $1',
      [idOrSlug]
    )
    return result.rows[0] ? mapEnvironment(result.rows[0]) : null
  }

  async saveEnvironment(environment: EnvironmentRecord, actor: string): Promise<EnvironmentRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query(
        'SELECT id, slug FROM environments WHERE id = $1 FOR UPDATE',
        [environment.id]
      )
      if (existing.rows[0] && existing.rows[0].slug !== environment.slug) {
        throw new InvalidSelectionError('Environment slug cannot be changed')
      }
      const result = await client.query(
        `INSERT INTO environments
           (id, slug, name, status, backend_origin, use_internal_proxy,
            resource_proxy_prefixes, current_revision_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9::integer, 0))
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           backend_origin = EXCLUDED.backend_origin,
           use_internal_proxy = EXCLUDED.use_internal_proxy,
           resource_proxy_prefixes = EXCLUDED.resource_proxy_prefixes,
           sort_order = COALESCE($9::integer, environments.sort_order)
         RETURNING *`,
        [
          environment.id,
          environment.slug,
          environment.name,
          environment.status,
          environment.backendOrigin,
          environment.useInternalProxy,
          JSON.stringify(environment.resourceProxyPrefixes ?? []),
          environment.currentRevisionId,
          environment.sortOrder ?? null,
        ]
      )
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'environment.save', 'environment', $3, $4::jsonb)`,
        [
          randomUUID(),
          actor,
          environment.id,
          JSON.stringify({
            slug: environment.slug,
            sortOrder: result.rows[0].sort_order ?? 0,
            name: environment.name,
            status: environment.status,
            backendOrigin: environment.backendOrigin,
            useInternalProxy: environment.useInternalProxy,
            resourceProxyPrefixes: environment.resourceProxyPrefixes ?? [],
          }),
        ]
      )
      await client.query('COMMIT')
      return mapEnvironment(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listProjectEnvironmentConfigs(environmentId: string): Promise<ProjectEnvironmentConfig[]> {
    const result = await this.pool.query(
      `SELECT * FROM project_environment_configs
       WHERE environment_id = $1
       ORDER BY target_id`,
      [environmentId]
    )
    return result.rows.map(mapProjectEnvironmentConfig)
  }

  async getProjectEnvironmentConfig(
    environmentId: string,
    targetId: string
  ): Promise<ProjectEnvironmentConfig | null> {
    const result = await this.pool.query(
      `SELECT * FROM project_environment_configs
       WHERE environment_id = $1 AND target_id = $2`,
      [environmentId, targetId]
    )
    return result.rows[0] ? mapProjectEnvironmentConfig(result.rows[0]) : null
  }

  async saveProjectEnvironmentConfig(
    config: ProjectEnvironmentConfig,
    actor: string
  ): Promise<ProjectEnvironmentConfig> {
    return (await this.saveProjectEnvironmentConfigs([config], actor))[0]!
  }

  async saveProjectEnvironmentConfigs(
    configs: ProjectEnvironmentConfig[],
    actor: string
  ): Promise<ProjectEnvironmentConfig[]> {
    if (configs.length === 0) return []
    if (new Set(configs.map((config) => config.environmentId)).size > 1) {
      throw new InvalidSelectionError('Project environment configs must belong to one environment')
    }
    if (new Set(configs.map((config) => config.targetId)).size !== configs.length) {
      throw new InvalidSelectionError('Project environment config targets must be unique')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const saved: ProjectEnvironmentConfig[] = []
      for (const config of configs) {
        const result = await client.query(
          `INSERT INTO project_environment_configs
            (target_id, environment_id, enabled, required, install_command, build_command,
             output_directory, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (environment_id, target_id) DO UPDATE SET
             enabled = EXCLUDED.enabled,
             required = EXCLUDED.required,
             install_command = EXCLUDED.install_command,
             build_command = EXCLUDED.build_command,
             output_directory = EXCLUDED.output_directory,
             updated_at = now()
           RETURNING *`,
          [
            config.targetId,
            config.environmentId,
            config.enabled,
            config.required,
            config.installCommand,
            config.buildCommand,
            config.outputDirectory,
          ]
        )
        saved.push(mapProjectEnvironmentConfig(result.rows[0]!))
      }
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'project-environment-config.save', 'environment', $3, $4::jsonb)`,
        [randomUUID(), actor, configs[0]!.environmentId, JSON.stringify({ configs })]
      )
      await client.query('COMMIT')
      return saved
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createBuildJob(record: CreateBuildJobRecord): Promise<BuildJob> {
    if (record.idempotencyKey) {
      const existing = await this.pool.query(
        'SELECT * FROM build_jobs WHERE idempotency_key = $1',
        [record.idempotencyKey]
      )
      if (existing.rows[0]) {
        const job = mapJob(existing.rows[0])
        if (
          job.environmentId !== record.environmentId ||
          job.environmentSlug !== record.environmentSlug ||
          job.targetId !== record.targetId ||
          job.branch !== record.branch ||
          job.profile !== record.profile
        ) {
          throw new InvalidSelectionError(
            'Idempotency key conflicts with a different build request'
          )
        }
        return job
      }
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const buildability = await client.query(
        `SELECT environment.status AS environment_status,
                target.enabled AS target_enabled,
                config.enabled AS config_enabled
         FROM environments AS environment
         JOIN build_targets AS target ON target.id = $3
         JOIN project_environment_configs AS config
           ON config.environment_id = environment.id AND config.target_id = target.id
         WHERE environment.id = $1 AND environment.slug = $2
         FOR SHARE OF environment, target, config`,
        [record.environmentId, record.environmentSlug, record.targetId]
      )
      const state = buildability.rows[0]
      if (!state) {
        throw new InvalidSelectionError(`Build environment is invalid: ${record.environmentSlug}`)
      }
      if (state.environment_status !== 'ACTIVE') {
        throw new InvalidSelectionError(
          `Build environment is not active: ${record.environmentSlug}`
        )
      }
      if (state.target_enabled !== true || state.config_enabled !== true) {
        throw new InvalidSelectionError(`Project is not enabled in environment: ${record.targetId}`)
      }
      const result = await client.query(
        `INSERT INTO build_jobs
          (id, environment_id, environment_slug, target_id, branch, profile, status, requested_by,
           idempotency_key, target_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', $7, $8, $9::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.environmentId,
          record.environmentSlug,
          record.targetId,
          record.branch,
          record.profile,
          record.requestedBy,
          record.idempotencyKey,
          JSON.stringify(record.targetSnapshot),
        ]
      )
      if (!result.rows[0] && record.idempotencyKey) {
        const concurrent = await client.query(
          'SELECT * FROM build_jobs WHERE idempotency_key = $1',
          [record.idempotencyKey]
        )
        const job = concurrent.rows[0] ? mapJob(concurrent.rows[0]) : null
        if (
          !job ||
          job.environmentId !== record.environmentId ||
          job.environmentSlug !== record.environmentSlug ||
          job.targetId !== record.targetId ||
          job.branch !== record.branch ||
          job.profile !== record.profile
        ) {
          throw new InvalidSelectionError(
            'Idempotency key conflicts with a different build request'
          )
        }
        await client.query('COMMIT')
        return job
      }
      await client.query(
        'INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, $2, $3)',
        [record.id, 'QUEUED', result.rows[0]!.created_at]
      )
      await client.query('COMMIT')
      return mapJob(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getBuildJob(id: string): Promise<BuildJob | null> {
    const result = await this.pool.query('SELECT * FROM build_jobs WHERE id = $1', [id])
    return result.rows[0] ? mapJob(result.rows[0]) : null
  }

  async listBuildJobs(targetId?: string, environmentId?: string): Promise<BuildJob[]> {
    const conditions: string[] = []
    const parameters: string[] = []
    if (targetId) {
      parameters.push(targetId)
      conditions.push(`target_id = $${parameters.length}`)
    }
    if (environmentId) {
      parameters.push(environmentId)
      conditions.push(`environment_id = $${parameters.length}::uuid`)
    }
    const result = await this.pool.query(
      `SELECT * FROM build_jobs
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT 200`,
      parameters
    )
    return result.rows.map(mapJob)
  }

  async listBuildJobPage(query: BuildJobPageQuery): Promise<BuildJobPage> {
    const conditions = ['environment_id = $1::uuid']
    const parameters: Array<string | number> = [query.environmentId]
    if (query.targetId) {
      parameters.push(query.targetId)
      conditions.push(`target_id = $${parameters.length}`)
    }
    if (query.status) {
      parameters.push(query.status)
      conditions.push(`status = $${parameters.length}`)
    }
    const search = query.query?.trim().toLowerCase() || ''
    if (search) {
      parameters.push(search)
      const parameter = `$${parameters.length}`
      conditions.push(
        `(strpos(lower(id::text), ${parameter}) > 0 OR strpos(lower(branch), ${parameter}) > 0 OR strpos(lower(requested_by), ${parameter}) > 0)`
      )
    }
    const where = `WHERE ${conditions.join(' AND ')}`
    const limitParameter = `$${parameters.length + 1}`
    const offsetParameter = `$${parameters.length + 2}`
    const offset = (query.page - 1) * query.pageSize
    const [itemsResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM build_jobs
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        [...parameters, query.pageSize, offset]
      ),
      this.pool.query(`SELECT count(*) AS total FROM build_jobs ${where}`, parameters),
    ])
    const total = Number(countResult.rows[0]?.total ?? 0)
    return {
      items: itemsResult.rows.map(mapJob),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    }
  }

  async listBuildQueue(): Promise<BuildJob[]> {
    const result = await this.pool.query(
      `SELECT * FROM build_jobs
       WHERE status IN ('QUEUED', 'LEASED', 'CHECKOUT', 'INSTALLING', 'BUILDING', 'VALIDATING', 'UPLOADING', 'CANCELING')
       ORDER BY
         CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END,
         COALESCE(started_at, created_at),
         created_at,
         id`
    )
    return result.rows.map(mapJob)
  }

  async claimNextBuildJob(workerId: string): Promise<BuildJob | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `WITH candidate AS (
         SELECT queued.id
         FROM build_jobs AS queued
         WHERE queued.status = 'QUEUED'
           AND NOT EXISTS (
             SELECT 1
             FROM build_jobs AS active
             WHERE active.target_id = queued.target_id
               AND active.status IN (
                  'LEASED', 'CHECKOUT', 'INSTALLING', 'BUILDING', 'VALIDATING', 'UPLOADING', 'CANCELING'
               )
           )
         ORDER BY queued.created_at, queued.id
         FOR UPDATE OF queued SKIP LOCKED
         LIMIT 1
       )
       UPDATE build_jobs AS job
       SET status = 'LEASED', worker_id = $1, started_at = now()
       FROM candidate
       WHERE job.id = candidate.id
         RETURNING job.*`,
        [workerId]
      )
      if (result.rows[0]) {
        await client.query(
          'INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, $2, $3)',
          [result.rows[0].id, result.rows[0].status, result.rows[0].started_at]
        )
      }
      await client.query('COMMIT')
      return result.rows[0] ? mapJob(result.rows[0]) : null
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateBuildJob(id: string, update: BuildJobUpdate): Promise<BuildJob> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const previous = await client.query(
        'SELECT status FROM build_jobs WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!previous.rows[0]) throw new Error(`Build job not found: ${id}`)
      const result = await client.query(
        `UPDATE build_jobs
       SET status = $2,
           started_at = COALESCE($3::timestamptz, started_at),
           finished_at = COALESCE($4::timestamptz, finished_at),
           failure_code = $5,
           failure_message = $6,
           log_path = COALESCE($7, log_path)
       WHERE id = $1
         RETURNING *`,
        [
          id,
          update.status,
          update.startedAt ?? null,
          update.finishedAt ?? null,
          update.failureCode ?? null,
          update.failureMessage ?? null,
          update.logPath ?? null,
        ]
      )
      if (previous.rows[0].status !== update.status) {
        await client.query(
          'INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, $2, $3)',
          [id, update.status, update.finishedAt ?? new Date().toISOString()]
        )
      }
      await client.query('COMMIT')
      return mapJob(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async transitionBuildJob(
    id: string,
    expectedStatuses: readonly BuildJobStatus[],
    update: BuildJobUpdate
  ): Promise<BuildJob | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE build_jobs
         SET status = $2,
             started_at = COALESCE($3::timestamptz, started_at),
             finished_at = COALESCE($4::timestamptz, finished_at),
             failure_code = $5,
             failure_message = $6,
             log_path = COALESCE($7, log_path)
         WHERE id = $1
           AND status = ANY($8::text[])
         RETURNING *`,
        [
          id,
          update.status,
          update.startedAt ?? null,
          update.finishedAt ?? null,
          update.failureCode ?? null,
          update.failureMessage ?? null,
          update.logPath ?? null,
          [...expectedStatuses],
        ]
      )
      if (!result.rows[0]) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        'INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, $2, $3)',
        [id, update.status, update.finishedAt ?? new Date().toISOString()]
      )
      await client.query('COMMIT')
      return mapJob(result.rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async requestBuildJobCancellation(id: string, actor: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query('SELECT * FROM build_jobs WHERE id = $1 FOR UPDATE', [id])
      if (!current.rows[0]) {
        await client.query('COMMIT')
        return { outcome: 'NOT_FOUND' as const, job: null }
      }

      const job = mapJob(current.rows[0])
      if (job.status === 'CANCELED') {
        await client.query('COMMIT')
        return { outcome: 'CANCELED' as const, job }
      }
      if (job.status === 'CANCELING') {
        await client.query('COMMIT')
        return { outcome: 'CANCELING' as const, job }
      }
      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
        await client.query('COMMIT')
        return { outcome: 'NOT_CANCELABLE' as const, job }
      }

      const nextStatus = job.status === 'QUEUED' ? 'CANCELED' : 'CANCELING'
      const result = await client.query(
        `UPDATE build_jobs
         SET status = $2,
             finished_at = CASE WHEN $2 = 'CANCELED' THEN now() ELSE finished_at END,
             failure_code = CASE WHEN $2 = 'CANCELED' THEN 'BUILD_CANCELED' ELSE failure_code END,
             failure_message = CASE WHEN $2 = 'CANCELED' THEN '构建已被提前中断' ELSE failure_message END
         WHERE id = $1
         RETURNING *`,
        [id, nextStatus]
      )
      const updated = mapJob(result.rows[0]!)
      await client.query(
        'INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, $2, $3)',
        [id, nextStatus, updated.finishedAt ?? new Date().toISOString()]
      )
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'build-job.cancel', 'build-job', $3, $4::jsonb)`,
        [
          randomUUID(),
          actor,
          id,
          JSON.stringify({ previousStatus: job.status, status: nextStatus }),
        ]
      )
      await client.query('COMMIT')
      return { outcome: nextStatus as 'CANCELED' | 'CANCELING', job: updated }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async completeBuildJob(id: string, record: CompleteBuildJobRecord): Promise<BuildJob | null> {
    if (record.artifact.buildJobId !== id || record.artifact.status !== 'READY') {
      throw new Error(`Invalid successful Artifact for build job: ${id}`)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT status, environment_id, environment_slug, target_id, branch
         FROM build_jobs WHERE id = $1 FOR UPDATE`,
        [id]
      )
      if (!current.rows[0] || current.rows[0].status !== 'UPLOADING') {
        await client.query('COMMIT')
        return null
      }
      if (
        record.artifact.targetId !== current.rows[0].target_id ||
        record.artifact.branch !== current.rows[0].branch ||
        record.artifact.environmentId !== current.rows[0].environment_id ||
        record.artifact.environmentSlug !== current.rows[0].environment_slug
      ) {
        throw new Error(`Successful Artifact does not match build job: ${id}`)
      }

      await client.query(
        `INSERT INTO artifacts
          (id, build_job_id, environment_id, environment_slug, target_id, branch, status,
           storage_key, manifest, built_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
        [
          record.artifact.id,
          record.artifact.buildJobId,
          record.artifact.environmentId,
          record.artifact.environmentSlug,
          record.artifact.targetId,
          record.artifact.branch,
          record.artifact.status,
          record.artifact.storageKey,
          JSON.stringify(record.artifact.manifest),
          record.artifact.builtAt,
          record.artifact.createdBy,
        ]
      )
      const result = await client.query(
        `UPDATE build_jobs
         SET status = 'SUCCEEDED',
             finished_at = $2,
             failure_code = NULL,
             failure_message = NULL,
             log_path = $3
         WHERE id = $1
         RETURNING *`,
        [id, record.finishedAt, record.logPath]
      )
      await client.query(
        "INSERT INTO build_job_events (job_id, status, created_at) VALUES ($1, 'SUCCEEDED', $2)",
        [id, record.finishedAt]
      )
      await client.query('COMMIT')
      return mapJob(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listBuildJobEvents(jobId: string): Promise<BuildJobEvent[]> {
    const result = await this.pool.query(
      'SELECT * FROM build_job_events WHERE job_id = $1 ORDER BY created_at, id',
      [jobId]
    )
    return result.rows.map(mapJobEvent)
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const job = await client.query(
        `SELECT environment_id, environment_slug, target_id, branch
         FROM build_jobs WHERE id = $1 FOR SHARE`,
        [artifact.buildJobId]
      )
      if (
        !job.rows[0] ||
        job.rows[0].environment_id !== artifact.environmentId ||
        job.rows[0].environment_slug !== artifact.environmentSlug ||
        job.rows[0].target_id !== artifact.targetId ||
        job.rows[0].branch !== artifact.branch
      ) {
        throw new InvalidSelectionError(`Artifact does not match build job: ${artifact.id}`)
      }
      const result = await client.query(
        `INSERT INTO artifacts
          (id, build_job_id, environment_id, environment_slug, target_id, branch, status,
           storage_key, manifest, built_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         RETURNING *`,
        [
          artifact.id,
          artifact.buildJobId,
          artifact.environmentId,
          artifact.environmentSlug,
          artifact.targetId,
          artifact.branch,
          artifact.status,
          artifact.storageKey,
          JSON.stringify(artifact.manifest),
          artifact.builtAt,
          artifact.createdBy,
        ]
      )
      await client.query('COMMIT')
      return mapArtifact(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const result = await this.pool.query('SELECT * FROM artifacts WHERE id = $1', [id])
    return result.rows[0] ? mapArtifact(result.rows[0]) : null
  }

  async getArtifactsByIds(ids: string[]): Promise<Artifact[]> {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return []
    const result = await this.pool.query(
      `SELECT *
       FROM artifacts
       WHERE id = ANY($1::uuid[])
       ORDER BY array_position($1::uuid[], id)`,
      [uniqueIds]
    )
    return result.rows.map(mapArtifact)
  }

  async getArtifactByBuildJobId(buildJobId: string): Promise<Artifact | null> {
    const result = await this.pool.query('SELECT * FROM artifacts WHERE build_job_id = $1', [
      buildJobId,
    ])
    return result.rows[0] ? mapArtifact(result.rows[0]) : null
  }

  async listArtifacts(
    targetId: string,
    branch?: string,
    environmentId?: string
  ): Promise<Artifact[]> {
    const conditions = ['target_id = $1', "status = 'READY'"]
    const parameters = [targetId]
    if (branch) {
      parameters.push(branch)
      conditions.push(`branch = $${parameters.length}`)
    }
    if (environmentId) {
      parameters.push(environmentId)
      conditions.push(`environment_id = $${parameters.length}::uuid`)
    }
    const result = await this.pool.query(
      `SELECT * FROM artifacts
       WHERE ${conditions.join(' AND ')}
       ORDER BY built_at DESC`,
      parameters
    )
    return result.rows.map(mapArtifact)
  }

  async listBranchCatalog(targetId: string, environmentId?: string): Promise<BranchCatalogItem[]> {
    const activeStatuses = [
      'QUEUED',
      'LEASED',
      'CHECKOUT',
      'INSTALLING',
      'BUILDING',
      'VALIDATING',
      'UPLOADING',
      'CANCELING',
    ]
    const [targetResult, jobsResult, activeResult, artifactsResult] = await Promise.all([
      this.pool.query('SELECT default_branch FROM build_targets WHERE id = $1', [targetId]),
      this.pool.query(
        `SELECT DISTINCT ON (branch)
                branch, id, status, created_at, finished_at, failure_message
         FROM build_jobs
         WHERE target_id = $1
           AND ($2::uuid IS NULL OR environment_id = $2)
         ORDER BY branch, created_at DESC, id DESC`,
        [targetId, environmentId ?? null]
      ),
      this.pool.query(
        `SELECT DISTINCT branch
         FROM build_jobs
         WHERE target_id = $1
           AND ($2::uuid IS NULL OR environment_id = $2)
           AND status = ANY($3::text[])`,
        [targetId, environmentId ?? null, activeStatuses]
      ),
      this.pool.query(
        `SELECT DISTINCT ON (branch) branch, id, built_at
         FROM artifacts
         WHERE target_id = $1
           AND ($2::uuid IS NULL OR environment_id = $2)
           AND status = 'READY'
         ORDER BY branch, built_at DESC, id DESC`,
        [targetId, environmentId ?? null]
      ),
    ])
    const branches = new Set<string>()
    const defaultBranch = targetResult.rows[0]?.default_branch as string | undefined
    if (defaultBranch) branches.add(defaultBranch)
    const latestJobs = new Map(jobsResult.rows.map((row) => [String(row.branch), row]))
    const activeBranches = new Set(activeResult.rows.map((row) => String(row.branch)))
    const latestArtifacts = new Map(artifactsResult.rows.map((row) => [String(row.branch), row]))
    jobsResult.rows.forEach((row) => branches.add(String(row.branch)))
    artifactsResult.rows.forEach((row) => branches.add(String(row.branch)))
    return [...branches].sort().map((branch) => {
      const latestJob = latestJobs.get(branch) ?? null
      const latestArtifact = latestArtifacts.get(branch) ?? null
      return {
        branch,
        buildStatus: activeBranches.has(branch)
          ? 'BUILDING'
          : latestJob?.status === 'FAILED'
            ? 'FAILED'
            : 'IDLE',
        latestArtifact: latestArtifact
          ? {
              id: latestArtifact.id,
              branch,
              builtAt: iso(latestArtifact.built_at)!,
            }
          : null,
        latestJob: latestJob
          ? {
              id: latestJob.id,
              status: latestJob.status,
              createdAt: iso(latestJob.created_at)!,
              finishedAt: iso(latestJob.finished_at),
              failureMessage: latestJob.failure_message,
            }
          : null,
      }
    })
  }

  async claimArtifactCleanupCandidates(limit: number) {
    const boundedLimit = Math.max(0, Math.min(200, Math.floor(limit)))
    if (boundedLimit === 0) return []
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cuddly-artifact-reference-lifecycle-v1'))"
      )
      const result = await client.query(
        `WITH ranked_ready AS (
           SELECT id,
                  row_number() OVER (
                    PARTITION BY environment_id, target_id, branch
                    ORDER BY built_at DESC, id DESC
                  ) AS branch_rank
           FROM artifacts
           WHERE status = 'READY'
         ), eligible AS (
           SELECT artifact.id
           FROM artifacts AS artifact
           LEFT JOIN ranked_ready AS ranked ON ranked.id = artifact.id
           WHERE (
               (artifact.status = 'READY' AND ranked.branch_rank > 1)
               OR (
                 artifact.status = 'DELETING'
                 AND COALESCE(artifact.deletion_started_at, artifact.created_at)
                   < now() - interval '5 minutes'
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM environments AS environment
               JOIN environment_revision_items AS item
                 ON item.revision_id = environment.current_revision_id
               WHERE item.artifact_id = artifact.id
             )
             AND NOT EXISTS (
               SELECT 1
               FROM preview_sessions AS preview
               WHERE preview.expires_at > now()
                 AND (
                   preview.revoked_at IS NULL
                   OR preview.revoked_at > now() - ($2 * interval '1 millisecond')
                 )
                 AND (
                   preview.site_artifact_id = artifact.id
                   OR preview.selections @> jsonb_build_array(
                     jsonb_build_object('artifactId', artifact.id)
                   )
                 )
             )
           ORDER BY artifact.built_at, artifact.id
           LIMIT $1
         )
         UPDATE artifacts AS artifact
         SET status = 'DELETING', deletion_started_at = now()
         FROM eligible
         WHERE artifact.id = eligible.id
         RETURNING artifact.id, artifact.target_id, artifact.branch, artifact.storage_key`,
        [boundedLimit, PREVIEW_REVOKE_GRACE_MS]
      )
      await client.query('COMMIT')
      return result.rows.map((row) => ({
        id: row.id as string,
        targetId: row.target_id as string,
        branch: row.branch as string,
        storageKey: row.storage_key as string,
      }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async completeArtifactDeletion(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE artifacts
       SET status = 'DELETED', deletion_started_at = NULL
       WHERE id = $1 AND status = 'DELETING'`,
      [id]
    )
  }

  async restoreArtifactDeletion(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE artifacts
       SET status = 'READY', deletion_started_at = NULL
       WHERE id = $1 AND status = 'DELETING'`,
      [id]
    )
  }

  async getRuntimeSettings(keys: string[]): Promise<RuntimeSettingRecord[]> {
    if (keys.length === 0) return []
    const result = await this.pool.query(
      'SELECT * FROM runtime_settings WHERE key = ANY($1::text[]) ORDER BY key',
      [keys]
    )
    return result.rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedBy: row.updated_by,
      updatedAt: iso(row.updated_at)!,
    }))
  }

  async updateRuntimeSettings(changes: RuntimeSettingChange[], actor: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const change of changes) {
        if (change.value === null) {
          await client.query('DELETE FROM runtime_settings WHERE key = $1', [change.key])
          continue
        }
        await client.query(
          `INSERT INTO runtime_settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [change.key, JSON.stringify(change.value), actor]
        )
      }
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'runtime_settings.update', 'settings', 'runtime', $3::jsonb)`,
        [
          randomUUID(),
          actor,
          JSON.stringify({
            keys: changes.map((change) => change.key),
            reset: changes.filter((change) => change.value === null).map((change) => change.key),
          }),
        ]
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createAuthSession(record: CreateAuthSessionRecord): Promise<AuthSession> {
    const result = await this.pool.query(
      `INSERT INTO auth_sessions
        (session_token_hash, tenant_key, open_id, union_id, name, avatar_url, csrf_token,
         created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        hashAuthSessionToken(record.token),
        record.tenantKey,
        record.openId,
        record.unionId,
        record.name,
        record.avatarUrl,
        record.csrfToken,
        record.createdAt,
        record.expiresAt,
      ]
    )
    return mapAuthSession(result.rows[0]!)
  }

  async getAuthSession(token: string): Promise<AuthSession | null> {
    const result = await this.pool.query(
      `WITH expired AS (
         DELETE FROM auth_sessions
         WHERE session_token_hash = $1 AND expires_at <= now()
         RETURNING session_token_hash
       )
       SELECT tenant_key, open_id, union_id, name, avatar_url, csrf_token,
              created_at, expires_at
       FROM auth_sessions
       WHERE session_token_hash = $1 AND expires_at > now()`,
      [hashAuthSessionToken(token)]
    )
    return result.rows[0] ? mapAuthSession(result.rows[0]) : null
  }

  async deleteAuthSession(token: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM auth_sessions WHERE session_token_hash = $1',
      [hashAuthSessionToken(token)]
    )
    return (result.rowCount ?? 0) > 0
  }

  async listSiteBindings(includeDisabled = false): Promise<SiteBinding[]> {
    const result = await this.pool.query(
      `SELECT * FROM site_bindings
       ${includeDisabled ? '' : 'WHERE enabled = true'}
       ORDER BY hostname, id`
    )
    return result.rows.map(mapSiteBinding)
  }

  async getSiteBinding(id: string): Promise<SiteBinding | null> {
    const result = await this.pool.query('SELECT * FROM site_bindings WHERE id = $1', [id])
    return result.rows[0] ? mapSiteBinding(result.rows[0]) : null
  }

  async getSiteBindingByHostname(
    hostname: string,
    includeDisabled = false
  ): Promise<SiteBinding | null> {
    const result = await this.pool.query(
      `SELECT * FROM site_bindings
       WHERE hostname = $1 ${includeDisabled ? '' : 'AND enabled = true'}`,
      [normalizeHostname(hostname)]
    )
    return result.rows[0] ? mapSiteBinding(result.rows[0]) : null
  }

  async getSiteBindingByOfficialOrigin(officialOrigin: string): Promise<SiteBinding | null> {
    const bindings = await this.listSiteBindingsByOfficialOrigin(officialOrigin)
    return bindings[0] ?? null
  }

  async listSiteBindingsByOfficialOrigin(officialOrigin: string): Promise<SiteBinding[]> {
    const result = await this.pool.query(
      `SELECT binding.*
       FROM site_bindings AS binding
       JOIN environments AS environment ON environment.slug = binding.environment_slug
       WHERE binding.official_origin = $1
         AND binding.enabled = true
       ORDER BY CASE environment.status WHEN 'ACTIVE' THEN 0 WHEN 'FROZEN' THEN 1 ELSE 2 END,
                binding.environment_slug, binding.hostname, binding.id`,
      [normalizeOrigin(officialOrigin)]
    )
    return result.rows.map(mapSiteBinding)
  }

  async saveSiteBinding(binding: SiteBinding, actor: string): Promise<SiteBinding> {
    const rawFallbackOrigin = binding.fallbackOrigin ?? binding.upstreamOrigin
    if (!rawFallbackOrigin) throw new InvalidSelectionError('Fallback origin is required')
    const fallbackOrigin = normalizeOrigin(rawFallbackOrigin)
    const normalized: SiteBinding = {
      ...binding,
      hostname: normalizeHostname(binding.hostname),
      fallbackOrigin,
      upstreamOrigin: fallbackOrigin,
      officialOrigin: normalizeOrigin(binding.officialOrigin),
      remoteTargetIds: [...binding.remoteTargetIds],
      resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const environment = await client.query(
        'SELECT status FROM environments WHERE slug = $1 FOR SHARE',
        [normalized.environmentSlug]
      )
      if (!environment.rows[0]) {
        throw new InvalidSelectionError(`Environment not found: ${normalized.environmentSlug}`)
      }
      if (normalized.enabled && environment.rows[0].status === 'ARCHIVED') {
        throw new InvalidSelectionError(`Environment is archived: ${normalized.environmentSlug}`)
      }
      const result = await client.query(
        `INSERT INTO site_bindings
          (id, name, hostname, target_id, environment_slug, upstream_origin, fallback_origin,
           official_origin, enabled, remote_target_ids, resource_proxy_prefixes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           hostname = EXCLUDED.hostname,
           target_id = EXCLUDED.target_id,
           environment_slug = EXCLUDED.environment_slug,
           upstream_origin = EXCLUDED.upstream_origin,
           fallback_origin = EXCLUDED.fallback_origin,
           official_origin = EXCLUDED.official_origin,
           enabled = EXCLUDED.enabled,
           remote_target_ids = EXCLUDED.remote_target_ids,
           resource_proxy_prefixes = EXCLUDED.resource_proxy_prefixes,
           updated_at = now()
         RETURNING *`,
        [
          normalized.id,
          normalized.name,
          normalized.hostname,
          normalized.targetId,
          normalized.environmentSlug,
          normalized.upstreamOrigin,
          normalized.fallbackOrigin,
          normalized.officialOrigin,
          normalized.enabled,
          JSON.stringify(normalized.remoteTargetIds),
          JSON.stringify(normalized.resourceProxyPrefixes),
        ]
      )
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'site-binding.save', 'site-binding', $3, $4::jsonb)`,
        [
          randomUUID(),
          actor,
          normalized.id,
          JSON.stringify({
            hostname: normalized.hostname,
            targetId: normalized.targetId,
            enabled: normalized.enabled,
            resourceProxyPrefixes: normalized.resourceProxyPrefixes,
          }),
        ]
      )
      await client.query('COMMIT')
      return mapSiteBinding(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteSiteBinding(id: string, actor: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query('DELETE FROM site_bindings WHERE id = $1 RETURNING id', [
        id,
      ])
      if (!result.rows[0]) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id)
         VALUES ($1, $2, 'site-binding.delete', 'site-binding', $3)`,
        [randomUUID(), actor, id]
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createConfigurationGroup(
    record: CreateConfigurationGroupRecord
  ): Promise<ConfigurationGroup> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const environment = await client.query(
        `SELECT status
         FROM environments
         WHERE id = $1 AND slug = $2
         FOR SHARE`,
        [record.environmentId, record.environmentSlug]
      )
      if (!environment.rows[0]) {
        throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
      }
      if (environment.rows[0].status === 'ARCHIVED') {
        throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
      }
      const binding = await client.query(
        `SELECT enabled
         FROM site_bindings
         WHERE id = $1
         FOR SHARE`,
        [record.siteBindingId]
      )
      if (binding.rows[0]?.enabled !== true) {
        throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
      }
      const result = await client.query(
        `INSERT INTO configuration_groups
          (token, preview_slug, preview_hostname_prefix, name, environment_id, environment_slug,
           site_binding_id, schema_version, items, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
         RETURNING *`,
        [
          record.token,
          record.previewSlug ?? createHash('md5').update(record.token).digest('hex'),
          record.previewHostnamePrefix ??
            `p-${record.previewSlug ?? createHash('md5').update(record.token).digest('hex')}`,
          record.name,
          record.environmentId,
          record.environmentSlug,
          record.siteBindingId,
          record.schemaVersion,
          JSON.stringify(record.items),
          record.createdBy,
        ]
      )
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'configuration-group.create', 'configuration-group', $3, $4::jsonb)`,
        [
          randomUUID(),
          record.createdBy,
          record.token,
          JSON.stringify({
            revision: 1,
            name: record.name,
            environmentSlug: record.environmentSlug,
            siteBindingId: record.siteBindingId,
            items: record.items,
          }),
        ]
      )
      await client.query('COMMIT')
      return mapConfigurationGroup(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getConfigurationGroup(token: string): Promise<ConfigurationGroup | null> {
    const result = await this.pool.query('SELECT * FROM configuration_groups WHERE token = $1', [
      token,
    ])
    return result.rows[0] ? mapConfigurationGroup(result.rows[0]) : null
  }

  async getConfigurationGroupByPreviewSlug(
    previewSlug: string
  ): Promise<ConfigurationGroup | null> {
    const result = await this.pool.query(
      'SELECT * FROM configuration_groups WHERE preview_slug = $1',
      [previewSlug]
    )
    return result.rows[0] ? mapConfigurationGroup(result.rows[0]) : null
  }

  async getConfigurationGroupByPreviewHostnamePrefix(
    previewHostnamePrefix: string
  ): Promise<ConfigurationGroup | null> {
    const result = await this.pool.query(
      'SELECT * FROM configuration_groups WHERE preview_hostname_prefix = $1',
      [previewHostnamePrefix]
    )
    return result.rows[0] ? mapConfigurationGroup(result.rows[0]) : null
  }

  async listConfigurationGroups(): Promise<ConfigurationGroup[]> {
    const result = await this.pool.query(
      'SELECT * FROM configuration_groups ORDER BY created_at DESC, token DESC'
    )
    return result.rows.map(mapConfigurationGroup)
  }

  async updateConfigurationGroup(
    token: string,
    record: UpdateConfigurationGroupRecord,
    expectedRevision: number,
    actor: string
  ): Promise<UpdateConfigurationGroupResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        'SELECT revision FROM configuration_groups WHERE token = $1 FOR UPDATE',
        [token]
      )
      if (!current.rows[0]) {
        await client.query('ROLLBACK')
        return { outcome: 'NOT_FOUND' }
      }
      const currentRevision = Number(current.rows[0].revision)
      if (currentRevision !== expectedRevision) {
        await client.query('ROLLBACK')
        return { outcome: 'CONFLICT', currentRevision }
      }
      const environment = await client.query(
        `SELECT status
         FROM environments
         WHERE id = $1 AND slug = $2
         FOR SHARE`,
        [record.environmentId, record.environmentSlug]
      )
      if (!environment.rows[0]) {
        throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
      }
      if (environment.rows[0].status === 'ARCHIVED') {
        throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
      }
      const binding = await client.query(
        `SELECT enabled
         FROM site_bindings
         WHERE id = $1
         FOR SHARE`,
        [record.siteBindingId]
      )
      if (binding.rows[0]?.enabled !== true) {
        throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
      }
      const result = await client.query(
        `UPDATE configuration_groups
         SET name = $2,
             environment_id = $3,
             environment_slug = $4,
             site_binding_id = $5,
             schema_version = $6,
             items = $7::jsonb,
             revision = revision + 1,
             updated_by = $8,
             updated_at = now()
         WHERE token = $1
         RETURNING *`,
        [
          token,
          record.name,
          record.environmentId,
          record.environmentSlug,
          record.siteBindingId,
          record.schemaVersion,
          JSON.stringify(record.items),
          actor,
        ]
      )
      const group = mapConfigurationGroup(result.rows[0]!)
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'configuration-group.update', 'configuration-group', $3, $4::jsonb)`,
        [
          randomUUID(),
          actor,
          token,
          JSON.stringify({
            previousRevision: currentRevision,
            revision: group.revision,
            name: group.name,
            environmentSlug: group.environmentSlug,
            siteBindingId: group.siteBindingId,
            items: group.items,
          }),
        ]
      )
      await client.query('COMMIT')
      return { outcome: 'UPDATED', group }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteConfigurationGroup(token: string, actor: string): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        'DELETE FROM configuration_groups WHERE token = $1 RETURNING revision',
        [token]
      )
      if (!result.rows[0]) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'configuration-group.delete', 'configuration-group', $3, $4::jsonb)`,
        [randomUUID(), actor, token, JSON.stringify({ revision: Number(result.rows[0].revision) })]
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createPreviewSession(record: CreatePreviewSessionRecord): Promise<PreviewSession> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cuddly-artifact-reference-lifecycle-v1'))"
      )
      const environment = await client.query(
        `SELECT status FROM environments
         WHERE id = $1 AND slug = $2
         FOR SHARE`,
        [record.environmentId, record.environmentSlug]
      )
      if (!environment.rows[0]) {
        throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
      }
      if (environment.rows[0].status === 'ARCHIVED') {
        throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
      }
      if (record.siteBindingId) {
        const binding = await client.query(
          `SELECT enabled FROM site_bindings
           WHERE id = $1
           FOR SHARE`,
          [record.siteBindingId]
        )
        if (binding.rows[0]?.enabled !== true) {
          throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
        }
      }
      const artifactIds = [
        record.siteArtifactId,
        ...record.selections.map((selection) => selection.artifactId),
      ].filter((id): id is string => Boolean(id))
      for (const artifactId of new Set(artifactIds)) {
        const artifact = await client.query(
          'SELECT status, environment_id FROM artifacts WHERE id = $1 FOR SHARE',
          [artifactId]
        )
        if (artifact.rows[0]?.status !== 'READY') {
          throw new InvalidSelectionError(`Artifact is not ready: ${artifactId}`)
        }
        if (artifact.rows[0].environment_id !== record.environmentId) {
          throw new InvalidSelectionError(`Artifact environment mismatch: ${artifactId}`)
        }
      }
      const result = await client.query(
        `INSERT INTO preview_sessions
          (token, environment_id, environment_slug, created_by, site_binding_id, site_artifact_id,
           selections, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING *`,
        [
          record.token,
          record.environmentId,
          record.environmentSlug,
          record.createdBy,
          record.siteBindingId ?? null,
          record.siteArtifactId ?? null,
          JSON.stringify(record.selections),
          record.expiresAt,
        ]
      )
      await client.query('COMMIT')
      return mapPreviewSession(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async getPreviewSession(token: string): Promise<PreviewSession | null> {
    const result = await this.pool.query(
      `SELECT *
       FROM preview_sessions
       WHERE token = $1 AND expires_at > now() AND revoked_at IS NULL`,
      [token]
    )
    return result.rows[0] ? mapPreviewSession(result.rows[0]) : null
  }

  async revokePreviewSession(token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE preview_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE token = $1 AND revoked_at IS NULL`,
      [token]
    )
    return (result.rowCount ?? 0) > 0
  }

  async isArtifactReferencedByActivePreview(artifactId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM preview_sessions
       WHERE expires_at > now()
         AND (revoked_at IS NULL OR revoked_at > now() - ($3 * interval '1 millisecond'))
         AND (site_artifact_id = $1 OR selections @> $2::jsonb)
       LIMIT 1`,
      [artifactId, JSON.stringify([{ artifactId }]), PREVIEW_REVOKE_GRACE_MS]
    )
    return Boolean(result.rows[0])
  }

  async isRemoteArtifactReferenced(artifactId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM preview_sessions
         WHERE expires_at > now()
           AND (revoked_at IS NULL OR revoked_at > now() - ($3 * interval '1 millisecond'))
           AND (site_artifact_id = $1 OR selections @> $2::jsonb)
       ) AS referenced`,
      [artifactId, JSON.stringify([{ artifactId }]), PREVIEW_REVOKE_GRACE_MS]
    )
    return result.rows[0]?.referenced === true
  }

  private async getRevision(
    client: Pool | PoolClient,
    revisionId: string
  ): Promise<EnvironmentRevision | null> {
    const result = await client.query('SELECT * FROM environment_revisions WHERE id = $1', [
      revisionId,
    ])
    if (!result.rows[0]) return null
    const items = await client.query(
      'SELECT * FROM environment_revision_items WHERE revision_id = $1 ORDER BY target_id',
      [revisionId]
    )
    const row = result.rows[0]
    return {
      id: row.id,
      environmentId: row.environment_id,
      revisionNo: row.revision_no,
      message: row.message,
      createdBy: row.created_by,
      createdAt: iso(row.created_at)!,
      selections: items.rows.map((item) => ({
        targetId: item.target_id,
        artifactId: item.artifact_id,
        branch: item.branch,
        builtAt: iso(item.built_at)!,
      })),
    }
  }

  async getEnvironmentMatrix(idOrSlug: string): Promise<EnvironmentMatrix | null> {
    const environment = await this.getEnvironment(idOrSlug)
    if (!environment) return null
    const revision = environment.currentRevisionId
      ? await this.getRevision(this.pool, environment.currentRevisionId)
      : null
    const targets = await this.listBuildTargets(true)
    const configs = await this.listProjectEnvironmentConfigs(environment.id)
    const configsByTarget = new Map(configs.map((config) => [config.targetId, config]))
    const [latestArtifactsResult, activeJobsResult] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT ON (target_id) *
         FROM artifacts
         WHERE environment_id = $1 AND status = 'READY'
         ORDER BY target_id, built_at DESC, id DESC`,
        [environment.id]
      ),
      this.pool.query(
        `SELECT DISTINCT ON (target_id) *
         FROM build_jobs
         WHERE environment_id = $1
           AND status IN (
             'QUEUED', 'LEASED', 'CHECKOUT', 'INSTALLING', 'BUILDING',
             'VALIDATING', 'UPLOADING', 'CANCELING'
           )
         ORDER BY target_id, created_at DESC, id DESC`,
        [environment.id]
      ),
    ])
    const latestArtifactByTarget = new Map(
      latestArtifactsResult.rows.map((row) => [String(row.target_id), mapArtifact(row)])
    )
    const activeJobByTarget = new Map(
      activeJobsResult.rows.map((row) => [String(row.target_id), mapJob(row)])
    )
    const rows = await Promise.all(
      targets.map(async (target) => {
        const current =
          revision?.selections.find((selection) => selection.targetId === target.id) ?? null
        const savedConfig = configsByTarget.get(target.id) ?? null
        if (!savedConfig?.enabled && !current) return null
        const config: ProjectEnvironmentConfig = savedConfig ?? {
          targetId: target.id,
          environmentId: environment.id,
          enabled: false,
          required: false,
          installCommand: target.installCommand,
          buildCommand: target.buildCommand,
          outputDirectory: target.outputDirectory,
        }
        const latestArtifact = latestArtifactByTarget.get(target.id) ?? null
        const activeJob = activeJobByTarget.get(target.id) ?? null
        return {
          target: {
            id: target.id,
            name: target.name,
            kind: target.kind,
            defaultBranch: target.defaultBranch,
            enabled:
              environment.status === 'ACTIVE' && target.enabled && savedConfig?.enabled === true,
            required: config.required,
            configured: Boolean(target.repositoryUrl) && Boolean(savedConfig),
          },
          config,
          current,
          latestArtifact: latestArtifact
            ? {
                id: latestArtifact.id,
                branch: latestArtifact.branch,
                builtAt: latestArtifact.builtAt,
              }
            : null,
          activeJob: activeJob
            ? {
                id: activeJob.id,
                branch: activeJob.branch,
                status: activeJob.status,
                createdAt: activeJob.createdAt,
              }
            : null,
        }
      })
    )
    return {
      environment,
      revision,
      rows: rows.filter((row): row is NonNullable<typeof row> => row !== null),
    }
  }

  async publishRevision(record: PublishRevisionRecord): Promise<EnvironmentRevision> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('cuddly-artifact-reference-lifecycle-v1'))"
      )
      const environmentResult = await client.query(
        'SELECT * FROM environments WHERE id::text = $1 OR slug = $1 FOR UPDATE',
        [record.environmentId]
      )
      if (!environmentResult.rows[0])
        throw new Error(`Environment not found: ${record.environmentId}`)
      const environment = mapEnvironment(environmentResult.rows[0])
      if (environment.status !== 'ACTIVE') {
        throw new InvalidSelectionError(`Environment is not active: ${environment.slug}`)
      }
      if (environment.currentRevisionId !== record.baseRevisionId) {
        throw new RevisionConflictError(environment.currentRevisionId)
      }

      const currentRevision = environment.currentRevisionId
        ? await this.getRevision(client, environment.currentRevisionId)
        : null
      const currentByTarget = new Map(
        (currentRevision?.selections ?? []).map((selection) => [selection.targetId, selection])
      )
      const configResult = await client.query(
        `SELECT config.target_id, config.enabled AS config_enabled,
                config.required, target.enabled AS target_enabled, target.kind AS target_kind
         FROM project_environment_configs AS config
         JOIN build_targets AS target ON target.id = config.target_id
         WHERE config.environment_id = $1
         FOR SHARE OF config, target`,
        [environment.id]
      )
      const configByTarget = new Map(configResult.rows.map((row) => [String(row.target_id), row]))

      const selectedTargets = new Set<string>()
      const selectedArtifacts = new Map<string, string>()
      const artifacts: Artifact[] = []
      for (const selection of record.selections) {
        if (selectedTargets.has(selection.targetId)) {
          throw new InvalidSelectionError(`Duplicate target selection: ${selection.targetId}`)
        }
        selectedTargets.add(selection.targetId)
        const artifactResult = await client.query(
          'SELECT * FROM artifacts WHERE id = $1 FOR SHARE',
          [selection.artifactId]
        )
        if (!artifactResult.rows[0])
          throw new InvalidSelectionError(`Artifact not found: ${selection.artifactId}`)
        const artifact = mapArtifact(artifactResult.rows[0])
        if (artifact.status !== 'READY') {
          throw new InvalidSelectionError(`Artifact is not ready: ${artifact.id}`)
        }
        if (artifact.targetId !== selection.targetId) {
          throw new InvalidSelectionError(`Artifact target mismatch: ${artifact.id}`)
        }
        if (
          artifact.environmentId !== environment.id ||
          artifact.environmentSlug !== environment.slug
        ) {
          throw new InvalidSelectionError(`Artifact environment mismatch: ${artifact.id}`)
        }
        const config = configByTarget.get(selection.targetId)
        const current = currentByTarget.get(selection.targetId)
        const buildable = config?.config_enabled === true && config.target_enabled === true
        if (!buildable && current?.artifactId !== artifact.id) {
          throw new InvalidSelectionError(
            `Project is disabled in environment: ${selection.targetId}`
          )
        }
        selectedArtifacts.set(selection.targetId, artifact.id)
        artifacts.push(artifact)
      }

      for (const [targetId, current] of currentByTarget) {
        const config = configByTarget.get(targetId)
        const buildable = config?.config_enabled === true && config.target_enabled === true
        if (
          !buildable &&
          config?.target_kind !== 'remote' &&
          selectedArtifacts.get(targetId) !== current.artifactId
        ) {
          throw new InvalidSelectionError(`Disabled current target must be retained: ${targetId}`)
        }
      }
      for (const config of configResult.rows) {
        if (
          config.required === true &&
          config.config_enabled === true &&
          config.target_enabled === true &&
          !selectedTargets.has(config.target_id)
        ) {
          throw new InvalidSelectionError(`Required target is missing: ${config.target_id}`)
        }
      }

      const revisionId = randomUUID()
      const nextRevision = await client.query(
        'SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM environment_revisions WHERE environment_id = $1',
        [environment.id]
      )
      const revisionNo = Number(nextRevision.rows[0]!.revision_no)
      await client.query(
        `INSERT INTO environment_revisions
          (id, environment_id, revision_no, message, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [revisionId, environment.id, revisionNo, record.message, record.createdBy]
      )

      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO environment_revision_items
            (revision_id, target_id, artifact_id, branch, built_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [revisionId, artifact.targetId, artifact.id, artifact.branch, artifact.builtAt]
        )
        await client.query(
          `INSERT INTO environment_artifact_refs
            (environment_id, artifact_id, first_revision_id, last_revision_id, last_referenced_at)
           VALUES ($1, $2, $3, $3, now())
           ON CONFLICT (environment_id, artifact_id)
           DO UPDATE SET last_revision_id = EXCLUDED.last_revision_id, last_referenced_at = now()`,
          [environment.id, artifact.id, revisionId]
        )
      }

      await client.query('UPDATE environments SET current_revision_id = $2 WHERE id = $1', [
        environment.id,
        revisionId,
      ])
      await client.query(
        `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, payload)
         VALUES ($1, $2, 'environment.revision.publish', 'environment', $3, $4::jsonb)`,
        [randomUUID(), record.createdBy, environment.id, JSON.stringify({ revisionId, revisionNo })]
      )
      await client.query('COMMIT')
      return (await this.getRevision(this.pool, revisionId))!
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async resolveCurrentArtifact(
    environmentSlug: string,
    targetId: string
  ): Promise<Artifact | null> {
    const result = await this.pool.query(
      `SELECT artifact.*
       FROM environments environment
       JOIN environment_revision_items item ON item.revision_id = environment.current_revision_id
       JOIN artifacts artifact ON artifact.id = item.artifact_id
       WHERE environment.slug = $1
         AND environment.status <> 'ARCHIVED'
         AND item.target_id = $2
         AND artifact.environment_id = environment.id
         AND artifact.environment_slug = environment.slug`,
      [environmentSlug, targetId]
    )
    return result.rows[0] ? mapArtifact(result.rows[0]) : null
  }

  async resolveCurrentRemoteArtifacts(
    environmentSlug: string,
    targetIds: string[]
  ): Promise<Artifact[]> {
    if (targetIds.length === 0) return []
    const result = await this.pool.query(
      `SELECT artifact.*
       FROM environments environment
       JOIN environment_revision_items item ON item.revision_id = environment.current_revision_id
       JOIN artifacts artifact ON artifact.id = item.artifact_id
       JOIN build_targets target ON target.id = item.target_id
       WHERE environment.slug = $1
         AND environment.status <> 'ARCHIVED'
         AND item.target_id = ANY($2::text[])
         AND artifact.environment_id = environment.id
         AND artifact.environment_slug = environment.slug
         AND target.kind = 'remote'
         AND target.site_adapter = 'kook-remote-v1'
       ORDER BY item.target_id`,
      [environmentSlug, targetIds]
    )
    return result.rows.map(mapArtifact)
  }

  async isArtifactReferenced(environmentId: string, artifactId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM environment_artifact_refs WHERE environment_id = $1 AND artifact_id = $2',
      [environmentId, artifactId]
    )
    return result.rowCount === 1
  }
}
