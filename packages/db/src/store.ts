import type {
  AuthorizationPolicy,
  SaveAuthorizationPolicy,
  UpdateUserPermissions,
  UserAccount,
  PrivateProfile,
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

export const PREVIEW_REVOKE_GRACE_MS = 35_000

export interface CreateBuildJobRecord {
  id: string
  environmentId: string
  environmentSlug: string
  targetId: string
  branch: string
  profile: string
  requestedBy: string
  idempotencyKey: string | null
  targetSnapshot: BuildJob['targetSnapshot']
}

export interface BuildJobUpdate {
  status: BuildJobStatus
  startedAt?: string | null
  finishedAt?: string | null
  failureCode?: string | null
  failureMessage?: string | null
  logPath?: string | null
}

export interface BuildJobPageQuery {
  environmentId: string
  targetId?: string
  status?: BuildJobStatus
  query?: string
  page: number
  pageSize: number
}

export interface BuildJobPage {
  items: BuildJob[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export type BuildJobCancellationResult =
  | { outcome: 'NOT_FOUND'; job: null }
  | { outcome: 'CANCELED' | 'CANCELING' | 'NOT_CANCELABLE'; job: BuildJob }

export interface CompleteBuildJobRecord {
  artifact: Artifact
  finishedAt: string
  logPath: string
}

export interface PublishRevisionRecord {
  environmentId: string
  baseRevisionId: string | null
  message: string
  createdBy: string
  selections: Array<{ targetId: string; artifactId: string }>
}

export interface RuntimeSettingRecord {
  key: string
  value: unknown
  updatedBy: string
  updatedAt: string
}

export interface RuntimeSettingChange {
  key: string
  value: unknown | null
}

export interface AuthSession {
  userId?: string
  kind?: 'browser' | 'pc' | 'mcp' | 'mcp-token' | 'legacy'
  permissionCeiling?: number
  tenantKey: string
  openId: string
  unionId: string
  name: string
  avatarUrl: string
  csrfToken: string
  createdAt: string
  expiresAt: string
}

export interface CreateAuthSessionRecord extends AuthSession {
  token: string
}

export class AuthorizationUpdateError extends Error {
  constructor(
    readonly code:
      | 'REVISION_CONFLICT'
      | 'USER_NOT_FOUND'
      | 'LAST_PERMISSION_MANAGER'
      | 'PERMISSION_DENIED'
      | 'PERMISSION_LEVEL_EXCEEDED'
  ) {
    super(code)
  }
}

export interface UserPage {
  items: UserAccount[]
  total: number
  page: number
  pageSize: number
}

export interface CreatePreviewSessionRecord {
  token: string
  createdBy: string
  expiresAt: string
  environmentId: string
  environmentSlug: string
  siteBindingId?: string
  siteArtifactId?: string
  selections: PreviewSession['selections']
}

export interface CreateConfigurationGroupRecord {
  token: string
  previewSlug?: string
  previewHostnamePrefix?: string
  name: string
  environmentId: string
  environmentSlug: string
  siteBindingId: string
  schemaVersion: 1
  items: ConfigurationGroup['items']
  createdBy: string
}

export interface UpdateConfigurationGroupRecord {
  name: string
  environmentId: string
  environmentSlug: string
  siteBindingId: string
  schemaVersion: 1
  items: ConfigurationGroup['items']
}

export type UpdateConfigurationGroupResult =
  | { outcome: 'UPDATED'; group: ConfigurationGroup }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'CONFLICT'; currentRevision: number }

export type ArtifactCleanupCandidate = Pick<Artifact, 'id' | 'targetId' | 'branch' | 'storageKey'>

export interface CuddlyStore {
  initialize(): Promise<void>
  close(): Promise<void>

  listBuildTargets(includeDisabled?: boolean): Promise<BuildTarget[]>
  getBuildTarget(id: string): Promise<BuildTarget | null>
  saveBuildTarget(target: BuildTarget, actor: string): Promise<BuildTarget>

  listEnvironments(includeArchived?: boolean): Promise<EnvironmentRecord[]>
  getEnvironment(idOrSlug: string): Promise<EnvironmentRecord | null>
  saveEnvironment(environment: EnvironmentRecord, actor: string): Promise<EnvironmentRecord>
  listProjectEnvironmentConfigs(environmentId: string): Promise<ProjectEnvironmentConfig[]>
  getProjectEnvironmentConfig(
    environmentId: string,
    targetId: string
  ): Promise<ProjectEnvironmentConfig | null>
  saveProjectEnvironmentConfig(
    config: ProjectEnvironmentConfig,
    actor: string
  ): Promise<ProjectEnvironmentConfig>
  saveProjectEnvironmentConfigs(
    configs: ProjectEnvironmentConfig[],
    actor: string
  ): Promise<ProjectEnvironmentConfig[]>

  createBuildJob(record: CreateBuildJobRecord): Promise<BuildJob>
  getBuildJob(id: string): Promise<BuildJob | null>
  listBuildJobs(targetId?: string, environmentId?: string): Promise<BuildJob[]>
  listBuildJobPage(query: BuildJobPageQuery): Promise<BuildJobPage>
  listBuildQueue(): Promise<BuildJob[]>
  claimNextBuildJob(workerId: string): Promise<BuildJob | null>
  updateBuildJob(id: string, update: BuildJobUpdate): Promise<BuildJob>
  transitionBuildJob(
    id: string,
    expectedStatuses: readonly BuildJobStatus[],
    update: BuildJobUpdate
  ): Promise<BuildJob | null>
  requestBuildJobCancellation(id: string, actor: string): Promise<BuildJobCancellationResult>
  completeBuildJob(id: string, record: CompleteBuildJobRecord): Promise<BuildJob | null>
  listBuildJobEvents(jobId: string): Promise<BuildJobEvent[]>

  createArtifact(artifact: Artifact): Promise<Artifact>
  getArtifact(id: string): Promise<Artifact | null>
  getArtifactsByIds(ids: string[]): Promise<Artifact[]>
  getArtifactByBuildJobId(buildJobId: string): Promise<Artifact | null>
  listArtifacts(targetId: string, branch?: string, environmentId?: string): Promise<Artifact[]>
  listBranchCatalog(targetId: string, environmentId?: string): Promise<BranchCatalogItem[]>
  claimArtifactCleanupCandidates(limit: number): Promise<ArtifactCleanupCandidate[]>
  completeArtifactDeletion(id: string): Promise<void>
  restoreArtifactDeletion(id: string): Promise<void>

  getRuntimeSettings(keys: string[]): Promise<RuntimeSettingRecord[]>
  updateRuntimeSettings(changes: RuntimeSettingChange[], actor: string): Promise<void>

  createAuthSession(record: CreateAuthSessionRecord): Promise<AuthSession>
  createMcpPersonalToken(
    session: AuthSession,
    name: string
  ): Promise<import('@cuddly/contracts').CreatedMcpPersonalToken>
  listMcpPersonalTokens(
    session: AuthSession
  ): Promise<import('@cuddly/contracts').McpPersonalToken[]>
  revokeMcpPersonalToken(session: AuthSession, id: string): Promise<boolean>
  getMcpTokenSession(token: string): Promise<AuthSession | null>
  getUserAccount(session: AuthSession): Promise<UserAccount | null>
  syncUserIdentity(session: AuthSession): Promise<UserAccount | null>
  updateOwnProfile(session: AuthSession, displayName: string): Promise<UserAccount>
  getOwnPrivateProfile(session: AuthSession): Promise<PrivateProfile | null>
  getPublicActorNames(ids: string[]): Promise<Record<string, string>>
  listUserAccounts(query: string, page: number, pageSize: number): Promise<UserPage>
  updateUserPermissions(
    id: string,
    input: UpdateUserPermissions,
    actor: string,
    actorSession?: AuthSession
  ): Promise<UserAccount>
  getAuthorizationPolicy(): Promise<AuthorizationPolicy>
  saveAuthorizationPolicy(
    input: SaveAuthorizationPolicy,
    actor: string,
    actorSession?: AuthSession
  ): Promise<AuthorizationPolicy>
  limitAuthSession(token: string, permissionCeiling: number): Promise<void>
  getAuthSession(token: string): Promise<AuthSession | null>
  deleteAuthSession(token: string): Promise<boolean>

  listSiteBindings(includeDisabled?: boolean): Promise<SiteBinding[]>
  getSiteBinding(id: string): Promise<SiteBinding | null>
  getSiteBindingByHostname(hostname: string, includeDisabled?: boolean): Promise<SiteBinding | null>
  getSiteBindingByOfficialOrigin(officialOrigin: string): Promise<SiteBinding | null>
  listSiteBindingsByOfficialOrigin(officialOrigin: string): Promise<SiteBinding[]>
  saveSiteBinding(binding: SiteBinding, actor: string): Promise<SiteBinding>
  deleteSiteBinding(id: string, actor: string): Promise<boolean>

  createPreviewSession(record: CreatePreviewSessionRecord): Promise<PreviewSession>
  getPreviewSession(token: string): Promise<PreviewSession | null>
  revokePreviewSession(token: string): Promise<boolean>
  isArtifactReferencedByActivePreview(artifactId: string): Promise<boolean>
  isRemoteArtifactReferenced(artifactId: string): Promise<boolean>

  createConfigurationGroup(record: CreateConfigurationGroupRecord): Promise<ConfigurationGroup>
  getConfigurationGroup(token: string): Promise<ConfigurationGroup | null>
  getConfigurationGroupByPreviewSlug(previewSlug: string): Promise<ConfigurationGroup | null>
  getConfigurationGroupByPreviewHostnamePrefix(
    previewHostnamePrefix: string
  ): Promise<ConfigurationGroup | null>
  listConfigurationGroups(): Promise<ConfigurationGroup[]>
  updateConfigurationGroup(
    token: string,
    record: UpdateConfigurationGroupRecord,
    expectedRevision: number,
    actor: string
  ): Promise<UpdateConfigurationGroupResult>
  deleteConfigurationGroup(token: string, actor: string): Promise<boolean>

  getEnvironmentMatrix(idOrSlug: string): Promise<EnvironmentMatrix | null>
  publishRevision(record: PublishRevisionRecord): Promise<EnvironmentRevision>
  resolveCurrentArtifact(environmentSlug: string, targetId: string): Promise<Artifact | null>
  resolveCurrentRemoteArtifacts(environmentSlug: string, targetIds: string[]): Promise<Artifact[]>
  isArtifactReferenced(environmentId: string, artifactId: string): Promise<boolean>
}

export class RevisionConflictError extends Error {
  constructor(public readonly currentRevisionId: string | null) {
    super('Environment revision changed')
    this.name = 'RevisionConflictError'
  }
}

export class InvalidSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSelectionError'
  }
}
