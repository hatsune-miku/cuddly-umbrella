import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { domainToASCII } from 'node:url'

import {
  buildJobStatuses,
  configurationGroupHostnamePrefixFromHostname,
  configurationGroupReservedUrlPrefixes,
  configurationGroupUrlPrefixPattern,
  createBuildJobSchema,
  createConfigurationGroupPreviewSchema,
  createConfigurationGroupSchema,
  createPreviewSchema,
  resetProxySettingsSchema,
  saveBuildTargetSchema,
  saveEnvironmentSchema,
  saveProjectEnvironmentConfigsSchema,
  saveSiteBindingSchema,
  siteBuildAdapters,
  updateConfigurationGroupSchema,
  updateSystemSettingsSchema,
  updateProxySettingsSchema,
  CHINA_NPM_REGISTRY,
  type BranchCatalogItem,
  type Artifact,
  type BuildCommandStep,
  type BuildJob,
  type BuildJobDetail,
  type BuildJobLogView,
  type BuildJobStatus,
  type BuildQueueItem,
  type BuildTarget,
  type BuildTargetSettingsView,
  type ConfigurationGroup,
  type ConfigurationGroupItem,
  type ConfigurationGroupManagementView,
  type CreatePreviewInput,
  type EnvironmentRecord,
  type ProjectEnvironmentConfig,
  type PreviewSession,
  type PreviewSessionView,
  type PreviewSelection,
  type SiteBinding,
} from '@cuddly/contracts'
import {
  type AuthSession,
  type CuddlyStore,
  InvalidSelectionError,
  resolveSystemSettings,
  SYSTEM_SETTING_KEYS,
  type RuntimeSettingChange,
} from '@cuddly/db'
import { decryptSetting, encryptSetting, listRemoteBranches } from '@cuddly/domain'
import express, { type NextFunction, type Request, type Response } from 'express'

import {
  FeishuOAuthError,
  type FeishuOAuthClient,
  oauthRandomToken,
  parseCookieHeader,
  pkceChallenge,
  safeStringEqual,
  sanitizeReturnTo,
  withAuthError,
} from './auth'
import type { ProxySettingsService } from './proxy-settings'

const DEFAULT_PREVIEW_BASE_DOMAIN = 'bifrost.vanillacake.cn'
const SESSION_COOKIE = 'cuddly_session'
const OAUTH_STATE_COOKIE = 'cuddly_oauth_state'
const OAUTH_VERIFIER_COOKIE = 'cuddly_oauth_verifier'
const OAUTH_RETURN_COOKIE = 'cuddly_oauth_return'
const OAUTH_COMPLETE_PATH = '/api/v1/auth/feishu/complete'
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1_000
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const PC_GUEST_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const PC_GUEST_TENANT_KEY = 'bifrost-pc-guest'
const REQUEST_AUTH = Symbol('cuddly-request-auth')

function oauthSuccessDestination(returnTo: string): string {
  const pcHandoff = /^\/api\/v1\/auth\/pc-complete\?nonce=([A-Za-z0-9_-]{16,128})$/.exec(returnTo)
  return pcHandoff ? returnTo : OAUTH_COMPLETE_PATH
}

type AuthenticatedRequest = Request & {
  [REQUEST_AUTH]?: AuthSession
}

export interface ControlAppOptions {
  store: CuddlyStore
  internalApiToken: string
  auth?: {
    client: FeishuOAuthClient
    publicOrigin: string
    sessionMaxAgeMs?: number
  }
  proxySettings?: ProxySettingsService
  projectTemplates?: BuildTarget[]
  settingsSecret: string
  logDirectory?: string
  previewBaseDomain?: string
}

function environmentTarget(target: BuildTarget, config: ProjectEnvironmentConfig) {
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    defaultBranch: target.defaultBranch,
    enabled: target.enabled && config.enabled,
    required: config.required,
    configured: Boolean(target.repositoryUrl),
  }
}

function publicBuildJob(job: BuildJob): BuildJob {
  const targetSnapshot = job.targetSnapshot
    ? (({ gitAuthorization: _credential, ...snapshot }) => ({
        ...snapshot,
        repositoryUrl: '<repository>',
        installCommand: redactSensitiveText(snapshot.installCommand),
        buildCommand: redactSensitiveText(snapshot.buildCommand),
      }))(job.targetSnapshot)
    : null
  return {
    ...job,
    failureMessage: job.failureMessage ? redactSensitiveText(job.failureMessage) : null,
    logPath: job.logPath ? `/api/v1/build-jobs/${job.id}/log` : null,
    targetSnapshot,
  }
}

const terminalBuildStatuses = new Set<BuildJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELED'])
const LOG_VIEW_MAX_BYTES = 1024 * 1024
const LOG_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024
const BUILD_HISTORY_DEFAULT_PAGE_SIZE = 50
const BUILD_HISTORY_MAX_PAGE_SIZE = 100
const BUILD_HISTORY_MAX_PAGE = 1_000_000

function positiveIntegerQuery(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      '<redacted-private-key>'
    )
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s'"`]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1<redacted>@')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|AUTHORIZATION|API_KEY|ACCESS_KEY|COOKIE)[A-Z0-9_]*)=([^\s]+)/gi,
      '$1=<redacted>'
    )
    .replace(/(--(?:token|password|secret|api-key|access-key)(?:=|\s+))[^\s'"`]+/gi, '$1<redacted>')
    .replace(/([?&](?:token|password|secret|key|authorization)=)[^&\s]+/gi, '$1<redacted>')
}

function buildCommandPlan(job: BuildJob): BuildCommandStep[] {
  if (!job.targetSnapshot) return []
  const registryEnvironment =
    job.targetSnapshot.useChinaRegistry === false
      ? ''
      : `npm_config_registry=${shellQuote(CHINA_NPM_REGISTRY)} COREPACK_NPM_REGISTRY=${shellQuote(CHINA_NPM_REGISTRY)} `
  const pnpmBuildEnvironment =
    /(?:^|[;&|()]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:corepack\s+)?pnpm(?:@[\w.-]+)?(?=$|\s|[;&|()])/i.test(
      job.targetSnapshot.installCommand
    )
      ? 'npm_config_dangerously_allow_all_builds=true pnpm_config_dangerously_allow_all_builds=true '
      : ''
  return [
    {
      stage: 'CHECKOUT',
      label: '拉取代码',
      command: `git clone --depth 1 --single-branch --branch ${shellQuote(job.branch)} <repository> source`,
    },
    {
      stage: 'INSTALLING',
      label: '安装依赖',
      command: `${registryEnvironment}${pnpmBuildEnvironment}${redactSensitiveText(job.targetSnapshot.installCommand)}`,
    },
    {
      stage: 'BUILDING',
      label: '执行构建',
      command: `${registryEnvironment}${redactSensitiveText(job.targetSnapshot.buildCommand)}`,
    },
    {
      stage: 'VALIDATING',
      label: '校验产物',
      command: `validate ${shellQuote(job.targetSnapshot.outputDirectory)}`,
    },
    {
      stage: 'UPLOADING',
      label: '保存产物',
      command: 'publish Artifact',
    },
  ]
}

async function readBuildLog(
  options: ControlAppOptions,
  job: BuildJob,
  maxBytes: number
): Promise<BuildJobLogView> {
  const logDirectory = options.logDirectory || path.resolve('data/logs')
  const logFile = path.join(logDirectory, `${job.id}.log`)
  try {
    const info = await stat(logFile)
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    const handle = await open(logFile, 'r')
    try {
      await handle.read(buffer, 0, length, start)
    } finally {
      await handle.close()
    }
    let content = buffer.toString('utf8')
    if (start > 0) {
      const firstLine = content.indexOf('\n')
      if (firstLine >= 0) content = content.slice(firstLine + 1)
      content = `[日志过长，仅显示最后 ${Math.round(maxBytes / 1024)} KiB]\n${content}`
    }
    return {
      content: redactSensitiveText(content),
      size: info.size,
      complete: terminalBuildStatuses.has(job.status),
      truncated: start > 0,
      updatedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {
      content: '',
      size: 0,
      complete: terminalBuildStatuses.has(job.status),
      truncated: false,
      updatedAt: null,
    }
  }
}

function projectAuthorizationKey(targetId: string): string {
  return `project.${targetId}.git_authorization`
}

async function getProjectAuthorization(
  options: ControlAppOptions,
  targetId: string
): Promise<{ configured: boolean; encrypted?: ReturnType<typeof encryptSetting> }> {
  const record = (await options.store.getRuntimeSettings([projectAuthorizationKey(targetId)]))[0]
  if (!record) return { configured: false }
  return { configured: true, encrypted: record.value as ReturnType<typeof encryptSetting> }
}

function requestAuth(req: Request): AuthSession | null {
  return (req as AuthenticatedRequest)[REQUEST_AUTH] || null
}

function requestActor(req: Request): string {
  const session = requestAuth(req)
  if (!session)
    throw new ApiRequestError(401, { code: 'AUTH_REQUIRED', message: '请先使用飞书登录' })
  return session.name
}

const pcGuestApiRoutes: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/v1\/environments$/ },
  { method: 'GET', path: /^\/api\/v1\/build-targets$/ },
  { method: 'GET', path: /^\/api\/v1\/build-targets\/[^/]+\/branches$/ },
  { method: 'POST', path: /^\/api\/v1\/build-jobs$/ },
  { method: 'GET', path: /^\/api\/v1\/build-jobs$/ },
  { method: 'GET', path: /^\/api\/v1\/build-jobs\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/build-jobs\/[^/]+\/cancel$/ },
  { method: 'GET', path: /^\/api\/v1\/build-jobs\/[^/]+\/(?:detail|log)$/ },
  { method: 'GET', path: /^\/api\/v1\/build-queue$/ },
  { method: 'GET', path: /^\/api\/v1\/artifacts$/ },
  { method: 'GET', path: /^\/api\/v1\/environments\/[^/]+\/matrix$/ },
  { method: 'GET', path: /^\/api\/v1\/site-bindings\/(?:candidates|resolve)$/ },
  { method: 'GET', path: /^\/api\/v1\/runtime$/ },
  { method: 'POST', path: /^\/api\/v1\/config-groups$/ },
  { method: 'GET', path: /^\/api\/v1\/config-groups$/ },
  { method: 'GET', path: /^\/api\/v1\/config-groups\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/v1\/config-groups\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/v1\/config-groups\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/config-groups\/[^/]+\/previews$/ },
  { method: 'POST', path: /^\/api\/v1\/previews$/ },
  { method: 'GET', path: /^\/api\/v1\/previews\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/v1\/previews\/[^/]+$/ },
]

function isPcGuestSession(session: AuthSession): boolean {
  return session.tenantKey === PC_GUEST_TENANT_KEY
}

function pcGuestCanAccess(req: Request): boolean {
  const pathname = new URL(req.originalUrl, 'http://cuddly.local').pathname
  return pcGuestApiRoutes.some(
    (route) => route.method === req.method.toUpperCase() && route.path.test(pathname)
  )
}

function previewToken(): string {
  return randomBytes(24).toString('base64url')
}

function configurationGroupToken(): string {
  return randomBytes(24).toString('base64url')
}

function configurationGroupPreviewSlug(): string {
  return randomBytes(16).toString('hex')
}

const reservedConfigurationGroupUrlPrefixes = new Set<string>(configurationGroupReservedUrlPrefixes)

function customConfigurationGroupUrlPrefixError(urlPrefix: string): string {
  if (urlPrefix.startsWith('p-')) return 'p- 开头的地址由系统自动链接保留'
  if (reservedConfigurationGroupUrlPrefixes.has(urlPrefix)) {
    return `${urlPrefix} 是系统或预览站点保留地址`
  }
  return ''
}

function canonicalConfigurationGroupUrlPrefix(urlPrefix: string): string {
  const canonical = domainToASCII(urlPrefix)
  return configurationGroupUrlPrefixPattern.test(canonical) ? canonical : ''
}

function isConfigurationGroupToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value)
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: string; message: string; [key: string]: unknown }
  ) {
    super(body.message)
    this.name = 'ApiRequestError'
  }
}

function requestError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): never {
  throw new ApiRequestError(status, { code, message, ...details })
}

type ConfigurationGroupItemReadiness = 'OFFICIAL' | 'READY' | 'MISSING' | 'UNAVAILABLE'

type ConfigurationGroupViewItem = ConfigurationGroupItem & {
  targetName: string
  kind: BuildTarget['kind'] | 'unknown'
  readiness: ConfigurationGroupItemReadiness
  artifact?: {
    id: string
    branch: string
    builtAt: string
  }
}

interface ConfigurationGroupView extends Omit<ConfigurationGroupManagementView, 'items'> {
  available: boolean
  environment: {
    id: string
    slug: string
    name: string
    status: EnvironmentRecord['status']
  }
  siteBinding: Pick<
    SiteBinding,
    'id' | 'name' | 'hostname' | 'targetId' | 'environmentSlug' | 'officialOrigin'
  >
  items: ConfigurationGroupViewItem[]
}

function configurationGroupManagementView(
  group: ConfigurationGroup,
  previewBaseDomain: string
): ConfigurationGroupManagementView {
  return {
    ...group,
    id: group.token,
    sharePath: `/s/${group.token}`,
    directPreviewUrl: `https://${group.previewHostnamePrefix}.${previewBaseDomain}`,
    items: group.items.map((item) => ({ ...item })),
  }
}

function remoteVersion(providerName: string, branch: string): string {
  return providerName || branch
}

async function previewSessionView(
  options: ControlAppOptions,
  preview: PreviewSession
): Promise<PreviewSessionView> {
  const siteArtifact = preview.siteArtifactId
    ? await options.store.getArtifact(preview.siteArtifactId)
    : null
  return {
    ...preview,
    ...(siteArtifact
      ? {
          siteSelection: {
            targetId: siteArtifact.targetId,
            artifactId: siteArtifact.id,
            branch: siteArtifact.branch,
            builtAt: siteArtifact.builtAt,
          },
        }
      : {}),
  }
}

function requireInternalApi(options: ControlAppOptions) {
  const expectedDigest = createHash('sha256').update(options.internalApiToken).digest()
  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get('authorization')
    const match = authorization?.match(/^Bearer ([^\s]+)$/i)
    const actualDigest = createHash('sha256')
      .update(match?.[1] || '')
      .digest()
    if (!match || !timingSafeEqual(actualDigest, expectedDigest)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="cuddly-internal"')
      res.status(401).json({ code: 'INTERNAL_API_UNAUTHORIZED' })
      return
    }
    next()
  }
}

export function mergeBranches(
  catalog: BranchCatalogItem[],
  remoteBranches: string[],
  query: string
): BranchCatalogItem[] {
  const byBranch = new Map(catalog.map((item) => [item.branch, item]))
  for (const branch of remoteBranches) {
    if (!byBranch.has(branch)) {
      byBranch.set(branch, {
        branch,
        buildStatus: 'IDLE',
        latestArtifact: null,
        latestJob: null,
      })
    }
  }
  const normalizedQuery = query.trim().toLowerCase()
  const activityAt = (item: BranchCatalogItem): number => {
    const values = [
      item.latestArtifact?.builtAt,
      item.latestJob?.finishedAt,
      item.latestJob?.createdAt,
    ]
    return Math.max(
      0,
      ...values.map((value) => {
        const parsed = Date.parse(value || '')
        return Number.isFinite(parsed) ? parsed : 0
      })
    )
  }
  return [...byBranch.values()]
    .filter((item) => !normalizedQuery || item.branch.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => activityAt(b) - activityAt(a) || a.branch.localeCompare(b.branch))
}

function normalizeRequestHostname(value: string): string {
  const trimmed = value.trim()
  try {
    return new URL(`http://${trimmed}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return trimmed.toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
  }
}

function normalizeRequestOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function normalizePreviewBaseDomain(value: string | undefined): string {
  const baseDomain = (value || DEFAULT_PREVIEW_BASE_DOMAIN).trim().toLowerCase().replace(/\.$/, '')
  const labels = baseDomain.split('.')
  if (
    baseDomain.length > 253 ||
    labels.length < 2 ||
    isIP(baseDomain) !== 0 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`Preview base domain is invalid: ${value || ''}`)
  }
  return baseDomain
}

function isDirectPreviewSubdomain(hostname: string, previewBaseDomain: string): boolean {
  const suffix = `.${previewBaseDomain}`
  if (!hostname.endsWith(suffix)) return false
  const siteLabel = hostname.slice(0, -suffix.length)
  return siteLabel.length > 0 && !siteLabel.includes('.')
}

async function validateSiteBinding(
  options: ControlAppOptions,
  binding: SiteBinding,
  previewBaseDomain: string
): Promise<{ code: string; message: string } | null> {
  if (!isDirectPreviewSubdomain(binding.hostname, previewBaseDomain)) {
    return {
      code: 'SITE_BINDING_HOSTNAME_OUTSIDE_PREVIEW_DOMAIN',
      message: `预览域名必须是 ${previewBaseDomain} 的直接一级子域名，例如 main.${previewBaseDomain}`,
    }
  }
  const [target, environment, bindings] = await Promise.all([
    options.store.getBuildTarget(binding.targetId),
    options.store.getEnvironment(binding.environmentSlug),
    options.store.listSiteBindings(true),
  ])
  const remoteTargets = await Promise.all(
    binding.remoteTargetIds.map((targetId) => options.store.getBuildTarget(targetId))
  )

  if (
    !target ||
    target.kind === 'remote' ||
    !target.enabled ||
    !siteBuildAdapters.includes(target.siteAdapter as (typeof siteBuildAdapters)[number])
  ) {
    return {
      code: 'SITE_BINDING_TARGET_INVALID',
      message: '站点壳项目必须已启用，并使用受支持的站点适配器',
    }
  }
  if (!environment || (binding.enabled && environment.status === 'ARCHIVED')) {
    return {
      code: 'SITE_BINDING_ENVIRONMENT_INVALID',
      message: '站点环境不存在，或已经归档',
    }
  }
  const targetConfig = environment
    ? await options.store.getProjectEnvironmentConfig(environment.id, binding.targetId)
    : null
  if (binding.enabled && environment?.status === 'ACTIVE' && !targetConfig?.enabled) {
    return {
      code: 'SITE_BINDING_TARGET_ENVIRONMENT_INVALID',
      message: '站点壳项目没有在这个环境中启用',
    }
  }
  for (let index = 0; index < remoteTargets.length; index += 1) {
    const remote = remoteTargets[index]
    if (
      !remote ||
      remote.kind !== 'remote' ||
      remote.siteAdapter !== 'kook-remote-v1' ||
      (binding.enabled && !remote.enabled)
    ) {
      return {
        code: 'SITE_BINDING_REMOTE_TARGET_INVALID',
        message: `${binding.remoteTargetIds[index]} 不是可用的 Remote 项目`,
      }
    }
    if (binding.enabled && environment?.status === 'ACTIVE') {
      const config = await options.store.getProjectEnvironmentConfig(
        environment.id,
        binding.remoteTargetIds[index]!
      )
      if (!config?.enabled) {
        return {
          code: 'SITE_BINDING_REMOTE_ENVIRONMENT_INVALID',
          message: `${binding.remoteTargetIds[index]} 没有在这个环境中启用`,
        }
      }
    }
  }
  const hostnameConflict = bindings.find(
    (candidate) => candidate.id !== binding.id && candidate.hostname === binding.hostname
  )
  if (hostnameConflict) {
    return {
      code: 'SITE_BINDING_HOSTNAME_CONFLICT',
      message: `预览域名已由 ${hostnameConflict.name} 使用`,
    }
  }
  const previewHostnamePrefix = configurationGroupHostnamePrefixFromHostname(
    binding.hostname,
    previewBaseDomain
  )
  const configurationGroupConflict = previewHostnamePrefix
    ? await options.store.getConfigurationGroupByPreviewHostnamePrefix(previewHostnamePrefix)
    : null
  if (configurationGroupConflict) {
    return {
      code: 'SITE_BINDING_HOSTNAME_CONFLICT',
      message: `预览域名已由提测需求“${configurationGroupConflict.name}”使用`,
    }
  }
  const officialOriginConflict = bindings.find(
    (candidate) =>
      candidate.id !== binding.id &&
      candidate.officialOrigin === binding.officialOrigin &&
      candidate.environmentSlug === binding.environmentSlug
  )
  if (officialOriginConflict) {
    return {
      code: 'SITE_BINDING_OFFICIAL_ORIGIN_CONFLICT',
      message: `官方站点已由 ${officialOriginConflict.name} 绑定`,
    }
  }
  return null
}

export function createControlApp(options: ControlAppOptions) {
  const app = express()
  const previewBaseDomain = normalizePreviewBaseDomain(options.previewBaseDomain)
  const remoteBranchCache = new Map<
    string,
    {
      branches: string[]
      expiresAt: number
      pending?: Promise<string[]>
    }
  >()

  async function cachedRemoteBranches(
    targetId: string,
    repositoryUrl: string,
    authorizationHeader?: string
  ): Promise<string[]> {
    const source = createHash('sha256')
      .update(repositoryUrl)
      .update('\0')
      .update(authorizationHeader || '')
      .digest('hex')
    const cached = remoteBranchCache.get(source)
    if (cached && cached.expiresAt > Date.now()) return cached.branches
    if (cached?.pending) return cached.pending

    const previous = cached?.branches || []
    let pending: Promise<string[]>
    pending = listRemoteBranches(repositoryUrl, authorizationHeader)
      .then((branches) => {
        if (remoteBranchCache.get(source)?.pending === pending) {
          remoteBranchCache.set(source, {
            branches,
            expiresAt: Date.now() + 60_000,
          })
        }
        return branches
      })
      .catch((error) => {
        console.warn(
          `[control-api] failed to list remote branches for ${targetId}:`,
          error instanceof Error ? error.message : error
        )
        if (remoteBranchCache.get(source)?.pending === pending) {
          remoteBranchCache.set(source, {
            branches: previous,
            expiresAt: Date.now() + 15_000,
          })
        }
        return previous
      })
    remoteBranchCache.set(source, {
      branches: previous,
      expiresAt: 0,
      pending,
    })
    return pending
  }

  async function environmentProjectItems(
    environment: EnvironmentRecord
  ): Promise<ProjectEnvironmentConfig[]> {
    const [targets, configs] = await Promise.all([
      options.store.listBuildTargets(true),
      options.store.listProjectEnvironmentConfigs(environment.id),
    ])
    const configByTarget = new Map(configs.map((config) => [config.targetId, config]))
    return targets.map(
      (target): ProjectEnvironmentConfig =>
        configByTarget.get(target.id) ?? {
          targetId: target.id,
          environmentId: environment.id,
          enabled: false,
          required: false,
          installCommand: target.installCommand,
          buildCommand: target.buildCommand,
          outputDirectory: target.outputDirectory,
        }
    )
  }

  function targetMatchesBindingRole(target: BuildTarget | null, binding: SiteBinding): boolean {
    if (!target?.enabled) return false
    if (target.id === binding.targetId) {
      return (
        target.kind !== 'remote' &&
        siteBuildAdapters.includes(target.siteAdapter as (typeof siteBuildAdapters)[number])
      )
    }
    return (
      binding.remoteTargetIds.includes(target.id) &&
      target.kind === 'remote' &&
      target.siteAdapter === 'kook-remote-v1'
    )
  }

  function artifactMatchesBindingRole(
    artifact: Artifact,
    target: BuildTarget,
    binding: SiteBinding,
    environment: EnvironmentRecord
  ): boolean {
    if (
      artifact.status !== 'READY' ||
      artifact.environmentId !== environment.id ||
      artifact.environmentSlug !== environment.slug ||
      artifact.targetId !== target.id
    ) {
      return false
    }
    if (target.id === binding.targetId) {
      return (
        artifact.manifest.serve.siteAdapter === target.siteAdapter &&
        !artifact.manifest.serve.remote
      )
    }
    return (
      artifact.manifest.serve.siteAdapter === 'kook-remote-v1' &&
      artifact.manifest.serve.remote?.moduleKey === target.id
    )
  }

  async function createValidatedPreview(
    input: CreatePreviewInput,
    actor: string
  ): Promise<PreviewSessionView> {
    const siteBinding = input.siteBindingId
      ? await options.store.getSiteBinding(input.siteBindingId)
      : null
    if (input.siteBindingId && !siteBinding?.enabled) {
      requestError(400, 'PREVIEW_SITE_BINDING_INVALID', '所选站点绑定不存在或已停用')
    }
    if (!siteBinding) {
      requestError(400, 'PREVIEW_SITE_BINDING_REQUIRED', '创建预览必须选择站点绑定')
    }
    const environment = await options.store.getEnvironment(
      input.environmentSlug || siteBinding.environmentSlug
    )
    if (!environment || environment.status === 'ARCHIVED') {
      requestError(409, 'PREVIEW_ENVIRONMENT_UNAVAILABLE', '所选运行环境不存在或已经归档')
    }

    if (input.siteArtifactId) {
      const [siteTarget, siteArtifact, siteConfig] = await Promise.all([
        options.store.getBuildTarget(siteBinding.targetId),
        options.store.getArtifact(input.siteArtifactId),
        options.store.getProjectEnvironmentConfig(environment.id, siteBinding.targetId),
      ])
      if (!targetMatchesBindingRole(siteTarget, siteBinding)) {
        requestError(400, 'PREVIEW_SITE_TARGET_INVALID', '站点绑定的壳项目不可用')
      }
      if (!siteConfig?.enabled) {
        requestError(409, 'PREVIEW_PROJECT_UNAVAILABLE', '页面项目在所选环境中已经停用')
      }
      if (
        !siteArtifact ||
        !artifactMatchesBindingRole(siteArtifact, siteTarget!, siteBinding, environment)
      ) {
        requestError(400, 'PREVIEW_SITE_ARTIFACT_INVALID', '所选产物不是这个站点可用的壳 Artifact')
      }
    }

    const seenTargets = new Set<string>()
    const selections: PreviewSelection[] = []
    for (const requested of input.selections) {
      if (seenTargets.has(requested.targetId)) {
        requestError(400, 'DUPLICATE_PREVIEW_TARGET', `预览中重复选择了 ${requested.targetId}`)
      }
      seenTargets.add(requested.targetId)

      if (!siteBinding.remoteTargetIds.includes(requested.targetId)) {
        requestError(
          400,
          'PREVIEW_REMOTE_NOT_ALLOWED',
          `${requested.targetId} 不属于 ${siteBinding.name} 的热更项目`
        )
      }

      const [target, artifact, targetConfig] = await Promise.all([
        options.store.getBuildTarget(requested.targetId),
        options.store.getArtifact(requested.artifactId),
        options.store.getProjectEnvironmentConfig(environment.id, requested.targetId),
      ])
      if (!targetMatchesBindingRole(target, siteBinding) || target?.kind !== 'remote') {
        requestError(
          400,
          'PREVIEW_TARGET_NOT_REMOTE',
          `${requested.targetId} 不是已启用的 Remote 项目`
        )
      }
      if (!targetConfig?.enabled) {
        requestError(409, 'PREVIEW_PROJECT_UNAVAILABLE', `${target.name} 在所选环境中已经停用`)
      }
      if (!artifact || !artifactMatchesBindingRole(artifact, target, siteBinding, environment)) {
        requestError(
          400,
          'PREVIEW_ARTIFACT_INVALID',
          `${target.name} 所选产物不是可用的 Remote Artifact`
        )
      }
      const remote = artifact.manifest.serve.remote!
      selections.push({
        moduleKey: remote.moduleKey,
        targetId: target.id,
        artifactId: artifact.id,
        branch: artifact.branch,
        builtAt: artifact.builtAt,
        providerName: remote.providerName,
        version: remoteVersion(remote.providerName, artifact.branch),
        entryPath: remote.entryPath,
      })
    }

    const token = previewToken()
    try {
      const created = await options.store.createPreviewSession({
        token,
        environmentId: environment.id,
        environmentSlug: environment.slug,
        createdBy: actor,
        expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000).toISOString(),
        siteBindingId: siteBinding.id,
        siteArtifactId: input.siteArtifactId,
        selections,
      })
      return previewSessionView(options, created)
    } catch (error) {
      if (error instanceof InvalidSelectionError) {
        requestError(409, 'PREVIEW_ARTIFACT_CHANGED', '所选产物已被更新，请刷新后重新选择')
      }
      throw error
    }
  }

  async function validateConfigurationGroupContext(input: {
    environmentSlug: string
    siteBindingId: string
    items: ConfigurationGroupItem[]
  }): Promise<{ environment: EnvironmentRecord; binding: SiteBinding }> {
    const [environment, binding] = await Promise.all([
      options.store.getEnvironment(input.environmentSlug),
      options.store.getSiteBinding(input.siteBindingId),
    ])
    if (!environment || environment.status === 'ARCHIVED') {
      requestError(409, 'CONFIG_GROUP_ENVIRONMENT_UNAVAILABLE', '所选运行环境不存在或已经归档')
    }
    if (!binding?.enabled || binding.id !== input.siteBindingId) {
      requestError(400, 'CONFIG_GROUP_SITE_INVALID', '所选预览站点不存在或已停用')
    }

    const expectedTargetIds = new Set([binding.targetId, ...binding.remoteTargetIds])
    const selectedTargetIds = new Set(input.items.map((item) => item.targetId))
    if (
      expectedTargetIds.size !== selectedTargetIds.size ||
      [...expectedTargetIds].some((targetId) => !selectedTargetIds.has(targetId))
    ) {
      requestError(400, 'CONFIG_GROUP_PROJECTS_INCOMPLETE', '配置组必须明确包含站点的全部项目', {
        expectedTargetIds: [...expectedTargetIds],
      })
    }

    const [targets, targetConfigs] = await Promise.all([
      Promise.all(input.items.map((item) => options.store.getBuildTarget(item.targetId))),
      Promise.all(
        input.items.map((item) =>
          options.store.getProjectEnvironmentConfig(environment.id, item.targetId)
        )
      ),
    ])
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index]!
      if (!targetMatchesBindingRole(targets[index] ?? null, binding)) {
        requestError(
          400,
          'CONFIG_GROUP_PROJECT_INVALID',
          `${item.targetId} 已停用、类型不匹配，或不属于这个站点`
        )
      }
      if (item.mode === 'branch' && !targetConfigs[index]?.enabled) {
        requestError(
          409,
          'CONFIG_GROUP_PROJECT_UNAVAILABLE',
          `${targets[index]!.name} 在所选环境中已经停用`
        )
      }
    }

    return { environment, binding }
  }

  async function resolveConfigurationGroup(group: ConfigurationGroup): Promise<{
    view: ConfigurationGroupView
    environment: EnvironmentRecord
    binding: SiteBinding
    artifacts: Map<string, Artifact>
  }> {
    const [environment, binding] = await Promise.all([
      options.store.getEnvironment(group.environmentId),
      options.store.getSiteBinding(group.siteBindingId),
    ])
    if (!environment || environment.slug !== group.environmentSlug) {
      requestError(409, 'CONFIG_GROUP_ENVIRONMENT_UNAVAILABLE', '配置组的运行环境已经不可用')
    }
    if (!binding) {
      requestError(409, 'CONFIG_GROUP_SITE_UNAVAILABLE', '配置组的预览站点已经不可用')
    }

    const allowedTargetIds = new Set([binding.targetId, ...binding.remoteTargetIds])
    const selectedTargetIds = new Set(group.items.map((item) => item.targetId))
    const bindingMatchesSnapshot =
      allowedTargetIds.size === selectedTargetIds.size &&
      [...allowedTargetIds].every((targetId) => selectedTargetIds.has(targetId))
    const artifacts = new Map<string, Artifact>()
    const items = await Promise.all(
      group.items.map(async (item): Promise<ConfigurationGroupViewItem> => {
        const [target, targetConfig] = await Promise.all([
          options.store.getBuildTarget(item.targetId),
          options.store.getProjectEnvironmentConfig(environment.id, item.targetId),
        ])
        const roleAvailable =
          bindingMatchesSnapshot &&
          allowedTargetIds.has(item.targetId) &&
          targetMatchesBindingRole(target, binding)
        if (!roleAvailable || !target) {
          return {
            ...item,
            targetName: target?.name || item.targetId,
            kind: target?.kind || 'unknown',
            readiness: 'UNAVAILABLE',
          }
        }
        if (item.mode === 'official') {
          return {
            ...item,
            targetName: target.name,
            kind: target.kind,
            readiness: 'OFFICIAL',
          }
        }
        if (!targetConfig?.enabled) {
          return {
            ...item,
            targetName: target.name,
            kind: target.kind,
            readiness: 'UNAVAILABLE',
          }
        }
        const candidates = await options.store.listArtifacts(
          item.targetId,
          item.branch,
          environment.id
        )
        const artifact = candidates.find((candidate) =>
          artifactMatchesBindingRole(candidate, target, binding, environment)
        )
        if (!artifact) {
          return {
            ...item,
            targetName: target.name,
            kind: target.kind,
            readiness: 'MISSING',
          }
        }
        artifacts.set(item.targetId, artifact)
        return {
          ...item,
          targetName: target.name,
          kind: target.kind,
          readiness: 'READY',
          artifact: {
            id: artifact.id,
            branch: artifact.branch,
            builtAt: artifact.builtAt,
          },
        }
      })
    )
    return {
      environment,
      binding,
      artifacts,
      view: {
        ...configurationGroupManagementView(group, previewBaseDomain),
        available:
          binding.enabled &&
          environment.status !== 'ARCHIVED' &&
          bindingMatchesSnapshot &&
          items.every((item) => item.readiness !== 'UNAVAILABLE'),
        environment: {
          id: environment.id,
          slug: environment.slug,
          name: environment.name,
          status: environment.status,
        },
        siteBinding: {
          id: binding.id,
          name: binding.name,
          hostname: binding.hostname,
          targetId: binding.targetId,
          environmentSlug: binding.environmentSlug,
          officialOrigin: binding.officialOrigin,
        },
        items,
      },
    }
  }

  const callbackPath = '/api/v1/auth/feishu/callback'
  const oauthCookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: callbackPath,
  }
  const sessionCookieOptions = {
    httpOnly: true,
    secure: true,
    // The KOOK PC injector embeds the authenticated Bifrost panel cross-site. OAuth state cookies
    // remain Lax and path-scoped; only the established opaque session is eligible for that iframe.
    // Every mutation still requires the per-session CSRF token.
    sameSite: 'none' as const,
    path: '/',
  }

  function clearOAuthCookies(res: Response) {
    res.clearCookie(OAUTH_STATE_COOKIE, oauthCookieOptions)
    res.clearCookie(OAUTH_VERIFIER_COOKIE, oauthCookieOptions)
    res.clearCookie(OAUTH_RETURN_COOKIE, oauthCookieOptions)
  }

  function attachRequestAuth(req: Request, session: AuthSession) {
    ;(req as AuthenticatedRequest)[REQUEST_AUTH] = session
  }

  function requestSessionToken(req: Request): string {
    const cookieToken = parseCookieHeader(req.get('cookie'))[SESSION_COOKIE]
    if (cookieToken) return cookieToken
    const authorization = req.get('authorization') || ''
    const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization.trim())
    return match?.[1] || ''
  }

  async function authenticateRequest(req: Request): Promise<AuthSession | null> {
    const token = requestSessionToken(req)
    return token ? options.store.getAuthSession(token) : null
  }

  function validCsrf(req: Request, session: AuthSession): boolean {
    const supplied = req.get('x-cuddly-csrf') || ''
    return Boolean(supplied) && safeStringEqual(supplied, session.csrfToken)
  }

  function sendAuthRequired(res: Response) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('WWW-Authenticate', 'Session realm="cuddly"')
    res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先使用飞书登录' })
  }

  app.disable('x-powered-by')
  app.set('trust proxy', true)
  app.use('/api/v1/internal', requireInternalApi(options))
  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin?.startsWith('chrome-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, idempotency-key, x-cuddly-csrf')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
      }
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))

  app.get('/health/live', (_req, res) => res.json({ ok: true }))
  app.get('/health/ready', async (_req, res) => {
    await options.store.listBuildTargets()
    res.json({ ok: true })
  })

  if (options.auth) {
    const auth = options.auth
    const sessionMaxAgeMs = Math.max(
      5 * 60 * 1_000,
      Math.min(auth.sessionMaxAgeMs || SESSION_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1_000)
    )

    app.get('/api/v1/auth/feishu/start', (req, res) => {
      const state = oauthRandomToken()
      const verifier = oauthRandomToken(48)
      const returnTo = sanitizeReturnTo(req.query.return_to)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.cookie(OAUTH_STATE_COOKIE, state, {
        ...oauthCookieOptions,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      })
      res.cookie(OAUTH_VERIFIER_COOKIE, verifier, {
        ...oauthCookieOptions,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      })
      res.cookie(OAUTH_RETURN_COOKIE, returnTo, {
        ...oauthCookieOptions,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      })
      res.redirect(302, auth.client.authorizationUrl(state, pkceChallenge(verifier)))
    })

    app.get(callbackPath, async (req, res) => {
      const cookies = parseCookieHeader(req.get('cookie'))
      const expectedState = cookies[OAUTH_STATE_COOKIE] || ''
      const verifier = cookies[OAUTH_VERIFIER_COOKIE] || ''
      const returnTo = sanitizeReturnTo(cookies[OAUTH_RETURN_COOKIE])
      const actualState = typeof req.query.state === 'string' ? req.query.state : ''
      clearOAuthCookies(res)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')

      if (!expectedState || !actualState || !safeStringEqual(expectedState, actualState)) {
        res.redirect(303, withAuthError(returnTo, 'invalid_state'))
        return
      }
      if (typeof req.query.error === 'string') {
        res.redirect(303, withAuthError(returnTo, 'access_denied'))
        return
      }
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      if (!code || !verifier) {
        res.redirect(303, withAuthError(returnTo, 'invalid_callback'))
        return
      }

      try {
        const accessToken = await auth.client.exchangeCode(code, verifier)
        const identity = await auth.client.fetchIdentity(accessToken)
        const token = oauthRandomToken()
        const csrfToken = oauthRandomToken()
        const createdAt = new Date()
        const expiresAt = new Date(createdAt.getTime() + sessionMaxAgeMs)
        const existingToken = cookies[SESSION_COOKIE]
        if (existingToken) await options.store.deleteAuthSession(existingToken)
        await options.store.createAuthSession({
          token,
          tenantKey: identity.tenantKey,
          openId: identity.openId,
          unionId: identity.unionId,
          name: identity.name,
          avatarUrl: identity.avatarUrl,
          csrfToken,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        })
        res.cookie(SESSION_COOKIE, token, {
          ...sessionCookieOptions,
          maxAge: sessionMaxAgeMs,
        })
        res.redirect(303, oauthSuccessDestination(returnTo))
      } catch (error) {
        console.error(
          '[control-api] Feishu OAuth callback failed:',
          error instanceof FeishuOAuthError
            ? JSON.stringify({ phase: error.code, ...error.details })
            : error instanceof Error
              ? error.name
              : 'unexpected failure'
        )
        res.redirect(303, withAuthError(returnTo, 'oauth_failed'))
      }
    })

    app.get(OAUTH_COMPLETE_PATH, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      )
      res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录完成</title>
<link rel="stylesheet" href="/ui/cakeui.css">
<link rel="stylesheet" href="/ui/cakeui-theme.css">
<link rel="stylesheet" href="/ui/auth.css">
<style>
@layer bifrost-layout {
:root{color-scheme:light;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#202321;background:#f5f6f5}
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
main{width:min(100%,440px);border:1px solid #dfe3df;border-radius:8px;background:#fff;padding:28px;box-shadow:0 8px 28px rgba(32,35,33,.08)}
.mark{width:36px;height:36px;display:grid;place-items:center;border-radius:50%;background:#e9f7ef;color:#18794e;font-size:22px;font-weight:700}
h1{margin:18px 0 8px;font-size:20px;line-height:1.35;letter-spacing:0}p{margin:0;color:#626963;font-size:14px;line-height:1.7}
button{margin-top:22px;width:100%;height:44px;border:0;border-radius:6px;background:#202321;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#343835}button:focus-visible{outline:3px solid rgba(32,35,33,.22);outline-offset:2px}
}
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">&#10003;</div>
  <h1>飞书登录已完成</h1>
  <p>登录状态已经同步。此页面会尝试自动关闭；若仍停留在这里，请关闭此标签页并返回刚才的界面。</p>
  <button class="cake-button" data-variant="primary" type="button" id="close-page">关闭此页</button>
</main>
<script>
document.getElementById('close-page').addEventListener('click', () => window.close());
setTimeout(() => window.close(), 180);
</script>
</body>
</html>`)
    })

    app.get('/api/v1/auth/session', async (req, res) => {
      const session = await authenticateRequest(req)
      if (!session) {
        sendAuthRequired(res)
        return
      }
      attachRequestAuth(req, session)
      res.setHeader('Cache-Control', 'no-store')
      res.json({
        authenticated: true,
        ...(isPcGuestSession(session) ? { guest: true } : {}),
        identity: { name: session.name, avatarUrl: session.avatarUrl },
        csrfToken: session.csrfToken,
      })
    })

    app.post('/api/v1/auth/pc-guest', async (req, res) => {
      if (req.get('x-bifrost-client') !== 'kook-pc-plugin') {
        res.status(403).json({
          code: 'PC_GUEST_CLIENT_REQUIRED',
          message: '该会话入口仅供 KOOK PC 插件使用',
        })
        return
      }
      const token = oauthRandomToken()
      const csrfToken = oauthRandomToken()
      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + PC_GUEST_SESSION_MAX_AGE_MS)
      const session = await options.store.createAuthSession({
        token,
        tenantKey: PC_GUEST_TENANT_KEY,
        openId: `pc-guest-${randomUUID()}`,
        unionId: '',
        name: 'KOOK PC Guest',
        avatarUrl: '',
        csrfToken,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
      res.setHeader('Cache-Control', 'no-store')
      res.status(201).json({
        authenticated: true,
        guest: true,
        token,
        csrfToken,
        expiresAt: session.expiresAt,
        identity: { name: session.name, avatarUrl: session.avatarUrl },
      })
    })

    app.get('/api/v1/auth/pc-complete', async (req, res) => {
      const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : ''
      const token = parseCookieHeader(req.get('cookie'))[SESSION_COOKIE] || ''
      const session = token ? await options.store.getAuthSession(token) : null
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"
      )
      if (!session || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
        res.status(401).type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Bifrost 登录失败</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/ui/cakeui.css"><link rel="stylesheet" href="/ui/auth.css">
<main class="auth-completion"><h1>登录未完成</h1><p>无法把登录状态交给 KOOK PC，请关闭此窗口后重试。</p></main>`)
        return
      }
      const channel = JSON.stringify(`bifrost-pc-auth:${nonce}`).replaceAll('<', '\\u003c')
      const sessionToken = JSON.stringify(token).replaceAll('<', '\\u003c')
      res.type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Bifrost 登录完成</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/ui/cakeui.css"><link rel="stylesheet" href="/ui/auth.css">
<main class="auth-completion"><strong>飞书登录已完成</strong><p>正在返回 KOOK PC，稍后可以关闭此窗口。</p></main>
<script>
const channel = new BroadcastChannel(${channel});
channel.postMessage({ type: 'session', token: ${sessionToken} });
setTimeout(() => { channel.close(); window.close(); }, 300);
</script>`)
    })

    app.post('/api/v1/auth/logout', async (req, res) => {
      const session = await authenticateRequest(req)
      if (!session) {
        res.clearCookie(SESSION_COOKIE, sessionCookieOptions)
        sendAuthRequired(res)
        return
      }
      if (!validCsrf(req, session)) {
        res.status(403).json({ code: 'CSRF_INVALID', message: '登录状态校验失败，请刷新后重试' })
        return
      }
      const token = requestSessionToken(req)
      if (token) await options.store.deleteAuthSession(token)
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions)
      res.status(204).end()
    })

    app.use('/api/v1', async (req, res, next) => {
      if (req.path.toLowerCase().startsWith('/internal')) {
        next()
        return
      }
      const session = await authenticateRequest(req)
      if (!session) {
        sendAuthRequired(res)
        return
      }
      attachRequestAuth(req, session)
      if (isPcGuestSession(session) && !pcGuestCanAccess(req)) {
        res.status(403).json({
          code: 'GUEST_FORBIDDEN',
          message: 'KOOK PC Guest 无权修改系统设置',
        })
        return
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validCsrf(req, session)) {
        res.status(403).json({ code: 'CSRF_INVALID', message: '登录状态校验失败，请刷新后重试' })
        return
      }
      next()
    })
  } else {
    // Direct app construction is used by unit tests and local fixtures. Production always passes
    // an OAuth configuration from main.ts; the legacy actor header is never trusted there.
    app.use('/api/v1', (req, _res, next) => {
      const actor = req.get('x-cuddly-actor')?.trim().replace(/\s+/g, ' ').slice(0, 120)
      attachRequestAuth(req, {
        tenantKey: 'unauthenticated-test',
        openId: actor || 'qa-operator',
        unionId: '',
        name: actor || 'QA Operator',
        avatarUrl: '',
        csrfToken: '',
        createdAt: new Date(0).toISOString(),
        expiresAt: '9999-12-31T23:59:59.999Z',
      })
      next()
    })
  }

  app.get('/api/v1/admin/setup-status', (_req, res) => {
    res.json({ setupRequired: false, passwordRequired: false })
  })

  app.post('/api/v1/admin/setup', (_req, res) => {
    res.json({ unlocked: true, passwordRequired: false })
  })

  app.post('/api/v1/admin/unlock', (_req, res) => {
    res.json({ unlocked: true, passwordRequired: false })
  })

  app.get('/api/v1/admin/proxy-settings', async (_req, res) => {
    if (!options.proxySettings) {
      res.status(503).json({ code: 'PROXY_SETTINGS_UNAVAILABLE' })
      return
    }
    res.json(await options.proxySettings.getView())
  })

  app.patch('/api/v1/admin/proxy-settings', async (req, res) => {
    if (!options.proxySettings) {
      res.status(503).json({ code: 'PROXY_SETTINGS_UNAVAILABLE' })
      return
    }
    const parsed = updateProxySettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    try {
      res.json(await options.proxySettings.update(parsed.data, requestActor(req)))
    } catch (error) {
      res.status(400).json({
        code: 'PROXY_APPLY_FAILED',
        message: error instanceof Error ? error.message : '代理配置应用失败',
      })
    }
  })

  app.post('/api/v1/admin/proxy-settings/reset', async (req, res) => {
    if (!options.proxySettings) {
      res.status(503).json({ code: 'PROXY_SETTINGS_UNAVAILABLE' })
      return
    }
    const parsed = resetProxySettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    try {
      res.json(await options.proxySettings.reset(parsed.data.keys, requestActor(req)))
    } catch (error) {
      res.status(400).json({
        code: 'PROXY_APPLY_FAILED',
        message: error instanceof Error ? error.message : '代理配置应用失败',
      })
    }
  })

  app.post('/api/v1/admin/proxy-settings/refresh', async (_req, res) => {
    if (!options.proxySettings) {
      res.status(503).json({ code: 'PROXY_SETTINGS_UNAVAILABLE' })
      return
    }
    try {
      res.json(await options.proxySettings.refresh())
    } catch (error) {
      res.status(400).json({
        code: 'PROXY_APPLY_FAILED',
        message: error instanceof Error ? error.message : '代理配置刷新失败',
      })
    }
  })

  app.get('/api/v1/admin/build-targets', async (_req, res) => {
    const defaults = new Set((options.projectTemplates || []).map((target) => target.id))
    const items: BuildTargetSettingsView[] = await Promise.all(
      (await options.store.listBuildTargets(true)).map(async (target) => ({
        ...target,
        canReset: defaults.has(target.id),
        gitAuthorizationConfigured: (await getProjectAuthorization(options, target.id)).configured,
      }))
    )
    res.json({ items })
  })

  app.put('/api/v1/admin/build-targets/:targetId', async (req, res) => {
    const parsed = saveBuildTargetSchema.safeParse({ ...req.body, id: req.params.targetId })
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_PROJECT', issues: parsed.error.issues })
      return
    }
    const input = parsed.data
    const { gitAuthorizationHeader, clearGitAuthorizationHeader, ...projectInput } = input
    const authorizationKey = projectAuthorizationKey(input.id)
    if (clearGitAuthorizationHeader) {
      await options.store.updateRuntimeSettings(
        [{ key: authorizationKey, value: null }],
        requestActor(req)
      )
    } else if (gitAuthorizationHeader) {
      await options.store.updateRuntimeSettings(
        [
          {
            key: authorizationKey,
            value: encryptSetting(gitAuthorizationHeader, options.settingsSecret),
          },
        ],
        requestActor(req)
      )
    }
    const saved = await options.store.saveBuildTarget(
      {
        ...projectInput,
        repositoryUrl: projectInput.repositoryUrl || null,
        configurationSource: 'database',
      },
      requestActor(req)
    )
    remoteBranchCache.delete(saved.id)
    res.json({
      ...saved,
      canReset: (options.projectTemplates || []).some((item) => item.id === saved.id),
      gitAuthorizationConfigured: (await getProjectAuthorization(options, saved.id)).configured,
    })
  })

  app.post('/api/v1/admin/build-targets/:targetId/reset', async (req, res) => {
    const target = (options.projectTemplates || []).find((item) => item.id === req.params.targetId)
    if (!target) {
      res.status(404).json({ code: 'PROJECT_DEFAULT_NOT_FOUND', message: '这个项目没有内置模板' })
      return
    }
    await options.store.updateRuntimeSettings(
      [{ key: projectAuthorizationKey(target.id), value: null }],
      requestActor(req)
    )
    const saved = await options.store.saveBuildTarget(target, requestActor(req))
    remoteBranchCache.delete(saved.id)
    res.json({ ...saved, canReset: true, gitAuthorizationConfigured: false })
  })

  app.get('/api/v1/admin/environments', async (_req, res) => {
    res.json({ items: await options.store.listEnvironments(true) })
  })

  app.get('/api/v1/admin/environments/:environmentSlug/projects', async (req, res) => {
    const environment = await options.store.getEnvironment(req.params.environmentSlug)
    if (!environment || environment.slug !== req.params.environmentSlug) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    res.json({ environment, items: await environmentProjectItems(environment) })
  })

  app.put('/api/v1/admin/environments/:environmentSlug/projects', async (req, res) => {
    const environment = await options.store.getEnvironment(req.params.environmentSlug)
    if (!environment || environment.slug !== req.params.environmentSlug) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    const parsed = saveProjectEnvironmentConfigsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_ENVIRONMENT_PROJECTS', issues: parsed.error.issues })
      return
    }
    const targets = new Map(
      (await options.store.listBuildTargets(true)).map((target) => [target.id, target])
    )
    const missingTarget = parsed.data.items.find((item) => !targets.has(item.targetId))
    if (missingTarget) {
      res.status(400).json({
        code: 'ENVIRONMENT_PROJECT_NOT_FOUND',
        message: `项目不存在：${missingTarget.targetId}`,
      })
      return
    }
    await options.store.saveProjectEnvironmentConfigs(
      parsed.data.items.map((item) => ({ ...item, environmentId: environment.id })),
      requestActor(req)
    )
    res.json({ environment, items: await environmentProjectItems(environment) })
  })

  app.put('/api/v1/admin/environments/:environmentSlug', async (req, res) => {
    if (typeof req.body?.slug === 'string' && req.body.slug.trim() !== req.params.environmentSlug) {
      res.status(409).json({
        code: 'ENVIRONMENT_SLUG_IMMUTABLE',
        message: '环境标识创建后不能修改',
      })
      return
    }
    const submittedUseInternalProxy = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'useInternalProxy'
    )
    const submittedResourceProxyPrefixes = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'resourceProxyPrefixes'
    )
    const parsed = saveEnvironmentSchema.safeParse({
      ...req.body,
      slug: req.params.environmentSlug,
    })
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_ENVIRONMENT', issues: parsed.error.issues })
      return
    }
    const existing = await options.store.getEnvironment(parsed.data.slug)
    if (parsed.data.status === 'ARCHIVED' && existing?.status !== 'ARCHIVED') {
      const settings = await resolveSystemSettings(options.store)
      if (settings.inPlaceUrlRules.some((rule) => rule.environmentSlug === parsed.data.slug)) {
        res.status(409).json({
          code: 'ENVIRONMENT_REFERENCED_BY_IN_PLACE_RULE',
          message: '该环境仍被官网原地应用规则引用，请先删除对应规则',
        })
        return
      }
    }
    try {
      const environment = await options.store.saveEnvironment(
        {
          id: existing?.id ?? randomUUID(),
          ...parsed.data,
          useInternalProxy: submittedUseInternalProxy
            ? parsed.data.useInternalProxy
            : (existing?.useInternalProxy ?? false),
          resourceProxyPrefixes: submittedResourceProxyPrefixes
            ? parsed.data.resourceProxyPrefixes
            : (existing?.resourceProxyPrefixes ?? []),
          currentRevisionId: existing?.currentRevisionId ?? null,
        },
        requestActor(req)
      )
      res.json(environment)
    } catch (error) {
      if (
        error instanceof InvalidSelectionError ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      ) {
        res.status(409).json({
          code: 'ENVIRONMENT_CONFLICT',
          message: error instanceof Error ? error.message : '环境标识已存在',
        })
        return
      }
      throw error
    }
  })

  app.get('/api/v1/admin/site-bindings', async (_req, res) => {
    res.json({ items: await options.store.listSiteBindings(true) })
  })

  app.get('/api/v1/admin/site-bindings/:siteBindingId', async (req, res) => {
    const binding = await options.store.getSiteBinding(req.params.siteBindingId)
    if (!binding) {
      res.status(404).json({ code: 'SITE_BINDING_NOT_FOUND' })
      return
    }
    res.json(binding)
  })

  app.put('/api/v1/admin/site-bindings/:siteBindingId', async (req, res) => {
    const parsed = saveSiteBindingSchema.safeParse({
      ...req.body,
      id: req.params.siteBindingId,
    })
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_SITE_BINDING', issues: parsed.error.issues })
      return
    }
    const validationError = await validateSiteBinding(options, parsed.data, previewBaseDomain)
    if (validationError) {
      res.status(validationError.code.endsWith('_CONFLICT') ? 409 : 400).json(validationError)
      return
    }
    res.json(await options.store.saveSiteBinding(parsed.data, requestActor(req)))
  })

  app.delete('/api/v1/admin/site-bindings/:siteBindingId', async (req, res) => {
    const deleted = await options.store.deleteSiteBinding(
      req.params.siteBindingId,
      requestActor(req)
    )
    if (!deleted) {
      res.status(404).json({ code: 'SITE_BINDING_NOT_FOUND' })
      return
    }
    res.status(204).end()
  })

  app.get('/api/v1/admin/system-settings', async (_req, res) => {
    res.json(await resolveSystemSettings(options.store))
  })

  app.patch('/api/v1/admin/system-settings', async (req, res) => {
    const parsed = updateSystemSettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_SETTINGS', issues: parsed.error.issues })
      return
    }
    const input = parsed.data
    if (input.inPlaceUrlRules !== undefined) {
      const environments = new Map(
        (await options.store.listEnvironments(true)).map((environment) => [
          environment.slug,
          environment,
        ])
      )
      const invalidRuleIndex = input.inPlaceUrlRules.findIndex((rule) => {
        const environment = environments.get(rule.environmentSlug)
        return !environment || environment.status === 'ARCHIVED'
      })
      if (invalidRuleIndex >= 0) {
        const invalidRule = input.inPlaceUrlRules[invalidRuleIndex]!
        res.status(400).json({
          code: 'IN_PLACE_RULE_ENVIRONMENT_INVALID',
          message: `第 ${invalidRuleIndex + 1} 条原地应用规则引用了不存在或已归档的环境：${invalidRule.environmentSlug}`,
          index: invalidRuleIndex,
          environmentSlug: invalidRule.environmentSlug,
        })
        return
      }
    }
    const changes: RuntimeSettingChange[] = []
    if (input.mobileUpstream !== undefined) {
      changes.push({ key: SYSTEM_SETTING_KEYS.mobileUpstream, value: input.mobileUpstream })
    }
    if (input.publicMobileOrigin !== undefined) {
      changes.push({ key: SYSTEM_SETTING_KEYS.publicMobileOrigin, value: input.publicMobileOrigin })
    }
    if (input.webappUpstream !== undefined) {
      changes.push({ key: SYSTEM_SETTING_KEYS.webappUpstream, value: input.webappUpstream })
    }
    if (input.publicPreviewOrigin !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.publicPreviewOrigin,
        value: input.publicPreviewOrigin,
      })
    }
    if (input.mobileHostnames !== undefined) {
      changes.push({ key: SYSTEM_SETTING_KEYS.mobileHostnames, value: input.mobileHostnames })
    }
    if (input.cookieDomain !== undefined) {
      changes.push({ key: SYSTEM_SETTING_KEYS.cookieDomain, value: input.cookieDomain })
    }
    if (input.buildMaxConcurrency !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.buildMaxConcurrency,
        value: input.buildMaxConcurrency,
      })
    }
    if (input.runnerRequestTimeoutMinutes !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.runnerRequestTimeoutMinutes,
        value: input.runnerRequestTimeoutMinutes,
      })
    }
    if (input.useChinaRegistry !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.useChinaRegistry,
        value: input.useChinaRegistry,
      })
    }
    if (input.proxyRewriteMaxMegabytes !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.proxyRewriteMaxMegabytes,
        value: input.proxyRewriteMaxMegabytes,
      })
    }
    if (input.autoSslEnabled !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.autoSslEnabled,
        value: input.autoSslEnabled,
      })
    }
    if (input.autoSslEmail !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.autoSslEmail,
        value: input.autoSslEmail,
      })
    }
    if (input.inPlaceUrlRules !== undefined) {
      changes.push({
        key: SYSTEM_SETTING_KEYS.inPlaceUrlRules,
        value: input.inPlaceUrlRules,
      })
    }
    await options.store.updateRuntimeSettings(changes, requestActor(req))
    res.json(await resolveSystemSettings(options.store))
  })

  app.get('/api/v1/internal/auto-ssl-config', async (_req, res) => {
    const [settings, bindings] = await Promise.all([
      resolveSystemSettings(options.store),
      options.store.listSiteBindings(),
    ])
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      autoSslEnabled: settings.autoSslEnabled,
      autoSslEmail: settings.autoSslEmail,
      hostnames: bindings.filter((binding) => binding.enabled).map((binding) => binding.hostname),
    })
  })

  app.get('/api/v1/environments', async (_req, res) => {
    res.json({ items: await options.store.listEnvironments() })
  })

  app.get('/api/v1/build-targets', async (req, res) => {
    const environmentSlug =
      typeof req.query.environment === 'string' ? req.query.environment : 'shared'
    const environment = await options.store.getEnvironment(environmentSlug)
    if (!environment || environment.status === 'ARCHIVED') {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    const [targets, configs] = await Promise.all([
      options.store.listBuildTargets(true),
      options.store.listProjectEnvironmentConfigs(environment.id),
    ])
    const targetsById = new Map(targets.map((target) => [target.id, target]))
    res.json({
      environment,
      items: configs
        .map((config) => {
          const target = targetsById.get(config.targetId)
          return target ? environmentTarget(target, config) : null
        })
        .filter((target): target is NonNullable<typeof target> => target !== null),
    })
  })

  app.get('/api/v1/build-targets/:targetId/branches', async (req, res) => {
    const environmentSlug =
      typeof req.query.environment === 'string' ? req.query.environment : 'shared'
    const [target, environment] = await Promise.all([
      options.store.getBuildTarget(req.params.targetId),
      options.store.getEnvironment(environmentSlug),
    ])
    if (!target || !environment || environment.status === 'ARCHIVED') {
      res.status(404).json({ code: 'TARGET_NOT_FOUND' })
      return
    }
    const config = await options.store.getProjectEnvironmentConfig(environment.id, target.id)
    if (!config) {
      res.status(404).json({ code: 'TARGET_NOT_IN_ENVIRONMENT' })
      return
    }
    const catalog = await options.store.listBranchCatalog(target.id, environment.id)
    if (environment.status === 'FROZEN') {
      res.json({
        environment,
        items: mergeBranches(
          catalog.filter((item) => item.latestArtifact !== null),
          [],
          String(req.query.query || '')
        ),
        remoteAvailable: false,
      })
      return
    }
    let remoteBranches: string[] = []
    const repositoryUrl = target.repositoryUrl
    if (repositoryUrl) {
      const authorization = await getProjectAuthorization(options, target.id)
      remoteBranches = await cachedRemoteBranches(
        target.id,
        repositoryUrl,
        authorization.encrypted
          ? decryptSetting(authorization.encrypted, options.settingsSecret)
          : undefined
      )
    }
    res.json({
      environment,
      items: mergeBranches(catalog, remoteBranches, String(req.query.query || '')),
      remoteAvailable: remoteBranches.length > 0,
    })
  })

  app.post('/api/v1/build-jobs', async (req, res) => {
    const parsed = createBuildJobSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    const [target, environment] = await Promise.all([
      options.store.getBuildTarget(parsed.data.targetId),
      options.store.getEnvironment(parsed.data.environmentSlug),
    ])
    if (!target?.enabled) {
      res.status(404).json({ code: 'TARGET_NOT_FOUND' })
      return
    }
    if (!environment) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    if (environment.status !== 'ACTIVE') {
      res.status(409).json({
        code: 'ENVIRONMENT_NOT_ACTIVE',
        message: '只有活动环境可以发起构建',
      })
      return
    }
    const config = await options.store.getProjectEnvironmentConfig(environment.id, target.id)
    if (!config?.enabled) {
      res.status(409).json({
        code: 'TARGET_NOT_ENABLED_IN_ENVIRONMENT',
        message: '项目没有在这个环境中启用',
      })
      return
    }
    if (!target.repositoryUrl) {
      res.status(409).json({ code: 'TARGET_NOT_CONFIGURED', message: '项目没有配置 Git 仓库地址' })
      return
    }
    const idempotencyKey = req.headers['idempotency-key']
    const systemSettings = await resolveSystemSettings(options.store)
    let job: BuildJob
    try {
      job = await options.store.createBuildJob({
        id: randomUUID(),
        environmentId: environment.id,
        environmentSlug: environment.slug,
        targetId: parsed.data.targetId,
        branch: parsed.data.branch,
        profile: parsed.data.profile,
        requestedBy: requestActor(req),
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
        targetSnapshot: {
          id: target.id,
          environment: {
            id: environment.id,
            slug: environment.slug,
            name: environment.name,
            backendOrigin: environment.backendOrigin,
          },
          kind: target.kind,
          repositoryUrl: target.repositoryUrl,
          installCommand: config.installCommand,
          buildCommand: config.buildCommand,
          outputDirectory: config.outputDirectory,
          siteAdapter: target.siteAdapter,
          useChinaRegistry: systemSettings.useChinaRegistry,
          gitAuthorization: (await getProjectAuthorization(options, target.id)).encrypted,
        },
      })
    } catch (error) {
      if (error instanceof InvalidSelectionError) {
        res.status(409).json({ code: 'BUILD_NOT_ALLOWED', message: error.message })
        return
      }
      throw error
    }
    res.status(202).json(publicBuildJob(job))
  })

  app.get('/api/v1/build-jobs', async (req, res) => {
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : undefined
    const environmentSlug =
      typeof req.query.environment === 'string' ? req.query.environment : 'shared'
    const environment = await options.store.getEnvironment(environmentSlug)
    if (!environment) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    const status = typeof req.query.status === 'string' ? req.query.status : ''
    if (
      req.query.status !== undefined &&
      (typeof req.query.status !== 'string' ||
        (status !== '' && !buildJobStatuses.includes(status as BuildJobStatus)))
    ) {
      res.status(400).json({ code: 'INVALID_REQUEST', message: 'status is invalid' })
      return
    }
    const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : ''
    const pageMode = req.query.page !== undefined || req.query.pageSize !== undefined
    if (pageMode) {
      const page = positiveIntegerQuery(req.query.page, 1, BUILD_HISTORY_MAX_PAGE)
      const pageSize = positiveIntegerQuery(
        req.query.pageSize,
        BUILD_HISTORY_DEFAULT_PAGE_SIZE,
        BUILD_HISTORY_MAX_PAGE_SIZE
      )
      if (page === null || pageSize === null) {
        res.status(400).json({
          code: 'INVALID_REQUEST',
          message: `page must be an integer from 1 to ${BUILD_HISTORY_MAX_PAGE}; pageSize must be an integer from 1 to ${BUILD_HISTORY_MAX_PAGE_SIZE}`,
        })
        return
      }
      const result = await options.store.listBuildJobPage({
        environmentId: environment.id,
        targetId,
        status: status ? (status as BuildJobStatus) : undefined,
        query,
        page,
        pageSize,
      })
      res.json({ ...result, items: result.items.map(publicBuildJob) })
      return
    }
    const before = typeof req.query.before === 'string' ? req.query.before : ''
    const requestedLimit = Number(req.query.limit || 50)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
      : 50
    const jobs = (await options.store.listBuildJobs(targetId, environment.id))
      .filter((job) => !status || job.status === status)
      .filter((job) => !before || job.createdAt < before)
      .filter(
        (job) =>
          !query ||
          job.id.toLowerCase().includes(query) ||
          job.branch.toLowerCase().includes(query) ||
          job.requestedBy.toLowerCase().includes(query)
      )
      .slice(0, limit)
    res.json({
      items: jobs.map(publicBuildJob),
      nextCursor: jobs.length === limit ? jobs.at(-1)?.createdAt || null : null,
    })
  })

  app.get('/api/v1/build-queue', async (req, res) => {
    const jobs = await options.store.listBuildQueue()
    let queuePosition = 0
    const items: BuildQueueItem[] = jobs.map((job) => {
      const queued = job.status === 'QUEUED'
      if (queued) queuePosition += 1
      return {
        id: job.id,
        environmentId: job.environmentId,
        environmentSlug: job.environmentSlug,
        targetId: job.targetId,
        branch: job.branch,
        status: job.status,
        requestedBy: job.requestedBy,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        queuePosition: queued ? queuePosition : null,
        isMine: job.requestedBy === requestActor(req),
      }
    })
    res.json({
      running: items.filter((item) => item.status !== 'QUEUED'),
      queued: items.filter((item) => item.status === 'QUEUED'),
      generatedAt: new Date().toISOString(),
    })
  })

  app.get('/api/v1/build-jobs/:jobId', async (req, res) => {
    const job = await options.store.getBuildJob(req.params.jobId)
    if (!job) {
      res.status(404).json({ code: 'JOB_NOT_FOUND' })
      return
    }
    res.json(publicBuildJob(job))
  })

  app.post('/api/v1/build-jobs/:jobId/cancel', async (req, res) => {
    const result = await options.store.requestBuildJobCancellation(
      req.params.jobId,
      requestActor(req)
    )
    res.setHeader('Cache-Control', 'no-store')
    if (result.outcome === 'NOT_FOUND') {
      res.status(404).json({ code: 'JOB_NOT_FOUND' })
      return
    }
    if (result.outcome === 'NOT_CANCELABLE') {
      res.status(409).json({
        code: 'JOB_NOT_CANCELABLE',
        message: '已经结束的构建不能中断',
        job: publicBuildJob(result.job),
      })
      return
    }
    res.status(result.outcome === 'CANCELING' ? 202 : 200).json(publicBuildJob(result.job))
  })

  app.get('/api/v1/build-jobs/:jobId/detail', async (req, res) => {
    const job = await options.store.getBuildJob(req.params.jobId)
    if (!job) {
      res.status(404).json({ code: 'JOB_NOT_FOUND' })
      return
    }
    const [events, artifact] = await Promise.all([
      options.store.listBuildJobEvents(job.id),
      options.store.getArtifactByBuildJobId(job.id),
    ])
    const detail: BuildJobDetail = {
      job: publicBuildJob(job),
      commands: buildCommandPlan(job),
      events,
      artifact: artifact
        ? {
            id: artifact.id,
            status: artifact.status,
            builtAt: artifact.builtAt,
            fileCount: artifact.manifest.files.length,
            entrypoints: artifact.manifest.serve.entrypoints,
            publicBase: redactSensitiveText(artifact.manifest.serve.publicBase),
          }
        : null,
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(detail)
  })

  app.get('/api/v1/build-jobs/:jobId/log', async (req, res) => {
    const job = await options.store.getBuildJob(req.params.jobId)
    if (!job) {
      res.status(404).json({ code: 'JOB_NOT_FOUND' })
      return
    }
    const download = req.query.download === '1'
    const log = await readBuildLog(
      options,
      job,
      download ? LOG_DOWNLOAD_MAX_BYTES : LOG_VIEW_MAX_BYTES
    )
    res.setHeader('Cache-Control', 'no-store')
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${job.id}.sanitized.log"`)
      res.type('text/plain').send(log.content)
      return
    }
    res.json(log)
  })

  app.get('/api/v1/artifacts', async (req, res) => {
    const targetId = String(req.query.targetId || '')
    if (!targetId) {
      res.status(400).json({ code: 'TARGET_REQUIRED' })
      return
    }
    const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined
    const environmentSlug =
      typeof req.query.environment === 'string' ? req.query.environment : 'shared'
    const environment = await options.store.getEnvironment(environmentSlug)
    if (!environment) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    res.json({ items: await options.store.listArtifacts(targetId, branch, environment.id) })
  })

  app.get('/api/v1/environments/:environmentId/matrix', async (req, res) => {
    const environmentId = String(req.params.environmentId || '')
    const environment = await options.store.getEnvironment(environmentId)
    if (!environment) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    if (environment.status === 'ARCHIVED') {
      res.status(410).json({ code: 'ENVIRONMENT_ARCHIVED' })
      return
    }
    const matrix = await options.store.getEnvironmentMatrix(environment.id)
    if (!matrix) {
      res.status(404).json({ code: 'ENVIRONMENT_NOT_FOUND' })
      return
    }
    res.json(matrix)
  })

  app.get('/api/v1/site-bindings/candidates', async (req, res) => {
    const officialOrigin =
      typeof req.query.officialOrigin === 'string' ? req.query.officialOrigin.trim() : ''
    const normalizedOrigin = normalizeRequestOrigin(officialOrigin)
    if (!normalizedOrigin) {
      res.status(400).json({ code: 'SITE_BINDING_ORIGIN_INVALID' })
      return
    }
    const bindings = await options.store.listSiteBindingsByOfficialOrigin(normalizedOrigin)
    const candidates = await Promise.all(
      bindings.map(async (binding) => {
        const environment = await options.store.getEnvironment(binding.environmentSlug)
        return environment
          ? {
              ...binding,
              environmentName: environment.name,
              environmentStatus: environment.status,
            }
          : null
      })
    )
    res.json({
      items: candidates.filter(
        (candidate): candidate is NonNullable<typeof candidate> => candidate !== null
      ),
    })
  })

  app.get('/api/v1/site-bindings/resolve', async (req, res) => {
    const hostname = typeof req.query.hostname === 'string' ? req.query.hostname.trim() : ''
    const officialOrigin =
      typeof req.query.officialOrigin === 'string' ? req.query.officialOrigin.trim() : ''
    if ((!hostname && !officialOrigin) || (hostname && officialOrigin)) {
      res.status(400).json({
        code: 'SITE_BINDING_LOOKUP_INVALID',
        message: '必须且只能提供 hostname 或 officialOrigin',
      })
      return
    }

    let binding: SiteBinding | null
    if (hostname) {
      binding = await options.store.getSiteBindingByHostname(normalizeRequestHostname(hostname))
    } else {
      const normalizedOrigin = normalizeRequestOrigin(officialOrigin)
      if (!normalizedOrigin) {
        res.status(400).json({ code: 'SITE_BINDING_ORIGIN_INVALID' })
        return
      }
      binding = await options.store.getSiteBindingByOfficialOrigin(normalizedOrigin)
    }
    if (!binding) {
      res.status(404).json({ code: 'SITE_BINDING_NOT_FOUND' })
      return
    }
    const environment = await options.store.getEnvironment(binding.environmentSlug)
    if (!environment) {
      res.status(409).json({ code: 'ENVIRONMENT_UNAVAILABLE' })
      return
    }
    res.json(binding)
  })

  app.get('/api/v1/runtime', async (_req, res) => {
    const settings = await resolveSystemSettings(options.store)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      mobileEnvironmentUrl: settings.publicMobileOrigin,
      previewOrigin: settings.publicPreviewOrigin,
      previewBaseDomain,
      webappOrigin: settings.webappUpstream,
      inPlaceUrlRules: settings.inPlaceUrlRules,
    })
  })

  app.post('/api/v1/config-groups', async (req, res) => {
    const parsed = createConfigurationGroupSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }

    const { environment, binding } = await validateConfigurationGroupContext(parsed.data)

    const token = configurationGroupToken()
    const previewSlug = configurationGroupPreviewSlug()
    const previewHostnamePrefix = parsed.data.urlPrefix
      ? canonicalConfigurationGroupUrlPrefix(parsed.data.urlPrefix)
      : `p-${previewSlug}`
    if (parsed.data.urlPrefix) {
      if (!previewHostnamePrefix) {
        res.status(400).json({
          code: 'CONFIG_GROUP_URL_PREFIX_INVALID',
          message: '中文前缀转换后的域名超过长度限制，请缩短后重试',
        })
        return
      }
      const reservedReason = customConfigurationGroupUrlPrefixError(previewHostnamePrefix)
      if (reservedReason) {
        res.status(400).json({
          code: 'CONFIG_GROUP_URL_PREFIX_RESERVED',
          message: reservedReason,
        })
        return
      }
    }
    const previewHostname = `${previewHostnamePrefix}.${previewBaseDomain}`
    const [prefixGroup, prefixBinding] = await Promise.all([
      options.store.getConfigurationGroupByPreviewHostnamePrefix(previewHostnamePrefix),
      options.store.getSiteBindingByHostname(previewHostname, true),
    ])
    if (prefixGroup || prefixBinding) {
      res.status(409).json({
        code: 'CONFIG_GROUP_URL_PREFIX_CONFLICT',
        message: prefixGroup
          ? `地址前缀已由提测需求“${prefixGroup.name}”使用`
          : `地址前缀已由预览站点“${prefixBinding!.name}”使用`,
      })
      return
    }

    let group: ConfigurationGroup
    try {
      group = await options.store.createConfigurationGroup({
        token,
        previewSlug,
        previewHostnamePrefix,
        name: parsed.data.name,
        environmentId: environment.id,
        environmentSlug: environment.slug,
        siteBindingId: binding.id,
        schemaVersion: 1,
        items: parsed.data.items,
        createdBy: requestActor(req),
      })
    } catch (error) {
      if (error instanceof InvalidSelectionError) {
        const prefixConflict = error.message.includes('preview hostname already exists')
        requestError(
          409,
          prefixConflict ? 'CONFIG_GROUP_URL_PREFIX_CONFLICT' : 'CONFIG_GROUP_CONTEXT_CHANGED',
          prefixConflict
            ? '地址前缀刚刚被其他人使用，请换一个前缀'
            : '环境或站点刚刚发生变化，请刷新后重试'
        )
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        requestError(
          409,
          'CONFIG_GROUP_URL_PREFIX_CONFLICT',
          '地址前缀刚刚被其他人使用，请换一个前缀'
        )
      }
      throw error
    }
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json((await resolveConfigurationGroup(group)).view)
  })

  app.get('/api/v1/config-groups', async (_req, res) => {
    const groups = await options.store.listConfigurationGroups()
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      items: groups.map((group) => configurationGroupManagementView(group, previewBaseDomain)),
    })
  })

  app.get('/api/v1/config-groups/resolve-preview', async (req, res) => {
    const hostname = normalizeRequestHostname(
      typeof req.query.hostname === 'string' ? req.query.hostname : ''
    )
    const previewHostnamePrefix = configurationGroupHostnamePrefixFromHostname(
      hostname,
      previewBaseDomain
    )
    if (!previewHostnamePrefix) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '当前域名不是分享预览' })
      return
    }
    const group =
      await options.store.getConfigurationGroupByPreviewHostnamePrefix(previewHostnamePrefix)
    if (!group) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '分享预览不存在' })
      return
    }
    const resolved = await resolveConfigurationGroup(group)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      configurationGroup: resolved.view,
      siteBinding: resolved.binding,
      environment: resolved.environment,
    })
  })

  app.put('/api/v1/config-groups/:token', async (req, res) => {
    if (!isConfigurationGroupToken(req.params.token)) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    const parsed = updateConfigurationGroupSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    const { expectedRevision, ...snapshot } = parsed.data
    const { environment, binding } = await validateConfigurationGroupContext(snapshot)
    let result: Awaited<ReturnType<CuddlyStore['updateConfigurationGroup']>>
    try {
      result = await options.store.updateConfigurationGroup(
        req.params.token,
        {
          ...snapshot,
          environmentId: environment.id,
          environmentSlug: environment.slug,
          siteBindingId: binding.id,
        },
        expectedRevision,
        requestActor(req)
      )
    } catch (error) {
      if (error instanceof InvalidSelectionError) {
        requestError(409, 'CONFIG_GROUP_CONTEXT_CHANGED', '环境或站点刚刚发生变化，请刷新后重试')
      }
      throw error
    }
    if (result.outcome === 'NOT_FOUND') {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    if (result.outcome === 'CONFLICT') {
      res.status(409).json({
        code: 'CONFIG_GROUP_REVISION_CONFLICT',
        message: '配置组已被其他人更新，请刷新后重试',
        currentRevision: result.currentRevision,
      })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json((await resolveConfigurationGroup(result.group)).view)
  })

  app.delete('/api/v1/config-groups/:token', async (req, res) => {
    if (!isConfigurationGroupToken(req.params.token)) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    const deleted = await options.store.deleteConfigurationGroup(
      req.params.token,
      requestActor(req)
    )
    if (!deleted) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    res.status(204).end()
  })

  app.get('/api/v1/config-groups/:token', async (req, res) => {
    if (!isConfigurationGroupToken(req.params.token)) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    const group = await options.store.getConfigurationGroup(req.params.token)
    if (!group) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json((await resolveConfigurationGroup(group)).view)
  })

  app.post('/api/v1/config-groups/:token/previews', async (req, res) => {
    if (!isConfigurationGroupToken(req.params.token)) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    const parsed = createConfigurationGroupPreviewSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    const group = await options.store.getConfigurationGroup(req.params.token)
    if (!group) {
      res.status(404).json({ code: 'CONFIG_GROUP_NOT_FOUND', message: '配置组不存在' })
      return
    }
    if (
      parsed.data.expectedRevision !== undefined &&
      parsed.data.expectedRevision !== group.revision
    ) {
      res.setHeader('Cache-Control', 'no-store')
      res.status(409).json({
        code: 'CONFIG_GROUP_REVISION_CONFLICT',
        message: '配置组已被其他人更新，请刷新后重试',
        currentRevision: group.revision,
      })
      return
    }
    const resolved = await resolveConfigurationGroup(group)
    if (!resolved.view.available) {
      requestError(
        409,
        'CONFIG_GROUP_UNAVAILABLE',
        '配置组与当前环境或站点设置不再匹配，请重新创建分享链接'
      )
    }
    const applicationMode = parsed.data.applicationMode ?? 'complete'
    const requestedItems =
      applicationMode === 'remote-only'
        ? resolved.view.items.filter((item) => item.targetId !== resolved.binding.targetId)
        : resolved.view.items
    const missing = requestedItems
      .filter((item) => item.readiness === 'MISSING')
      .map((item) => ({
        targetId: item.targetId,
        targetName: item.targetName,
        branch: item.mode === 'branch' ? item.branch : '',
      }))
    if (missing.length) {
      requestError(
        409,
        'CONFIG_GROUP_ARTIFACTS_NOT_READY',
        '配置组中仍有分支没有成功可用的打包产物',
        { missing }
      )
    }

    const branchItems = requestedItems.filter(
      (item): item is ConfigurationGroupViewItem & { mode: 'branch' } => item.mode === 'branch'
    )
    const siteItem =
      applicationMode === 'complete'
        ? branchItems.find((item) => item.targetId === resolved.binding.targetId)
        : undefined
    const remoteItems = branchItems.filter((item) => item.targetId !== resolved.binding.targetId)
    const preview = await createValidatedPreview(
      {
        ttlMinutes: 1440,
        siteBindingId: resolved.binding.id,
        environmentSlug: resolved.environment.slug,
        siteArtifactId: siteItem ? resolved.artifacts.get(siteItem.targetId)?.id : undefined,
        selections: remoteItems.map((item) => ({
          targetId: item.targetId,
          artifactId: resolved.artifacts.get(item.targetId)!.id,
        })),
      },
      requestActor(req)
    )
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({
      mode: 'preview',
      applicationMode,
      configurationGroup: resolved.view,
      preview,
      previewOrigin: `${req.protocol}://${resolved.binding.hostname}`,
    })
  })

  app.get('/api/v1/previews/:token', async (req, res) => {
    const preview = await options.store.getPreviewSession(req.params.token)
    if (!preview) {
      res.status(404).json({ code: 'PREVIEW_NOT_FOUND' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(await previewSessionView(options, preview))
  })

  app.delete('/api/v1/previews/:token', async (req, res) => {
    await options.store.revokePreviewSession(req.params.token)
    res.status(204).end()
  })

  app.post('/api/v1/previews', async (req, res) => {
    const parsed = createPreviewSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    res.status(201).json(await createValidatedPreview(parsed.data, requestActor(req)))
  })

  app.post('/api/v1/environments/:environmentId/revisions', (_req, res) => {
    res.status(410).json({
      code: 'PUBLIC_REVISION_DISABLED',
      message: '公共环境发布已停用，请使用浏览器扩展创建按标签页隔离的预览',
    })
  })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiRequestError) {
      res.status(error.status).json(error.body)
      return
    }
    console.error('[control-api] request failed', error)
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : '服务器处理失败',
    })
  })

  return app
}
