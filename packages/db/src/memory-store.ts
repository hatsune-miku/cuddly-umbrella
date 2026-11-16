import { createHash, randomUUID } from 'node:crypto'

import type {
  AuthorizationPolicy,
  SaveAuthorizationPolicy,
  UpdateUserPermissions,
  UserAccount,
  Artifact,
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
import {
  defaultAuthorizationPolicy,
  permissionLevelSchema,
  saveAuthorizationPolicySchema,
  updateUserPermissionsSchema,
  USER_MANAGEMENT,
  PERMISSION_MANAGEMENT,
} from '@cuddly/contracts'
import { assertPermissionMutation } from './authorization-guards'
import { BOOTSTRAP_OWNER } from './authorization-schema'

import {
  AuthorizationUpdateError,
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
import { hashAuthSessionToken } from './auth-session'
import { actorUserId, defaultDisplayName } from './public-identity'
import {
  privateProfileSchema,
  updateOwnProfileSchema,
  type PrivateProfile,
} from '@cuddly/contracts'
import { PROJECT_TEMPLATES } from './project-templates'
import { McpTokenLimitError, mcpTokenSession, newMcpToken } from './mcp-tokens'
import { mcpPersonalTokenPattern, type McpPersonalToken } from '@cuddly/contracts'

function compareTimeDesc(a: string, b: string): number {
  return b.localeCompare(a)
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

function cloneConfigurationGroup(group: ConfigurationGroup): ConfigurationGroup {
  return {
    ...group,
    items: group.items.map((item) => ({ ...item })),
  }
}

function cloneAuthSession(session: AuthSession): AuthSession {
  return { ...session }
}

function cloneEnvironment(environment: EnvironmentRecord): EnvironmentRecord {
  return {
    ...environment,
    sortOrder: environment.sortOrder ?? 0,
    resourceProxyPrefixes: [...(environment.resourceProxyPrefixes ?? [])],
  }
}

export class MemoryStore implements CuddlyStore {
  private readonly targets = new Map<string, BuildTarget>()
  private readonly jobs = new Map<string, BuildJob>()
  private readonly jobEvents = new Map<string, BuildJobEvent[]>()
  private readonly artifacts = new Map<string, Artifact>()
  private readonly environments = new Map<string, EnvironmentRecord>()
  private readonly projectEnvironmentConfigs = new Map<string, ProjectEnvironmentConfig>()
  private readonly revisions = new Map<string, EnvironmentRevision>()
  private readonly artifactReferences = new Set<string>()
  private readonly runtimeSettings = new Map<string, RuntimeSettingRecord>()
  private readonly authSessions = new Map<string, AuthSession>()
  private readonly mcpTokens = new Map<
    string,
    { userId: string; item: McpPersonalToken; revoked: boolean }
  >()
  private readonly users = new Map<string, UserAccount>()
  private readonly privateProfiles = new Map<string, PrivateProfile>()
  private authorizationPolicy: AuthorizationPolicy = defaultAuthorizationPolicy()
  private readonly siteBindings = new Map<string, SiteBinding>()
  private readonly previewSessions = new Map<string, PreviewSession>()
  private readonly configurationGroups = new Map<string, ConfigurationGroup>()
  private readonly previewRevokedAt = new Map<string, number>()
  private readonly artifactDeletionStartedAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {
    const ownerId = randomUUID()
    const owner: UserAccount = {
      ...BOOTSTRAP_OWNER,
      id: ownerId,
      name: defaultDisplayName(ownerId),
      displayName: defaultDisplayName(ownerId),
      username: '',
      avatarUrl: '',
      permissionLevel: 8,
      roles: ['owner', 'administrator'],
      revision: 1,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.users.set(owner.id, owner)
    this.privateProfiles.set(owner.id, {
      feishu: { realName: BOOTSTRAP_OWNER.name, username: BOOTSTRAP_OWNER.username },
    })
    for (const target of PROJECT_TEMPLATES) this.targets.set(target.id, { ...target })

    const environment: EnvironmentRecord = {
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'shared',
      name: '公共调试环境',
      status: 'ACTIVE',
      backendOrigin: 'https://www.kookapp.cn',
      useInternalProxy: false,
      resourceProxyPrefixes: [],
      currentRevisionId: null,
    }
    this.environments.set(environment.id, environment)
    this.environments.set(environment.slug, environment)
    for (const target of PROJECT_TEMPLATES) {
      this.projectEnvironmentConfigs.set(`${environment.id}:${target.id}`, {
        targetId: target.id,
        environmentId: environment.id,
        enabled: target.enabled,
        required: target.required,
        installCommand: target.installCommand,
        buildCommand: target.buildCommand,
        outputDirectory: target.outputDirectory,
      })
    }
  }

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async listBuildTargets(includeDisabled = false): Promise<BuildTarget[]> {
    return [...this.targets.values()].filter((target) => includeDisabled || target.enabled)
  }

  async getBuildTarget(id: string): Promise<BuildTarget | null> {
    return this.targets.get(id) ?? null
  }

  async saveBuildTarget(target: BuildTarget, _actor: string): Promise<BuildTarget> {
    this.targets.set(target.id, { ...target })
    const shared = this.environments.get('shared')
    if (shared && !this.projectEnvironmentConfigs.has(`${shared.id}:${target.id}`)) {
      this.projectEnvironmentConfigs.set(`${shared.id}:${target.id}`, {
        targetId: target.id,
        environmentId: shared.id,
        enabled: target.enabled,
        required: target.required,
        installCommand: target.installCommand,
        buildCommand: target.buildCommand,
        outputDirectory: target.outputDirectory,
      })
    }
    return target
  }

  async listEnvironments(includeArchived = false): Promise<EnvironmentRecord[]> {
    const seen = new Set<string>()
    return [...this.environments.values()]
      .filter((environment) => {
        if (seen.has(environment.id)) return false
        seen.add(environment.id)
        return includeArchived || environment.status !== 'ARCHIVED'
      })
      .sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          a.name.localeCompare(b.name) ||
          a.slug.localeCompare(b.slug)
      )
      .map(cloneEnvironment)
  }

  async saveEnvironment(
    environment: EnvironmentRecord,
    _actor: string
  ): Promise<EnvironmentRecord> {
    const existingBySlug = this.environments.get(environment.slug)
    if (existingBySlug && existingBySlug.id !== environment.id) {
      throw new Error(`Environment slug already exists: ${environment.slug}`)
    }
    const existing = this.environments.get(environment.id)
    if (existing && existing.slug !== environment.slug) {
      throw new Error('Environment slug cannot be changed')
    }
    const saved: EnvironmentRecord = {
      ...environment,
      sortOrder: environment.sortOrder ?? existing?.sortOrder ?? 0,
      useInternalProxy: environment.useInternalProxy ?? false,
      resourceProxyPrefixes: [...(environment.resourceProxyPrefixes ?? [])],
      currentRevisionId: existing?.currentRevisionId ?? environment.currentRevisionId,
    }
    this.environments.set(saved.id, saved)
    this.environments.set(saved.slug, saved)
    return cloneEnvironment(saved)
  }

  async listProjectEnvironmentConfigs(environmentId: string): Promise<ProjectEnvironmentConfig[]> {
    return [...this.projectEnvironmentConfigs.values()]
      .filter((config) => config.environmentId === environmentId)
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map((config) => ({ ...config }))
  }

  async getProjectEnvironmentConfig(
    environmentId: string,
    targetId: string
  ): Promise<ProjectEnvironmentConfig | null> {
    const config = this.projectEnvironmentConfigs.get(`${environmentId}:${targetId}`)
    return config ? { ...config } : null
  }

  async saveProjectEnvironmentConfig(
    config: ProjectEnvironmentConfig,
    actor: string
  ): Promise<ProjectEnvironmentConfig> {
    return (await this.saveProjectEnvironmentConfigs([config], actor))[0]!
  }

  async saveProjectEnvironmentConfigs(
    configs: ProjectEnvironmentConfig[],
    _actor: string
  ): Promise<ProjectEnvironmentConfig[]> {
    if (new Set(configs.map((config) => config.environmentId)).size > 1) {
      throw new InvalidSelectionError('Project environment configs must belong to one environment')
    }
    if (new Set(configs.map((config) => config.targetId)).size !== configs.length) {
      throw new InvalidSelectionError('Project environment config targets must be unique')
    }
    for (const config of configs) {
      if (!this.environments.has(config.environmentId)) {
        throw new Error(`Environment not found: ${config.environmentId}`)
      }
      if (!this.targets.has(config.targetId)) {
        throw new Error(`Build target not found: ${config.targetId}`)
      }
      if (config.required && !config.enabled) {
        throw new InvalidSelectionError('Required projects must be enabled in the environment')
      }
    }
    const saved = configs.map((config) => ({ ...config }))
    for (const config of saved) {
      this.projectEnvironmentConfigs.set(`${config.environmentId}:${config.targetId}`, config)
    }
    return saved.map((config) => ({ ...config }))
  }

  async createBuildJob(record: CreateBuildJobRecord): Promise<BuildJob> {
    if (record.idempotencyKey) {
      const existing = [...this.jobs.values()].find(
        (job) =>
          (job as BuildJob & { idempotencyKey?: string }).idempotencyKey === record.idempotencyKey
      )
      if (existing) {
        if (
          existing.environmentId !== record.environmentId ||
          existing.environmentSlug !== record.environmentSlug ||
          existing.targetId !== record.targetId ||
          existing.branch !== record.branch ||
          existing.profile !== record.profile
        ) {
          throw new InvalidSelectionError(
            'Idempotency key conflicts with a different build request'
          )
        }
        return existing
      }
    }
    const environment = this.environments.get(record.environmentId)
    if (!environment || environment.slug !== record.environmentSlug) {
      throw new Error(`Build environment is invalid: ${record.environmentSlug}`)
    }
    if (environment.status !== 'ACTIVE') {
      throw new Error(`Build environment is not active: ${record.environmentSlug}`)
    }
    const target = this.targets.get(record.targetId)
    const config = this.projectEnvironmentConfigs.get(`${record.environmentId}:${record.targetId}`)
    if (!target?.enabled || !config?.enabled) {
      throw new InvalidSelectionError(`Project is not enabled in environment: ${record.targetId}`)
    }
    const job: BuildJob & { idempotencyKey?: string | null; workerId?: string } = {
      id: record.id,
      environmentId: record.environmentId,
      environmentSlug: record.environmentSlug,
      targetId: record.targetId,
      branch: record.branch,
      profile: record.profile,
      status: 'QUEUED',
      requestedBy: record.requestedBy,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      failureCode: null,
      failureMessage: null,
      logPath: null,
      targetSnapshot: record.targetSnapshot,
      idempotencyKey: record.idempotencyKey,
    }
    this.jobs.set(job.id, job)
    this.appendJobEvent(job.id, job.status, job.createdAt)
    return job
  }

  async getBuildJob(id: string): Promise<BuildJob | null> {
    return this.jobs.get(id) ?? null
  }

  async listBuildJobs(targetId?: string, environmentId?: string): Promise<BuildJob[]> {
    return [...this.jobs.values()]
      .filter((job) => !targetId || job.targetId === targetId)
      .filter((job) => !environmentId || job.environmentId === environmentId)
      .sort((a, b) => compareTimeDesc(a.createdAt, b.createdAt))
  }

  async listBuildJobPage(query: BuildJobPageQuery): Promise<BuildJobPage> {
    const search = query.query?.trim().toLowerCase() || ''
    const matching = [...this.jobs.values()]
      .filter((job) => job.environmentId === query.environmentId)
      .filter((job) => !query.targetId || job.targetId === query.targetId)
      .filter((job) => !query.status || job.status === query.status)
      .filter(
        (job) =>
          !search ||
          job.id.toLowerCase().includes(search) ||
          job.branch.toLowerCase().includes(search) ||
          (this.users.get(actorUserId(job.requestedBy) || '')?.displayName || '历史用户')
            .toLowerCase()
            .includes(search)
      )
      .sort((a, b) => compareTimeDesc(a.createdAt, b.createdAt) || b.id.localeCompare(a.id))
    const total = matching.length
    const offset = (query.page - 1) * query.pageSize
    return {
      items: matching.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    }
  }

  async listBuildQueue(): Promise<BuildJob[]> {
    const activeStatuses = new Set([
      'QUEUED',
      'LEASED',
      'CHECKOUT',
      'INSTALLING',
      'BUILDING',
      'VALIDATING',
      'UPLOADING',
      'CANCELING',
    ])
    return [...this.jobs.values()]
      .filter((job) => activeStatuses.has(job.status))
      .sort((a, b) => {
        const aQueued = a.status === 'QUEUED' ? 1 : 0
        const bQueued = b.status === 'QUEUED' ? 1 : 0
        return (
          aQueued - bQueued ||
          (a.startedAt || a.createdAt).localeCompare(b.startedAt || b.createdAt) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
        )
      })
  }

  async claimNextBuildJob(workerId: string): Promise<BuildJob | null> {
    const activeStatuses = new Set([
      'LEASED',
      'CHECKOUT',
      'INSTALLING',
      'BUILDING',
      'VALIDATING',
      'UPLOADING',
      'CANCELING',
    ])
    const activeTargets = new Set(
      [...this.jobs.values()]
        .filter((candidate) => activeStatuses.has(candidate.status))
        .map((candidate) => candidate.targetId)
    )
    const job = [...this.jobs.values()]
      .filter(
        (candidate) => candidate.status === 'QUEUED' && !activeTargets.has(candidate.targetId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
    if (!job) return null
    const claimed = job as BuildJob & { workerId?: string }
    claimed.status = 'LEASED'
    claimed.startedAt = new Date().toISOString()
    claimed.workerId = workerId
    this.appendJobEvent(claimed.id, claimed.status, claimed.startedAt)
    return claimed
  }

  async updateBuildJob(id: string, update: BuildJobUpdate): Promise<BuildJob> {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Build job not found: ${id}`)
    const previousStatus = job.status
    Object.assign(job, update)
    if (job.status !== previousStatus) {
      this.appendJobEvent(job.id, job.status, job.finishedAt || new Date().toISOString())
    }
    return job
  }

  async transitionBuildJob(
    id: string,
    expectedStatuses: readonly BuildJobStatus[],
    update: BuildJobUpdate
  ): Promise<BuildJob | null> {
    const job = this.jobs.get(id)
    if (!job || !expectedStatuses.includes(job.status)) return null
    const previousStatus = job.status
    Object.assign(job, update)
    if (job.status !== previousStatus) {
      this.appendJobEvent(job.id, job.status, job.finishedAt || new Date().toISOString())
    }
    return job
  }

  async requestBuildJobCancellation(id: string, _actor: string) {
    const job = this.jobs.get(id)
    if (!job) return { outcome: 'NOT_FOUND' as const, job: null }
    if (job.status === 'CANCELED') return { outcome: 'CANCELED' as const, job }
    if (job.status === 'CANCELING') return { outcome: 'CANCELING' as const, job }
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
      return { outcome: 'NOT_CANCELABLE' as const, job }
    }

    const now = new Date().toISOString()
    if (job.status === 'QUEUED') {
      Object.assign(job, {
        status: 'CANCELED' as const,
        finishedAt: now,
        failureCode: 'BUILD_CANCELED',
        failureMessage: '构建已被提前中断',
      })
      this.appendJobEvent(job.id, job.status, now)
      return { outcome: 'CANCELED' as const, job }
    }

    job.status = 'CANCELING'
    this.appendJobEvent(job.id, job.status, now)
    return { outcome: 'CANCELING' as const, job }
  }

  async completeBuildJob(id: string, record: CompleteBuildJobRecord): Promise<BuildJob | null> {
    if (record.artifact.buildJobId !== id || record.artifact.status !== 'READY') {
      throw new Error(`Invalid successful Artifact for build job: ${id}`)
    }
    const job = this.jobs.get(id)
    if (!job || job.status !== 'UPLOADING') return null
    if (
      record.artifact.targetId !== job.targetId ||
      record.artifact.branch !== job.branch ||
      record.artifact.environmentId !== job.environmentId ||
      record.artifact.environmentSlug !== job.environmentSlug
    ) {
      throw new Error(`Successful Artifact does not match build job: ${id}`)
    }
    if (this.artifacts.has(record.artifact.id)) {
      throw new Error(`Artifact already exists: ${record.artifact.id}`)
    }
    if ([...this.artifacts.values()].some((artifact) => artifact.buildJobId === id)) {
      throw new Error(`Build job already has an Artifact: ${id}`)
    }
    this.artifacts.set(record.artifact.id, record.artifact)
    Object.assign(job, {
      status: 'SUCCEEDED' as const,
      finishedAt: record.finishedAt,
      failureCode: null,
      failureMessage: null,
      logPath: record.logPath,
    })
    this.appendJobEvent(job.id, job.status, record.finishedAt)
    return job
  }

  async listBuildJobEvents(jobId: string): Promise<BuildJobEvent[]> {
    return [...(this.jobEvents.get(jobId) || [])]
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    if (this.artifacts.has(artifact.id)) throw new Error(`Artifact already exists: ${artifact.id}`)
    const environment = this.environments.get(artifact.environmentId)
    if (!environment || environment.slug !== artifact.environmentSlug) {
      throw new Error(`Artifact environment is invalid: ${artifact.environmentSlug}`)
    }
    this.artifacts.set(artifact.id, artifact)
    return artifact
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.artifacts.get(id) ?? null
  }

  async getArtifactsByIds(ids: string[]): Promise<Artifact[]> {
    return [...new Set(ids)]
      .map((id) => this.artifacts.get(id))
      .filter((artifact): artifact is Artifact => Boolean(artifact))
  }

  async getArtifactByBuildJobId(buildJobId: string): Promise<Artifact | null> {
    return (
      [...this.artifacts.values()].find((artifact) => artifact.buildJobId === buildJobId) ?? null
    )
  }

  async listArtifacts(
    targetId: string,
    branch?: string,
    environmentId?: string
  ): Promise<Artifact[]> {
    return [...this.artifacts.values()]
      .filter(
        (artifact) =>
          artifact.targetId === targetId &&
          (!environmentId || artifact.environmentId === environmentId) &&
          artifact.status === 'READY' &&
          (!branch || artifact.branch === branch)
      )
      .sort((a, b) => compareTimeDesc(a.builtAt, b.builtAt))
  }

  async listBranchCatalog(targetId: string, environmentId?: string): Promise<BranchCatalogItem[]> {
    const branches = new Set<string>()
    const latestArtifacts = new Map<string, Artifact>()
    const latestJobs = new Map<string, BuildJob>()
    const activeBranches = new Set<string>()
    for (const artifact of this.artifacts.values()) {
      if (
        artifact.targetId !== targetId ||
        artifact.status !== 'READY' ||
        (environmentId && artifact.environmentId !== environmentId)
      )
        continue
      branches.add(artifact.branch)
      const latest = latestArtifacts.get(artifact.branch)
      if (!latest || compareTimeDesc(artifact.builtAt, latest.builtAt) < 0) {
        latestArtifacts.set(artifact.branch, artifact)
      }
    }
    for (const job of this.jobs.values()) {
      if (job.targetId !== targetId || (environmentId && job.environmentId !== environmentId))
        continue
      branches.add(job.branch)
      const latest = latestJobs.get(job.branch)
      if (!latest || compareTimeDesc(job.createdAt, latest.createdAt) < 0) {
        latestJobs.set(job.branch, job)
      }
      if (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) {
        activeBranches.add(job.branch)
      }
    }
    const target = this.targets.get(targetId)
    if (target) branches.add(target.defaultBranch)

    return [...branches].sort().map((branch) => {
      const latestArtifact = latestArtifacts.get(branch) ?? null
      const latestJob = latestJobs.get(branch) ?? null
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
              branch: latestArtifact.branch,
              builtAt: latestArtifact.builtAt,
            }
          : null,
        latestJob: latestJob
          ? {
              id: latestJob.id,
              status: latestJob.status,
              createdAt: latestJob.createdAt,
              finishedAt: latestJob.finishedAt,
              failureMessage: latestJob.failureMessage,
            }
          : null,
      }
    })
  }

  async claimArtifactCleanupCandidates(limit: number) {
    const boundedLimit = Math.max(0, Math.floor(limit))
    if (boundedLimit === 0) return []

    const newestReady = new Map<string, string>()
    const readyArtifacts = [...this.artifacts.values()]
      .filter((artifact) => artifact.status === 'READY')
      .sort((a, b) => compareTimeDesc(a.builtAt, b.builtAt) || b.id.localeCompare(a.id))
    for (const artifact of readyArtifacts) {
      const key = `${artifact.environmentId}\0${artifact.targetId}\0${artifact.branch}`
      if (!newestReady.has(key)) newestReady.set(key, artifact.id)
    }

    const now = this.now()
    const retryBefore = now - 5 * 60_000
    const candidates: Artifact[] = []
    for (const artifact of this.artifacts.values()) {
      const key = `${artifact.environmentId}\0${artifact.targetId}\0${artifact.branch}`
      const retryable =
        artifact.status === 'DELETING' &&
        (this.artifactDeletionStartedAt.get(artifact.id) ?? 0) <= retryBefore
      const superseded = artifact.status === 'READY' && newestReady.get(key) !== artifact.id
      if (!retryable && !superseded) continue
      if (this.isArtifactInCurrentRevision(artifact.id)) continue
      if (this.isArtifactReferencedByActivePreviewSync(artifact.id)) continue
      candidates.push(artifact)
    }

    candidates.sort((a, b) => a.builtAt.localeCompare(b.builtAt) || a.id.localeCompare(b.id))
    return candidates.slice(0, boundedLimit).map((artifact) => {
      artifact.status = 'DELETING'
      this.artifactDeletionStartedAt.set(artifact.id, now)
      return {
        id: artifact.id,
        targetId: artifact.targetId,
        branch: artifact.branch,
        storageKey: artifact.storageKey,
      }
    })
  }

  async completeArtifactDeletion(id: string): Promise<void> {
    const artifact = this.artifacts.get(id)
    if (artifact?.status === 'DELETING') artifact.status = 'DELETED'
    this.artifactDeletionStartedAt.delete(id)
  }

  async restoreArtifactDeletion(id: string): Promise<void> {
    const artifact = this.artifacts.get(id)
    if (artifact?.status === 'DELETING') artifact.status = 'READY'
    this.artifactDeletionStartedAt.delete(id)
  }

  private appendJobEvent(jobId: string, status: BuildJob['status'], createdAt: string): void {
    const events = this.jobEvents.get(jobId) || []
    events.push({ id: String(events.length + 1), jobId, status, createdAt })
    this.jobEvents.set(jobId, events)
  }

  async getRuntimeSettings(keys: string[]): Promise<RuntimeSettingRecord[]> {
    return keys
      .map((key) => this.runtimeSettings.get(key))
      .filter((setting): setting is RuntimeSettingRecord => Boolean(setting))
  }

  async updateRuntimeSettings(changes: RuntimeSettingChange[], actor: string): Promise<void> {
    const updatedAt = new Date().toISOString()
    for (const change of changes) {
      if (change.value === null) {
        this.runtimeSettings.delete(change.key)
        continue
      }
      this.runtimeSettings.set(change.key, {
        key: change.key,
        value: change.value,
        updatedBy: actor,
        updatedAt,
      })
    }
  }

  async createAuthSession(record: CreateAuthSessionRecord): Promise<AuthSession> {
    const user = await this.getUserAccount(record)
    const tokenHash = hashAuthSessionToken(record.token)
    if (this.authSessions.has(tokenHash)) {
      throw new Error('Auth session already exists')
    }
    const session: AuthSession = {
      kind: record.kind || 'legacy',
      ...(user ? { userId: user.id } : {}),
      ...(record.permissionCeiling === undefined
        ? {}
        : { permissionCeiling: permissionLevelSchema.parse(record.permissionCeiling) }),
      tenantKey: record.tenantKey,
      openId: record.openId,
      unionId: record.unionId,
      name: user?.displayName || '游客',
      avatarUrl: record.avatarUrl,
      csrfToken: record.csrfToken,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }
    this.authSessions.set(tokenHash, cloneAuthSession(session))
    return cloneAuthSession(session)
  }

  async getAuthSession(token: string): Promise<AuthSession | null> {
    const tokenHash = hashAuthSessionToken(token)
    const session = this.authSessions.get(tokenHash)
    if (!session) return null
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.authSessions.delete(tokenHash)
      return null
    }
    const user = await this.getUserAccount(session)
    return {
      ...cloneAuthSession(session),
      name: user?.displayName || '游客',
      ...(user ? { userId: user.id, avatarUrl: user.avatarUrl } : {}),
    }
  }

  async deleteAuthSession(token: string): Promise<boolean> {
    return this.authSessions.delete(hashAuthSessionToken(token))
  }

  async createMcpPersonalToken(session: AuthSession, name: string) {
    const user = await this.getUserAccount(session)
    if (!user || session.kind !== 'browser') throw new AuthorizationUpdateError('PERMISSION_DENIED')
    if (
      [...this.mcpTokens.values()].filter((entry) => entry.userId === user.id && !entry.revoked)
        .length >= 20
    )
      throw new McpTokenLimitError('最多保留 20 个 Token，请先撤销不再使用的 Token')
    const generated = newMcpToken(name, this.now())
    this.mcpTokens.set(generated.hash, { userId: user.id, item: generated.item, revoked: false })
    return { token: generated.token, item: structuredClone(generated.item) }
  }

  async listMcpPersonalTokens(session: AuthSession) {
    const user = await this.getUserAccount(session)
    if (!user || session.kind !== 'browser') throw new AuthorizationUpdateError('PERMISSION_DENIED')
    return [...this.mcpTokens.values()]
      .filter((entry) => entry.userId === user.id && !entry.revoked)
      .map((entry) => structuredClone(entry.item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async revokeMcpPersonalToken(session: AuthSession, id: string) {
    const user = await this.getUserAccount(session)
    if (!user || session.kind !== 'browser') throw new AuthorizationUpdateError('PERMISSION_DENIED')
    const entry = [...this.mcpTokens.values()].find(
      (entry) => entry.userId === user.id && entry.item.id === id && !entry.revoked
    )
    if (!entry) return false
    entry.revoked = true
    return true
  }

  async getMcpTokenSession(token: string): Promise<AuthSession | null> {
    if (!mcpPersonalTokenPattern.test(token)) return null
    const entry = this.mcpTokens.get(hashAuthSessionToken(token))
    if (!entry || entry.revoked) return null
    const user = this.users.get(entry.userId)
    if (!user) return null
    entry.item.lastUsedAt = new Date(this.now()).toISOString()
    return mcpTokenSession(user, entry.item.createdAt)
  }

  async getUserAccount(session: AuthSession): Promise<UserAccount | null> {
    if (session.tenantKey === 'bifrost-pc-guest') return null
    let user = [...this.users.values()].find(
      (item) => item.tenantKey === session.tenantKey && item.openId === session.openId
    )
    if (!user) {
      const id = randomUUID()
      user = {
        id,
        tenantKey: session.tenantKey,
        openId: session.openId,
        username: '',
        name: defaultDisplayName(id),
        displayName: defaultDisplayName(id),
        avatarUrl: session.avatarUrl,
        permissionLevel: this.authorizationPolicy.defaultUserPermissionLevel,
        roles: [],
        revision: 1,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      }
      this.users.set(user.id, user)
      this.privateProfiles.set(user.id, { feishu: { realName: session.name } })
    }
    return structuredClone(user)
  }

  async listUserAccounts(query: string, page: number, pageSize: number) {
    const needle = query.toLocaleLowerCase()
    const users = [...this.users.values()]
      .filter((user) =>
        [user.displayName, user.username, user.openId, user.id].some((value) =>
          value.toLocaleLowerCase().includes(needle)
        )
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return {
      items: structuredClone(users.slice((page - 1) * pageSize, page * pageSize)),
      total: users.length,
      page,
      pageSize,
    }
  }

  async syncUserIdentity(session: AuthSession) {
    const user = await this.getUserAccount(session)
    if (!user) return null
    const current = this.privateProfiles.get(user.id)
    this.privateProfiles.set(user.id, { feishu: { ...current?.feishu, realName: session.name } })
    this.users.get(user.id)!.avatarUrl = session.avatarUrl
    return { ...user, avatarUrl: session.avatarUrl }
  }

  async updateOwnProfile(session: AuthSession, displayName: string) {
    const input = updateOwnProfileSchema.parse({ displayName })
    const user = await this.getUserAccount(session)
    if (!user) throw new AuthorizationUpdateError('USER_NOT_FOUND')
    const saved = {
      ...user,
      name: input.displayName,
      displayName: input.displayName,
      revision: user.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.users.set(user.id, saved)
    return structuredClone(saved)
  }

  async getOwnPrivateProfile(session: AuthSession) {
    if (session.kind !== 'browser') return null
    const user = await this.getUserAccount(session)
    return user
      ? privateProfileSchema.parse(
          this.privateProfiles.get(user.id) || { feishu: { realName: '' } }
        )
      : null
  }

  async getPublicActorNames(ids: string[]) {
    return Object.fromEntries(
      ids.flatMap((id) => {
        const user = this.users.get(id)
        return user ? [[id, user.displayName]] : []
      })
    )
  }

  async updateUserPermissions(
    id: string,
    value: UpdateUserPermissions,
    _actor: string,
    actorSession?: AuthSession
  ): Promise<UserAccount> {
    const input = updateUserPermissionsSchema.parse(value)
    const user = this.users.get(id)
    if (!user) throw new AuthorizationUpdateError('USER_NOT_FOUND')
    if (actorSession) {
      const operator =
        [...this.users.values()].find(
          (item) => item.tenantKey === actorSession.tenantKey && item.openId === actorSession.openId
        ) || null
      assertPermissionMutation(
        operator,
        actorSession,
        USER_MANAGEMENT.permissionLevel,
        user.permissionLevel,
        input.permissionLevel
      )
    }
    if (user.revision !== input.expectedRevision)
      throw new AuthorizationUpdateError('REVISION_CONFLICT')
    if (
      user.permissionLevel >= USER_MANAGEMENT.permissionLevel &&
      input.permissionLevel < USER_MANAGEMENT.permissionLevel &&
      ![...this.users.values()].some(
        (other) => other.id !== id && other.permissionLevel >= USER_MANAGEMENT.permissionLevel
      )
    ) {
      throw new AuthorizationUpdateError('LAST_PERMISSION_MANAGER')
    }
    Object.assign(user, {
      permissionLevel: input.permissionLevel,
      roles: [...input.roles],
      revision: user.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    })
    return structuredClone(user)
  }

  async getAuthorizationPolicy(): Promise<AuthorizationPolicy> {
    return structuredClone(this.authorizationPolicy)
  }

  async saveAuthorizationPolicy(
    value: SaveAuthorizationPolicy,
    _actor: string,
    actorSession?: AuthSession
  ): Promise<AuthorizationPolicy> {
    const input = saveAuthorizationPolicySchema.parse(value)
    if (actorSession) {
      const operator =
        [...this.users.values()].find(
          (item) => item.tenantKey === actorSession.tenantKey && item.openId === actorSession.openId
        ) || null
      assertPermissionMutation(
        operator,
        actorSession,
        PERMISSION_MANAGEMENT.permissionLevel,
        this.authorizationPolicy.defaultUserPermissionLevel,
        input.defaultUserPermissionLevel
      )
    }
    if (input.expectedRevision !== this.authorizationPolicy.revision)
      throw new AuthorizationUpdateError('REVISION_CONFLICT')
    this.authorizationPolicy = {
      revision: this.authorizationPolicy.revision + 1,
      defaultUserPermissionLevel: input.defaultUserPermissionLevel,
      requirements: structuredClone(input.requirements),
    }
    return structuredClone(this.authorizationPolicy)
  }

  async limitAuthSession(token: string, ceiling: number): Promise<void> {
    permissionLevelSchema.parse(ceiling)
    const session = this.authSessions.get(hashAuthSessionToken(token))
    if (session) session.permissionCeiling = Math.min(session.permissionCeiling ?? ceiling, ceiling)
  }

  async listSiteBindings(includeDisabled = false): Promise<SiteBinding[]> {
    return [...this.siteBindings.values()]
      .filter((binding) => includeDisabled || binding.enabled)
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((binding) => ({
        ...binding,
        remoteTargetIds: [...binding.remoteTargetIds],
        resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
      }))
  }

  async getSiteBinding(id: string): Promise<SiteBinding | null> {
    const binding = this.siteBindings.get(id)
    return binding
      ? {
          ...binding,
          remoteTargetIds: [...binding.remoteTargetIds],
          resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
        }
      : null
  }

  async getSiteBindingByHostname(
    hostname: string,
    includeDisabled = false
  ): Promise<SiteBinding | null> {
    const normalized = normalizeHostname(hostname)
    const binding = [...this.siteBindings.values()].find(
      (candidate) => (includeDisabled || candidate.enabled) && candidate.hostname === normalized
    )
    return binding
      ? {
          ...binding,
          remoteTargetIds: [...binding.remoteTargetIds],
          resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
        }
      : null
  }

  async getSiteBindingByOfficialOrigin(officialOrigin: string): Promise<SiteBinding | null> {
    return (await this.listSiteBindingsByOfficialOrigin(officialOrigin))[0] ?? null
  }

  async listSiteBindingsByOfficialOrigin(officialOrigin: string): Promise<SiteBinding[]> {
    const normalized = normalizeOrigin(officialOrigin)
    const statusRank = (binding: SiteBinding) => {
      const status = this.environments.get(binding.environmentSlug)?.status
      return status === 'ACTIVE' ? 0 : status === 'FROZEN' ? 1 : 2
    }
    return [...this.siteBindings.values()]
      .filter((candidate) => candidate.enabled && candidate.officialOrigin === normalized)
      .sort(
        (a, b) =>
          statusRank(a) - statusRank(b) ||
          a.environmentSlug.localeCompare(b.environmentSlug) ||
          a.id.localeCompare(b.id)
      )
      .map((binding) => ({
        ...binding,
        remoteTargetIds: [...binding.remoteTargetIds],
        resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
      }))
  }

  async saveSiteBinding(binding: SiteBinding, _actor: string): Promise<SiteBinding> {
    const environment = this.environments.get(binding.environmentSlug)
    if (!environment) {
      throw new InvalidSelectionError(`Environment not found: ${binding.environmentSlug}`)
    }
    if (binding.enabled && environment.status === 'ARCHIVED') {
      throw new InvalidSelectionError(`Environment is archived: ${binding.environmentSlug}`)
    }
    const rawFallbackOrigin = binding.fallbackOrigin ?? binding.upstreamOrigin
    if (!rawFallbackOrigin) throw new InvalidSelectionError('Fallback origin is required')
    const fallbackOrigin = normalizeOrigin(rawFallbackOrigin)
    const saved: SiteBinding = {
      ...binding,
      hostname: normalizeHostname(binding.hostname),
      fallbackOrigin,
      upstreamOrigin: fallbackOrigin,
      officialOrigin: normalizeOrigin(binding.officialOrigin),
      remoteTargetIds: [...binding.remoteTargetIds],
      resourceProxyPrefixes: [...binding.resourceProxyPrefixes],
    }
    this.siteBindings.set(saved.id, saved)
    return {
      ...saved,
      remoteTargetIds: [...saved.remoteTargetIds],
      resourceProxyPrefixes: [...saved.resourceProxyPrefixes],
    }
  }

  async deleteSiteBinding(id: string, _actor: string): Promise<boolean> {
    if ([...this.configurationGroups.values()].some((group) => group.siteBindingId === id)) {
      throw new InvalidSelectionError(`Site binding is referenced by a configuration group: ${id}`)
    }
    return this.siteBindings.delete(id)
  }

  async createConfigurationGroup(
    record: CreateConfigurationGroupRecord
  ): Promise<ConfigurationGroup> {
    const environment = this.environments.get(record.environmentId)
    if (!environment || environment.slug !== record.environmentSlug) {
      throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
    }
    if (environment.status === 'ARCHIVED') {
      throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
    }
    const binding = this.siteBindings.get(record.siteBindingId)
    if (!binding?.enabled) {
      throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
    }
    if (this.configurationGroups.has(record.token)) {
      throw new InvalidSelectionError(`Configuration group already exists: ${record.token}`)
    }
    const previewSlug = record.previewSlug ?? createHash('md5').update(record.token).digest('hex')
    const previewHostnamePrefix = record.previewHostnamePrefix ?? `p-${previewSlug}`
    if (
      [...this.configurationGroups.values()].some(
        (group) => group.previewHostnamePrefix === previewHostnamePrefix
      )
    ) {
      throw new InvalidSelectionError(
        `Configuration group preview hostname already exists: ${previewHostnamePrefix}`
      )
    }
    const createdAt = new Date(this.now()).toISOString()
    const group: ConfigurationGroup = {
      ...record,
      previewSlug,
      previewHostnamePrefix,
      items: record.items.map((item) => ({ ...item })),
      revision: 1,
      createdAt,
      updatedBy: record.createdBy,
      updatedAt: createdAt,
    }
    this.configurationGroups.set(group.token, group)
    return cloneConfigurationGroup(group)
  }

  async getConfigurationGroup(token: string): Promise<ConfigurationGroup | null> {
    const group = this.configurationGroups.get(token)
    return group ? cloneConfigurationGroup(group) : null
  }

  async getConfigurationGroupByPreviewSlug(
    previewSlug: string
  ): Promise<ConfigurationGroup | null> {
    const group = [...this.configurationGroups.values()].find(
      (candidate) => candidate.previewSlug === previewSlug
    )
    return group ? cloneConfigurationGroup(group) : null
  }

  async getConfigurationGroupByPreviewHostnamePrefix(
    previewHostnamePrefix: string
  ): Promise<ConfigurationGroup | null> {
    const group = [...this.configurationGroups.values()].find(
      (candidate) => candidate.previewHostnamePrefix === previewHostnamePrefix
    )
    return group ? cloneConfigurationGroup(group) : null
  }

  async listConfigurationGroups(): Promise<ConfigurationGroup[]> {
    return [...this.configurationGroups.values()]
      .sort(
        (left, right) =>
          compareTimeDesc(left.createdAt, right.createdAt) || right.token.localeCompare(left.token)
      )
      .map(cloneConfigurationGroup)
  }

  async updateConfigurationGroup(
    token: string,
    record: UpdateConfigurationGroupRecord,
    expectedRevision: number,
    actor: string
  ): Promise<UpdateConfigurationGroupResult> {
    const current = this.configurationGroups.get(token)
    if (!current) return { outcome: 'NOT_FOUND' }
    if (current.revision !== expectedRevision) {
      return { outcome: 'CONFLICT', currentRevision: current.revision }
    }
    const environment = this.environments.get(record.environmentId)
    if (!environment || environment.slug !== record.environmentSlug) {
      throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
    }
    if (environment.status === 'ARCHIVED') {
      throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
    }
    const binding = this.siteBindings.get(record.siteBindingId)
    if (!binding?.enabled) {
      throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
    }
    const updated: ConfigurationGroup = {
      ...current,
      ...record,
      items: record.items.map((item) => ({ ...item })),
      revision: current.revision + 1,
      updatedBy: actor,
      updatedAt: new Date(this.now()).toISOString(),
    }
    this.configurationGroups.set(token, updated)
    return { outcome: 'UPDATED', group: cloneConfigurationGroup(updated) }
  }

  async deleteConfigurationGroup(token: string, _actor: string): Promise<boolean> {
    return this.configurationGroups.delete(token)
  }

  async createPreviewSession(record: CreatePreviewSessionRecord): Promise<PreviewSession> {
    const environment = this.environments.get(record.environmentId)
    if (!environment || environment.slug !== record.environmentSlug) {
      throw new InvalidSelectionError(`Environment is invalid: ${record.environmentSlug}`)
    }
    if (environment.status === 'ARCHIVED') {
      throw new InvalidSelectionError(`Environment is archived: ${record.environmentSlug}`)
    }
    if (record.siteBindingId) {
      const binding = this.siteBindings.get(record.siteBindingId)
      if (!binding?.enabled) {
        throw new InvalidSelectionError(`Site binding is unavailable: ${record.siteBindingId}`)
      }
    }
    const artifactIds = [
      record.siteArtifactId,
      ...record.selections.map((item) => item.artifactId),
    ].filter((id): id is string => Boolean(id))
    for (const artifactId of new Set(artifactIds)) {
      const artifact = this.artifacts.get(artifactId)
      if (!artifact || artifact.status !== 'READY') {
        throw new InvalidSelectionError(`Artifact is not ready: ${artifactId}`)
      }
      if (artifact.environmentId !== environment.id) {
        throw new InvalidSelectionError(`Artifact environment mismatch: ${artifactId}`)
      }
    }
    const preview: PreviewSession = {
      ...record,
      createdAt: new Date(this.now()).toISOString(),
      selections: record.selections.map((selection) => ({ ...selection })),
    }
    this.previewRevokedAt.delete(preview.token)
    this.previewSessions.set(preview.token, preview)
    return preview
  }

  async getPreviewSession(token: string): Promise<PreviewSession | null> {
    const preview = this.previewSessions.get(token)
    if (!preview) return null
    if (new Date(preview.expiresAt).getTime() <= this.now()) {
      this.previewSessions.delete(token)
      this.previewRevokedAt.delete(token)
      return null
    }
    if (this.previewRevokedAt.has(token)) return null
    return preview
  }

  async revokePreviewSession(token: string): Promise<boolean> {
    if (!this.previewSessions.has(token)) return false
    if (this.previewRevokedAt.has(token)) return false
    this.previewRevokedAt.set(token, this.now())
    return true
  }

  async isArtifactReferencedByActivePreview(artifactId: string): Promise<boolean> {
    return this.isArtifactReferencedByActivePreviewSync(artifactId)
  }

  private isArtifactReferencedByActivePreviewSync(artifactId: string): boolean {
    const now = this.now()
    for (const [token, preview] of this.previewSessions) {
      if (new Date(preview.expiresAt).getTime() <= now) {
        this.previewSessions.delete(token)
        this.previewRevokedAt.delete(token)
        continue
      }
      const revokedAt = this.previewRevokedAt.get(token)
      if (revokedAt !== undefined && now - revokedAt >= PREVIEW_REVOKE_GRACE_MS) continue
      if (preview.siteArtifactId === artifactId) return true
      if (preview.selections.some((selection) => selection.artifactId === artifactId)) return true
    }
    return false
  }

  async isRemoteArtifactReferenced(artifactId: string): Promise<boolean> {
    return this.isArtifactReferencedByActivePreview(artifactId)
  }

  async getEnvironment(idOrSlug: string): Promise<EnvironmentRecord | null> {
    const environment = this.environments.get(idOrSlug)
    return environment ? cloneEnvironment(environment) : null
  }

  async getEnvironmentMatrix(idOrSlug: string): Promise<EnvironmentMatrix | null> {
    const environment = await this.getEnvironment(idOrSlug)
    if (!environment) return null
    const revision = environment.currentRevisionId
      ? (this.revisions.get(environment.currentRevisionId) ?? null)
      : null
    const configs = await this.listProjectEnvironmentConfigs(environment.id)
    const configByTarget = new Map(configs.map((config) => [config.targetId, config]))
    const selectedTargets = new Set(
      (revision?.selections || []).map((selection) => selection.targetId)
    )
    const targets = (await this.listBuildTargets(true)).filter(
      (target) => configByTarget.get(target.id)?.enabled || selectedTargets.has(target.id)
    )
    const jobs = await this.listBuildJobs(undefined, environment.id)

    return {
      environment,
      revision,
      rows: await Promise.all(
        targets.map(async (target) => {
          const current =
            revision?.selections.find((selection) => selection.targetId === target.id) ?? null
          const savedConfig = configByTarget.get(target.id) ?? null
          const config: ProjectEnvironmentConfig = savedConfig ?? {
            targetId: target.id,
            environmentId: environment.id,
            enabled: false,
            required: false,
            installCommand: target.installCommand,
            buildCommand: target.buildCommand,
            outputDirectory: target.outputDirectory,
          }
          const artifacts = await this.listArtifacts(target.id, undefined, environment.id)
          const activeJob = jobs.find(
            (job) =>
              job.targetId === target.id &&
              !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)
          )
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
            latestArtifact: artifacts[0]
              ? {
                  id: artifacts[0].id,
                  branch: artifacts[0].branch,
                  builtAt: artifacts[0].builtAt,
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
      ),
    }
  }

  async publishRevision(record: PublishRevisionRecord): Promise<EnvironmentRevision> {
    const environment = await this.getEnvironment(record.environmentId)
    if (!environment) throw new Error(`Environment not found: ${record.environmentId}`)
    if (environment.status !== 'ACTIVE') {
      throw new InvalidSelectionError(`Environment is not active: ${environment.slug}`)
    }
    if (environment.currentRevisionId !== record.baseRevisionId) {
      throw new RevisionConflictError(environment.currentRevisionId)
    }

    const selections = []
    const selectedTargets = new Set<string>()
    const selectedArtifacts = new Map<string, string>()
    const previousRevision = environment.currentRevisionId
      ? this.revisions.get(environment.currentRevisionId)
      : null
    const currentByTarget = new Map(
      (previousRevision?.selections ?? []).map((selection) => [selection.targetId, selection])
    )
    for (const selection of record.selections) {
      if (selectedTargets.has(selection.targetId)) {
        throw new InvalidSelectionError(`Duplicate target selection: ${selection.targetId}`)
      }
      selectedTargets.add(selection.targetId)
      const artifact = this.artifacts.get(selection.artifactId)
      if (!artifact || artifact.status !== 'READY') {
        throw new InvalidSelectionError(`Artifact is not ready: ${selection.artifactId}`)
      }
      if (artifact.targetId !== selection.targetId) {
        throw new InvalidSelectionError(`Artifact target mismatch: ${selection.artifactId}`)
      }
      if (
        artifact.environmentId !== environment.id ||
        artifact.environmentSlug !== environment.slug
      ) {
        throw new InvalidSelectionError(`Artifact environment mismatch: ${selection.artifactId}`)
      }
      const config = await this.getProjectEnvironmentConfig(environment.id, selection.targetId)
      const target = this.targets.get(selection.targetId)
      const current = currentByTarget.get(selection.targetId)
      if ((!target?.enabled || !config?.enabled) && current?.artifactId !== artifact.id) {
        throw new InvalidSelectionError(`Project is disabled in environment: ${selection.targetId}`)
      }
      selectedArtifacts.set(selection.targetId, artifact.id)
      selections.push({
        targetId: selection.targetId,
        artifactId: artifact.id,
        branch: artifact.branch,
        builtAt: artifact.builtAt,
      })
    }

    for (const [targetId, current] of currentByTarget) {
      const config = await this.getProjectEnvironmentConfig(environment.id, targetId)
      const target = this.targets.get(targetId)
      if (
        (!target?.enabled || !config?.enabled) &&
        target?.kind !== 'remote' &&
        selectedArtifacts.get(targetId) !== current.artifactId
      ) {
        throw new InvalidSelectionError(`Disabled current target must be retained: ${targetId}`)
      }
    }
    for (const config of await this.listProjectEnvironmentConfigs(environment.id)) {
      const target = this.targets.get(config.targetId)
      if (
        config.required &&
        config.enabled &&
        target?.enabled &&
        !selectedTargets.has(config.targetId)
      ) {
        throw new InvalidSelectionError(`Required target is missing: ${config.targetId}`)
      }
    }

    const revision: EnvironmentRevision = {
      id: randomUUID(),
      environmentId: environment.id,
      revisionNo: (previousRevision?.revisionNo ?? 0) + 1,
      message: record.message,
      createdBy: record.createdBy,
      createdAt: new Date().toISOString(),
      selections,
    }
    this.revisions.set(revision.id, revision)
    const savedEnvironment = { ...environment, currentRevisionId: revision.id }
    this.environments.set(savedEnvironment.id, savedEnvironment)
    this.environments.set(savedEnvironment.slug, savedEnvironment)
    for (const selection of selections) {
      this.artifactReferences.add(`${environment.id}:${selection.artifactId}`)
    }
    return revision
  }

  async resolveCurrentArtifact(
    environmentSlug: string,
    targetId: string
  ): Promise<Artifact | null> {
    const environment = await this.getEnvironment(environmentSlug)
    if (!environment?.currentRevisionId || environment.status === 'ARCHIVED') return null
    const revision = this.revisions.get(environment.currentRevisionId)
    const selection = revision?.selections.find((item) => item.targetId === targetId)
    const artifact = selection ? (this.artifacts.get(selection.artifactId) ?? null) : null
    return artifact?.environmentId === environment.id ? artifact : null
  }

  async resolveCurrentRemoteArtifacts(
    environmentSlug: string,
    targetIds: string[]
  ): Promise<Artifact[]> {
    const environment = await this.getEnvironment(environmentSlug)
    if (
      !environment?.currentRevisionId ||
      environment.status === 'ARCHIVED' ||
      targetIds.length === 0
    )
      return []
    const revision = this.revisions.get(environment.currentRevisionId)
    const allowedTargetIds = new Set(targetIds)
    return (revision?.selections || [])
      .filter((selection) => {
        const target = this.targets.get(selection.targetId)
        return (
          allowedTargetIds.has(selection.targetId) &&
          target?.kind === 'remote' &&
          target.siteAdapter === 'kook-remote-v1'
        )
      })
      .map((selection) => this.artifacts.get(selection.artifactId))
      .filter(
        (artifact): artifact is Artifact =>
          Boolean(artifact) && artifact?.environmentId === environment.id
      )
  }

  async isArtifactReferenced(environmentId: string, artifactId: string): Promise<boolean> {
    return this.artifactReferences.has(`${environmentId}:${artifactId}`)
  }

  private isArtifactInCurrentRevision(artifactId: string): boolean {
    const seenEnvironments = new Set<string>()
    for (const environment of this.environments.values()) {
      if (seenEnvironments.has(environment.id)) continue
      seenEnvironments.add(environment.id)
      if (!environment.currentRevisionId) continue
      const revision = this.revisions.get(environment.currentRevisionId)
      if (revision?.selections.some((selection) => selection.artifactId === artifactId)) {
        return true
      }
    }
    return false
  }
}
