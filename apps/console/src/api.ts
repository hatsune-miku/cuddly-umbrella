import type {
  AuthorizationPolicy,
  SaveAuthorizationPolicy,
  UpdateUserPermissions,
  UserAccount,
  PermissionContext,
  BranchCatalogItem,
  BuildJob,
  BuildJobDetail,
  BuildJobLogView,
  BuildJobStatus,
  BuildQueueSnapshot,
  BuildTargetSettingsView,
  BuildTargetSummary,
  EnvironmentMatrix,
  EnvironmentRecord,
  ProjectEnvironmentConfig,
  ProxySettingsView,
  PublicRuntimeSettings,
  PreviewSessionView,
  SiteBinding,
  SystemSettingsView,
} from '@cuddly/contracts'

export interface EnvironmentSettingsView extends EnvironmentRecord {
  backendOrigin: string
  useInternalProxy: boolean
}

export type ProjectEnvironmentSettingsView = ProjectEnvironmentConfig

export type ConfigurationGroupReadiness = 'OFFICIAL' | 'READY' | 'MISSING' | 'UNAVAILABLE'

export type ConfigurationGroupItem =
  | {
      targetId: string
      mode: 'official'
    }
  | {
      targetId: string
      mode: 'branch'
      branch: string
    }

export interface ConfigurationGroupRecord {
  id: string
  token: string
  previewSlug?: string
  previewHostnamePrefix?: string
  name: string
  environmentId: string
  environmentSlug: string
  siteBindingId: string
  schemaVersion: 1
  items: ConfigurationGroupItem[]
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  revision: number
  sharePath: string
  directPreviewUrl?: string
}

export type ConfigurationGroupResolvedItem = ConfigurationGroupItem & {
  targetId: string
  targetName: string
  kind: BuildTargetSummary['kind'] | 'unknown'
  readiness: ConfigurationGroupReadiness
  artifact?: {
    id: string
    branch: string
    builtAt: string
  }
}

export interface ConfigurationGroupView extends Omit<ConfigurationGroupRecord, 'items'> {
  available: boolean
  environment: Pick<EnvironmentRecord, 'id' | 'slug' | 'name' | 'status'>
  siteBinding: Pick<
    SiteBinding,
    'id' | 'name' | 'hostname' | 'targetId' | 'environmentSlug' | 'officialOrigin'
  >
  items: ConfigurationGroupResolvedItem[]
}

export interface SaveConfigurationGroupInput {
  name: string
  urlPrefix?: string
  environmentSlug: string
  siteBindingId: string
  schemaVersion?: 1
  items: ConfigurationGroupItem[]
}

export interface AuthIdentity {
  name: string
  avatarUrl: string
}

export interface AuthSessionView extends PermissionContext {
  userId?: string
  authenticated: boolean
  identity: AuthIdentity
  csrfToken: string
}

export const AUTH_REQUIRED_EVENT = 'cuddly:auth-required'
export const PERMISSIONS_CHANGED_EVENT = 'bifrost:permissions-changed'

export function notifyPermissionsChanged(): void {
  clearCachedAuthSession()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PERMISSIONS_CHANGED_EVENT))
}

let cachedAuthSession: AuthSessionView | null = null
let authSessionRequest: Promise<AuthSessionView> | null = null

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`API request failed with ${status}`)
  }
}

function dispatchAuthRequired() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}

function isUnsafeMethod(method?: string): boolean {
  const normalized = (method || 'GET').toUpperCase()
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS'
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

export function clearCachedAuthSession() {
  cachedAuthSession = null
  authSessionRequest = null
}

export function currentReturnTo(
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location
): string {
  return `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`
}

export function feishuLoginUrl(returnTo = currentReturnTo()): string {
  const query = new URLSearchParams({ return_to: returnTo })
  return `/api/v1/auth/feishu/start?${query}`
}

export async function getAuthSession(options: { force?: boolean } = {}): Promise<AuthSessionView> {
  if (options.force) cachedAuthSession = null
  if (cachedAuthSession) return cachedAuthSession
  if (authSessionRequest) return authSessionRequest

  const pending = (async () => {
    const response = await fetch('/api/v1/auth/session', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      const body = await responseBody(response)
      clearCachedAuthSession()
      throw new ApiError(response.status, body)
    }
    const session = (await response.json()) as AuthSessionView
    if (!session.authenticated) {
      session.identity = { name: '游客', avatarUrl: '' }
      session.csrfToken = ''
    }
    cachedAuthSession = session
    return session
  })()

  authSessionRequest = pending
  try {
    return await pending
  } finally {
    if (authSessionRequest === pending) authSessionRequest = null
  }
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const unsafe = isUnsafeMethod(init?.method)
  const session = unsafe ? await getAuthSession() : null
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (session) headers.set('x-cuddly-csrf', session.csrfToken)

  const response = await fetch(pathname, {
    ...init,
    credentials: 'include',
    headers,
  })
  if (!response.ok) {
    const body = await responseBody(response)
    if (response.status === 401) {
      clearCachedAuthSession()
      dispatchAuthRequired()
    }
    if (response.status === 403 && (body as { code?: string } | null)?.code === 'PERMISSION_DENIED')
      notifyPermissionsChanged()
    throw new ApiError(response.status, body)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function logout(): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST' })
  clearCachedAuthSession()
}

export function getOwnProfile(): Promise<UserAccount> {
  return request('/api/v1/me', { cache: 'no-store' })
}
export function listMcpTokens(): Promise<{
  items: import('@cuddly/contracts').McpPersonalToken[]
}> {
  return request('/api/v1/me/mcp-tokens', { cache: 'no-store' })
}
export function createMcpToken(
  name: string
): Promise<import('@cuddly/contracts').CreatedMcpPersonalToken> {
  return request('/api/v1/me/mcp-tokens', { method: 'POST', body: JSON.stringify({ name }) })
}
export function revokeMcpToken(id: string): Promise<void> {
  return request(`/api/v1/me/mcp-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export async function saveOwnProfile(displayName: string): Promise<UserAccount> {
  const profile = await request<UserAccount>('/api/v1/me', {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  })
  clearCachedAuthSession()
  return profile
}

export async function getPermissionPolicy(): Promise<AuthorizationPolicy> {
  return request('/api/v1/admin/permissions')
}

export async function savePermissionPolicy(
  input: SaveAuthorizationPolicy
): Promise<AuthorizationPolicy> {
  const result = await request<AuthorizationPolicy>('/api/v1/admin/permissions', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  notifyPermissionsChanged()
  return result
}

export async function getUsers(
  query = '',
  page = 1,
  pageSize = 20
): Promise<{ items: UserAccount[]; total: number; page: number; pageSize: number }> {
  return request(
    `/api/v1/admin/users?${new URLSearchParams({ query, page: String(page), pageSize: String(pageSize) })}`
  )
}

export async function saveUserPermissions(
  id: string,
  input: UpdateUserPermissions
): Promise<UserAccount> {
  const user = await request<UserAccount>(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  notifyPermissionsChanged()
  return user
}

export async function getEnvironments(): Promise<{ items: EnvironmentSettingsView[] }> {
  return request('/api/v1/admin/environments')
}

export async function saveEnvironment(
  environment: Omit<EnvironmentSettingsView, 'id' | 'currentRevisionId'>
): Promise<EnvironmentSettingsView> {
  return request(`/api/v1/admin/environments/${encodeURIComponent(environment.slug)}`, {
    method: 'PUT',
    body: JSON.stringify(environment),
  })
}

export async function getEnvironmentProjectSettings(
  environmentSlug: string
): Promise<{ items: ProjectEnvironmentSettingsView[] }> {
  return request(`/api/v1/admin/environments/${encodeURIComponent(environmentSlug)}/projects`)
}

export async function saveEnvironmentProjectSettings(
  environmentSlug: string,
  items: ProjectEnvironmentSettingsView[]
): Promise<{ items: ProjectEnvironmentSettingsView[] }> {
  return request(`/api/v1/admin/environments/${encodeURIComponent(environmentSlug)}/projects`, {
    method: 'PUT',
    body: JSON.stringify({
      items: items.map(({ environmentId: _environmentId, ...item }) => item),
    }),
  })
}

export async function getMatrix(environmentSlug: string): Promise<EnvironmentMatrix> {
  return request(`/api/v1/environments/${encodeURIComponent(environmentSlug)}/matrix`)
}

export async function getBuildTargets(
  environmentSlug: string
): Promise<{ items: BuildTargetSummary[] }> {
  const query = new URLSearchParams({ environment: environmentSlug })
  return request(`/api/v1/build-targets?${query}`)
}

export async function getBranches(
  targetId: string,
  environmentSlug: string
): Promise<{
  items: BranchCatalogItem[]
  remoteAvailable: boolean
}> {
  const query = new URLSearchParams({ environment: environmentSlug })
  return request(`/api/v1/build-targets/${encodeURIComponent(targetId)}/branches?${query}`)
}

export async function createBuild(
  targetId: string,
  branch: string,
  environmentSlug: string
): Promise<BuildJob> {
  return request('/api/v1/build-jobs', {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ targetId, branch, environmentSlug, profile: 'qa-web' }),
  })
}

export async function getArtifacts(targetId: string, environmentSlug: string, branch?: string) {
  const query = new URLSearchParams({ targetId, environment: environmentSlug })
  if (branch) query.set('branch', branch)
  return request<{ items: unknown[] }>(`/api/v1/artifacts?${query}`)
}

export async function getBuildQueue(): Promise<BuildQueueSnapshot> {
  return request('/api/v1/build-queue')
}

export async function getBuildJob(jobId: string): Promise<BuildJob> {
  return request(`/api/v1/build-jobs/${jobId}`)
}

export async function cancelBuildJob(jobId: string): Promise<BuildJob> {
  return request(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
}

export async function getBuildHistory(
  filters: {
    environmentSlug?: string
    targetId?: string
    status?: BuildJobStatus | ''
    query?: string
    page?: number
    pageSize?: number
  } = {}
): Promise<{
  items: BuildJob[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}> {
  const query = new URLSearchParams()
  if (filters.environmentSlug) query.set('environment', filters.environmentSlug)
  if (filters.targetId) query.set('targetId', filters.targetId)
  if (filters.status) query.set('status', filters.status)
  if (filters.query) query.set('query', filters.query)
  query.set('page', String(filters.page || 1))
  query.set('pageSize', String(filters.pageSize || 20))
  return request(`/api/v1/build-jobs?${query}`)
}

export async function getBuildJobDetail(jobId: string): Promise<BuildJobDetail> {
  return request(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/detail`)
}

export async function getBuildJobLog(jobId: string): Promise<BuildJobLogView> {
  return request(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/log`)
}

export async function getProxySettings(): Promise<ProxySettingsView> {
  return request('/api/v1/admin/proxy-settings')
}

export async function getProjectSettings(): Promise<{ items: BuildTargetSettingsView[] }> {
  return request('/api/v1/admin/build-targets')
}

export async function getSiteBindings(): Promise<{ items: SiteBinding[] }> {
  return request('/api/v1/admin/site-bindings')
}

export async function saveSiteBinding(
  binding: SiteBinding & { fallbackOrigin?: string }
): Promise<SiteBinding & { fallbackOrigin?: string }> {
  return request(`/api/v1/admin/site-bindings/${encodeURIComponent(binding.id)}`, {
    method: 'PUT',
    body: JSON.stringify(binding),
  })
}

export async function deleteSiteBinding(bindingId: string): Promise<void> {
  await request(`/api/v1/admin/site-bindings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
  })
}

export async function saveProjectSettings(
  project: Omit<
    BuildTargetSettingsView,
    'configurationSource' | 'canReset' | 'gitAuthorizationConfigured'
  > & {
    gitAuthorizationHeader?: string
    clearGitAuthorizationHeader?: boolean
  }
): Promise<BuildTargetSettingsView> {
  return request(`/api/v1/admin/build-targets/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...project, repositoryUrl: project.repositoryUrl || '' }),
  })
}

export async function resetProjectSettings(targetId: string): Promise<BuildTargetSettingsView> {
  return request(`/api/v1/admin/build-targets/${encodeURIComponent(targetId)}/reset`, {
    method: 'POST',
  })
}

export async function updateProxySettings(input: {
  enabled?: boolean
  subscriptionUrl?: string
  refreshIntervalMinutes?: number
}): Promise<ProxySettingsView> {
  return request('/api/v1/admin/proxy-settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function resetProxySettings(
  keys: Array<'enabled' | 'subscriptionUrl' | 'refreshIntervalMinutes'>
): Promise<ProxySettingsView> {
  return request('/api/v1/admin/proxy-settings/reset', {
    method: 'POST',
    body: JSON.stringify({ keys }),
  })
}

export async function refreshProxySettings(): Promise<ProxySettingsView> {
  return request('/api/v1/admin/proxy-settings/refresh', { method: 'POST' })
}

export async function getSystemSettings(): Promise<SystemSettingsView> {
  return request('/api/v1/admin/system-settings')
}

export async function updateSystemSettings(input: {
  cookieDomain: string
  buildMaxConcurrency: number
  runnerRequestTimeoutMinutes: number
  useChinaRegistry: boolean
  proxyRewriteMaxMegabytes: number
  autoSslEnabled: boolean
  autoSslEmail?: string
  inPlaceUrlRules: SystemSettingsView['inPlaceUrlRules']
}): Promise<SystemSettingsView> {
  return request('/api/v1/admin/system-settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function getPublicRuntimeSettings(): Promise<PublicRuntimeSettings> {
  return request('/api/v1/runtime')
}

export async function getConfigurationGroup(token: string): Promise<ConfigurationGroupView> {
  return request(`/api/v1/config-groups/${encodeURIComponent(token)}`)
}

export async function getConfigurationGroups(): Promise<{ items: ConfigurationGroupRecord[] }> {
  return request('/api/v1/config-groups')
}

export async function createConfigurationGroup(
  input: SaveConfigurationGroupInput
): Promise<ConfigurationGroupRecord> {
  return request('/api/v1/config-groups', {
    method: 'POST',
    body: JSON.stringify({ ...input, schemaVersion: 1 }),
  })
}

export async function updateConfigurationGroup(
  token: string,
  input: SaveConfigurationGroupInput & { expectedRevision: number }
): Promise<ConfigurationGroupRecord> {
  return request(`/api/v1/config-groups/${encodeURIComponent(token)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...input, schemaVersion: 1 }),
  })
}

export async function deleteConfigurationGroup(token: string): Promise<void> {
  await request(`/api/v1/config-groups/${encodeURIComponent(token)}`, {
    method: 'DELETE',
  })
}

export async function createPreview(input: {
  siteBindingId: string
  siteArtifactId?: string
  selections?: Array<{ targetId: string; artifactId: string }>
  ttlMinutes?: number
}): Promise<PreviewSessionView> {
  return request('/api/v1/previews', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
