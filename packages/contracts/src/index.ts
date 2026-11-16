import { z } from 'zod'
export * from './mcp-tokens'

export const CHINA_NPM_REGISTRY = 'https://registry.npmmirror.com'

export const buildJobStatuses = [
  'QUEUED',
  'LEASED',
  'CHECKOUT',
  'INSTALLING',
  'BUILDING',
  'VALIDATING',
  'UPLOADING',
  'CANCELING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
] as const

export type BuildJobStatus = (typeof buildJobStatuses)[number]

export const artifactStatuses = ['STAGING', 'READY', 'QUARANTINED', 'DELETING', 'DELETED'] as const
export type ArtifactStatus = (typeof artifactStatuses)[number]

export const runnerStages = [
  'CHECKOUT',
  'INSTALLING',
  'BUILDING',
  'VALIDATING',
  'UPLOADING',
] as const
export type RunnerStage = (typeof runnerStages)[number]

export const buildTargetKinds = ['webapp', 'h5-site', 'spa-site', 'remote'] as const
export type BuildTargetKind = (typeof buildTargetKinds)[number]

export const siteBuildAdapters = ['kook-online-h5-v1', 'generic-static-v1'] as const
export type SiteBuildAdapter = (typeof siteBuildAdapters)[number]
export const siteBindingIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const kookRemoteModuleKeys = [
  'base',
  'discover',
  'gift',
  'guild',
  'help_center',
  'mall',
  'mini_game',
  'order_tracker',
  'profile',
  'settings',
  'thread',
  'tutorial',
  'voice_panel',
  'voice_runtime',
] as const

export type BuildTargetConfigurationSource = 'template' | 'database'

export const environmentStatuses = ['ACTIVE', 'FROZEN', 'ARCHIVED'] as const
export type EnvironmentStatus = (typeof environmentStatuses)[number]

export const environmentSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)

export const inPlaceUrlRuleSchema = z
  .object({
    pattern: z.string().trim().min(1).max(2048),
    environmentSlug: environmentSlugSchema,
  })
  .strict()

export const inPlaceUrlRulesSchema = z
  .array(inPlaceUrlRuleSchema)
  .max(100)
  .superRefine((rules, context) => {
    const seenPatterns = new Map<string, number>()
    rules.forEach((rule, index) => {
      const previousIndex = seenPatterns.get(rule.pattern)
      if (previousIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'pattern'],
          message: `URL pattern duplicates rule ${previousIndex + 1}`,
        })
        return
      }
      seenPatterns.set(rule.pattern, index)
    })
  })

export type InPlaceUrlRule = z.infer<typeof inPlaceUrlRuleSchema>

export interface BuildEnvironmentSnapshot {
  id: string
  slug: string
  name: string
  backendOrigin: string
}

export interface BuildTargetExecution {
  id: string
  environment: BuildEnvironmentSnapshot
  kind?: BuildTargetKind
  repositoryUrl: string
  installCommand: string
  buildCommand: string
  outputDirectory: string
  siteAdapter: string
  useChinaRegistry?: boolean
  gitAuthorization?: {
    version: 1
    iv: string
    tag: string
    ciphertext: string
  }
}

export interface BuildTarget {
  id: string
  name: string
  kind: BuildTargetKind
  repositoryUrl: string | null
  defaultBranch: string
  installCommand: string
  buildCommand: string
  outputDirectory: string
  siteAdapter: string
  enabled: boolean
  required: boolean
  configurationSource: BuildTargetConfigurationSource
}

export interface BuildTargetSummary {
  id: string
  name: string
  kind: BuildTargetKind
  defaultBranch: string
  enabled: boolean
  required: boolean
  configured: boolean
}

export interface BuildTargetSettingsView extends BuildTarget {
  canReset: boolean
  gitAuthorizationConfigured: boolean
}

export interface ProjectEnvironmentConfig {
  targetId: string
  environmentId: string
  enabled: boolean
  required: boolean
  installCommand: string
  buildCommand: string
  outputDirectory: string
}

export interface BuildJob {
  id: string
  environmentId: string
  environmentSlug: string
  targetId: string
  branch: string
  profile: string
  status: BuildJobStatus
  requestedBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  failureCode: string | null
  failureMessage: string | null
  logPath: string | null
  targetSnapshot: BuildTargetExecution | null
}

export interface BuildJobEvent {
  id: string
  jobId: string
  status: BuildJobStatus
  createdAt: string
}

export interface BuildCommandStep {
  stage: BuildJobStatus
  label: string
  command: string
}

export interface BuildArtifactSummary {
  id: string
  status: ArtifactStatus
  builtAt: string
  fileCount: number
  entrypoints: string[]
  publicBase: string
}

export interface BuildJobDetail {
  job: BuildJob
  commands: BuildCommandStep[]
  events: BuildJobEvent[]
  artifact: BuildArtifactSummary | null
}

export interface BuildJobLogView {
  content: string
  size: number
  complete: boolean
  truncated: boolean
  updatedAt: string | null
}

export interface BuildQueueItem {
  id: string
  environmentId: string
  environmentSlug: string
  targetId: string
  branch: string
  status: BuildJobStatus
  requestedBy: string
  createdAt: string
  startedAt: string | null
  queuePosition: number | null
  isMine: boolean
}

export interface BuildQueueSnapshot {
  running: BuildQueueItem[]
  queued: BuildQueueItem[]
  generatedAt: string
}

export type RuntimeSettingSource = 'default' | 'database'

export interface ProxySettingsView {
  enabled: boolean
  subscriptionConfigured: boolean
  subscriptionUrlMasked: string | null
  refreshIntervalMinutes: number
  sources: {
    enabled: RuntimeSettingSource
    subscriptionUrl: RuntimeSettingSource
    refreshIntervalMinutes: RuntimeSettingSource
  }
  status: {
    mihomoReachable: boolean
    lastAppliedAt: string | null
    lastCheckedAt: string | null
    lastError: string | null
  }
}

export interface SystemSettingsView {
  mobileUpstream: string
  publicMobileOrigin: string
  webappUpstream: string
  publicPreviewOrigin: string
  mobileHostnames: string[]
  cookieDomain: string
  buildMaxConcurrency: number
  runnerRequestTimeoutMinutes: number
  useChinaRegistry: boolean
  proxyRewriteMaxMegabytes: number
  autoSslEnabled: boolean
  autoSslEmail: string
  inPlaceUrlRules: InPlaceUrlRule[]
}

export interface PublicRuntimeSettings {
  mobileEnvironmentUrl: string
  previewOrigin: string
  previewBaseDomain: string
  webappOrigin: string
  inPlaceUrlRules: InPlaceUrlRule[]
}

export interface PreviewSelection {
  moduleKey: string
  targetId: string
  artifactId: string
  branch: string
  builtAt: string
  providerName: string
  version: string
  entryPath: string
}

export interface PreviewSession {
  token: string
  environmentId: string
  environmentSlug: string
  createdBy: string
  createdAt: string
  expiresAt: string
  siteBindingId?: string
  siteArtifactId?: string
  selections: PreviewSelection[]
}

export interface PreviewSiteSelection {
  targetId: string
  artifactId: string
  branch: string
  builtAt: string
}

export interface PreviewSessionView extends PreviewSession {
  siteSelection?: PreviewSiteSelection
}

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

export interface ConfigurationGroup {
  token: string
  /** DNS-safe opaque id used by the extension-free preview hostname. */
  previewSlug: string
  /** Complete first DNS label used by the extension-free preview hostname. */
  previewHostnamePrefix: string
  name: string
  environmentId: string
  environmentSlug: string
  siteBindingId: string
  schemaVersion: 1
  items: ConfigurationGroupItem[]
  revision: number
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
}

export interface ConfigurationGroupManagementView extends ConfigurationGroup {
  /** The canonical persistent id is the existing share token. */
  id: string
  sharePath: string
  directPreviewUrl: string
}

export interface SiteBinding {
  id: string
  name: string
  hostname: string
  targetId: string
  environmentSlug: string
  fallbackOrigin: string
  /** @deprecated Use fallbackOrigin. Kept while older clients and images are rolled out. */
  upstreamOrigin?: string
  officialOrigin: string
  enabled: boolean
  remoteTargetIds: string[]
  resourceProxyPrefixes: string[]
}

export interface SiteBindingCandidate extends SiteBinding {
  environmentName: string
  environmentStatus: EnvironmentStatus
}

export interface AutoSslConfigView {
  autoSslEnabled: boolean
  autoSslEmail: string
  hostnames: string[]
}

export interface ArtifactManifestFile {
  path: string
  size: number
  contentType: string
  digest: string
  cacheClass: 'html' | 'immutable' | 'asset'
}

export interface ArtifactManifest {
  schemaVersion: 1
  artifactId: string
  target: string
  branch: string
  builtAt: string
  serve: {
    siteAdapter: string
    entrypoints: string[]
    publicBase: string
    remote?: {
      moduleKey: string
      providerName: string
      entryPath: string
    }
  }
  files: ArtifactManifestFile[]
}

export interface Artifact {
  id: string
  buildJobId: string
  environmentId: string
  environmentSlug: string
  targetId: string
  branch: string
  status: ArtifactStatus
  storageKey: string
  manifest: ArtifactManifest
  builtAt: string
  createdBy: string
}

export interface BranchCatalogItem {
  branch: string
  buildStatus: 'IDLE' | 'BUILDING' | 'FAILED'
  latestArtifact: Pick<Artifact, 'id' | 'branch' | 'builtAt'> | null
  latestJob: Pick<BuildJob, 'id' | 'status' | 'createdAt' | 'finishedAt' | 'failureMessage'> | null
}

export interface EnvironmentSelection {
  targetId: string
  artifactId: string
  branch: string
  builtAt: string
}

export interface EnvironmentRevision {
  id: string
  environmentId: string
  revisionNo: number
  message: string
  createdBy: string
  createdAt: string
  selections: EnvironmentSelection[]
}

export interface EnvironmentRecord {
  id: string
  slug: string
  name: string
  /** Ascending display priority. Legacy records/clients default to zero. */
  sortOrder?: number
  status: EnvironmentStatus
  backendOrigin: string
  useInternalProxy: boolean
  resourceProxyPrefixes: string[]
  currentRevisionId: string | null
}

export interface MatrixRow {
  target: BuildTargetSummary
  config: ProjectEnvironmentConfig
  current: EnvironmentSelection | null
  latestArtifact: Pick<Artifact, 'id' | 'branch' | 'builtAt'> | null
  activeJob: Pick<BuildJob, 'id' | 'branch' | 'status' | 'createdAt'> | null
}

export interface EnvironmentMatrix {
  environment: EnvironmentRecord
  revision: EnvironmentRevision | null
  rows: MatrixRow[]
}

export const createBuildJobSchema = z.object({
  environmentSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
    .default('shared'),
  targetId: z.string().trim().min(1).max(80),
  branch: z.string().trim().min(1).max(240),
  profile: z.string().trim().min(1).max(80).default('qa-web'),
})

const repositoryUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) =>
      value === '' ||
      /^(https?|ssh|git|file):\/\//i.test(value) ||
      /^[^\s@]+@[^\s:]+:.+/.test(value),
    'Git repository must use HTTP(S), SSH, Git, file, or SCP syntax'
  )
  .refine((value) => {
    if (!/^https?:\/\//i.test(value)) return true
    try {
      const url = new URL(value)
      return (
        !url.username &&
        !url.password &&
        !/^https?:\/\/[^/?#]*@/i.test(value) &&
        !value.includes('?') &&
        !value.includes('#')
      )
    } catch {
      return false
    }
  }, 'HTTP(S) Git repository URLs must not contain credentials, query parameters, or fragments')

const relativeDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split(/[\\/]+/).includes('..'),
    'Output directory must stay inside the repository'
  )

export const saveBuildTargetSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(buildTargetKinds),
    repositoryUrl: repositoryUrlSchema,
    defaultBranch: z.string().trim().min(1).max(240),
    installCommand: z.string().trim().min(1).max(1000),
    buildCommand: z.string().trim().min(1).max(1000),
    outputDirectory: relativeDirectorySchema,
    siteAdapter: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    enabled: z.boolean(),
    required: z.boolean(),
    gitAuthorizationHeader: z.string().trim().max(4096).optional(),
    clearGitAuthorizationHeader: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.repositoryUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryUrl'],
        message: 'Enabled projects require a Git repository',
      })
    }
    if (value.required && !value.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required'],
        message: 'Required projects must be enabled',
      })
    }
    if (value.kind === 'remote' && value.siteAdapter !== 'kook-remote-v1') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['siteAdapter'],
        message: 'Remote projects must use the kook-remote-v1 adapter',
      })
    }
    if (
      value.kind !== 'remote' &&
      !siteBuildAdapters.includes(value.siteAdapter as SiteBuildAdapter)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['siteAdapter'],
        message: 'Site projects must use kook-online-h5-v1 or generic-static-v1',
      })
    }
    if (
      value.kind === 'remote' &&
      !kookRemoteModuleKeys.includes(value.id as (typeof kookRemoteModuleKeys)[number])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'Remote project id must match a KOOK Remote module key',
      })
    }
  })

export const updateProxySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    subscriptionUrl: z.string().trim().url().max(4096).optional(),
    refreshIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one setting is required')

export const resetProxySettingsSchema = z.object({
  keys: z.array(z.enum(['enabled', 'subscriptionUrl', 'refreshIntervalMinutes'])).min(1),
})

export const updateSystemSettingsSchema = z
  .object({
    mobileUpstream: z.string().trim().url().max(2048).optional(),
    publicMobileOrigin: z.string().trim().url().max(2048).optional(),
    webappUpstream: z.string().trim().url().max(2048).optional(),
    publicPreviewOrigin: z.string().trim().url().max(2048).optional(),
    mobileHostnames: z.array(z.string().trim().min(1).max(253)).min(1).max(20).optional(),
    cookieDomain: z.string().trim().max(253).optional(),
    buildMaxConcurrency: z.number().int().min(1).max(16).optional(),
    runnerRequestTimeoutMinutes: z.number().int().min(1).max(180).optional(),
    useChinaRegistry: z.boolean().optional(),
    proxyRewriteMaxMegabytes: z.number().int().min(1).max(32).optional(),
    autoSslEnabled: z.boolean().optional(),
    autoSslEmail: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
    inPlaceUrlRules: inPlaceUrlRulesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one setting is required')

const siteBindingIdSchema = z
  .string()
  .trim()
  .max(63)
  .regex(siteBindingIdPattern, 'Site id must be a DNS label')

const siteHostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .refine(
    (value) =>
      value === 'localhost' ||
      (value.includes('.') &&
        value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))),
    'Hostname must be a concrete DNS hostname'
  )

const httpOriginSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  }, 'Origin must be an HTTP(S) origin without a path, credentials, query, or fragment')
  .transform((value) => new URL(value).origin)

function parseIpv4Literal(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  const octets = parts.map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return null
  return octets as [number, number, number, number]
}

function isNonPublicIpv4([first, second, third]: [number, number, number, number]): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  )
}

function parseIpv6Literal(hostname: string): number[] | null {
  const value =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (!value.includes(':')) return null
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parseHalf = (half: string) => {
    if (!half) return []
    const segments = half.split(':')
    return segments.every((segment) => /^[\da-f]{1,4}$/i.test(segment))
      ? segments.map((segment) => Number.parseInt(segment, 16))
      : null
  }
  const left = parseHalf(halves[0] || '')
  const right = parseHalf(halves[1] || '')
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const missing = 8 - left.length - right.length
  return missing > 0 ? [...left, ...Array<number>(missing).fill(0), ...right] : null
}

function isNonPublicIpv6(segments: number[]): boolean {
  const first = segments[0]!
  const second = segments[1]!
  return (
    (first & 0xe000) !== 0x2000 ||
    (first === 0x2001 && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    first === 0x3ffe ||
    (first === 0x3fff && (second & 0xf000) === 0)
  )
}

function isNonPublicResourceProxyHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  const ipv4 = parseIpv4Literal(hostname)
  if (ipv4) return isNonPublicIpv4(ipv4)
  const ipv6 = parseIpv6Literal(hostname)
  return ipv6 ? isNonPublicIpv6(ipv6) : false
}

const resourceProxyPrefixSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .superRefine((value, context) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource proxy prefix must use HTTP or HTTPS',
      })
    }
    if (url.username || url.password || /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource proxy prefix must not contain credentials',
      })
    }
    if (url.search || url.hash || value.includes('?') || value.includes('#')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource proxy prefix must not contain a query or fragment',
      })
    }
    if (!url.pathname.endsWith('/')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource proxy prefix path must end with /',
      })
    }
    if (isNonPublicResourceProxyHost(url)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resource proxy prefix must not target localhost or a non-public IP address',
      })
    }
  })
  .transform((value) => new URL(value).href)

const resourceProxyPrefixesSchema = z
  .array(resourceProxyPrefixSchema)
  .max(20)
  .refine(
    (items) => new Set(items).size === items.length,
    'Resource proxy URL prefixes must be unique'
  )

export const saveEnvironmentSchema = z.object({
  slug: environmentSlugSchema,
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(-1000000).max(1000000).optional(),
  backendOrigin: httpOriginSchema,
  useInternalProxy: z.boolean().default(false),
  resourceProxyPrefixes: resourceProxyPrefixesSchema.default([]),
  status: z.enum(environmentStatuses).default('ACTIVE'),
})

export const projectEnvironmentConfigSchema = z
  .object({
    targetId: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    required: z.boolean(),
    installCommand: z.string().trim().min(1).max(1000),
    buildCommand: z.string().trim().min(1).max(1000),
    outputDirectory: relativeDirectorySchema,
  })
  .superRefine((value, context) => {
    if (value.required && !value.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required'],
        message: 'Required projects must be enabled in the environment',
      })
    }
  })

export const saveProjectEnvironmentConfigsSchema = z.object({
  items: z
    .array(projectEnvironmentConfigSchema)
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.targetId)).size === items.length,
      'Project ids must be unique'
    ),
})

export const saveSiteBindingSchema = z
  .object({
    id: siteBindingIdSchema,
    name: z.string().trim().min(1).max(80),
    hostname: siteHostnameSchema,
    targetId: z.string().trim().min(1).max(80),
    environmentSlug: environmentSlugSchema,
    fallbackOrigin: httpOriginSchema.optional(),
    upstreamOrigin: httpOriginSchema.optional(),
    officialOrigin: httpOriginSchema,
    enabled: z.boolean(),
    remoteTargetIds: z
      .array(z.string().trim().min(1).max(80))
      .max(40)
      .default([])
      .refine((items) => new Set(items).size === items.length, 'Remote project ids must be unique'),
    resourceProxyPrefixes: resourceProxyPrefixesSchema,
  })
  .superRefine((value, context) => {
    if (!value.fallbackOrigin && !value.upstreamOrigin) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallbackOrigin'],
        message: 'Fallback origin is required',
      })
    }
  })
  .transform((value) => {
    const fallbackOrigin = value.fallbackOrigin ?? value.upstreamOrigin!
    return {
      ...value,
      fallbackOrigin,
      upstreamOrigin: fallbackOrigin,
    }
  })

export const publishRevisionSchema = z.object({
  baseRevisionId: z.string().uuid().nullable(),
  message: z.string().trim().max(240).default('QA 更新环境'),
  selections: z.array(
    z.object({
      targetId: z.string().trim().min(1).max(80),
      artifactId: z.string().uuid(),
    })
  ),
})

export const createPreviewSchema = z.object({
  ttlMinutes: z.number().int().min(5).max(1440).default(480),
  siteBindingId: siteBindingIdSchema,
  // A binding identifies the site shape and hostname. The preview independently selects the
  // environment so one preview hostname can serve isolated online and test tabs.
  environmentSlug: environmentSlugSchema.optional(),
  siteArtifactId: z.string().uuid().optional(),
  selections: z
    .array(
      z.object({
        targetId: z.string().trim().min(1).max(80),
        artifactId: z.string().uuid(),
      })
    )
    .max(40)
    .default([]),
})

const configurationGroupItemSchema = z.discriminatedUnion('mode', [
  z
    .object({
      targetId: z.string().trim().min(1).max(80),
      mode: z.literal('official'),
    })
    .strict(),
  z
    .object({
      targetId: z.string().trim().min(1).max(80),
      mode: z.literal('branch'),
      branch: z.string().trim().min(1).max(240),
    })
    .strict(),
])

export const configurationGroupUrlPrefixPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const configurationGroupChineseUrlPrefixPattern =
  /^[\p{Script=Han}0-9](?:[\p{Script=Han}0-9-]{0,61}[\p{Script=Han}0-9])?$/u

export function normalizeConfigurationGroupUrlPrefixInput(value: string): string {
  return value.trim().normalize('NFC').toLowerCase()
}

export function isConfigurationGroupUrlPrefixInput(value: string): boolean {
  const prefix = normalizeConfigurationGroupUrlPrefixInput(value)
  return (
    configurationGroupUrlPrefixPattern.test(prefix) ||
    configurationGroupChineseUrlPrefixPattern.test(prefix)
  )
}

export const configurationGroupReservedUrlPrefixes = [
  'acme',
  'admin',
  'api',
  'assets',
  'biz',
  'certbot',
  'control',
  'gateway',
  'kfc',
  'm',
  'main',
  'mihomo',
  'oss',
  'static',
  'www',
] as const

export function configurationGroupHostnamePrefixFromHostname(
  rawHostname: string,
  rawBaseDomain: string
): string | null {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, '')
  const baseDomain = rawBaseDomain.toLowerCase().replace(/\.$/, '')
  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return null
  const prefix = hostname.slice(0, -suffix.length)
  return configurationGroupUrlPrefixPattern.test(prefix) ? prefix : null
}

const configurationGroupSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(80),
  environmentSlug: environmentSlugSchema,
  siteBindingId: siteBindingIdSchema,
  schemaVersion: z.literal(1).default(1),
  items: z
    .array(configurationGroupItemSchema)
    .min(1)
    .max(40)
    .refine(
      (items) => new Set(items.map((item) => item.targetId)).size === items.length,
      'Configuration group project ids must be unique'
    ),
})

export const createConfigurationGroupSchema = configurationGroupSnapshotSchema.extend({
  urlPrefix: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .transform(normalizeConfigurationGroupUrlPrefixInput)
    .refine(isConfigurationGroupUrlPrefixInput, 'Invalid configuration group URL prefix')
    .optional(),
})

export const updateConfigurationGroupSchema = configurationGroupSnapshotSchema.extend({
  schemaVersion: z.literal(1),
  expectedRevision: z.number().int().min(1),
})

export const createConfigurationGroupPreviewSchema = z.object({
  expectedRevision: z.number().int().min(1).optional(),
  applicationMode: z.enum(['complete', 'remote-only']).optional(),
})

export const runnerJobSchema = z
  .object({
    jobId: z.string().uuid(),
    artifactId: z.string().uuid(),
    environmentId: z.string().uuid(),
    environmentSlug: environmentSlugSchema,
    targetId: z.string().trim().min(1).max(80),
    branch: z.string().trim().min(1).max(240),
    requestedBy: z.string().trim().min(1).max(120),
    artifactBaseUrl: z.string().trim().min(1).max(2048),
    project: z.object({
      id: z.string().trim().min(1).max(80),
      environment: z.object({
        id: z.string().uuid(),
        slug: environmentSlugSchema,
        name: z.string().trim().min(1).max(80),
        backendOrigin: httpOriginSchema,
      }),
      kind: z.enum(buildTargetKinds).optional(),
      repositoryUrl: z.string().trim().min(1).max(2048),
      installCommand: z.string().trim().min(1).max(1000),
      buildCommand: z.string().trim().min(1).max(1000),
      outputDirectory: relativeDirectorySchema,
      siteAdapter: z.string().trim().min(1).max(80),
      useChinaRegistry: z.boolean().optional(),
      gitAuthorization: z
        .object({
          version: z.literal(1),
          iv: z.string().min(1),
          tag: z.string().min(1),
          ciphertext: z.string().min(1),
        })
        .optional(),
    }),
  })
  .superRefine((value, context) => {
    if (value.environmentId !== value.project.environment.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', 'environment', 'id'],
        message: 'Runner project environment id must match the job environment id',
      })
    }
    if (value.environmentSlug !== value.project.environment.slug) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', 'environment', 'slug'],
        message: 'Runner project environment slug must match the job environment slug',
      })
    }
  })

export const runnerArtifactDeleteSchema = z.object({
  artifactId: z.string().uuid(),
  storageKey: z.string().trim().min(1).max(2048),
})

export const runnerArtifactInventoryStates = ['READY', 'DELETING'] as const
export type RunnerArtifactInventoryState = (typeof runnerArtifactInventoryStates)[number]

export const runnerArtifactInventoryItemSchema = z.object({
  artifactId: z.string().uuid(),
  targetId: z.string().trim().min(1).max(80),
  storageKey: z.string().trim().min(1).max(2048),
  state: z.enum(runnerArtifactInventoryStates),
  modifiedAt: z.string().datetime(),
})

export type RunnerArtifactInventoryItem = z.infer<typeof runnerArtifactInventoryItemSchema>

export const runnerArtifactInventorySchema = z.object({
  artifacts: z.array(runnerArtifactInventoryItemSchema),
})

export const artifactManifestFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  digest: z.string().min(1),
  cacheClass: z.enum(['html', 'immutable', 'asset']),
})

export const artifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().uuid(),
  target: z.string().min(1),
  branch: z.string().min(1),
  builtAt: z.string().datetime(),
  serve: z.object({
    siteAdapter: z.string().min(1),
    entrypoints: z.array(z.string().min(1)).min(1),
    publicBase: z.string().min(1),
    remote: z
      .object({
        moduleKey: z.string().min(1),
        providerName: z.string().min(1),
        entryPath: z.string().min(1),
      })
      .optional(),
  }),
  files: z.array(artifactManifestFileSchema).min(1),
})

export const runnerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    stage: z.enum(runnerStages),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    message: z.string(),
  }),
  z.object({
    type: z.literal('result'),
    artifactId: z.string().uuid(),
    storageKey: z.string().min(1),
    manifest: artifactManifestSchema,
    builtAt: z.string().datetime(),
    logPath: z.string().min(1),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
    logPath: z.string().min(1),
  }),
])

export type CreateBuildJobInput = z.infer<typeof createBuildJobSchema>
export type SaveBuildTargetInput = z.infer<typeof saveBuildTargetSchema>
export type SaveEnvironmentInput = z.infer<typeof saveEnvironmentSchema>
export type SaveProjectEnvironmentConfigsInput = z.infer<typeof saveProjectEnvironmentConfigsSchema>
export type UpdateProxySettingsInput = z.infer<typeof updateProxySettingsSchema>
export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>
export type SaveSiteBindingInput = z.infer<typeof saveSiteBindingSchema>
export type PublishRevisionInput = z.infer<typeof publishRevisionSchema>
export type CreatePreviewInput = z.infer<typeof createPreviewSchema>
export type CreateConfigurationGroupInput = z.infer<typeof createConfigurationGroupSchema>
export type UpdateConfigurationGroupInput = z.infer<typeof updateConfigurationGroupSchema>
export type CreateConfigurationGroupPreviewInput = z.infer<
  typeof createConfigurationGroupPreviewSchema
>
export type RunnerJobInput = z.infer<typeof runnerJobSchema>
export type RunnerEvent = z.infer<typeof runnerEventSchema>
export * from './permissions'
