import { Alert, Button, CheckBox, ComboBox, NumberBox, Switch, TextArea, TextBox } from './ui'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from 'react'
import {
  siteBindingIdPattern,
  hasPermission,
  PERMISSION_MANAGEMENT,
  defaultAuthorizationPolicy,
  type PermissionContext,
  siteBuildAdapters,
  type SiteBuildAdapter,
  type BranchCatalogItem,
  type BuildJob,
  type BuildJobDetail,
  type BuildJobLogView,
  type BuildJobStatus,
  type BuildQueueItem,
  type BuildQueueSnapshot,
  type BuildTargetSettingsView,
  type EnvironmentRecord,
  type EnvironmentMatrix,
  type MatrixRow,
  type ProxySettingsView,
  type SiteBinding,
  type SystemSettingsView,
} from '@cuddly/contracts'
import { PRODUCT_NAME } from '@cuddly/product'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Hammer,
  History,
  Layers3,
  ListOrdered,
  LoaderCircle,
  LogOut,
  Network,
  LockKeyhole,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Settings,
  ServerCog,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'

import {
  ApiError,
  cancelBuildJob,
  deleteConfigurationGroup,
  createBuild,
  deleteSiteBinding,
  getEnvironmentProjectSettings,
  getEnvironments,
  getBranches,
  getBuildHistory,
  getBuildJobDetail,
  getBuildJobLog,
  getBuildQueue,
  getConfigurationGroups,
  getMatrix,
  getProjectSettings,
  getPublicRuntimeSettings,
  getProxySettings,
  getSiteBindings,
  getSystemSettings,
  refreshProxySettings,
  resetProjectSettings,
  resetProxySettings,
  saveProjectSettings,
  saveEnvironment,
  saveEnvironmentProjectSettings,
  saveSiteBinding,
  updateProxySettings,
  updateSystemSettings,
  type AuthIdentity,
  type ConfigurationGroupItem,
  type ConfigurationGroupRecord,
  type EnvironmentSettingsView,
  type ProjectEnvironmentSettingsView,
} from './api'
import { BranchPicker } from './BranchPicker'
import { buildStatusText } from './branch-picker'
import {
  ConfigurationGroupEditor,
  type ConfigurationGroupEditorDefaults,
} from './ConfigurationGroupEditor'

type StatusTone = 'idle' | 'busy' | 'success' | 'warning'
type ManagementTab = 'environments' | 'projects' | 'runtime' | 'proxy'
type MainView = 'environment' | 'history'
type JobDetailTab = 'overview' | 'console'
export type ProjectVersionMode = 'requirements' | 'branches'

type InPlaceUrlRuleDraft = SystemSettingsView['inPlaceUrlRules'][number] & { clientId: string }
let nextInPlaceUrlRuleDraftId = 0

function inPlaceUrlRuleDraft(
  rule: SystemSettingsView['inPlaceUrlRules'][number]
): InPlaceUrlRuleDraft {
  nextInPlaceUrlRuleDraftId += 1
  return { ...rule, clientId: `in-place-url-rule-${nextInPlaceUrlRuleDraftId}` }
}

const projectVersionModes: ProjectVersionMode[] = ['requirements', 'branches']

interface StatusState {
  tone: StatusTone
  text: string
}

type EnvironmentStatus = EnvironmentRecord['status']
type CompatibleSiteBinding = SiteBinding & { fallbackOrigin?: string }

interface EnvironmentDraft {
  id: string | null
  slug: string
  name: string
  sortOrder: number
  backendOrigin: string
  useInternalProxy: boolean
  resourceProxyPrefixes: string[]
  status: EnvironmentStatus
}

const ENVIRONMENT_STORAGE_KEY = 'cuddly.environmentSlug'
export const PROJECT_VERSION_MODE_STORAGE_KEY = 'cuddly.projectVersionMode'

export function projectVersionModeFromStorage(
  storage: Pick<Storage, 'getItem'> | null | undefined
): ProjectVersionMode {
  try {
    return storage?.getItem(PROJECT_VERSION_MODE_STORAGE_KEY) === 'requirements'
      ? 'requirements'
      : 'branches'
  } catch {
    return 'branches'
  }
}

export function configurationGroupBranchSelection(
  items: ConfigurationGroupItem[]
): Record<string, string> {
  return Object.fromEntries(
    items.map((item) => [
      item.targetId,
      item.mode === 'branch' && item.branch.trim() ? item.branch.trim() : '',
    ])
  )
}

export function projectVersionModeFromKeyboard(
  current: ProjectVersionMode,
  key: string
): ProjectVersionMode | null {
  const index = projectVersionModes.indexOf(current)
  if (key === 'Home') return projectVersionModes[0]!
  if (key === 'End') return projectVersionModes.at(-1)!
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return projectVersionModes[(index + 1) % projectVersionModes.length]!
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return projectVersionModes[
      (index - 1 + projectVersionModes.length) % projectVersionModes.length
    ]!
  }
  return null
}

export function configurationGroupSharePath(
  group: Pick<ConfigurationGroupRecord, 'token' | 'sharePath'>
): string {
  const expected = /^[A-Za-z0-9_-]{32}$/.test(group.token) ? `/s/${group.token}` : ''
  return group.sharePath === expected ? group.sharePath : expected
}

export function configurationGroupDirectPreviewUrl(
  group: Pick<ConfigurationGroupRecord, 'previewHostnamePrefix' | 'directPreviewUrl'>,
  previewBaseDomain = 'bifrost.vanillacake.cn'
): string {
  const prefix = group.previewHostnamePrefix || ''
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) return ''
  try {
    const url = new URL(group.directPreviewUrl || '')
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname === `${prefix}.${previewBaseDomain.toLowerCase().replace(/\.$/, '')}` &&
      url.pathname === '/'
      ? url.href
      : ''
  } catch {
    return ''
  }
}

export function previewableSiteBindings(bindings: SiteBinding[]): SiteBinding[] {
  return bindings
    .filter((binding) => binding.enabled)
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function configurationGroupDirectoryReady(
  environments: Array<Pick<EnvironmentRecord, 'status'>>,
  bindings: Array<Pick<SiteBinding, 'enabled'>>
): boolean {
  return (
    environments.some((environment) => environment.status !== 'ARCHIVED') &&
    bindings.some((binding) => binding.enabled)
  )
}

export function selectedBranchAfterCatalogRefresh(
  selectedBranch: string | undefined,
  catalog: BranchCatalogItem[],
  defaultBranch: string
): string {
  if (selectedBranch === '') return ''
  if (selectedBranch && catalog.some((item) => item.branch === selectedBranch)) {
    return selectedBranch
  }
  return catalog[0]?.branch || defaultBranch
}

function environmentStatusLabel(status: EnvironmentStatus): string {
  if (status === 'ACTIVE') return '可用'
  if (status === 'FROZEN') return '冻结'
  return '归档'
}

function fallbackOrigin(binding: CompatibleSiteBinding): string {
  return binding.fallbackOrigin || binding.upstreamOrigin || ''
}

function environmentSiteUrl(binding: SiteBinding): string {
  return `https://${binding.hostname}`
}

interface BranchState {
  items: BranchCatalogItem[]
  remoteAvailable: boolean
}

const emptyQueue: BuildQueueSnapshot = { running: [], queued: [], generatedAt: '' }

const buildStatusOptions: BuildJobStatus[] = [
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
]

const terminalBuildStatuses = new Set<BuildJobStatus>(['SUCCEEDED', 'FAILED', 'CANCELED'])

const dialogFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function dialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(dialogFocusableSelector)].filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' &&
      (element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement)
  )
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '暂无产物'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function queueTargetSignatures(
  snapshot: BuildQueueSnapshot,
  environmentSlug: string
): Map<string, string> {
  const signatures = new Map<string, string[]>()
  for (const item of [...snapshot.running, ...snapshot.queued]) {
    if (item.environmentSlug !== environmentSlug) continue
    const values = signatures.get(item.targetId) || []
    values.push(item.id)
    signatures.set(item.targetId, values)
  }
  return new Map([...signatures].map(([targetId, values]) => [targetId, values.sort().join('|')]))
}

function completedQueueTargets(
  previous: Map<string, string>,
  current: Map<string, string>
): Set<string> {
  return new Set(
    [...previous].flatMap(([targetId, signature]) => {
      const currentIds = new Set((current.get(targetId) || '').split('|').filter(Boolean))
      const completed = signature
        .split('|')
        .filter(Boolean)
        .some((id) => !currentIds.has(id))
      return completed ? [targetId] : []
    })
  )
}

function formatQueueTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatFullTime(value: string | null | undefined): string {
  if (!value) return '尚未开始'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDuration(job: Pick<BuildJob, 'createdAt' | 'startedAt' | 'finishedAt'>): string {
  const start = new Date(job.startedAt || job.createdAt).getTime()
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes} 分 ${remainingSeconds} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function jobEnvironmentSlug(job: unknown): string | null {
  if (!job || typeof job !== 'object') return null
  const record = job as {
    environmentSlug?: unknown
    targetSnapshot?: { environment?: { slug?: unknown } }
  }
  const value = record.environmentSlug || record.targetSnapshot?.environment?.slug
  return typeof value === 'string' && value ? value : null
}

function jobEnvironmentName(job: unknown): string | null {
  if (!job || typeof job !== 'object') return null
  const value = (job as { targetSnapshot?: { environment?: { name?: unknown } } }).targetSnapshot
    ?.environment?.name
  return typeof value === 'string' && value ? value : null
}

function jobBackendOrigin(job: unknown): string | null {
  if (!job || typeof job !== 'object') return null
  const value = (job as { targetSnapshot?: { environment?: { backendOrigin?: unknown } } })
    .targetSnapshot?.environment?.backendOrigin
  return typeof value === 'string' && value ? value : null
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    if (error.body && typeof error.body === 'object' && 'message' in error.body) {
      const message = error.body.message
      if (typeof message === 'string') return message
    }
    return '数据已被其他人更新，请刷新后重试'
  }
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const message = 'message' in error.body ? error.body.message : null
    if (typeof message === 'string') return message
    const issues = 'issues' in error.body ? error.body.issues : null
    if (Array.isArray(issues) && issues[0] && typeof issues[0] === 'object') {
      const issueMessage = 'message' in issues[0] ? issues[0].message : null
      if (typeof issueMessage === 'string') return issueMessage
    }
  }
  if (error instanceof Error) return error.message
  return '操作没有完成，服务未返回可识别的原因'
}

function QueueRow({
  item,
  targetName,
  environmentName,
  onOpen,
}: {
  item: BuildQueueItem
  targetName: string
  environmentName: string
  onOpen: () => void
}) {
  const queued = item.status === 'QUEUED'
  return (
    <Button type="button" className={`queue-row ${item.isMine ? 'mine' : ''}`} onClick={onOpen}>
      <span
        className="queue-position"
        aria-label={queued ? `排队第 ${item.queuePosition} 位` : '正在构建'}
      >
        {queued ? item.queuePosition : <LoaderCircle className="spin" size={15} />}
      </span>
      <div className="queue-copy">
        <div className="queue-branch-line">
          <strong title={item.branch}>{item.branch}</strong>
          {item.isMine ? <span className="mine-badge">我的</span> : null}
        </div>
        <span>
          {environmentName} · {targetName} · {item.requestedBy} · {formatQueueTime(item.createdAt)}
        </span>
      </div>
      <span className={`queue-state ${queued ? 'waiting' : 'working'}`}>
        {queued ? `第 ${item.queuePosition} 位` : buildStatusText[item.status] || item.status}
      </span>
    </Button>
  )
}

export function BuildHistoryView({
  navigation,
  jobs,
  loading,
  error,
  targetId,
  status,
  query,
  targets,
  environmentNames,
  onTargetChange,
  onStatusChange,
  onQueryChange,
  onRefresh,
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  onOpen,
}: {
  navigation?: ReactNode
  jobs: BuildJob[]
  loading: boolean
  error: string
  targetId: string
  status: BuildJobStatus | ''
  query: string
  targets: Array<{ id: string; name: string }>
  environmentNames: ReadonlyMap<string, string>
  onTargetChange: (value: string) => void
  onStatusChange: (value: BuildJobStatus | '') => void
  onQueryChange: (value: string) => void
  onRefresh: () => void
  page: number
  pageSize: number
  total: number
  totalPages: number
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
  onOpen: (jobId: string) => void
}) {
  const visibleTotalPages = Math.max(1, totalPages)
  return (
    <section className="history-view" aria-label="构建记录">
      <div className="history-filters">
        {navigation}
        <label>
          <span>项目</span>
          <ComboBox value={targetId} onChange={(event) => onTargetChange(event.target.value)}>
            <option value="">全部项目</option>
            {targets.map((target) => (
              <option value={target.id} key={target.id}>
                {target.name}
              </option>
            ))}
          </ComboBox>
        </label>
        <label>
          <span>结果</span>
          <ComboBox
            value={status}
            onChange={(event) => onStatusChange(event.target.value as BuildJobStatus | '')}
          >
            <option value="">全部状态</option>
            {buildStatusOptions.map((option) => (
              <option value={option} key={option}>
                {buildStatusText[option]}
              </option>
            ))}
          </ComboBox>
        </label>
        <label className="history-query">
          <span>查找</span>
          <TextBox
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="分支、发起人或任务 ID"
          />
        </label>
        <Button
          type="button"
          className="icon-button history-refresh"
          onClick={onRefresh}
          title="刷新构建记录"
        >
          {loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
        </Button>
      </div>

      {error ? <InlineError message={error} /> : null}
      <div className="history-table" role="table" aria-label="历史任务">
        <div className="history-table-head" role="row">
          <span>状态</span>
          <span>项目与分支</span>
          <span>发起人</span>
          <span>开始时间</span>
          <span>耗时</span>
        </div>
        {jobs.map((job) => (
          <Button
            type="button"
            className="history-row"
            role="row"
            key={job.id}
            onClick={() => onOpen(job.id)}
          >
            <span className={`job-status job-status-${job.status.toLowerCase()}`} role="cell">
              {buildStatusText[job.status] || job.status}
            </span>
            <span className="history-job" role="cell">
              <strong>
                {targets.find((target) => target.id === job.targetId)?.name || job.targetId}
              </strong>
              <small title={job.branch}>
                {jobEnvironmentName(job) ||
                  environmentNames.get(jobEnvironmentSlug(job) || '') ||
                  jobEnvironmentSlug(job) ||
                  '环境未记录'}{' '}
                · {job.branch}
              </small>
            </span>
            <span role="cell">{job.requestedBy}</span>
            <span role="cell">{formatTime(job.startedAt || job.createdAt)}</span>
            <span role="cell">{formatDuration(job)}</span>
          </Button>
        ))}
        {!loading && jobs.length === 0 ? (
          <div className="history-empty">
            <History size={18} />
            没有符合条件的构建记录
          </div>
        ) : null}
      </div>
      <div className="history-pagination" aria-label="构建记录分页">
        <span className="history-pagination-total">共 {total} 条</span>
        <div className="history-pagination-controls">
          <label className="history-page-size">
            <span>每页</span>
            <ComboBox
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              disabled={loading}
              aria-label="每页记录数"
            >
              {[20, 50, 100].map((option) => (
                <option value={option} key={option}>
                  {option} 条
                </option>
              ))}
            </ComboBox>
          </label>
          <Button
            type="button"
            className="icon-button history-page-button"
            onClick={() => onPageChange(page - 1)}
            disabled={loading || page <= 1}
            title="上一页"
            aria-label="上一页"
          >
            <ChevronLeft size={15} />
          </Button>
          <ComboBox
            className="history-page-select"
            value={Math.min(page, visibleTotalPages)}
            onChange={(event) => onPageChange(Number(event.target.value))}
            disabled={loading || totalPages <= 1}
            aria-label="当前页码"
          >
            {Array.from({ length: visibleTotalPages }, (_, index) => index + 1).map((option) => (
              <option value={option} key={option}>
                第 {option} / {visibleTotalPages} 页
              </option>
            ))}
          </ComboBox>
          <Button
            type="button"
            className="icon-button history-page-button"
            onClick={() => onPageChange(page + 1)}
            disabled={loading || totalPages === 0 || page >= totalPages}
            title="下一页"
            aria-label="下一页"
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
    </section>
  )
}

function JobDetailPanel({
  detail,
  log,
  loading,
  error,
  tab,
  copied,
  logRef,
  targetName,
  canceling,
  retrying,
  canCancel,
  canRetry,
  onTabChange,
  onCancel,
  onRetry,
  onCopy,
  onClose,
}: {
  detail: BuildJobDetail | null
  log: BuildJobLogView | null
  loading: boolean
  error: string
  tab: JobDetailTab
  copied: boolean
  logRef: RefObject<HTMLPreElement | null>
  targetName: string
  canceling: boolean
  retrying: boolean
  canCancel: boolean
  canRetry: boolean
  onTabChange: (tab: JobDetailTab) => void
  onCancel: () => void
  onRetry: () => void
  onCopy: () => void
  onClose: () => void
}) {
  const job = detail?.job
  return (
    <div className="job-detail-scrim" role="presentation" onMouseDown={onClose}>
      <aside
        className="job-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="job-detail-header">
          <div>
            <span className="eyebrow">构建任务 POWERED BY 打包嘟嘟</span>
            <h2 id="job-detail-title">{job?.branch || '正在读取'}</h2>
            {job ? (
              <p>
                {targetName} · {jobEnvironmentName(job) || jobEnvironmentSlug(job) || '环境未记录'}{' '}
                · {job.requestedBy} · {job.id.slice(0, 8)}
              </p>
            ) : null}
          </div>
          <div className="job-detail-actions">
            {job?.status === 'FAILED' && canRetry ? (
              <Button
                type="button"
                className="retry-build-button"
                onClick={onRetry}
                disabled={retrying}
              >
                <RefreshCw className={retrying ? 'spin' : undefined} size={15} />
                {retrying ? '正在重试' : '重试构建'}
              </Button>
            ) : null}
            {job && canCancel && !terminalBuildStatuses.has(job.status) ? (
              <Button
                type="button"
                className="cancel-build-button"
                onClick={onCancel}
                disabled={canceling || job.status === 'CANCELING'}
              >
                {canceling || job.status === 'CANCELING' ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <X size={15} />
                )}
                {canceling || job.status === 'CANCELING' ? '正在中断' : '中断构建'}
              </Button>
            ) : null}
            <Button type="submit" className="icon-button" onClick={onClose} title="关闭任务详情">
              <X size={18} />
            </Button>
          </div>
        </header>

        <nav className="job-detail-tabs" aria-label="任务详情分类">
          <Button
            type="submit"
            className={tab === 'overview' ? 'active' : ''}
            onClick={() => onTabChange('overview')}
          >
            <ListOrdered size={15} />
            概览
          </Button>
          <Button
            type="submit"
            className={tab === 'console' ? 'active' : ''}
            onClick={() => onTabChange('console')}
          >
            <SquareTerminal size={15} />
            控制台
          </Button>
        </nav>

        <div className="job-detail-content">
          {loading && !detail ? (
            <div className="detail-loading">
              <LoaderCircle className="spin" size={18} />
              正在读取任务
            </div>
          ) : error ? (
            <InlineError message={error} />
          ) : detail && tab === 'overview' ? (
            <>
              <section className="job-summary">
                <div className="job-summary-primary">
                  <span className={`job-status job-status-${detail.job.status.toLowerCase()}`}>
                    {buildStatusText[detail.job.status] || detail.job.status}
                  </span>
                  <strong>{formatDuration(detail.job)}</strong>
                </div>
                <dl>
                  <div>
                    <dt>环境</dt>
                    <dd>
                      {jobEnvironmentName(detail.job) ||
                        jobEnvironmentSlug(detail.job) ||
                        '历史任务未记录环境详情'}
                    </dd>
                  </div>
                  <div>
                    <dt>业务后端</dt>
                    <dd title={jobBackendOrigin(detail.job) || undefined}>
                      {jobBackendOrigin(detail.job) || '历史任务未记录环境详情'}
                    </dd>
                  </div>
                  <div>
                    <dt>提交</dt>
                    <dd>{formatFullTime(detail.job.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>开始</dt>
                    <dd>{formatFullTime(detail.job.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>结束</dt>
                    <dd>
                      {detail.job.finishedAt ? formatFullTime(detail.job.finishedAt) : '仍在执行'}
                    </dd>
                  </div>
                </dl>
                {detail.job.failureMessage ? (
                  <div className="job-failure">
                    <CircleAlert size={16} />
                    <div>
                      <strong>{detail.job.failureCode || 'BUILD_FAILED'}</strong>
                      <span>{detail.job.failureMessage}</span>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="detail-section">
                <h3>执行时间线</h3>
                <ol className="job-timeline">
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      <span className={`timeline-dot timeline-${event.status.toLowerCase()}`} />
                      <div>
                        <strong>{buildStatusText[event.status] || event.status}</strong>
                        <time>{formatFullTime(event.createdAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="detail-section">
                <h3>执行命令</h3>
                <div className="command-list">
                  {detail.commands.map((step) => (
                    <div className="command-step" key={step.stage}>
                      <span>{step.label}</span>
                      <code>{step.command}</code>
                    </div>
                  ))}
                </div>
              </section>

              <section className="detail-section artifact-result">
                <h3>构建结果</h3>
                {detail.artifact ? (
                  <dl>
                    <div>
                      <dt>Artifact</dt>
                      <dd title={detail.artifact.id}>{detail.artifact.id.slice(0, 12)}</dd>
                    </div>
                    <div>
                      <dt>文件</dt>
                      <dd>{detail.artifact.fileCount} 个</dd>
                    </div>
                    <div>
                      <dt>生成时间</dt>
                      <dd>{formatFullTime(detail.artifact.builtAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p>
                    {terminalBuildStatuses.has(detail.job.status)
                      ? '任务没有生成可用产物'
                      : '构建完成后显示产物信息'}
                  </p>
                )}
              </section>
            </>
          ) : detail ? (
            <section className="job-console-section">
              <div className="job-console-toolbar">
                <span>
                  {log?.complete ? '日志已结束' : '实时日志'}
                  {log?.truncated ? ' · 已截断' : ''}
                </span>
                <div>
                  <Button type="submit" className="icon-button" onClick={onCopy} title="复制日志">
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </Button>
                  <a
                    className="icon-button"
                    href={`/api/v1/build-jobs/${detail.job.id}/log?download=1`}
                    title="下载脱敏日志"
                  >
                    <Download size={16} />
                  </a>
                </div>
              </div>
              <pre className="job-console" ref={logRef} tabIndex={0}>
                {log?.content || (log?.complete ? '没有日志输出' : '等待 Runner 输出...')}
              </pre>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function InlineError({ message }: { message: string }) {
  return (
    <Alert className="inline-error" tone="danger">
      <CircleAlert size={16} />
      <span>{message}</span>
    </Alert>
  )
}

function ProxySettingsForm({
  settings,
  onChange,
}: {
  settings: ProxySettingsView
  onChange: (view: ProxySettingsView) => void
}) {
  const [enabled, setEnabled] = useState(settings.enabled)
  const [subscriptionUrl, setSubscriptionUrl] = useState('')
  const [refreshMinutes, setRefreshMinutes] = useState(settings.refreshIntervalMinutes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setEnabled(settings.enabled)
    setRefreshMinutes(settings.refreshIntervalMinutes)
    setSubscriptionUrl('')
  }, [settings])

  async function run(action: () => Promise<ProxySettingsView>, success: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      onChange(await action())
      setNotice(success)
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="management-form"
      onSubmit={(event) => {
        event.preventDefault()
        void run(
          () =>
            updateProxySettings({
              enabled,
              refreshIntervalMinutes: refreshMinutes,
              ...(subscriptionUrl.trim() ? { subscriptionUrl: subscriptionUrl.trim() } : {}),
            }),
          '代理配置已保存并应用'
        )
      }}
    >
      <div className="health-line">
        <span className={`health-dot ${settings.status.mihomoReachable ? 'ok' : 'bad'}`} />
        <div>
          <strong>
            {settings.status.mihomoReachable ? 'Mihomo 运行正常' : 'Mihomo 当前不可达'}
          </strong>
          <span>{settings.status.lastError || '最近一次配置检查未发现错误'}</span>
        </div>
      </div>

      <Switch
        className="toggle-row"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      >
        <div>
          <strong>内网代理</strong>
          <span>分支查询与代码拉取按订阅规则访问网络</span>
        </div>
      </Switch>

      <label className="field">
        <span>订阅链接</span>
        <TextBox
          type="password"
          value={subscriptionUrl}
          onChange={(event) => setSubscriptionUrl(event.target.value)}
          placeholder={settings.subscriptionUrlMasked || '尚未配置'}
          autoComplete="off"
        />
        <small>
          {settings.sources.subscriptionUrl === 'database' ? '后台配置' : '系统默认'} ·{' '}
          {settings.subscriptionUrlMasked || '未设置'}
        </small>
      </label>

      <label className="field compact-field">
        <span>自动刷新</span>
        <ComboBox
          value={refreshMinutes}
          onChange={(event) => setRefreshMinutes(Number(event.target.value))}
        >
          <option value={15}>15 分钟</option>
          <option value={30}>30 分钟</option>
          <option value={60}>1 小时</option>
          <option value={360}>6 小时</option>
          <option value={1440}>24 小时</option>
        </ComboBox>
      </label>

      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <div className="inline-success">
          <Check size={15} />
          {notice}
        </div>
      ) : null}
      <div className="form-actions">
        <Button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() =>
            void run(
              () => resetProxySettings(['enabled', 'subscriptionUrl', 'refreshIntervalMinutes']),
              '已恢复系统默认配置'
            )
          }
        >
          恢复系统默认
        </Button>
        <Button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void run(refreshProxySettings, '订阅已重新拉取并应用')}
        >
          <RefreshCw size={15} />
          立即刷新
        </Button>
        <Button type="submit" className="primary-button" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          保存
        </Button>
      </div>
    </form>
  )
}

function newEnvironmentDraft(): EnvironmentDraft {
  return {
    id: null,
    slug: '',
    name: '',
    sortOrder: 0,
    backendOrigin: 'https://www.kookapp.cn',
    useInternalProxy: false,
    resourceProxyPrefixes: [],
    status: 'ACTIVE',
  }
}

function environmentDraft(environment: EnvironmentSettingsView): EnvironmentDraft {
  return {
    id: environment.id,
    slug: environment.slug,
    name: environment.name,
    sortOrder: environment.sortOrder ?? 0,
    backendOrigin: environment.backendOrigin,
    useInternalProxy: environment.useInternalProxy ?? false,
    resourceProxyPrefixes: [...(environment.resourceProxyPrefixes || [])],
    status: environment.status,
  }
}

export function normalizeResourceProxyPrefixes(prefixes: string[]): string[] {
  return [...new Set(prefixes.map((prefix) => prefix.trim()).filter(Boolean))]
}

function defaultEnvironmentProject(
  environmentId: string,
  project: BuildTargetSettingsView
): ProjectEnvironmentSettingsView {
  return {
    environmentId,
    targetId: project.id,
    installCommand: project.installCommand,
    buildCommand: project.buildCommand,
    outputDirectory: project.outputDirectory,
    enabled: false,
    required: false,
  }
}

export function selectedEnvironmentOrFirst<T extends { slug: string }>(
  environments: T[],
  selectedSlug: string
): T | null {
  return (
    environments.find((environment) => environment.slug === selectedSlug) || environments[0] || null
  )
}

export function EnvironmentsSettings({
  environments,
  setEnvironments,
  projects,
  proxyEnabled,
  onChanged,
  initialSelectedSlug,
}: {
  environments: EnvironmentSettingsView[]
  setEnvironments: (items: EnvironmentSettingsView[]) => void
  projects: BuildTargetSettingsView[]
  proxyEnabled: boolean
  onChanged: () => void
  initialSelectedSlug: string
}) {
  const initialEnvironment = selectedEnvironmentOrFirst(environments, initialSelectedSlug)
  const [selectedSlug, setSelectedSlug] = useState(initialEnvironment?.slug || '')
  const [draft, setDraft] = useState<EnvironmentDraft>(
    initialEnvironment ? environmentDraft(initialEnvironment) : newEnvironmentDraft()
  )
  const [creating, setCreating] = useState(!initialEnvironment)
  const [projectSettings, setProjectSettings] = useState<ProjectEnvironmentSettingsView[]>([])
  const [loadingProjects, setLoadingProjects] = useState(Boolean(initialEnvironment))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const completeProjectSettings = useMemo(() => {
    const configured = new Map(projectSettings.map((item) => [item.targetId, item]))
    return projects.map(
      (project) => configured.get(project.id) || defaultEnvironmentProject(draft.id || '', project)
    )
  }, [draft.slug, projectSettings, projects])

  useEffect(() => {
    if (creating || !selectedSlug) return
    const selected = environments.find((environment) => environment.slug === selectedSlug)
    if (!selected) {
      const fallback = environments[0]
      if (fallback) {
        setSelectedSlug(fallback.slug)
        setDraft(environmentDraft(fallback))
      }
      return
    }
    setDraft(environmentDraft(selected))
  }, [creating, environments, selectedSlug])

  useEffect(() => {
    if (creating || !selectedSlug) {
      setProjectSettings([])
      setLoadingProjects(false)
      return
    }
    let stopped = false
    setLoadingProjects(true)
    setError('')
    void getEnvironmentProjectSettings(selectedSlug)
      .then((result) => {
        if (!stopped) setProjectSettings(result.items)
      })
      .catch((requestError) => {
        if (!stopped) setError(errorMessage(requestError))
      })
      .finally(() => {
        if (!stopped) setLoadingProjects(false)
      })
    return () => {
      stopped = true
    }
  }, [creating, selectedSlug])

  function selectEnvironment(environment: EnvironmentSettingsView) {
    setCreating(false)
    setSelectedSlug(environment.slug)
    setDraft(environmentDraft(environment))
    setError('')
    setNotice('')
  }

  function startCreating() {
    setCreating(true)
    setSelectedSlug('')
    setDraft(newEnvironmentDraft())
    setProjectSettings([])
    setError('')
    setNotice('')
  }

  function updateProjectSetting(targetId: string, change: Partial<ProjectEnvironmentSettingsView>) {
    setProjectSettings((current) => {
      const byTarget = new Map(current.map((item) => [item.targetId, item]))
      const project = projects.find((item) => item.id === targetId)
      if (!project) return current
      const previous = byTarget.get(targetId) || defaultEnvironmentProject(draft.id || '', project)
      byTarget.set(targetId, {
        ...previous,
        ...change,
        environmentId: draft.id || '',
        targetId,
      })
      return [...byTarget.values()]
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const slug = draft.slug.trim().toLowerCase()
    setBusy(true)
    setError('')
    setNotice('')
    let savedEnvironment: EnvironmentSettingsView | null = null
    try {
      savedEnvironment = await saveEnvironment({
        slug,
        name: draft.name.trim(),
        sortOrder: draft.sortOrder,
        backendOrigin: draft.backendOrigin.trim(),
        useInternalProxy: draft.useInternalProxy,
        resourceProxyPrefixes: normalizeResourceProxyPrefixes(draft.resourceProxyPrefixes),
        status: draft.status,
      })
      const settings = completeProjectSettings.map((item) => ({
        ...item,
        environmentId: savedEnvironment!.id,
        installCommand: item.installCommand.trim(),
        buildCommand: item.buildCommand.trim(),
        outputDirectory: item.outputDirectory.trim(),
        required: item.enabled && item.required,
      }))
      const savedProjects = await saveEnvironmentProjectSettings(savedEnvironment.slug, settings)
      setProjectSettings(savedProjects.items)
      setEnvironments((await getEnvironments()).items)
      setSelectedSlug(savedEnvironment.slug)
      setDraft(environmentDraft(savedEnvironment))
      setCreating(false)
      setNotice(
        savedEnvironment.status === 'ARCHIVED'
          ? '环境已归档；现有记录保留，但不会再进入日常环境列表'
          : '环境与项目构建配置已保存'
      )
      onChanged()
    } catch (requestError) {
      if (savedEnvironment) {
        setEnvironments(
          [
            ...environments.filter((item) => item.slug !== savedEnvironment!.slug),
            savedEnvironment,
          ].sort(
            (a, b) =>
              (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
              a.name.localeCompare(b.name) ||
              a.slug.localeCompare(b.slug)
          )
        )
        setSelectedSlug(savedEnvironment.slug)
        setDraft(environmentDraft(savedEnvironment))
        setCreating(false)
        setError(`环境基本信息已保存，但项目配置没有完成：${errorMessage(requestError)}`)
        onChanged()
      } else {
        setError(errorMessage(requestError))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="projects-layout environments-layout">
      <aside className="project-index" aria-label="环境列表">
        <div className="project-index-heading">
          <strong>环境</strong>
          <Button type="submit" className="icon-button" title="新增环境" onClick={startCreating}>
            <Plus size={17} />
          </Button>
        </div>
        <div className="project-index-list">
          {environments.map((environment) => (
            <Button
              type="submit"
              className={`project-index-item ${!creating && environment.slug === selectedSlug ? 'active' : ''}`}
              key={environment.slug}
              onClick={() => selectEnvironment(environment)}
            >
              <span>{environment.name}</span>
              <small>
                {environment.slug} · {environmentStatusLabel(environment.status)} · 顺序{' '}
                {environment.sortOrder ?? 0}
              </small>
            </Button>
          ))}
        </div>
      </aside>

      <form className="project-workspace environment-editor management-form" onSubmit={save}>
        <div className="editor-heading">
          <div>
            <span className="eyebrow">{creating ? '新环境' : draft.slug}</span>
            <h3>{creating ? '添加 QA 环境' : draft.name}</h3>
          </div>
          {!creating ? (
            <span className={`environment-status-badge status-${draft.status.toLowerCase()}`}>
              {environmentStatusLabel(draft.status)}
            </span>
          ) : null}
        </div>

        <section className="environment-section" aria-labelledby="environment-basic-title">
          <div className="settings-section-heading compact-section-heading">
            <Network size={17} />
            <div>
              <h3 id="environment-basic-title">环境入口</h3>
              <p>后端请求回源到这个地址；前端与热更由浏览器扩展按标签页选择。</p>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>环境名称</span>
              <TextBox
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>显示顺序</span>
              <NumberBox
                value={draft.sortOrder}
                onChange={(event) => setDraft({ ...draft, sortOrder: event.target.valueAsNumber })}
                min={-1000000}
                max={1000000}
                step={1}
                required
              />
              <small>数字越小越靠前，相同则按名称排序。保存后主站和插件统一生效。</small>
            </label>
            <label className="field">
              <span>环境标识</span>
              <TextBox
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase() })}
                placeholder="qa-a"
                pattern="[a-z0-9][a-z0-9_-]{0,79}"
                maxLength={80}
                readOnly={!creating}
                required
              />
              <small>
                {creating ? '创建后不可修改，用于 API 与预览域名。' : '环境标识不可修改。'}
              </small>
            </label>
            <label className="field field-wide">
              <span>业务后端</span>
              <TextBox
                type="url"
                value={draft.backendOrigin}
                onChange={(event) => setDraft({ ...draft, backendOrigin: event.target.value })}
                placeholder="https://www.kookapp.cn"
                required
              />
            </label>
            <label className="field field-wide">
              <span>环境附加资源代理来源</span>
              <TextArea
                value={draft.resourceProxyPrefixes.join('\n')}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    resourceProxyPrefixes: event.target.value.split(/\r?\n/),
                  })
                }
                placeholder={'https://img.kookapp.cn/\nhttps://static.kookapp.cn/'}
                rows={3}
                spellCheck={false}
              />
              <small>
                每行一个 HTTP(S) URL 前缀；与预览站点的基础白名单合并，并且只在选择此环境时生效。
              </small>
            </label>
            <Switch
              className="toggle-row field-wide"
              checked={draft.useInternalProxy}
              onChange={(event) => setDraft({ ...draft, useInternalProxy: event.target.checked })}
            >
              <div>
                <strong>走公司内网</strong>
                <span>
                  仅业务后端请求经 Mihomo；
                  {proxyEnabled
                    ? '全局内网代理已启用。'
                    : '当前未启用 Mihomo，打开后也不会生效，请先到“代理”中启用。'}
                </span>
              </div>
            </Switch>
            <label className="field compact-field">
              <span>状态</span>
              <ComboBox
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as EnvironmentStatus })
                }
              >
                <option value="ACTIVE">可用</option>
                <option value="FROZEN">冻结构建，保留已有产物</option>
                <option value="ARCHIVED">归档</option>
              </ComboBox>
              <small>冻结后不能新建构建，已有产物仍可用于标签页预览；归档替代删除。</small>
            </label>
          </div>
        </section>

        <section className="environment-section" aria-labelledby="environment-projects-title">
          <div className="settings-section-heading compact-section-heading">
            <Hammer size={17} />
            <div>
              <h3 id="environment-projects-title">项目构建配置</h3>
              <p>命令与产物目录在环境内独立维护；打包只生成可供标签页预览的 Artifact。</p>
            </div>
          </div>
          {loadingProjects ? (
            <div className="detail-loading compact-loading">
              <LoaderCircle className="spin" size={17} />
              正在读取项目配置
            </div>
          ) : (
            <div className="environment-project-list">
              {completeProjectSettings.map((item) => {
                const project = projects.find((candidate) => candidate.id === item.targetId)!
                return (
                  <fieldset
                    className={`environment-project-row ${project.enabled ? '' : 'project-globally-disabled'}`}
                    key={item.targetId}
                  >
                    <div className="environment-project-heading">
                      <div>
                        <strong>{project.name}</strong>
                        <span>
                          {project.id}
                          {project.enabled ? '' : ' · 项目总开关已关闭，不能发起新构建'}
                        </span>
                      </div>
                      <div className="environment-project-toggles">
                        <CheckBox
                          checked={item.enabled}
                          disabled={!project.enabled}
                          onChange={(event) =>
                            updateProjectSetting(item.targetId, {
                              enabled: event.target.checked,
                              required: event.target.checked ? item.required : false,
                            })
                          }
                        >
                          环境可构建
                        </CheckBox>
                      </div>
                    </div>
                    <div className="environment-project-fields">
                      <label className="field">
                        <span>安装命令</span>
                        <TextBox
                          value={item.installCommand}
                          onChange={(event) =>
                            updateProjectSetting(item.targetId, {
                              installCommand: event.target.value,
                            })
                          }
                          required
                        />
                      </label>
                      <label className="field">
                        <span>打包命令</span>
                        <TextBox
                          value={item.buildCommand}
                          onChange={(event) =>
                            updateProjectSetting(item.targetId, {
                              buildCommand: event.target.value,
                            })
                          }
                          required
                        />
                      </label>
                      <label className="field">
                        <span>产物目录</span>
                        <TextBox
                          value={item.outputDirectory}
                          onChange={(event) =>
                            updateProjectSetting(item.targetId, {
                              outputDirectory: event.target.value,
                            })
                          }
                          required
                        />
                      </label>
                    </div>
                  </fieldset>
                )
              })}
            </div>
          )}
        </section>

        {error ? <InlineError message={error} /> : null}
        {notice ? (
          <div className="inline-success">
            <Check size={15} />
            {notice}
          </div>
        ) : null}
        <div className="form-actions">
          <span />
          <Button type="submit" className="primary-button" disabled={busy || loadingProjects}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
            保存环境
          </Button>
        </div>
      </form>
    </div>
  )
}

function newProject(): BuildTargetSettingsView {
  return {
    id: '',
    name: '',
    kind: 'spa-site',
    repositoryUrl: null,
    defaultBranch: 'master',
    installCommand: 'corepack pnpm install --frozen-lockfile',
    buildCommand: 'corepack pnpm run build',
    outputDirectory: 'dist',
    siteAdapter: 'generic-static-v1',
    enabled: false,
    required: false,
    configurationSource: 'database',
    canReset: false,
    gitAuthorizationConfigured: false,
  }
}

function ProjectsSettings({
  projects,
  setProjects,
  bindings,
  setBindings,
  environments,
  selectedEnvironmentSlug,
  autoSslEnabled,
  previewBaseDomain,
  onChanged,
}: {
  projects: BuildTargetSettingsView[]
  setProjects: (items: BuildTargetSettingsView[]) => void
  bindings: SiteBinding[]
  setBindings: (items: SiteBinding[]) => void
  environments: EnvironmentSettingsView[]
  selectedEnvironmentSlug: string
  autoSslEnabled: boolean
  previewBaseDomain: string
  onChanged: () => void
}) {
  const [selectedId, setSelectedId] = useState(projects[0]?.id || '')
  const selected = projects.find((item) => item.id === selectedId) || null
  const [draft, setDraft] = useState<BuildTargetSettingsView>(selected || newProject())
  const [creating, setCreating] = useState(projects.length === 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [gitAuthorizationHeader, setGitAuthorizationHeader] = useState('')
  const [clearGitAuthorizationHeader, setClearGitAuthorizationHeader] = useState(false)

  useEffect(() => {
    if (creating) return
    const next = projects.find((item) => item.id === selectedId) || projects[0]
    if (next) {
      setSelectedId(next.id)
      setDraft(next)
    }
  }, [creating, projects, selectedId])

  function selectProject(project: BuildTargetSettingsView) {
    setCreating(false)
    setSelectedId(project.id)
    setDraft(project)
    setError('')
    setNotice('')
    setGitAuthorizationHeader('')
    setClearGitAuthorizationHeader(false)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await saveProjectSettings({
        id: draft.id.trim(),
        name: draft.name.trim(),
        kind: draft.kind,
        repositoryUrl: draft.repositoryUrl?.trim() || null,
        defaultBranch: draft.defaultBranch.trim(),
        installCommand: draft.installCommand.trim(),
        buildCommand: draft.buildCommand.trim(),
        outputDirectory: draft.outputDirectory.trim(),
        siteAdapter: draft.siteAdapter.trim(),
        enabled: draft.enabled,
        required: draft.required,
        ...(gitAuthorizationHeader.trim()
          ? { gitAuthorizationHeader: gitAuthorizationHeader.trim() }
          : {}),
        ...(clearGitAuthorizationHeader ? { clearGitAuthorizationHeader: true } : {}),
      })
      setProjects(
        [...projects.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      )
      setSelectedId(saved.id)
      setDraft(saved)
      setCreating(false)
      setGitAuthorizationHeader('')
      setClearGitAuthorizationHeader(false)
      setNotice('项目源码配置已保存；各环境的构建命令仍由环境配置决定')
      onChanged()
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const restored = await resetProjectSettings(draft.id)
      setProjects(projects.map((item) => (item.id === restored.id ? restored : item)))
      setDraft(restored)
      setGitAuthorizationHeader('')
      setClearGitAuthorizationHeader(false)
      setNotice('已恢复内置项目模板')
      onChanged()
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="projects-layout">
      <aside className="project-index" aria-label="项目列表">
        <div className="project-index-heading">
          <strong>项目</strong>
          <Button
            type="submit"
            className="icon-button"
            title="新增项目"
            onClick={() => {
              setCreating(true)
              setSelectedId('')
              setDraft(newProject())
              setError('')
              setNotice('')
            }}
          >
            <Plus size={17} />
          </Button>
        </div>
        <div className="project-index-list">
          {projects.map((project) => (
            <Button
              type="submit"
              className={`project-index-item ${!creating && project.id === selectedId ? 'active' : ''}`}
              key={project.id}
              onClick={() => selectProject(project)}
            >
              <span>{project.name}</span>
              <small>
                {project.enabled ? '启用' : '停用'} · {projectSiteSummary(project, bindings)}
              </small>
            </Button>
          ))}
        </div>
      </aside>

      <div className="project-workspace">
        <form className="project-editor management-form" onSubmit={save}>
          <div className="editor-heading">
            <div>
              <span className="eyebrow">{creating ? '新项目' : draft.id}</span>
              <h3>{creating ? '添加打包项目' : draft.name}</h3>
            </div>
            {!creating && draft.configurationSource === 'database' ? (
              <span className="source-badge">后台配置</span>
            ) : null}
          </div>

          <div className="field-grid">
            <label className="field">
              <span>项目名称</span>
              <TextBox
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>项目标识</span>
              <TextBox
                value={draft.id}
                onChange={(event) => setDraft({ ...draft, id: event.target.value.toLowerCase() })}
                placeholder="example-site"
                pattern="[a-z0-9][a-z0-9_-]{0,79}"
                maxLength={80}
                readOnly={!creating}
                required
              />
            </label>
            <label className="field field-wide">
              <span>Git 仓库地址</span>
              <TextBox
                value={draft.repositoryUrl || ''}
                onChange={(event) => setDraft({ ...draft, repositoryUrl: event.target.value })}
                placeholder="https://git.example.cn/group/project.git"
                required={draft.enabled}
              />
            </label>
            <label className="field field-wide">
              <span>Git HTTP 认证头</span>
              <TextBox
                type="password"
                value={gitAuthorizationHeader}
                onChange={(event) => {
                  setGitAuthorizationHeader(event.target.value)
                  setClearGitAuthorizationHeader(false)
                }}
                placeholder={
                  draft.gitAuthorizationConfigured
                    ? '已配置，留空保持不变'
                    : '例如 Authorization: Basic ***'
                }
                autoComplete="off"
              />
              <small>
                {draft.gitAuthorizationConfigured
                  ? '凭证已加密保存且不会回显'
                  : '仅 HTTPS 私有仓库需要；SSH 仓库可留空'}
              </small>
            </label>
            {draft.gitAuthorizationConfigured ? (
              <Switch
                className="toggle-row field-wide credential-clear-row"
                checked={clearGitAuthorizationHeader}
                onChange={(event) => {
                  setClearGitAuthorizationHeader(event.target.checked)
                  if (event.target.checked) setGitAuthorizationHeader('')
                }}
              >
                <div>
                  <strong>清除已保存凭证</strong>
                  <span>保存项目时删除现有 Git HTTP 认证头</span>
                </div>
              </Switch>
            ) : null}
            <label className="field">
              <span>默认分支</span>
              <TextBox
                value={draft.defaultBranch}
                onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>项目类型</span>
              <ComboBox
                value={draft.kind}
                onChange={(event) => {
                  const kind = event.target.value as BuildTargetSettingsView['kind']
                  const currentSiteAdapter = draft.siteAdapter as SiteBuildAdapter
                  setDraft({
                    ...draft,
                    kind,
                    siteAdapter:
                      kind === 'remote'
                        ? 'kook-remote-v1'
                        : siteBuildAdapters.includes(currentSiteAdapter)
                          ? currentSiteAdapter
                          : 'generic-static-v1',
                  })
                }}
              >
                <option value="h5-site">移动 H5</option>
                <option value="webapp">网页端</option>
                <option value="spa-site">单页站点</option>
                <option value="remote">远程项目</option>
              </ComboBox>
            </label>
            <label className="field">
              <span>产物适配器</span>
              <ComboBox
                value={draft.siteAdapter}
                onChange={(event) => setDraft({ ...draft, siteAdapter: event.target.value })}
              >
                {draft.kind === 'remote' ? (
                  <option value="kook-remote-v1">KOOK Remote</option>
                ) : (
                  <>
                    <option value="kook-online-h5-v1">KOOK 移动 H5</option>
                    <option value="generic-static-v1">通用静态站点</option>
                  </>
                )}
              </ComboBox>
            </label>
          </div>

          <div className="toggle-stack">
            <Switch
              className="toggle-row"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  enabled: event.target.checked,
                  required: event.target.checked ? draft.required : false,
                })
              }
            >
              <div>
                <strong>项目全局可用</strong>
                <span>关闭后所有环境都不能发起新构建；已有标签页预览保持有效至会话结束。</span>
              </div>
            </Switch>
          </div>

          {error ? <InlineError message={error} /> : null}
          {notice ? (
            <div className="inline-success">
              <Check size={15} />
              {notice}
            </div>
          ) : null}
          <div className="form-actions">
            {!creating && draft.canReset ? (
              <Button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void reset()}
              >
                恢复内置模板
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" className="primary-button" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              保存项目
            </Button>
          </div>
        </form>

        {!creating && selected && selected.kind !== 'remote' ? (
          <ProjectSitesSettings
            key={selected.id}
            project={selected}
            bindings={bindings}
            setBindings={setBindings}
            projects={projects}
            environments={environments}
            selectedEnvironmentSlug={selectedEnvironmentSlug}
            autoSslEnabled={autoSslEnabled}
            previewBaseDomain={previewBaseDomain}
          />
        ) : null}
      </div>
    </div>
  )
}

export function projectSiteSummary(
  project: Pick<BuildTargetSettingsView, 'id' | 'kind'>,
  bindings: SiteBinding[]
): string {
  if (project.kind === 'remote') return 'Remote'
  const projectBindings = bindings.filter((binding) => binding.targetId === project.id)
  if (projectBindings.length === 0) return '未配置站点'
  if (projectBindings.length === 1) return projectBindings[0]!.hostname
  return `${projectBindings.length} 个站点`
}

function isBindableSiteProject(project: BuildTargetSettingsView): boolean {
  return (
    project.enabled &&
    project.kind !== 'remote' &&
    siteBuildAdapters.includes(project.siteAdapter as SiteBuildAdapter)
  )
}

export const DEFAULT_PREVIEW_BASE_DOMAIN = 'bifrost.vanillacake.cn'
export const DEFAULT_RESOURCE_PROXY_PREFIXES = [
  'https://img.kookapp.cn/',
  'https://static.kookapp.cn/',
]

export function siteHostnameForId(
  id: string,
  previewBaseDomain = DEFAULT_PREVIEW_BASE_DOMAIN
): string {
  const baseDomain = previewBaseDomain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '')
  return siteBindingIdPattern.test(id) && baseDomain ? `${id}.${baseDomain}` : ''
}

function newSiteBinding(
  project: BuildTargetSettingsView,
  environmentSlug: string
): CompatibleSiteBinding {
  const origin = project.kind === 'h5-site' ? 'https://m.kookapp.cn' : 'https://www.kookapp.cn'
  return {
    id: '',
    name: project.name,
    hostname: '',
    targetId: project.id,
    environmentSlug,
    fallbackOrigin: origin,
    upstreamOrigin: origin,
    officialOrigin: origin,
    enabled: false,
    remoteTargetIds: [],
    resourceProxyPrefixes: [...DEFAULT_RESOURCE_PROXY_PREFIXES],
  }
}

function ProjectSitesSettings({
  project,
  bindings,
  setBindings,
  projects,
  environments,
  selectedEnvironmentSlug,
  autoSslEnabled,
  previewBaseDomain,
}: {
  project: BuildTargetSettingsView
  bindings: SiteBinding[]
  setBindings: (items: SiteBinding[]) => void
  projects: BuildTargetSettingsView[]
  environments: EnvironmentSettingsView[]
  selectedEnvironmentSlug: string
  autoSslEnabled: boolean
  previewBaseDomain: string
}) {
  const projectBindings = useMemo(
    () =>
      bindings
        .filter((binding) => binding.targetId === project.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [bindings, project.id]
  )
  const [selectedId, setSelectedId] = useState(projectBindings[0]?.id || '')
  const selected = projectBindings.find((item) => item.id === selectedId) || null
  const [draft, setDraft] = useState<CompatibleSiteBinding>(
    selected || newSiteBinding(project, selectedEnvironmentSlug)
  )
  const [creating, setCreating] = useState(projectBindings.length === 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const remoteProjects = projects.filter((project) => project.kind === 'remote')
  const editable = isBindableSiteProject(project)

  useEffect(() => {
    if (creating) return
    const next = projectBindings.find((item) => item.id === selectedId) || projectBindings[0]
    if (next) {
      setSelectedId(next.id)
      setDraft(next)
    } else {
      setSelectedId('')
      setDraft(newSiteBinding(project, selectedEnvironmentSlug))
      setCreating(true)
    }
  }, [creating, project, projectBindings, selectedEnvironmentSlug, selectedId])

  function selectBinding(binding: SiteBinding) {
    setCreating(false)
    setSelectedId(binding.id)
    setDraft(binding)
    setError('')
    setNotice('')
  }

  function startCreating() {
    setCreating(true)
    setSelectedId('')
    setDraft(newSiteBinding(project, selectedEnvironmentSlug))
    setError('')
    setNotice('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await saveSiteBinding({
        ...draft,
        id: draft.id.trim().toLowerCase(),
        name: draft.name.trim(),
        hostname: draft.hostname.trim().toLowerCase(),
        targetId: project.id,
        environmentSlug: draft.environmentSlug.trim(),
        fallbackOrigin: fallbackOrigin(draft).trim(),
        upstreamOrigin: fallbackOrigin(draft).trim(),
        officialOrigin: draft.officialOrigin.trim(),
        resourceProxyPrefixes: (draft.resourceProxyPrefixes || [])
          .map((prefix) => prefix.trim())
          .filter(Boolean),
      })
      setBindings(
        [...bindings.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      )
      setSelectedId(saved.id)
      setDraft(saved)
      setCreating(false)
      setNotice('站点绑定已保存；网关会按 Host 读取这份配置')
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`删除站点“${draft.name}”？这个域名将不再由 ${PRODUCT_NAME} 提供预览。`))
      return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await deleteSiteBinding(draft.id)
      const remaining = bindings.filter((item) => item.id !== draft.id)
      setBindings(remaining)
      const remainingProjectBindings = projectBindings.filter((item) => item.id !== draft.id)
      if (remainingProjectBindings[0]) {
        setSelectedId(remainingProjectBindings[0].id)
        setDraft(remainingProjectBindings[0])
        setCreating(false)
      } else {
        setSelectedId('')
        setDraft(newSiteBinding(project, selectedEnvironmentSlug))
        setCreating(true)
      }
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="project-sites-section" aria-labelledby={`project-sites-${project.id}`}>
      <header className="project-sites-heading">
        <div>
          <span className="eyebrow">标签页入口</span>
          <h3 id={`project-sites-${project.id}`}>预览站点</h3>
        </div>
        <div className="project-site-controls">
          {projectBindings.length ? (
            <label className="project-site-picker">
              <span className="sr-only">选择预览站点</span>
              <ComboBox
                aria-label="选择预览站点"
                value={creating ? '' : selectedId}
                onChange={(event) => {
                  const binding = projectBindings.find((item) => item.id === event.target.value)
                  if (binding) selectBinding(binding)
                }}
              >
                {creating ? <option value="">新站点</option> : null}
                {projectBindings.map((binding) => (
                  <option value={binding.id} key={binding.id}>
                    {binding.name} · {binding.hostname}
                  </option>
                ))}
              </ComboBox>
            </label>
          ) : null}
          <Button
            type="button"
            className="icon-button"
            title="新增预览站点"
            disabled={!editable}
            onClick={startCreating}
          >
            <Plus size={17} />
          </Button>
        </div>
      </header>

      {!editable ? (
        <div className="project-site-unavailable">
          <CircleAlert size={16} />
          <span>
            {project.enabled
              ? '当前站点适配器不支持页面预览。'
              : '启用并保存项目后，才能新增或修改预览站点。'}
          </span>
        </div>
      ) : null}

      {editable || projectBindings.length ? (
        <form className="management-form embedded-site-editor" onSubmit={save}>
          <fieldset className="site-editor-fieldset" disabled={!editable || busy}>
            <div className="editor-heading site-editor-heading">
              <div>
                <span className="eyebrow">{creating ? '新站点' : draft.id}</span>
                <h3>{creating ? '添加预览站点' : draft.name}</h3>
              </div>
              {!creating && draft.hostname ? (
                <a
                  className="site-preview-link"
                  href={`https://${draft.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开站点
                  <ExternalLink size={14} />
                </a>
              ) : null}
            </div>

            <div className="field-grid">
              <label className="field">
                <span>默认环境</span>
                <ComboBox
                  value={draft.environmentSlug}
                  onChange={(event) => setDraft({ ...draft, environmentSlug: event.target.value })}
                  required
                >
                  {environments.map((environment) => (
                    <option value={environment.slug} key={environment.slug}>
                      {environment.name} · {environmentStatusLabel(environment.status)}
                    </option>
                  ))}
                </ComboBox>
                <small>未携带扩展预览 Token 时使用；扩展可在同一站点选择其他环境。</small>
              </label>
              <label className="field">
                <span>站点名称</span>
                <TextBox
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="KOOK 网页端"
                  required
                />
              </label>
              <label className="field">
                <span>站点标识</span>
                <TextBox
                  value={draft.id}
                  onChange={(event) => {
                    const id = event.target.value.toLowerCase()
                    const generatedHostname = siteHostnameForId(draft.id, previewBaseDomain)
                    setDraft({
                      ...draft,
                      id,
                      hostname:
                        !draft.hostname || draft.hostname === generatedHostname
                          ? siteHostnameForId(id, previewBaseDomain)
                          : draft.hostname,
                    })
                  }}
                  placeholder="main"
                  pattern={siteBindingIdPattern.source}
                  maxLength={63}
                  readOnly={!creating}
                  required
                />
              </label>
              <label className="field field-wide">
                <span>预览域名</span>
                <TextBox
                  value={draft.hostname}
                  onChange={(event) => setDraft({ ...draft, hostname: event.target.value })}
                  placeholder={siteHostnameForId('main', previewBaseDomain)}
                  required
                />
                <small>
                  {autoSslEnabled
                    ? `保存并启用后，自动 SSL 会维护 ${previewBaseDomain} 下这个域名的证书。`
                    : `当前预览根域为 ${previewBaseDomain}；自动 SSL 关闭时证书由部署环境提供。`}
                </small>
              </label>
              <label className="field">
                <span>对应官网</span>
                <TextBox
                  type="url"
                  value={draft.officialOrigin}
                  onChange={(event) => setDraft({ ...draft, officialOrigin: event.target.value })}
                  placeholder="https://www.kookapp.cn"
                  required
                />
                <small>扩展在这个官网页面展示本站点的分支。</small>
              </label>
              <label className="field">
                <span>页面回退源</span>
                <TextBox
                  type="url"
                  value={fallbackOrigin(draft)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fallbackOrigin: event.target.value,
                      upstreamOrigin: event.target.value,
                    })
                  }
                  placeholder="https://www.kookapp.cn"
                  required
                />
                <small>没有命中页面 Artifact 的请求由网关转发到这里。</small>
              </label>
              <label className="field field-wide">
                <span>站点基础资源代理来源</span>
                <TextArea
                  value={(draft.resourceProxyPrefixes || []).join('\n')}
                  onChange={(event) =>
                    setDraft({ ...draft, resourceProxyPrefixes: event.target.value.split(/\r?\n/) })
                  }
                  placeholder={'https://img.kookapp.cn/\nhttps://static.kookapp.cn/'}
                  rows={3}
                />
                <small>
                  每行一个 HTTP(S) 路径前缀；命中的图片、脚本、样式与数据仅通过 GET/HEAD
                  转发，且不会携带登录凭据；环境设置可为当前环境追加来源。
                </small>
              </label>
            </div>

            <Switch
              className="toggle-row site-enabled-toggle"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            >
              <div>
                <strong>启用站点</strong>
                <span>启用后，网关接受这个 Host，扩展也会显示对应项目。</span>
              </div>
            </Switch>

            <fieldset className="remote-project-fieldset">
              <legend>关联热更项目</legend>
              <p>访问对应官网或预览域名时，扩展一并列出这些 Remote 项目。</p>
              <div className="remote-project-list">
                {remoteProjects.length ? (
                  remoteProjects.map((remoteProject) => {
                    const checked = draft.remoteTargetIds.includes(remoteProject.id)
                    return (
                      <CheckBox
                        className="remote-project-option"
                        key={remoteProject.id}
                        checked={checked}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            remoteTargetIds: event.target.checked
                              ? [...draft.remoteTargetIds, remoteProject.id]
                              : draft.remoteTargetIds.filter((id) => id !== remoteProject.id),
                          })
                        }
                      >
                        <span>
                          <strong>{remoteProject.name}</strong>
                          <small>
                            {remoteProject.id}
                            {remoteProject.enabled ? '' : ' · 已停用'}
                          </small>
                        </span>
                      </CheckBox>
                    )
                  })
                ) : (
                  <span className="fieldset-empty">当前没有 Remote 项目。</span>
                )}
              </div>
            </fieldset>
          </fieldset>

          {error ? <InlineError message={error} /> : null}
          {notice ? (
            <div className="inline-success">
              <Check size={15} />
              {notice}
            </div>
          ) : null}
          <div className="form-actions">
            {!creating ? (
              <Button
                type="button"
                className="text-button danger-text-button"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2 size={15} />
                删除站点
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" className="primary-button" disabled={busy || !editable}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              保存站点
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

export function SystemSettingsForm({
  settings,
  environments,
  selectedEnvironmentSlug,
  onChange,
}: {
  settings: SystemSettingsView
  environments: EnvironmentSettingsView[]
  selectedEnvironmentSlug: string
  onChange: (view: SystemSettingsView) => void
}) {
  const [draft, setDraft] = useState(settings)
  const [ruleDrafts, setRuleDrafts] = useState<InPlaceUrlRuleDraft[]>(() =>
    (settings.inPlaceUrlRules || []).map(inPlaceUrlRuleDraft)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setDraft(settings)
    setRuleDrafts((settings.inPlaceUrlRules || []).map(inPlaceUrlRuleDraft))
  }, [settings])

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const inPlaceUrlRules = ruleDrafts.map(({ pattern, environmentSlug }) => ({
        pattern: pattern.trim(),
        environmentSlug,
      }))
      const emptyRuleIndex = inPlaceUrlRules.findIndex(
        (rule) => !rule.pattern || !rule.environmentSlug
      )
      if (emptyRuleIndex >= 0) {
        throw new Error(`请补全第 ${emptyRuleIndex + 1} 条官网原地应用规则`)
      }
      const seenPatterns = new Set<string>()
      const duplicateRuleIndex = inPlaceUrlRules.findIndex((rule) => {
        if (seenPatterns.has(rule.pattern)) return true
        seenPatterns.add(rule.pattern)
        return false
      })
      if (duplicateRuleIndex >= 0) {
        throw new Error(`第 ${duplicateRuleIndex + 1} 条规则的 URL 模式与前面的规则重复`)
      }
      const invalidEnvironmentIndex = inPlaceUrlRules.findIndex((rule) => {
        const environment = environments.find(
          (candidate) => candidate.slug === rule.environmentSlug
        )
        return !environment || environment.status === 'ARCHIVED'
      })
      if (invalidEnvironmentIndex >= 0) {
        throw new Error(`第 ${invalidEnvironmentIndex + 1} 条规则引用了不存在或已归档的环境`)
      }
      const saved = await updateSystemSettings({
        cookieDomain: draft.cookieDomain.trim(),
        buildMaxConcurrency: draft.buildMaxConcurrency,
        runnerRequestTimeoutMinutes: draft.runnerRequestTimeoutMinutes,
        useChinaRegistry: draft.useChinaRegistry,
        proxyRewriteMaxMegabytes: draft.proxyRewriteMaxMegabytes,
        autoSslEnabled: draft.autoSslEnabled,
        inPlaceUrlRules,
      })
      onChange(saved)
      setNotice('系统配置已保存并应用')
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="management-form system-settings-form" onSubmit={save}>
      <section className="settings-section" aria-labelledby="in-place-url-rules-title">
        <div className="settings-section-heading">
          <ShieldCheck size={17} />
          <div>
            <h3 id="in-place-url-rules-title">官网原地应用规则</h3>
            <p>
              完整 URL 包含模式即命中；命中后锁定环境且只允许原地热更，绝不会打开 {PRODUCT_NAME}
              。多条命中时采用最长、最具体的模式。
            </p>
          </div>
        </div>
        <div className="in-place-rule-editor">
          {ruleDrafts.length ? (
            <div className="in-place-rule-header" aria-hidden="true">
              <span>URL 包含模式</span>
              <span>锁定环境</span>
              <span />
            </div>
          ) : (
            <div className="in-place-rule-empty">
              暂无规则；未命中的页面继续按站点绑定决定应用方式。
            </div>
          )}
          {ruleDrafts.map((rule, index) => (
            <div className="in-place-rule-row" key={rule.clientId}>
              <label className="in-place-rule-control">
                <span className="sr-only">第 {index + 1} 条规则的 URL 包含模式</span>
                <TextBox
                  value={rule.pattern}
                  maxLength={2048}
                  required
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="例如 www.kookapp.cn"
                  aria-label={`第 ${index + 1} 条规则的 URL 包含模式`}
                  onChange={(event) =>
                    setRuleDrafts((items) =>
                      items.map((item) =>
                        item.clientId === rule.clientId
                          ? { ...item, pattern: event.target.value }
                          : item
                      )
                    )
                  }
                />
              </label>
              <label className="in-place-rule-control">
                <span className="sr-only">第 {index + 1} 条规则锁定的环境</span>
                <ComboBox
                  value={rule.environmentSlug}
                  aria-label={`第 ${index + 1} 条规则锁定的环境`}
                  onChange={(event) =>
                    setRuleDrafts((items) =>
                      items.map((item) =>
                        item.clientId === rule.clientId
                          ? { ...item, environmentSlug: event.target.value }
                          : item
                      )
                    )
                  }
                >
                  {environments.map((environment) => (
                    <option
                      key={environment.slug}
                      value={environment.slug}
                      disabled={environment.status === 'ARCHIVED'}
                    >
                      {environment.name} · {environment.slug} ·{' '}
                      {environmentStatusLabel(environment.status)}
                    </option>
                  ))}
                </ComboBox>
              </label>
              <Button
                type="button"
                className="icon-button in-place-rule-delete"
                aria-label={`删除第 ${index + 1} 条原地应用规则`}
                title="删除规则"
                onClick={() =>
                  setRuleDrafts((items) => items.filter((item) => item.clientId !== rule.clientId))
                }
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            className="secondary-button in-place-rule-add"
            disabled={
              ruleDrafts.length >= 100 || !environments.some((item) => item.status !== 'ARCHIVED')
            }
            onClick={() => {
              const preferredEnvironment =
                environments.find(
                  (environment) =>
                    environment.slug === selectedEnvironmentSlug &&
                    environment.status !== 'ARCHIVED'
                ) ||
                environments.find((environment) => environment.status === 'ACTIVE') ||
                environments.find((environment) => environment.status !== 'ARCHIVED')
              if (!preferredEnvironment) return
              setRuleDrafts((items) => [
                ...items,
                inPlaceUrlRuleDraft({ pattern: '', environmentSlug: preferredEnvironment.slug }),
              ])
            }}
          >
            <Plus size={15} />
            添加规则
          </Button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="artifact-settings-title">
        <div className="settings-section-heading">
          <PackageCheck size={17} />
          <div>
            <h3 id="artifact-settings-title">网关边界</h3>
            <p>站点和业务后端由环境维护；这里只设置所有环境共用的安全边界。</p>
          </div>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>默认 Cookie 域</span>
            <TextBox
              value={draft.cookieDomain}
              onChange={(event) => setDraft({ ...draft, cookieDomain: event.target.value })}
              placeholder=".vanillacake.cn"
            />
            <small>留空时保持 Host-only；仅在多个预览站点必须共享登录时扩大范围。</small>
          </label>
          <label className="field">
            <span>响应改写上限</span>
            <div className="number-field">
              <NumberBox
                min={1}
                max={32}
                value={draft.proxyRewriteMaxMegabytes}
                onChange={(event) =>
                  setDraft({ ...draft, proxyRewriteMaxMegabytes: Number(event.target.value) })
                }
              />
              <span>MB</span>
            </div>
            <small>只限制需要缓冲改写的文本响应，不影响普通静态资源流式传输。</small>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ssl-settings-title">
        <div className="settings-section-heading">
          <LockKeyhole size={17} />
          <div>
            <h3 id="ssl-settings-title">自动 SSL</h3>
            <p>为已启用的站点域名申请并续期独立的 Let's Encrypt 证书。</p>
          </div>
        </div>
        <div className="field-grid">
          <Switch
            className="toggle-row field-wide ssl-toggle"
            checked={draft.autoSslEnabled}
            onChange={(event) => setDraft({ ...draft, autoSslEnabled: event.target.checked })}
          >
            <div>
              <strong>自动维护证书</strong>
              <span>
                {draft.autoSslEnabled
                  ? 'Certbot 会同步所有已启用站点；新增域名无需手工改证书配置。'
                  : `已关闭；${PRODUCT_NAME} 不会调用 Certbot，也不会改动现有证书。`}
              </span>
            </div>
          </Switch>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="build-settings-title">
        <div className="settings-section-heading">
          <ServerCog size={17} />
          <div>
            <h3 id="build-settings-title">打包机</h3>
            <p>不同项目可并行，同一项目仍然保持串行。</p>
          </div>
        </div>
        <div className="field-grid">
          <Switch
            className="toggle-row field-wide build-registry-toggle"
            checked={draft.useChinaRegistry}
            onChange={(event) => setDraft({ ...draft, useChinaRegistry: event.target.checked })}
          >
            <div>
              <strong>使用国内源</strong>
              <span>依赖安装使用 npmmirror；关闭后遵循项目仓库自身配置。</span>
            </div>
          </Switch>
          <label className="field">
            <span>最大并行项目数</span>
            <NumberBox
              min={1}
              max={16}
              value={draft.buildMaxConcurrency}
              onChange={(event) =>
                setDraft({ ...draft, buildMaxConcurrency: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span>单次打包超时</span>
            <div className="number-field">
              <NumberBox
                min={1}
                max={180}
                value={draft.runnerRequestTimeoutMinutes}
                onChange={(event) =>
                  setDraft({ ...draft, runnerRequestTimeoutMinutes: Number(event.target.value) })
                }
              />
              <span>分钟</span>
            </div>
          </label>
        </div>
      </section>

      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <div className="inline-success">
          <Check size={15} />
          {notice}
        </div>
      ) : null}
      <div className="form-actions">
        <Button type="submit" className="primary-button" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          保存系统配置
        </Button>
      </div>
    </form>
  )
}

function ManagementPanel({
  onClose,
  onProjectsChanged,
  selectedEnvironmentSlug,
  previewBaseDomain,
}: {
  onClose: () => void
  onProjectsChanged: () => void
  selectedEnvironmentSlug: string
  previewBaseDomain: string
}) {
  const [tab, setTab] = useState<ManagementTab>('environments')
  const [proxy, setProxy] = useState<ProxySettingsView | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentSettingsView[]>([])
  const [projects, setProjects] = useState<BuildTargetSettingsView[]>([])
  const [siteBindings, setSiteBindings] = useState<SiteBinding[]>([])
  const [systemSettings, setSystemSettings] = useState<SystemSettingsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const returnTarget = returnFocusRef.current
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus()
      })
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      const fallback = dialogFocusableElements(dialog)[0] || dialog
      const focusTarget = initial || fallback
      focusTarget.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [tab])

  const handleDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = dialogFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose]
  )

  const load = useCallback(async () => {
    const [proxyView, environmentView, projectView, siteView, systemView] = await Promise.all([
      getProxySettings(),
      getEnvironments(),
      getProjectSettings(),
      getSiteBindings(),
      getSystemSettings(),
    ])
    setProxy(proxyView)
    setEnvironments(environmentView.items)
    setProjects(projectView.items)
    setSiteBindings(siteView.items)
    setSystemSettings(systemView)
  }, [])

  useEffect(() => {
    setLoading(true)
    setError('')
    void load()
      .catch((requestError) => setError(errorMessage(requestError)))
      .finally(() => setLoading(false))
  }, [load])

  return (
    <div className="management-scrim" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="management-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="management-header">
          <div>
            <span className="eyebrow">管理</span>
            <h2 id="management-title">环境与项目</h2>
          </div>
          <Button type="submit" className="icon-button" title="关闭管理后台" onClick={onClose}>
            <X size={18} />
          </Button>
        </header>

        <nav className="management-tabs" aria-label="管理分类">
          <Button
            type="submit"
            className={tab === 'environments' ? 'active' : ''}
            onClick={() => setTab('environments')}
            data-dialog-initial-focus={tab === 'environments' ? true : undefined}
          >
            <Network size={16} />
            环境
          </Button>
          <Button
            type="submit"
            className={tab === 'projects' ? 'active' : ''}
            onClick={() => setTab('projects')}
            data-dialog-initial-focus={tab === 'projects' ? true : undefined}
          >
            <FolderGit2 size={16} />
            项目
          </Button>
          <Button
            type="submit"
            className={tab === 'proxy' ? 'active' : ''}
            onClick={() => setTab('proxy')}
            data-dialog-initial-focus={tab === 'proxy' ? true : undefined}
          >
            <Network size={16} />
            代理
          </Button>
          <Button
            type="submit"
            className={tab === 'runtime' ? 'active' : ''}
            onClick={() => setTab('runtime')}
            data-dialog-initial-focus={tab === 'runtime' ? true : undefined}
          >
            <ServerCog size={16} />
            系统
          </Button>
        </nav>
        <div className="management-content">
          {loading ? (
            <div className="detail-loading">
              <LoaderCircle className="spin" size={18} />
              正在读取环境与项目设置
            </div>
          ) : error ? (
            <InlineError message={error} />
          ) : tab === 'environments' ? (
            <EnvironmentsSettings
              environments={environments}
              setEnvironments={setEnvironments}
              projects={projects}
              proxyEnabled={Boolean(proxy?.enabled)}
              onChanged={onProjectsChanged}
              initialSelectedSlug={selectedEnvironmentSlug}
            />
          ) : tab === 'projects' ? (
            <ProjectsSettings
              projects={projects}
              setProjects={setProjects}
              bindings={siteBindings}
              setBindings={setSiteBindings}
              environments={environments}
              selectedEnvironmentSlug={selectedEnvironmentSlug}
              autoSslEnabled={Boolean(systemSettings?.autoSslEnabled)}
              previewBaseDomain={previewBaseDomain}
              onChanged={onProjectsChanged}
            />
          ) : tab === 'runtime' && systemSettings ? (
            <SystemSettingsForm
              settings={systemSettings}
              environments={environments}
              selectedEnvironmentSlug={selectedEnvironmentSlug}
              onChange={setSystemSettings}
            />
          ) : proxy ? (
            <ProxySettingsForm settings={proxy} onChange={setProxy} />
          ) : null}
        </div>
      </section>
    </div>
  )
}

export function TargetRow({
  row,
  branchState,
  queueItems,
  selectedBranch,
  busy,
  environmentStatus,
  canBuild = true,
  onBranchChange,
  onBuild,
}: {
  row: MatrixRow
  branchState: BranchState
  queueItems: BuildQueueItem[]
  selectedBranch: string
  busy: boolean
  environmentStatus: EnvironmentStatus
  canBuild?: boolean
  onBranchChange: (branch: string) => void
  onBuild: () => void
}) {
  const selected = branchState.items.find((item) => item.branch === selectedBranch) || null
  const configured = row.target.configured
  const frozen = environmentStatus === 'FROZEN'
  const enabled = row.config.enabled && (frozen || row.target.enabled)
  const disabledReason = !configured
    ? '尚未配置 Git 仓库'
    : !row.config.enabled
      ? '项目在当前环境中已停用'
      : '项目总开关已关闭'

  return (
    <article className={`target-row ${enabled && configured ? '' : 'disabled-target'}`}>
      <div className="target-identity">
        <div className="target-name">
          <PackageCheck size={17} />
          <strong>{row.target.name}</strong>
        </div>
        <span className={`target-state ${enabled && configured ? 'available' : ''}`}>
          {enabled && configured ? (frozen ? '可预览' : '可用') : '不可用'}
        </span>
      </div>

      {enabled && configured ? (
        <>
          <label className="branch-control">
            <span>打包分支</span>
            <BranchPicker
              targetId={row.target.id}
              targetName={row.target.name}
              items={branchState.items}
              queueItems={queueItems}
              selectedBranch={selectedBranch}
              fallbackBranch={row.target.defaultBranch}
              officialLabel={row.target.kind === 'remote' ? '官方热更' : '官网页面'}
              onChange={onBranchChange}
            />
          </label>
          <div className="artifact-meta">
            <span>上次打包</span>
            <strong>{formatTime(selected?.latestArtifact?.builtAt)}</strong>
            {!branchState.remoteAvailable ? (
              <small>
                {frozen ? '冻结环境仅显示已有产物分支' : '远端分支查询失败，仍可使用已有产物'}
              </small>
            ) : null}
          </div>
          {canBuild ? (
            <div className="row-actions">
              <Button
                type="submit"
                className="secondary-button"
                onClick={onBuild}
                disabled={busy || !selectedBranch || environmentStatus !== 'ACTIVE'}
                title={
                  environmentStatus === 'FROZEN'
                    ? '环境已冻结，只能浏览已有产物'
                    : environmentStatus === 'ARCHIVED'
                      ? '环境已归档，不能发起构建'
                      : undefined
                }
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Hammer size={16} />}
                {busy ? '提交中' : '打最新包'}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="disabled-reason">{disabledReason}，不能发起新构建。</div>
      )}
    </article>
  )
}

function configurationGroupItemLabel(
  item: ConfigurationGroupItem,
  targetNames: ReadonlyMap<string, string>
): string {
  const targetName = targetNames.get(item.targetId) || item.targetId
  return item.mode === 'branch' ? `${targetName} · ${item.branch}` : `${targetName} · 官方版本`
}

export function ProjectVersionTabs({
  mode,
  onChange,
}: {
  mode: ProjectVersionMode
  onChange: (mode: ProjectVersionMode) => void
}) {
  const buttonRefs = useRef<Record<ProjectVersionMode, HTMLButtonElement | null>>({
    requirements: null,
    branches: null,
  })

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const nextMode = projectVersionModeFromKeyboard(mode, event.key)
    if (!nextMode) return
    event.preventDefault()
    onChange(nextMode)
    window.requestAnimationFrame(() => buttonRefs.current[nextMode]?.focus())
  }

  return (
    <nav className="version-mode-tabs" role="tablist" aria-label="项目版本查看方式">
      <Button
        ref={(element) => {
          buttonRefs.current.requirements = element
        }}
        id="version-mode-requirements"
        type="button"
        role="tab"
        tabIndex={mode === 'requirements' ? 0 : -1}
        aria-selected={mode === 'requirements'}
        aria-controls="version-panel-requirements"
        className={mode === 'requirements' ? 'active' : ''}
        onClick={() => onChange('requirements')}
        onKeyDown={handleKeyDown}
      >
        <Layers3 size={14} />
        按需求
      </Button>
      <Button
        ref={(element) => {
          buttonRefs.current.branches = element
        }}
        id="version-mode-branches"
        type="button"
        role="tab"
        tabIndex={mode === 'branches' ? 0 : -1}
        aria-selected={mode === 'branches'}
        aria-controls="version-panel-branches"
        className={mode === 'branches' ? 'active' : ''}
        onClick={() => onChange('branches')}
        onKeyDown={handleKeyDown}
      >
        <GitBranch size={14} />
        按分支
      </Button>
    </nav>
  )
}

export function ConfigurationGroupsView({
  groups,
  loading,
  error,
  environments,
  siteBindings,
  targetNames,
  deletingToken,
  canManage = true,
  onUse,
  onEdit,
  onCopy,
  onDelete,
  onRetry,
}: {
  groups: ConfigurationGroupRecord[]
  loading: boolean
  error: string
  environments: EnvironmentSettingsView[]
  siteBindings: SiteBinding[]
  targetNames: ReadonlyMap<string, string>
  deletingToken: string | null
  canManage?: boolean
  onUse: (group: ConfigurationGroupRecord) => void
  onEdit: (group: ConfigurationGroupRecord) => void
  onCopy: (group: ConfigurationGroupRecord) => void
  onDelete: (group: ConfigurationGroupRecord) => void
  onRetry: () => void
}) {
  const environmentNames = new Map(
    environments.map((environment) => [environment.slug, environment.name])
  )
  const siteNames = new Map(siteBindings.map((binding) => [binding.id, binding.name]))

  if (loading && !groups.length) {
    return (
      <div className="configuration-groups-state" role="status">
        <LoaderCircle className="spin" size={18} />
        <div>
          <strong>正在读取提测需求</strong>
          <span>正在加载所有人创建的分享配置</span>
        </div>
      </div>
    )
  }

  if (error && !groups.length) {
    return (
      <div className="configuration-groups-state error" role="alert">
        <CircleAlert size={18} />
        <div>
          <strong>提测需求读取失败</strong>
          <span>{error}</span>
        </div>
        <Button type="button" className="secondary-button" onClick={onRetry}>
          <RefreshCw size={14} />
          重试
        </Button>
      </div>
    )
  }

  if (!groups.length) {
    return (
      <div className="configuration-groups-state" role="status">
        <Layers3 size={18} />
        <div>
          <strong>还没有提测需求</strong>
          <span>使用右上角“新建需求”保存第一组环境与项目分支</span>
        </div>
      </div>
    )
  }

  const operationsBusy = Boolean(deletingToken)

  return (
    <div className="configuration-groups-view">
      {error ? (
        <div className="configuration-groups-stale-warning" role="alert">
          <CircleAlert size={14} />
          <span>刷新失败，当前展示上次加载的数据：{error}</span>
          <Button type="button" onClick={onRetry} disabled={loading || operationsBusy}>
            重试
          </Button>
        </div>
      ) : null}
      <section className="configuration-group-list" aria-label="所有提测需求">
        {groups.map((group) => {
          const sharePath = configurationGroupSharePath(group)
          const deleting = deletingToken === group.token
          const summaries = group.items.map((item) =>
            configurationGroupItemLabel(item, targetNames)
          )
          return (
            <article
              className={`configuration-group-card ${deleting ? 'deleting' : ''}`}
              key={group.token}
              aria-busy={deleting || undefined}
            >
              <a
                className="configuration-group-main"
                href={sharePath || undefined}
                target="_blank"
                rel="noreferrer"
                aria-disabled={operationsBusy || undefined}
                tabIndex={operationsBusy ? -1 : undefined}
                aria-label={`使用提测需求 ${group.name}`}
                onClick={(event) => {
                  if (!sharePath || operationsBusy) {
                    event.preventDefault()
                    return
                  }
                  onUse(group)
                }}
              >
                <header className="configuration-group-card-heading">
                  <div>
                    <strong title={group.name}>{group.name}</strong>
                    <span>#{group.token.slice(0, 8)}</span>
                  </div>
                  <span className="configuration-group-use-label">
                    使用
                    <ExternalLink size={12} />
                  </span>
                </header>
                <div className="configuration-group-context">
                  <span>
                    {environmentNames.get(group.environmentSlug) || group.environmentSlug}
                  </span>
                  <span>{siteNames.get(group.siteBindingId) || group.siteBindingId}</span>
                </div>
                <div className="configuration-group-items">
                  {summaries.slice(0, 6).map((summary, index) => (
                    <span key={`${group.token}-${group.items[index]?.targetId}`}>{summary}</span>
                  ))}
                  {summaries.length > 6 ? <span>另有 {summaries.length - 6} 个项目</span> : null}
                </div>
              </a>
              <footer className="configuration-group-footer">
                <div>
                  <strong>{group.createdBy}</strong>
                  <span>更新于 {formatFullTime(group.updatedAt || group.createdAt)}</span>
                </div>
                <div className="configuration-group-actions">
                  <Button
                    type="button"
                    onClick={() => onCopy(group)}
                    title="复制分享链接"
                    disabled={operationsBusy}
                  >
                    <Copy size={14} />
                    <span>复制</span>
                  </Button>
                  {canManage ? (
                    <Button
                      type="button"
                      onClick={() => onEdit(group)}
                      title="编辑配置组"
                      disabled={operationsBusy}
                    >
                      <Pencil size={14} />
                      <span>编辑</span>
                    </Button>
                  ) : null}
                  {canManage ? (
                    <Button
                      type="button"
                      className="danger-action"
                      onClick={() => onDelete(group)}
                      title={deleting ? '正在删除配置组' : '删除配置组'}
                      disabled={operationsBusy}
                    >
                      {deleting ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      <span>{deleting ? '删除中' : '删除'}</span>
                    </Button>
                  ) : null}
                </div>
              </footer>
            </article>
          )
        })}
      </section>
    </div>
  )
}

export function App({
  identity,
  authorization,
  authenticated = true,
  onLogout,
}: {
  identity: AuthIdentity
  authorization: PermissionContext
  authenticated?: boolean
  onLogout: () => Promise<void>
}) {
  const requirements = authorization.requirements || defaultAuthorizationPolicy().requirements
  const canManageSystem = hasPermission(authorization, requirements['system.read'])
  const canManagePermissions = hasPermission(authorization, PERMISSION_MANAGEMENT)
  const canBuild = hasPermission(authorization, requirements['build.create'])
  const canCancel = hasPermission(authorization, requirements['build.cancel'])
  const canManageShares = hasPermission(authorization, requirements['share.manage'])
  const [loggingOut, setLoggingOut] = useState(false)
  const [selectedEnvironmentSlug, setSelectedEnvironmentSlug] = useState(
    () => localStorage.getItem(ENVIRONMENT_STORAGE_KEY)?.trim() || ''
  )
  const [environments, setEnvironments] = useState<EnvironmentSettingsView[]>([])
  const [siteBindings, setSiteBindings] = useState<SiteBinding[]>([])
  const [selectedSiteId, setSelectedSiteId] = useState('')
  const [mainView, setMainView] = useState<MainView>('environment')
  const [projectVersionMode, setProjectVersionMode] = useState<ProjectVersionMode>(() =>
    projectVersionModeFromStorage(typeof window === 'undefined' ? null : window.localStorage)
  )
  const [matrix, setMatrix] = useState<EnvironmentMatrix | null>(null)
  const [branches, setBranches] = useState<Record<string, BranchState>>({})
  const [selectedBranches, setSelectedBranches] = useState<Record<string, string>>({})
  const [configurationGroups, setConfigurationGroups] = useState<ConfigurationGroupRecord[]>([])
  const [configurationGroupsLoading, setConfigurationGroupsLoading] = useState(false)
  const [configurationGroupsLoaded, setConfigurationGroupsLoaded] = useState(false)
  const [configurationGroupsError, setConfigurationGroupsError] = useState('')
  const [configurationEditorOpen, setConfigurationEditorOpen] = useState(false)
  const [editingConfigurationGroup, setEditingConfigurationGroup] =
    useState<ConfigurationGroupRecord | null>(null)
  const [deletingConfigurationGroupToken, setDeletingConfigurationGroupToken] = useState<
    string | null
  >(null)
  const [queue, setQueue] = useState<BuildQueueSnapshot>(emptyQueue)
  const [submittingTarget, setSubmittingTarget] = useState<string | null>(null)
  const [managementOpen, setManagementOpen] = useState(false)
  const [previewBaseDomain, setPreviewBaseDomain] = useState(DEFAULT_PREVIEW_BASE_DOMAIN)
  const [status, setStatus] = useState<StatusState>({ tone: 'idle', text: '正在连接 QA 环境' })
  const [historyJobs, setHistoryJobs] = useState<BuildJob[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyTargetId, setHistoryTargetId] = useState('')
  const [historyStatus, setHistoryStatus] = useState<BuildJobStatus | ''>('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(20)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyTotalPages, setHistoryTotalPages] = useState(0)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [jobDetail, setJobDetail] = useState<BuildJobDetail | null>(null)
  const [jobLog, setJobLog] = useState<BuildJobLogView | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)
  const [jobDetailError, setJobDetailError] = useState('')
  const [jobDetailTab, setJobDetailTab] = useState<JobDetailTab>('overview')
  const [logCopied, setLogCopied] = useState(false)
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null)
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null)
  const historyRequestId = useRef(0)
  const logRef = useRef<HTMLPreElement>(null)
  const queueSignaturesRef = useRef<Map<string, string>>(new Map())
  const dirtyBranchTargetsRef = useRef<Set<string>>(new Set())
  const coreRequestIdRef = useRef(0)
  const branchRequestIdRef = useRef(0)
  const configurationGroupsRequestIdRef = useRef(0)
  const configurationEditorReturnFocusRef = useRef<HTMLElement | null>(null)
  const deletingConfigurationGroupTokenRef = useRef<string | null>(null)

  const refreshEnvironmentDirectory = useCallback(async () => {
    try {
      const [environmentView, siteView] = await Promise.all([getEnvironments(), getSiteBindings()])
      setEnvironments(environmentView.items)
      setSiteBindings(siteView.items)
      const availableEnvironments = environmentView.items.filter(
        (environment) => environment.status !== 'ARCHIVED'
      )
      if (!availableEnvironments.some((item) => item.slug === selectedEnvironmentSlug)) {
        const fallback =
          availableEnvironments.find((item) => item.status === 'ACTIVE') || availableEnvironments[0]
        if (fallback) {
          localStorage.setItem(ENVIRONMENT_STORAGE_KEY, fallback.slug)
          setSelectedEnvironmentSlug(fallback.slug)
          setHistoryPage(1)
        } else {
          localStorage.removeItem(ENVIRONMENT_STORAGE_KEY)
          setSelectedEnvironmentSlug('')
          setHistoryPage(1)
          setStatus({ tone: 'warning', text: '暂无可用环境，请先在管理中创建或恢复环境' })
        }
      }
    } catch (error) {
      setStatus({ tone: 'warning', text: `环境目录读取失败：${errorMessage(error)}` })
    }
  }, [selectedEnvironmentSlug])

  useEffect(() => {
    void refreshEnvironmentDirectory()
  }, [refreshEnvironmentDirectory])

  const refreshConfigurationGroups = useCallback(async () => {
    const requestId = ++configurationGroupsRequestIdRef.current
    setConfigurationGroupsLoading(true)
    setConfigurationGroupsError('')
    try {
      const result = await getConfigurationGroups()
      if (requestId !== configurationGroupsRequestIdRef.current) return
      setConfigurationGroups(result.items)
      setConfigurationGroupsLoaded(true)
    } catch (error) {
      if (requestId !== configurationGroupsRequestIdRef.current) return
      setConfigurationGroupsError(errorMessage(error))
    } finally {
      if (requestId === configurationGroupsRequestIdRef.current) {
        setConfigurationGroupsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (mainView !== 'environment' || projectVersionMode !== 'requirements') return
    if (!configurationGroupsLoaded && !configurationGroupsLoading && !configurationGroupsError) {
      void refreshConfigurationGroups()
    }
  }, [
    configurationGroupsError,
    configurationGroupsLoaded,
    configurationGroupsLoading,
    mainView,
    projectVersionMode,
    refreshConfigurationGroups,
  ])

  const refreshCore = useCallback(
    async (quiet = false) => {
      if (!selectedEnvironmentSlug) return null
      const requestId = ++coreRequestIdRef.current
      try {
        const [nextMatrix, nextQueue, runtime] = await Promise.all([
          getMatrix(selectedEnvironmentSlug),
          getBuildQueue(),
          getPublicRuntimeSettings(),
        ])
        if (requestId !== coreRequestIdRef.current) return null
        setPreviewBaseDomain(runtime.previewBaseDomain || DEFAULT_PREVIEW_BASE_DOMAIN)
        setMatrix(nextMatrix)
        setQueue(nextQueue)
        setSelectedBranches((current) => {
          const next = { ...current }
          for (const row of nextMatrix.rows) {
            if (!Object.prototype.hasOwnProperty.call(next, row.target.id)) {
              next[row.target.id] = row.target.defaultBranch
            }
          }
          return next
        })
        if (!quiet) setStatus({ tone: 'idle', text: `${nextMatrix.environment.name} 已刷新` })
        return { matrix: nextMatrix, queue: nextQueue }
      } catch (error) {
        if (requestId === coreRequestIdRef.current) {
          setStatus({ tone: 'warning', text: errorMessage(error) })
        }
        return null
      }
    },
    [selectedEnvironmentSlug]
  )

  const refreshBranches = useCallback(
    async (nextMatrix: EnvironmentMatrix, targetIds?: ReadonlySet<string>) => {
      const requestId = branchRequestIdRef.current
      const rows = targetIds
        ? nextMatrix.rows.filter((row) => targetIds.has(row.target.id))
        : nextMatrix.rows
      const catalogs = await Promise.all(
        rows.map(async (row) => {
          const canBrowseExisting =
            row.config.enabled &&
            row.target.configured &&
            (nextMatrix.environment.status === 'FROZEN' || row.target.enabled)
          if (!canBrowseExisting) {
            return {
              targetId: row.target.id,
              catalog: { items: [], remoteAvailable: false } as BranchState,
              failed: false,
            }
          }
          try {
            return {
              targetId: row.target.id,
              catalog: await getBranches(row.target.id, nextMatrix.environment.slug),
              failed: false,
            }
          } catch {
            return { targetId: row.target.id, catalog: null, failed: true }
          }
        })
      )
      const successful = catalogs.filter(
        (result): result is typeof result & { catalog: BranchState; failed: false } =>
          !result.failed && result.catalog !== null
      )
      if (requestId !== branchRequestIdRef.current) return new Set<string>()
      const refreshedBranches = Object.fromEntries(
        successful.map((result) => [result.targetId, result.catalog])
      ) as Record<string, BranchState>
      setBranches((current) => {
        if (targetIds) return { ...current, ...refreshedBranches }
        const visibleTargets = new Set(nextMatrix.rows.map((row) => row.target.id))
        const preserved = Object.fromEntries(
          Object.entries(current).filter(([targetId]) => visibleTargets.has(targetId))
        )
        return { ...preserved, ...refreshedBranches }
      })
      setSelectedBranches((current) => {
        const next = { ...current }
        for (const row of rows.filter((candidate) => candidate.target.id in refreshedBranches)) {
          const catalog = refreshedBranches[row.target.id]?.items || []
          next[row.target.id] = selectedBranchAfterCatalogRefresh(
            next[row.target.id],
            catalog,
            row.target.defaultBranch
          )
        }
        return next
      })
      return new Set(catalogs.filter((result) => result.failed).map((result) => result.targetId))
    },
    []
  )

  const refreshAll = useCallback(
    async (quiet = false) => {
      const next = await refreshCore(quiet)
      if (next) {
        dirtyBranchTargetsRef.current = await refreshBranches(next.matrix)
        queueSignaturesRef.current = queueTargetSignatures(next.queue, next.matrix.environment.slug)
      }
    },
    [refreshBranches, refreshCore]
  )

  const refreshQueueAware = useCallback(
    async (quiet = true) => {
      const next = await refreshCore(quiet)
      if (!next) return
      const currentSignatures = queueTargetSignatures(next.queue, next.matrix.environment.slug)
      const affectedTargets = completedQueueTargets(queueSignaturesRef.current, currentSignatures)
      queueSignaturesRef.current = currentSignatures
      for (const targetId of affectedTargets) dirtyBranchTargetsRef.current.add(targetId)
      if (dirtyBranchTargetsRef.current.size) {
        const attempted = new Set(dirtyBranchTargetsRef.current)
        const failed = await refreshBranches(next.matrix, attempted)
        for (const targetId of attempted) dirtyBranchTargetsRef.current.delete(targetId)
        for (const targetId of failed) dirtyBranchTargetsRef.current.add(targetId)
      }
    },
    [refreshBranches, refreshCore]
  )

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      await refreshQueueAware(true)
      if (!stopped) timer = window.setTimeout(() => void poll(), 3000)
    }
    void refreshAll().finally(() => {
      if (!stopped) timer = window.setTimeout(() => void poll(), 3000)
    })
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refreshAll, refreshQueueAware])

  const loadHistory = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      if (!selectedEnvironmentSlug) {
        setHistoryJobs([])
        setHistoryTotal(0)
        setHistoryTotalPages(0)
        setHistoryLoading(false)
        return
      }
      const requestId = ++historyRequestId.current
      if (!quiet) setHistoryLoading(true)
      setHistoryError('')
      try {
        const result = await getBuildHistory({
          environmentSlug: selectedEnvironmentSlug,
          targetId: historyTargetId,
          status: historyStatus,
          query: historyQuery.trim(),
          page: historyPage,
          pageSize: historyPageSize,
        })
        if (requestId !== historyRequestId.current) return
        setHistoryJobs(result.items)
        setHistoryPage(result.page)
        setHistoryPageSize(result.pageSize)
        setHistoryTotal(result.total)
        setHistoryTotalPages(result.totalPages)
      } catch (error) {
        if (requestId === historyRequestId.current) setHistoryError(errorMessage(error))
      } finally {
        if (requestId === historyRequestId.current) setHistoryLoading(false)
      }
    },
    [
      historyPage,
      historyPageSize,
      historyQuery,
      historyStatus,
      historyTargetId,
      selectedEnvironmentSlug,
    ]
  )

  useEffect(() => {
    if (mainView !== 'history') return
    const initialTimer = window.setTimeout(() => void loadHistory(), historyQuery.trim() ? 220 : 0)
    const pollTimer =
      historyPage === 1
        ? window.setInterval(() => void loadHistory({ quiet: true }), 5000)
        : undefined
    return () => {
      window.clearTimeout(initialTimer)
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
    }
  }, [historyPage, historyQuery, loadHistory, mainView])

  useEffect(() => {
    if (!selectedJobId) return
    let stopped = false
    let timer: number | undefined

    setJobDetail(null)
    setJobLog(null)
    setJobDetailError('')
    setJobDetailLoading(true)

    const poll = async () => {
      try {
        const [nextDetail, nextLog] = await Promise.all([
          getBuildJobDetail(selectedJobId),
          getBuildJobLog(selectedJobId),
        ])
        if (stopped) return
        setJobDetail(nextDetail)
        setJobLog(nextLog)
        setJobDetailError('')
        setJobDetailLoading(false)
        if (!terminalBuildStatuses.has(nextDetail.job.status)) {
          timer = window.setTimeout(() => void poll(), 1500)
        }
      } catch (error) {
        if (stopped) return
        setJobDetailError(errorMessage(error))
        setJobDetailLoading(false)
        timer = window.setTimeout(() => void poll(), 3000)
      }
    }

    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [selectedJobId])

  useEffect(() => {
    if (!selectedJobId) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedJobId(null)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [selectedJobId])

  useEffect(() => {
    if (jobDetailTab === 'console' && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [jobDetailTab, jobLog?.content])

  const queueItems = [...queue.running, ...queue.queued]
  const selectableEnvironments = useMemo(
    () => environments.filter((environment) => environment.status !== 'ARCHIVED'),
    [environments]
  )
  const availableSites = useMemo(() => previewableSiteBindings(siteBindings), [siteBindings])
  const selectedSite =
    availableSites.find((binding) => binding.id === selectedSiteId) || availableSites[0] || null

  useEffect(() => {
    if (!availableSites.length) {
      setSelectedSiteId('')
      return
    }
    if (!availableSites.some((binding) => binding.id === selectedSiteId)) {
      setSelectedSiteId(availableSites[0]!.id)
    }
  }, [availableSites, selectedSiteId])

  function changeEnvironment(environmentSlug: string, preferredBranches?: Record<string, string>) {
    if (!environmentSlug) return
    if (environmentSlug === selectedEnvironmentSlug) {
      if (preferredBranches) {
        setSelectedBranches((current) => ({ ...current, ...preferredBranches }))
      }
      return
    }
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, environmentSlug)
    coreRequestIdRef.current += 1
    branchRequestIdRef.current += 1
    setSelectedEnvironmentSlug(environmentSlug)
    setHistoryPage(1)
    setMatrix(null)
    setBranches({})
    setSelectedBranches(preferredBranches ? { ...preferredBranches } : {})
    dirtyBranchTargetsRef.current.clear()
    queueSignaturesRef.current.clear()
    setStatus({ tone: 'busy', text: `正在切换到 ${environmentSlug}` })
  }

  const myRunning = queue.running.filter((item) => item.isMine)
  const myQueued = queue.queued.filter((item) => item.isMine)
  const queueSummary = myRunning.length
    ? `我的请求构建中${myRunning.length > 1 ? ` · ${myRunning.length} 个` : ''}`
    : myQueued.length
      ? `我的请求第 ${myQueued[0]?.queuePosition} 位${myQueued.length > 1 ? ` · 共 ${myQueued.length} 个` : ''}`
      : queue.running.length
        ? `忙碌 · ${queue.queued.length} 个等待`
        : queue.queued.length
          ? `${queue.queued.length} 个等待`
          : '空闲'

  const targetNames = useMemo(
    () => new Map(matrix?.rows.map((row) => [row.target.id, row.target.name]) || []),
    [matrix]
  )
  const environmentNames = useMemo(
    () => new Map(environments.map((environment) => [environment.slug, environment.name])),
    [environments]
  )
  const historyTargets = useMemo(
    () => matrix?.rows.map((row) => ({ id: row.target.id, name: row.target.name })) || [],
    [matrix]
  )
  const configurationEditorDefaults: ConfigurationGroupEditorDefaults = {
    environmentSlug: selectedEnvironmentSlug,
    siteBindingId: selectedSite?.id || '',
    selectedBranches,
  }
  const canCreateConfigurationGroup =
    canManageShares && configurationGroupDirectoryReady(environments, siteBindings)

  async function handleBuild(targetId: string) {
    const branch = selectedBranches[targetId]
    if (!branch) return
    if (!matrix || matrix.environment.status !== 'ACTIVE') {
      setStatus({
        tone: 'warning',
        text: `${matrix?.environment.name || selectedEnvironmentSlug} 当前不能发起构建`,
      })
      return
    }
    setSubmittingTarget(targetId)
    setStatus({ tone: 'busy', text: `${targetNames.get(targetId) || targetId} · 正在提交打包任务` })
    try {
      await createBuild(targetId, branch, selectedEnvironmentSlug)
      await refreshQueueAware(true)
      setStatus({ tone: 'busy', text: `${branch} · 已加入全局队列` })
    } catch (error) {
      setStatus({ tone: 'warning', text: errorMessage(error) })
    } finally {
      setSubmittingTarget(null)
    }
  }

  function changeProjectVersionMode(mode: ProjectVersionMode) {
    setProjectVersionMode(mode)
    try {
      localStorage.setItem(PROJECT_VERSION_MODE_STORAGE_KEY, mode)
    } catch {
      // The selected tab remains usable for this page even when storage is unavailable.
    }
  }

  function openConfigurationGroupEditor(group: ConfigurationGroupRecord | null) {
    if (!canManageShares) return
    configurationEditorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditingConfigurationGroup(group)
    setConfigurationEditorOpen(true)
  }

  function closeConfigurationGroupEditor() {
    setConfigurationEditorOpen(false)
    setEditingConfigurationGroup(null)
    const returnFocus = configurationEditorReturnFocusRef.current
    configurationEditorReturnFocusRef.current = null
    if (returnFocus?.isConnected) {
      window.requestAnimationFrame(() => returnFocus.focus())
    }
  }

  async function handleConfigurationGroupSaved(saved: ConfigurationGroupRecord) {
    const wasEditing = Boolean(editingConfigurationGroup)
    closeConfigurationGroupEditor()
    setConfigurationGroups((current) => {
      const index = current.findIndex((item) => item.token === saved.token)
      if (index < 0) return [saved, ...current]
      return current.map((item) => (item.token === saved.token ? saved : item))
    })
    setConfigurationGroupsLoaded(true)
    setStatus({
      tone: 'success',
      text: wasEditing ? `需求“${saved.name}”已更新` : `需求“${saved.name}”已创建`,
    })
    await refreshConfigurationGroups()
  }

  function handleUseConfigurationGroup(group: ConfigurationGroupRecord) {
    const preferredBranches = configurationGroupBranchSelection(group.items)
    if (group.environmentSlug === selectedEnvironmentSlug) {
      setSelectedBranches((current) => {
        const next = { ...current }
        for (const item of group.items) delete next[item.targetId]
        return { ...next, ...preferredBranches }
      })
    } else {
      changeEnvironment(group.environmentSlug, preferredBranches)
    }
    setSelectedSiteId(group.siteBindingId)
    setStatus({
      tone: 'success',
      text: `已切换到“${group.name}”，正在新标签页中应用`,
    })
  }

  async function handleCopyConfigurationGroup(group: ConfigurationGroupRecord) {
    const directUrl = configurationGroupDirectPreviewUrl(group, previewBaseDomain)
    const path = configurationGroupSharePath(group)
    if (!directUrl && !path) {
      setStatus({ tone: 'warning', text: '配置组链接无效，请刷新后重试' })
      return
    }
    try {
      await navigator.clipboard.writeText(directUrl || new URL(path, window.location.origin).href)
      setStatus({ tone: 'success', text: `已复制“${group.name}”的分享链接` })
    } catch {
      setStatus({ tone: 'warning', text: '浏览器没有允许复制链接' })
    }
  }

  async function handleDeleteConfigurationGroup(group: ConfigurationGroupRecord) {
    if (deletingConfigurationGroupTokenRef.current) return
    if (!window.confirm(`删除提测需求“${group.name}”？已有分享链接将立即失效。`)) return
    deletingConfigurationGroupTokenRef.current = group.token
    setDeletingConfigurationGroupToken(group.token)
    setStatus({ tone: 'busy', text: `正在删除“${group.name}”` })
    try {
      await deleteConfigurationGroup(group.token)
      setConfigurationGroups((current) => current.filter((item) => item.token !== group.token))
      setStatus({ tone: 'success', text: `提测需求“${group.name}”已删除` })
    } catch (error) {
      setStatus({ tone: 'warning', text: `删除失败：${errorMessage(error)}` })
    } finally {
      if (deletingConfigurationGroupTokenRef.current === group.token) {
        deletingConfigurationGroupTokenRef.current = null
        setDeletingConfigurationGroupToken(null)
      }
    }
  }

  async function handleCopyLog() {
    if (!jobLog?.content) return
    try {
      await navigator.clipboard.writeText(jobLog.content)
      setLogCopied(true)
      window.setTimeout(() => setLogCopied(false), 1600)
    } catch {
      setJobDetailError('浏览器没有允许复制日志，请使用下载按钮')
    }
  }

  async function handleCancelJob() {
    const job = jobDetail?.job
    if (!job || terminalBuildStatuses.has(job.status) || job.status === 'CANCELING') return
    setCancelingJobId(job.id)
    setJobDetailError('')
    try {
      const canceled = await cancelBuildJob(job.id)
      setJobDetail((current) => (current ? { ...current, job: canceled } : current))
      setStatus({
        tone: canceled.status === 'CANCELED' ? 'success' : 'busy',
        text: canceled.status === 'CANCELED' ? '构建已取消' : '已提交中断请求',
      })
      await Promise.all([refreshQueueAware(true), loadHistory({ quiet: true })])
    } catch (error) {
      setJobDetailError(errorMessage(error))
    } finally {
      setCancelingJobId(null)
    }
  }

  async function handleRetryJob() {
    const job = jobDetail?.job
    const environmentSlug = jobEnvironmentSlug(job)
    if (!job || job.status !== 'FAILED' || !environmentSlug || retryingJobId) return
    setRetryingJobId(job.id)
    setJobDetailError('')
    setStatus({ tone: 'busy', text: `${job.branch} · 正在重新提交打包任务` })
    try {
      const retried = await createBuild(job.targetId, job.branch, environmentSlug)
      openJob(retried.id)
      setStatus({ tone: 'success', text: `${job.branch} · 已重新加入全局队列` })
      await Promise.all([refreshQueueAware(true), loadHistory({ quiet: true })])
    } catch (error) {
      setJobDetailError(errorMessage(error))
      setStatus({ tone: 'warning', text: errorMessage(error) })
    } finally {
      setRetryingJobId(null)
    }
  }

  function openJob(jobId: string) {
    setJobDetailTab('overview')
    setLogCopied(false)
    setSelectedJobId(jobId)
  }

  function closeJob() {
    setSelectedJobId(null)
    setJobDetail(null)
    setJobLog(null)
    setJobDetailError('')
  }

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await onLogout()
    } catch (error) {
      setStatus({ tone: 'warning', text: `退出失败：${errorMessage(error)}` })
      setLoggingOut(false)
    }
  }

  const contextSelectors = (
    <div className="version-context-controls" aria-label="环境与端">
      <label className="environment-switcher">
        <span>环境</span>
        <ComboBox
          value={selectedEnvironmentSlug}
          onChange={(event) => changeEnvironment(event.target.value)}
          aria-label="当前环境"
          disabled={!selectableEnvironments.length}
        >
          {!selectableEnvironments.some(
            (environment) => environment.slug === selectedEnvironmentSlug
          ) ? (
            <option value={selectedEnvironmentSlug}>
              {selectedEnvironmentSlug || (environments.length ? '暂无可用环境' : '正在读取环境')}
            </option>
          ) : null}
          {selectableEnvironments.map((environment) => (
            <option value={environment.slug} key={environment.slug}>
              {environment.name}
              {environment.status === 'FROZEN' ? ' · 冻结' : ''}
              {environment.status === 'ARCHIVED' ? ' · 归档' : ''}
            </option>
          ))}
        </ComboBox>
      </label>
      <label className="site-switcher">
        <span>端</span>
        <ComboBox
          value={selectedSite?.id || ''}
          onChange={(event) => setSelectedSiteId(event.target.value)}
          aria-label="要打开的站点"
          disabled={!availableSites.length}
        >
          {!availableSites.length ? <option value="">暂无可用端</option> : null}
          {availableSites.map((binding) => (
            <option value={binding.id} key={binding.id}>
              {binding.name}
            </option>
          ))}
        </ComboBox>
      </label>
      {selectedSite ? (
        <a
          className="icon-button"
          href={environmentSiteUrl(selectedSite)}
          target="_blank"
          rel="noreferrer"
          title={`打开 ${selectedSite.name}`}
        >
          <ExternalLink size={17} />
        </a>
      ) : null}
    </div>
  )

  const mainViewTabs = (
    <nav className="main-view-tabs" aria-label="控制台视图">
      <Button
        type="button"
        className={mainView === 'environment' ? 'active' : ''}
        onClick={() => setMainView('environment')}
      >
        <Network size={15} />
        项目版本
      </Button>
      <Button
        type="button"
        className={mainView === 'history' ? 'active' : ''}
        onClick={() => setMainView('history')}
      >
        <History size={15} />
        构建记录
      </Button>
    </nav>
  )

  return (
    <main className="app-page">
      <section className="console-surface">
        <header className="toolbar">
          <div className="environment-title">
            <h1 className="product-title">{PRODUCT_NAME}</h1>
            <span className="environment-meta">
              {matrix ? environmentStatusLabel(matrix.environment.status) : '正在读取环境'}
            </span>
          </div>
          <div className="toolbar-actions">
            <details
              className="session-menu"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  event.currentTarget.removeAttribute('open')
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.currentTarget.removeAttribute('open')
                  event.currentTarget.querySelector<HTMLElement>('summary')?.focus()
                }
              }}
            >
              <summary
                className="session-menu-trigger"
                title={`已登录：${identity.name}`}
                aria-label={`已登录：${identity.name}`}
              >
                {identity.avatarUrl ? (
                  <img src={identity.avatarUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="session-avatar-fallback" aria-hidden="true">
                    <UserRound size={15} />
                  </span>
                )}
                <span className="session-name">{identity.name}</span>
              </summary>
              <div className="session-menu-panel">
                <div className="session-account">
                  <span>Bifrost 账号</span>
                  <strong>{identity.name}</strong>
                  <span>{authorization.permissionLevel} 级权限</span>
                </div>
                {authenticated && (
                  <a className="permissions-menu-link" href="/settings/profile">
                    个人设置
                  </a>
                )}
                {authenticated && (
                  <a className="permissions-menu-link" href="/settings/mcp">
                    MCP 接入
                  </a>
                )}
                {canManagePermissions ? (
                  <a className="permissions-menu-link" href="/permissions">
                    权限与用户
                  </a>
                ) : null}
                {authenticated ? (
                  <Button
                    type="button"
                    className="session-logout"
                    onClick={() => void handleLogout()}
                    disabled={loggingOut}
                  >
                    {loggingOut ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <LogOut size={15} />
                    )}
                    {loggingOut ? '正在退出' : '退出登录'}
                  </Button>
                ) : (
                  <a className="permissions-menu-link" href="/api/v1/auth/feishu/start">
                    使用飞书登录
                  </a>
                )}
              </div>
            </details>
            <Button
              type="submit"
              className="icon-button"
              onClick={() => void refreshAll()}
              title="刷新环境"
            >
              <RefreshCw size={17} />
            </Button>
            {canManageSystem ? (
              <Button
                type="button"
                className="icon-button"
                onClick={() => setManagementOpen(true)}
                title="环境与项目设置"
              >
                <Settings size={17} />
              </Button>
            ) : null}
          </div>
        </header>

        {mainView === 'environment' ? (
          <>
            <div className="version-mode-toolbar">
              <div className="version-mode-main">
                {mainViewTabs}
                <ProjectVersionTabs mode={projectVersionMode} onChange={changeProjectVersionMode} />
                {contextSelectors}
              </div>
              {projectVersionMode === 'requirements' ? (
                <div className="version-mode-actions">
                  <Button
                    type="button"
                    className="icon-button"
                    onClick={() => void refreshConfigurationGroups()}
                    disabled={
                      configurationGroupsLoading || Boolean(deletingConfigurationGroupToken)
                    }
                    title="刷新提测需求"
                  >
                    <RefreshCw
                      className={configurationGroupsLoading ? 'spin' : undefined}
                      size={15}
                    />
                  </Button>
                  {canManageShares ? (
                    <Button
                      type="button"
                      className="secondary-button"
                      onClick={() => openConfigurationGroupEditor(null)}
                      disabled={
                        !canCreateConfigurationGroup || Boolean(deletingConfigurationGroupToken)
                      }
                      title={!canCreateConfigurationGroup ? '环境与站点目录尚未就绪' : undefined}
                    >
                      <Share2 size={14} />
                      新建需求
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <section className="build-queue" aria-label="打包机队列">
              <div className="queue-heading">
                <div className="queue-title">
                  <ListOrdered size={16} />
                  <strong>打包机队列</strong>
                </div>
                <span
                  className={
                    myRunning.length || myQueued.length
                      ? 'queue-summary mine-summary'
                      : 'queue-summary'
                  }
                >
                  {queueSummary}
                </span>
              </div>
              {queueItems.length ? (
                <div className="queue-list">
                  {queueItems.map((item) => (
                    <QueueRow
                      item={item}
                      targetName={targetNames.get(item.targetId) || item.targetId}
                      environmentName={
                        environmentNames.get(jobEnvironmentSlug(item) || '') ||
                        jobEnvironmentSlug(item) ||
                        '环境未记录'
                      }
                      key={item.id}
                      onOpen={() => openJob(item.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="queue-empty">
                  <Clock3 size={14} />
                  当前没有打包任务
                </div>
              )}
            </section>

            {projectVersionMode === 'requirements' ? (
              <div
                id="version-panel-requirements"
                className="version-mode-panel"
                role="tabpanel"
                aria-labelledby="version-mode-requirements"
              >
                <ConfigurationGroupsView
                  groups={configurationGroups}
                  loading={configurationGroupsLoading}
                  error={configurationGroupsError}
                  environments={environments}
                  siteBindings={siteBindings}
                  targetNames={targetNames}
                  deletingToken={deletingConfigurationGroupToken}
                  canManage={canManageShares}
                  onUse={handleUseConfigurationGroup}
                  onEdit={(group) => openConfigurationGroupEditor(group)}
                  onCopy={(group) => void handleCopyConfigurationGroup(group)}
                  onDelete={(group) => void handleDeleteConfigurationGroup(group)}
                  onRetry={() => void refreshConfigurationGroups()}
                />
              </div>
            ) : (
              <section
                id="version-panel-branches"
                className="target-list version-mode-panel"
                role="tabpanel"
                aria-labelledby="version-mode-branches"
              >
                {matrix?.rows.map((row) => (
                  <TargetRow
                    key={row.target.id}
                    row={row}
                    branchState={branches[row.target.id] || { items: [], remoteAvailable: false }}
                    queueItems={queueItems.filter(
                      (item) =>
                        item.targetId === row.target.id &&
                        item.environmentSlug === selectedEnvironmentSlug
                    )}
                    selectedBranch={selectedBranches[row.target.id] ?? row.target.defaultBranch}
                    busy={submittingTarget === row.target.id}
                    canBuild={canBuild}
                    environmentStatus={matrix.environment.status}
                    onBranchChange={(branch) =>
                      setSelectedBranches((current) => ({ ...current, [row.target.id]: branch }))
                    }
                    onBuild={() => void handleBuild(row.target.id)}
                  />
                ))}
              </section>
            )}
          </>
        ) : (
          <BuildHistoryView
            navigation={
              <>
                {mainViewTabs}
                {contextSelectors}
              </>
            }
            jobs={historyJobs}
            loading={historyLoading}
            error={historyError}
            targetId={historyTargetId}
            status={historyStatus}
            query={historyQuery}
            targets={historyTargets}
            environmentNames={environmentNames}
            page={historyPage}
            pageSize={historyPageSize}
            total={historyTotal}
            totalPages={historyTotalPages}
            onTargetChange={(value) => {
              setHistoryTargetId(value)
              setHistoryPage(1)
            }}
            onStatusChange={(value) => {
              setHistoryStatus(value)
              setHistoryPage(1)
            }}
            onQueryChange={(value) => {
              setHistoryQuery(value)
              setHistoryPage(1)
            }}
            onRefresh={() => void loadHistory()}
            onPageChange={setHistoryPage}
            onPageSizeChange={(value) => {
              setHistoryPageSize(value)
              setHistoryPage(1)
            }}
            onOpen={openJob}
          />
        )}

        <div className={`status-bar status-${status.tone}`} role="status">
          <div className="status-message">
            {status.tone === 'busy' ? (
              <LoaderCircle className="spin" size={14} />
            ) : status.tone === 'warning' ? (
              <CircleAlert size={14} />
            ) : status.tone === 'success' ? (
              <Check size={14} />
            ) : (
              <ShieldCheck size={14} />
            )}
            <span>{status.text}</span>
          </div>
          <span className="cakedesign-credit" aria-hidden="true">
            Proudly Crafted With CakeDesign.
          </span>
        </div>
      </section>
      {managementOpen && canManageSystem ? (
        <ManagementPanel
          onClose={() => setManagementOpen(false)}
          onProjectsChanged={() => {
            void Promise.all([refreshEnvironmentDirectory(), refreshAll(true)])
          }}
          selectedEnvironmentSlug={selectedEnvironmentSlug}
          previewBaseDomain={previewBaseDomain}
        />
      ) : null}
      {configurationEditorOpen && canManageShares ? (
        <ConfigurationGroupEditor
          group={editingConfigurationGroup}
          defaults={configurationEditorDefaults}
          environments={environments}
          siteBindings={siteBindings}
          queueItems={queueItems}
          previewBaseDomain={previewBaseDomain}
          onClose={closeConfigurationGroupEditor}
          onSaved={(group) => void handleConfigurationGroupSaved(group)}
        />
      ) : null}
      {selectedJobId ? (
        <JobDetailPanel
          detail={jobDetail}
          log={jobLog}
          loading={jobDetailLoading}
          error={jobDetailError}
          tab={jobDetailTab}
          copied={logCopied}
          logRef={logRef}
          targetName={
            jobDetail ? targetNames.get(jobDetail.job.targetId) || jobDetail.job.targetId : ''
          }
          canceling={cancelingJobId === selectedJobId}
          retrying={retryingJobId === selectedJobId}
          canCancel={canCancel}
          canRetry={canBuild}
          onTabChange={setJobDetailTab}
          onCancel={() => void handleCancelJob()}
          onRetry={() => void handleRetryJob()}
          onCopy={() => void handleCopyLog()}
          onClose={closeJob}
        />
      ) : null}
    </main>
  )
}
