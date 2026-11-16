import { createUiElement, setUiClass, initializeCakeUI } from './cakeui-dom.js'
import {
  createBranchPicker,
  describeBranchBuild,
  endedQueueTargetIds,
  flattenBuildQueue,
  prepareTargetBranchItems,
} from './branch-picker.js'
import {
  createPreviewRequest,
  mergeSelectedBranches,
  planPreviewApplication,
  previewDestinationUrl,
  resolveSelectedArtifacts,
  SITE_BINDING_REQUIRED,
} from './preview-routing.js'
import {
  APPLY_CONFIGURATION_GROUP_COMMAND,
  APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
  APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
  extensionCommandErrorMessage,
  REMOVE_PREVIEW_TRANSACTION_COMMAND,
  requireExtensionCapabilities,
} from './extension-protocol.js'
import { chooseBindingCandidate, normalizeBindingCandidates } from './binding-selection.js'
import {
  chooseEnvironment,
  environmentClassForUrl,
  environmentForUrl,
  environmentOptionLabel,
  normalizeEnvironments,
  readTabEnvironmentPreference,
  TAB_ENVIRONMENT_PREFS_KEY,
  writeTabEnvironmentPreference,
} from './environment-selection.js'
import { authenticatedRequestInit, feishuLoginUrl, normalizeAuthSession } from './auth-session.js'
import {
  buildJobPresentation,
  buildQueueSummary,
  isBuildSubmissionLocked,
  orderedBuildQueue,
  replaceBuildQueueJob,
  shouldPollBuildJob,
  TERMINAL_BUILD_STATUSES,
} from './build-queue.js'
import {
  BUILD_HISTORY_PAGE_SIZES,
  BUILD_HISTORY_STATUSES,
  buildHistoryPageNumbers,
  buildHistoryQuery,
  normalizeBuildHistoryPage,
} from './build-history.js'
import {
  chooseRestoredPopupState,
  operationMatchesContext,
  READ_POPUP_SCOPED_STATE_COMMAND,
  WRITE_POPUP_SCOPED_STATE_COMMAND,
} from './popup-state.js'
import {
  canonicalConfigurationGroupUrlPrefix,
  configurationGroupFingerprint,
  configurationGroupItems,
  configurationGroupShareDisplayUrl,
  configurationGroupUrlPrefixError,
  normalizedConfigurationGroupUrlPrefix,
} from './config-share.js'
import {
  configurationGroupBranchSummary,
  configurationGroupUpdateInput,
  isConfigurationGroupRevisionConflict,
  normalizeConfigurationGroup,
  normalizeConfigurationGroups,
  normalizeProjectVersionTab,
  PROJECT_VERSION_TAB_KEY,
  projectVersionTabForKey,
} from './configuration-groups.js'
import { normalizePopupTab, popupTabForKey } from './popup-tabs.js'
import {
  inPlaceRuleEnvironment,
  matchInPlaceUrlRule,
  normalizeInPlaceUrlRules,
} from './in-place-url-rules.js'

initializeCakeUI()

const extensionManifest = chrome.runtime.getManifest()
const productName = extensionManifest.short_name || extensionManifest.name
const pcInPlaceOnly = globalThis.BIFROST_PC_PLUGIN === true
document.documentElement.classList.toggle('pc-plugin', pcInPlaceOnly)
document.title = extensionManifest.name

const CONTROL_KEY = 'cuddly.controlOrigin'
const ACTIVE_KEY = 'cuddly.activePreviews'
const ENVIRONMENT_PREFS_KEY = 'cuddly.environmentByOfficialOrigin'
const DEFAULT_CONTROL_ORIGIN = 'https://bifrost.vanillacake.cn'
const BUILD_QUEUE_POLL_MS = 2_500
const BUILD_HISTORY_QUERY_DEBOUNCE_MS = 300
const TTTT_REMOTE_SOURCE_BRANCH = '__cuddly_source_tttt__'
const LEGACY_TTTT_PAGE_ROUTE_BRANCH = '__cuddly_route_tttt__'
const emptyQueue = { running: [], queued: [] }

const state = {
  tab: null,
  controlOrigin: DEFAULT_CONTROL_ORIGIN,
  previewBaseDomain: new URL(DEFAULT_CONTROL_ORIGIN).hostname,
  authenticated: false,
  guest: false,
  authLoading: true,
  authHint: '正在检查登录状态',
  loggingOut: false,
  identity: null,
  csrfToken: '',
  binding: null,
  environmentPreferences: {},
  tabEnvironmentPreferences: {},
  environments: [],
  environment: null,
  environmentChanging: false,
  inPlaceUrlRules: [],
  inPlaceRule: null,
  inPlaceRuleError: '',
  targets: [],
  targetNames: {},
  siteTargetId: null,
  siteOverrideEnabled: false,
  branches: {},
  selectedBranches: {},
  active: null,
  busyTargets: new Map(),
  submittedBuildBranches: {},
  applyingToken: null,
  sharing: false,
  shareResult: null,
  workspaceTab: 'projects',
  buildTaskTab: 'queue',
  projectVersionTab: 'branches',
  configurationGroups: [],
  configurationGroupsLoading: true,
  configurationGroupsError: '',
  configurationGroupActionToken: null,
  editingConfigurationGroup: null,
  deletingConfigurationGroup: null,
  cancelingJobs: new Set(),
  retryingJobs: new Set(),
  dirtyCatalogTargets: new Set(),
  queue: emptyQueue,
  queueLastSuccessAt: null,
  queueRefreshError: '',
  buildHistory: normalizeBuildHistoryPage(null),
  buildHistoryTargetId: '',
  buildHistoryStatus: '',
  buildHistoryQuery: '',
  buildHistoryLoading: false,
  buildHistoryError: '',
  buildHistoryDirty: true,
  buildHistoryEnvironmentSlug: '',
  selectedJobId: null,
  jobDetail: null,
  jobLog: null,
  jobDetailTab: 'overview',
  jobDetailError: '',
  jobDetailRefreshError: '',
  jobDetailLoading: false,
  jobLogFollow: true,
  jobLogScrollTop: 0,
  jobDetailScrollTop: 0,
}

const elements = {
  pageTitle: document.querySelector('#page-title'),
  pageMeta: document.querySelector('#page-meta'),
  identityPanel: document.querySelector('#identity-panel'),
  identityAvatar: document.querySelector('#identity-avatar'),
  identityAvatarFallback: document.querySelector('#identity-avatar-fallback'),
  identityName: document.querySelector('#identity-name'),
  logoutButton: document.querySelector('#logout-button'),
  authGate: document.querySelector('#auth-gate'),
  authGateHint: document.querySelector('#auth-gate-hint'),
  loginButton: document.querySelector('#login-button'),
  workspaceTabs: document.querySelector('#workspace-tabs'),
  projectsTab: document.querySelector('#projects-tab'),
  queueTab: document.querySelector('#queue-tab'),
  queueTabCount: document.querySelector('#queue-tab-count'),
  projectsPanel: document.querySelector('#projects-panel'),
  projectVersionTabs: document.querySelector('#project-version-tabs'),
  requirementsTab: document.querySelector('#requirements-tab'),
  branchesTab: document.querySelector('#branches-tab'),
  requirementsPanel: document.querySelector('#requirements-panel'),
  branchesPanel: document.querySelector('#branches-panel'),
  requirementsSummary: document.querySelector('#requirements-summary'),
  requirementsRefresh: document.querySelector('#requirements-refresh'),
  requirementsList: document.querySelector('#requirements-list'),
  shareButton: document.querySelector('#share-button'),
  shareDialog: document.querySelector('#share-dialog'),
  shareForm: document.querySelector('#share-form'),
  shareClose: document.querySelector('#share-close'),
  shareCancel: document.querySelector('#share-cancel'),
  shareName: document.querySelector('#share-name'),
  shareUrlPrefix: document.querySelector('#share-url-prefix'),
  shareUrlHint: document.querySelector('#share-url-hint'),
  shareContext: document.querySelector('#share-context'),
  shareCaveat: document.querySelector('#share-caveat'),
  shareResultField: document.querySelector('#share-result-field'),
  shareResult: document.querySelector('#share-result'),
  shareSubmit: document.querySelector('#share-submit'),
  configurationGroupEditDialog: document.querySelector('#configuration-group-edit-dialog'),
  configurationGroupEditForm: document.querySelector('#configuration-group-edit-form'),
  configurationGroupEditClose: document.querySelector('#configuration-group-edit-close'),
  configurationGroupEditCancel: document.querySelector('#configuration-group-edit-cancel'),
  configurationGroupEditName: document.querySelector('#configuration-group-edit-name'),
  configurationGroupEditContext: document.querySelector('#configuration-group-edit-context'),
  configurationGroupOverwrite: document.querySelector('#configuration-group-overwrite'),
  configurationGroupOverwriteHint: document.querySelector('#configuration-group-overwrite-hint'),
  configurationGroupEditSubmit: document.querySelector('#configuration-group-edit-submit'),
  configurationGroupDeleteDialog: document.querySelector('#configuration-group-delete-dialog'),
  configurationGroupDeleteForm: document.querySelector('#configuration-group-delete-form'),
  configurationGroupDeleteClose: document.querySelector('#configuration-group-delete-close'),
  configurationGroupDeleteCancel: document.querySelector('#configuration-group-delete-cancel'),
  configurationGroupDeleteCopy: document.querySelector('#configuration-group-delete-copy'),
  configurationGroupDeleteSubmit: document.querySelector('#configuration-group-delete-submit'),
  configurationGroupSiteDialog: document.querySelector('#configuration-group-site-dialog'),
  configurationGroupSiteForm: document.querySelector('#configuration-group-site-form'),
  configurationGroupSiteClose: document.querySelector('#configuration-group-site-close'),
  configurationGroupSiteCancel: document.querySelector('#configuration-group-site-cancel'),
  configurationGroupSiteRemote: document.querySelector('#configuration-group-site-remote'),
  configurationGroupSiteCurrent: document.querySelector('#configuration-group-site-current'),
  configurationGroupSiteTarget: document.querySelector('#configuration-group-site-target'),
  refreshButton: document.querySelector('#refresh-button'),
  settingsButton: document.querySelector('#settings-button'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  settingsCancel: document.querySelector('#settings-cancel'),
  settingsClose: document.querySelector('#settings-close'),
  controlOrigin: document.querySelector('#control-origin'),
  environmentBar: document.querySelector('#environment-bar'),
  environmentSelect: document.querySelector('#environment-select'),
  environmentHint: document.querySelector('#environment-hint'),
  activePanel: document.querySelector('#active-panel'),
  activeTitle: document.querySelector('#active-title'),
  activeSummary: document.querySelector('#active-summary'),
  removeButton: document.querySelector('#remove-button'),
  moduleList: document.querySelector('#module-list'),
  queuePanel: document.querySelector('#queue-panel'),
  buildQueueTab: document.querySelector('#build-queue-tab'),
  buildHistoryTab: document.querySelector('#build-history-tab'),
  buildQueuePanel: document.querySelector('#build-queue-panel'),
  buildHistoryPanel: document.querySelector('#build-history-panel'),
  queueSummary: document.querySelector('#queue-summary'),
  queueList: document.querySelector('#queue-list'),
  buildHistorySummary: document.querySelector('#build-history-summary'),
  buildHistoryRefresh: document.querySelector('#build-history-refresh'),
  buildHistoryTarget: document.querySelector('#build-history-target'),
  buildHistoryStatus: document.querySelector('#build-history-status'),
  buildHistoryQuery: document.querySelector('#build-history-query'),
  buildHistoryList: document.querySelector('#build-history-list'),
  buildHistoryTotal: document.querySelector('#build-history-total'),
  buildHistoryPageSize: document.querySelector('#build-history-page-size'),
  buildHistoryPrevious: document.querySelector('#build-history-previous'),
  buildHistoryPage: document.querySelector('#build-history-page'),
  buildHistoryNext: document.querySelector('#build-history-next'),
  selectionSummary: document.querySelector('#selection-summary'),
  applyButton: document.querySelector('#apply-button'),
  applyButtonWrap: document.querySelector('#apply-button-wrap'),
  statusBar: document.querySelector('#status-bar'),
  statusText: document.querySelector('#status-text'),
  extensionVersion: document.querySelector('#extension-version'),
  branchPickerDropdown: document.querySelector('#branch-picker-dropdown'),
  jobDetailDialog: document.querySelector('#job-detail-dialog'),
  jobDetailTitle: document.querySelector('#job-detail-title'),
  jobDetailContext: document.querySelector('#job-detail-context'),
  jobDetailClose: document.querySelector('#job-detail-close'),
  jobOverviewTab: document.querySelector('#job-overview-tab'),
  jobLogTab: document.querySelector('#job-log-tab'),
  jobDetailContent: document.querySelector('#job-detail-content'),
  jobDetailRefreshHint: document.querySelector('#job-detail-refresh-hint'),
  jobDetailRetry: document.querySelector('#job-detail-retry'),
  jobDetailCancel: document.querySelector('#job-detail-cancel'),
}

const branchPicker = createBranchPicker(elements.branchPickerDropdown)
let queuePollTimer = null
let queuePollRunning = false
let buildHistoryQueryTimer = null
let loadGeneration = 0
let jobDetailGeneration = 0
let configurationGroupsGeneration = 0
let buildHistoryGeneration = 0
let configurationGroupSiteChoiceResolve = null

function setStatus(text, tone = '') {
  const message = typeof text === 'string' ? text : String(text ?? '')
  elements.statusText.textContent = message
  if (message) {
    elements.statusText.title = message
  } else {
    elements.statusText.removeAttribute('title')
  }
  setUiClass(elements.statusBar, `status-bar ${tone}`.trim())
}

function renderAuthentication() {
  const authenticated = state.authenticated && state.identity && state.csrfToken
  elements.authGate.hidden = Boolean(authenticated)
  elements.workspaceTabs.hidden = !authenticated
  elements.identityPanel.hidden = !authenticated
  elements.shareButton.hidden = !authenticated
  elements.refreshButton.hidden = !authenticated
  elements.loginButton.disabled = state.authLoading
  elements.authGateHint.textContent = state.authHint

  if (authenticated) {
    const { name, avatarUrl } = state.identity
    elements.identityName.textContent = name
    elements.identityAvatarFallback.textContent = name.slice(0, 1)
    elements.identityPanel.title = `当前操作人：${name}`
    elements.logoutButton.disabled = state.loggingOut
    elements.logoutButton.hidden = pcInPlaceOnly && state.guest
    elements.logoutButton.textContent = state.loggingOut ? '退出中' : '退出'
    elements.identityAvatar.hidden = !avatarUrl
    elements.identityAvatarFallback.hidden = Boolean(avatarUrl)
    if (avatarUrl) elements.identityAvatar.src = avatarUrl
  } else {
    elements.identityName.textContent = ''
    elements.identityPanel.removeAttribute('title')
    elements.identityAvatar.hidden = true
    elements.identityAvatar.removeAttribute('src')
    elements.identityAvatarFallback.hidden = false
    elements.identityAvatarFallback.textContent = ''
    elements.logoutButton.hidden = false
    elements.projectsPanel.hidden = true
    elements.queuePanel.hidden = true
    branchPicker.close({ restoreFocus: false })
    if (elements.configurationGroupEditDialog.open) elements.configurationGroupEditDialog.close()
    if (elements.configurationGroupDeleteDialog.open)
      elements.configurationGroupDeleteDialog.close()
    if (elements.configurationGroupSiteDialog.open) finishConfigurationGroupSiteChoice('cancel')
  }
  setWorkspaceTab(state.workspaceTab)
}

function setAuthenticatedSession(session) {
  state.authenticated = true
  state.authLoading = false
  state.authHint = ''
  state.guest = session.guest === true
  state.identity = session.identity
  state.csrfToken = session.csrfToken
  renderAuthentication()
}

function expireAuthentication(message = '登录已过期，请重新登录') {
  state.authenticated = false
  state.authLoading = false
  state.authHint = '登录后可查看项目版本和构建队列'
  state.loggingOut = false
  state.guest = false
  state.identity = null
  state.csrfToken = ''
  state.inPlaceUrlRules = []
  state.inPlaceRule = null
  state.inPlaceRuleError = ''
  if (queuePollTimer !== null) {
    window.clearTimeout(queuePollTimer)
    queuePollTimer = null
  }
  if (elements.shareDialog.open) elements.shareDialog.close()
  closeJobDetail()
  invalidateBuildHistory()
  renderAuthentication()
  setStatus(message, 'warning')
}

async function readAuthSession(controlOrigin) {
  const response = await fetch(
    `${controlOrigin.replace(/\/$/, '')}/api/v1/auth/session`,
    authenticatedRequestInit({ cache: 'no-store' })
  )
  const body = await response.json().catch(() => null)
  if (response.status === 401) return null
  if (!response.ok) {
    const error = new Error(`登录状态接口返回 HTTP ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  const session = normalizeAuthSession(body)
  if (!session) throw new Error('登录状态接口返回了无效身份')
  return session
}

async function startFeishuLogin() {
  if (state.authLoading) return
  state.authLoading = true
  state.authHint = '正在打开飞书登录页'
  renderAuthentication()
  try {
    await chrome.tabs.create({ url: feishuLoginUrl(state.controlOrigin) })
    state.authHint = '登录完成后重新打开扩展即可继续'
    setStatus('已在新标签页打开飞书登录', 'success')
  } catch (error) {
    state.authHint = '无法打开登录页，请重试'
    setStatus(`打开登录页失败：${errorText(error)}`, 'warning')
  } finally {
    state.authLoading = false
    renderAuthentication()
  }
}

async function logout() {
  if (!state.authenticated || state.loggingOut) return
  state.loggingOut = true
  renderAuthentication()
  setStatus('正在退出飞书登录', 'busy')
  try {
    await api('/api/v1/auth/logout', { method: 'POST' })
    expireAuthentication('已退出登录')
  } catch (error) {
    if (!state.authenticated) return
    state.loggingOut = false
    renderAuthentication()
    setStatus(`退出失败：${errorText(error)}`, 'warning')
  }
}

function setWorkspaceTab(nextTab, { focus = false } = {}) {
  const tab = normalizePopupTab(nextTab)
  state.workspaceTab = tab
  const projectsActive = tab === 'projects'
  elements.projectsTab.classList.toggle('active', projectsActive)
  elements.projectsTab.setAttribute('aria-selected', String(projectsActive))
  elements.projectsTab.tabIndex = projectsActive ? 0 : -1
  elements.projectsPanel.hidden = !state.authenticated || !projectsActive
  elements.queueTab.classList.toggle('active', !projectsActive)
  elements.queueTab.setAttribute('aria-selected', String(!projectsActive))
  elements.queueTab.tabIndex = projectsActive ? -1 : 0
  elements.queuePanel.hidden = !state.authenticated || projectsActive
  branchPicker.close({ restoreFocus: false })
  setProjectVersionTab(state.projectVersionTab)
  setBuildTaskTab(state.buildTaskTab)
  if (focus) (projectsActive ? elements.projectsTab : elements.queueTab).focus()
}

function handleWorkspaceTabKey(event) {
  const nextTab = popupTabForKey(state.workspaceTab, event.key)
  if (nextTab === state.workspaceTab && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  setWorkspaceTab(nextTab, { focus: true })
  if (nextTab === 'queue' && state.buildTaskTab === 'history') void refreshBuildHistory()
}

function setBuildTaskTab(nextTab, { focus = false, refresh = false } = {}) {
  const tab = nextTab === 'history' ? 'history' : 'queue'
  state.buildTaskTab = tab
  const historyActive = tab === 'history'
  elements.buildQueueTab.classList.toggle('active', !historyActive)
  elements.buildQueueTab.setAttribute('aria-selected', String(!historyActive))
  elements.buildQueueTab.tabIndex = historyActive ? -1 : 0
  elements.buildQueuePanel.hidden = historyActive
  elements.buildHistoryTab.classList.toggle('active', historyActive)
  elements.buildHistoryTab.setAttribute('aria-selected', String(historyActive))
  elements.buildHistoryTab.tabIndex = historyActive ? 0 : -1
  elements.buildHistoryPanel.hidden = !historyActive
  if (focus) (historyActive ? elements.buildHistoryTab : elements.buildQueueTab).focus()
  if (historyActive && refresh && state.workspaceTab === 'queue') {
    void refreshBuildHistory()
  }
}

function handleBuildTaskTabKey(event) {
  let nextTab = state.buildTaskTab
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    nextTab = event.key === 'ArrowLeft' || event.key === 'Home' ? 'queue' : 'history'
  }
  if (nextTab === state.buildTaskTab && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  setBuildTaskTab(nextTab, { focus: true, refresh: true })
}

function setProjectVersionTab(nextTab, { focus = false, persist = false } = {}) {
  const tab = normalizeProjectVersionTab(nextTab)
  state.projectVersionTab = tab
  const requirementsActive = tab === 'requirements'
  elements.requirementsTab.classList.toggle('active', requirementsActive)
  elements.requirementsTab.setAttribute('aria-selected', String(requirementsActive))
  elements.requirementsTab.tabIndex = requirementsActive ? 0 : -1
  elements.requirementsPanel.hidden = !requirementsActive
  elements.branchesTab.classList.toggle('active', !requirementsActive)
  elements.branchesTab.setAttribute('aria-selected', String(!requirementsActive))
  elements.branchesTab.tabIndex = requirementsActive ? -1 : 0
  elements.branchesPanel.hidden = requirementsActive
  branchPicker.close({ restoreFocus: false })
  if (persist) {
    void chrome.storage.local.set({ [PROJECT_VERSION_TAB_KEY]: tab }).catch(() => undefined)
  }
  if (focus) (requirementsActive ? elements.requirementsTab : elements.branchesTab).focus()
}

function handleProjectVersionTabKey(event) {
  const nextTab = projectVersionTabForKey(state.projectVersionTab, event.key)
  if (nextTab === state.projectVersionTab && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  setProjectVersionTab(nextTab, { focus: true, persist: true })
}

function formatTime(value) {
  if (!value) return '尚未打包'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function errorText(error) {
  if (error?.body?.message) return error.body.message
  return error instanceof Error ? error.message : String(error)
}

async function apiWithContext(context, pathname, init) {
  const response = await fetch(
    `${context.controlOrigin.replace(/\/$/, '')}${pathname}`,
    authenticatedRequestInit(init, context.csrfToken)
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(`${productName} 返回 HTTP ${response.status}`)
    error.status = response.status
    error.body = body
    if (response.status === 401 && context.controlOrigin === state.controlOrigin) {
      expireAuthentication()
    }
    throw error
  }
  return body
}

async function api(pathname, init) {
  return apiWithContext(
    { controlOrigin: state.controlOrigin, csrfToken: state.csrfToken },
    pathname,
    init
  )
}

async function ensureOriginPermission(origin) {
  const permission = { origins: [`${new URL(origin).origin}/*`] }
  if (await chrome.permissions.contains(permission)) return
  const granted = await chrome.permissions.request(permission)
  if (!granted) throw new Error(`没有获得 ${new URL(origin).origin} 的页面访问权限`)
}

async function readPersistedPopupState(tabId, bindingId, environmentSlug) {
  const response = await chrome.runtime.sendMessage({
    type: READ_POPUP_SCOPED_STATE_COMMAND,
    tabId,
    bindingId,
    environmentSlug,
  })
  if (!response?.ok) {
    throw new Error(response?.message || '扩展后台无法读取分支选择')
  }
  return response.state || null
}

function persistPopupState({
  tabId,
  bindingId,
  environmentSlug,
  selectedBranches,
  submittedBuildBranches,
  siteOverrideEnabled,
}) {
  try {
    // Send immediately: the service worker owns the write lifecycle and can finish after the
    // popup document closes. Delaying sendMessage behind a popup-local promise loses that guarantee.
    return chrome.runtime
      .sendMessage({
        type: WRITE_POPUP_SCOPED_STATE_COMMAND,
        tabId,
        bindingId,
        environmentSlug,
        selectedBranches,
        submittedBuildBranches,
        siteOverrideEnabled,
      })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.message || '扩展后台无法保存分支选择')
      })
      .catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

function persistCurrentPopupState() {
  const tabId = state.tab?.id
  const bindingId = state.binding?.id
  const environmentSlug = state.environment?.slug
  if (!Number.isInteger(tabId) || !bindingId || !environmentSlug) return Promise.resolve()
  return persistPopupState({
    tabId,
    bindingId,
    environmentSlug,
    selectedBranches: { ...state.selectedBranches },
    submittedBuildBranches: { ...state.submittedBuildBranches },
    siteOverrideEnabled: state.siteOverrideEnabled,
  })
}

function selectedOfficialOrigin() {
  try {
    return state.binding?.officialOrigin ? new URL(state.binding.officialOrigin).origin : ''
  } catch {
    return ''
  }
}

async function persistEnvironmentSelection(environmentSlug, { rememberGlobally = true } = {}) {
  const tabId = state.tab?.id
  const officialOrigin = selectedOfficialOrigin()
  if (!Number.isInteger(tabId) || !officialOrigin || !environmentSlug) return
  state.tabEnvironmentPreferences = writeTabEnvironmentPreference(state.tabEnvironmentPreferences, {
    tabId,
    officialOrigin,
    environmentSlug,
  })
  if (rememberGlobally) {
    state.environmentPreferences = {
      ...state.environmentPreferences,
      [officialOrigin]: environmentSlug,
    }
  }
  await chrome.storage.local.set({
    [TAB_ENVIRONMENT_PREFS_KEY]: state.tabEnvironmentPreferences,
    ...(rememberGlobally ? { [ENVIRONMENT_PREFS_KEY]: state.environmentPreferences } : {}),
  })
}

function currentOperationContext(targetId = '', branch = '') {
  return {
    tabId: state.tab?.id,
    bindingId: state.binding?.id || '',
    environmentSlug: state.environment?.slug || '',
    targetId,
    branch,
    contextVersion: loadGeneration,
  }
}

async function optionalApi(pathname) {
  try {
    return await api(pathname)
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

function branchForArtifact(targetId, artifactId) {
  if (!artifactId) return ''
  return (
    state.branches[targetId]?.items?.find((item) => item.latestArtifact?.id === artifactId)
      ?.branch || ''
  )
}

function selectedArtifacts() {
  const selectedBranches = Object.fromEntries(
    Object.entries(state.selectedBranches).map(([targetId, branch]) => [
      targetId,
      isTtttRemoteSourceBranch(branch) ? '' : branch,
    ])
  )
  return resolveSelectedArtifacts({
    targets: state.targets,
    selectedBranches,
    branchCatalogs: state.branches,
    siteTargetId: state.siteTargetId,
    siteOverrideEnabled: state.siteOverrideEnabled && !state.inPlaceRule,
  })
}

function effectiveSelectedBranches() {
  const next = { ...state.selectedBranches }
  if (state.siteTargetId && (!state.siteOverrideEnabled || state.inPlaceRule)) {
    next[state.siteTargetId] = ''
  }
  for (const [targetId, branch] of Object.entries(next)) {
    if (isTtttRemoteSourceBranch(branch)) next[targetId] = ''
  }
  return next
}

function currentConfigurationGroupSnapshot() {
  const items = configurationGroupItems(state.targets, effectiveSelectedBranches())
  return {
    bindingId: state.binding?.id || '',
    environmentSlug: state.environment?.slug || '',
    items,
    fingerprint: configurationGroupFingerprint({
      bindingId: state.binding?.id || '',
      environmentSlug: state.environment?.slug || '',
      items,
    }),
  }
}

function selectedSourceOverrides() {
  if (!isLocalhostTab()) return []
  return state.targets.flatMap((target) =>
    target.id !== state.siteTargetId && isTtttRemoteSourceBranch(state.selectedBranches[target.id])
      ? [{ moduleKey: target.id, source: 'tttt' }]
      : []
  )
}

function shareUnavailableReason() {
  if (!state.binding || !state.environment) return '当前标签页还没有关联可分享的站点与环境'
  if (state.environment.status === 'ARCHIVED') return '归档环境不能创建新的配置组'
  const expectedTargetIds = new Set([
    state.binding.targetId,
    ...(state.binding.remoteTargetIds || []),
  ])
  const actualTargetIds = new Set(state.targets.map((target) => target.id))
  if (
    expectedTargetIds.size !== actualTargetIds.size ||
    [...expectedTargetIds].some((targetId) => !actualTargetIds.has(targetId))
  ) {
    return '站点项目尚未完整加载，刷新后再分享'
  }
  return ''
}

function renderShareButton() {
  const reason = shareUnavailableReason()
  elements.shareButton.disabled = Boolean(reason || state.sharing)
  elements.shareButton.title = reason || '创建并复制当前环境与全部项目分支的配置组链接'
}

function renderShareDialog() {
  const snapshot = currentConfigurationGroupSnapshot()
  const urlPrefix = normalizedConfigurationGroupUrlPrefix(elements.shareUrlPrefix.value)
  const canonicalUrlPrefix = canonicalConfigurationGroupUrlPrefix(urlPrefix)
  const urlPrefixError = configurationGroupUrlPrefixError(urlPrefix)
  const branchCount = snapshot.items.filter((item) => item.mode === 'branch').length
  const officialCount = snapshot.items.length - branchCount
  elements.shareContext.textContent = `${state.environment?.name || snapshot.environmentSlug || '当前环境'} · ${snapshot.items.length} 个项目 · ${branchCount} 个指定分支`
  elements.shareCaveat.textContent = officialCount
    ? `${officialCount} 个项目会跟随 KOOK 官网版本；指定分支仅在该分支产生新的成功包后变化。`
    : '所有项目均固定跟随所选分支；只有分支产生新的成功包后，重新打开链接才会变化。'
  const resultIsCurrent =
    state.shareResult?.fingerprint === snapshot.fingerprint &&
    state.shareResult?.name === elements.shareName.value.trim() &&
    state.shareResult?.urlPrefix === urlPrefix
  elements.shareResultField.hidden = !resultIsCurrent
  elements.shareResult.value = resultIsCurrent ? state.shareResult.url : ''
  elements.shareName.disabled = state.sharing
  elements.shareUrlPrefix.disabled = state.sharing
  elements.shareUrlPrefix.setCustomValidity(urlPrefixError)
  elements.shareUrlPrefix.setAttribute('aria-invalid', String(Boolean(urlPrefixError)))
  elements.shareUrlHint.classList.toggle('invalid', Boolean(urlPrefixError))
  elements.shareUrlHint.textContent = urlPrefixError
    ? urlPrefixError
    : urlPrefix
      ? canonicalUrlPrefix === urlPrefix
        ? `https://${canonicalUrlPrefix}.${state.previewBaseDomain}`
        : `显示地址：https://${urlPrefix}.${state.previewBaseDomain} · 实际地址：https://${canonicalUrlPrefix}.${state.previewBaseDomain}`
      : '留空时由系统生成不可猜测的独立地址'
  elements.shareSubmit.disabled =
    state.sharing || !elements.shareName.value.trim() || Boolean(urlPrefixError)
  elements.shareSubmit.textContent = state.sharing
    ? '创建中'
    : resultIsCurrent
      ? '复制链接'
      : '创建并复制'
}

function openShareDialog() {
  const reason = shareUnavailableReason()
  if (reason) {
    setStatus(reason, 'warning')
    return
  }
  const snapshot = currentConfigurationGroupSnapshot()
  if (state.shareResult && state.shareResult.fingerprint !== snapshot.fingerprint) {
    state.shareResult = null
    elements.shareName.value = ''
    elements.shareUrlPrefix.value = ''
  }
  renderShareDialog()
  if (!elements.shareDialog.open) elements.shareDialog.showModal()
  if (elements.shareResultField.hidden) elements.shareName.focus()
  else elements.shareResult.select()
}

async function copyShareUrl(url) {
  try {
    await navigator.clipboard.writeText(url)
    return
  } catch {
    elements.shareResult.value = url
    elements.shareResultField.hidden = false
    elements.shareResult.focus()
    elements.shareResult.select()
    if (!document.execCommand('copy')) {
      throw new Error('浏览器没有允许自动复制，请手动复制输入框中的链接')
    }
  }
}

async function shareConfiguration(event) {
  event.preventDefault()
  if (state.sharing) return
  const reason = shareUnavailableReason()
  if (reason) {
    setStatus(reason, 'warning')
    return
  }
  const name = elements.shareName.value.trim()
  const urlPrefix = normalizedConfigurationGroupUrlPrefix(elements.shareUrlPrefix.value)
  const urlPrefixError = configurationGroupUrlPrefixError(urlPrefix)
  if (!name) {
    elements.shareName.focus()
    return
  }
  if (urlPrefixError) {
    elements.shareUrlPrefix.focus()
    return
  }
  const snapshot = currentConfigurationGroupSnapshot()
  if (
    state.shareResult?.fingerprint === snapshot.fingerprint &&
    state.shareResult?.name === name &&
    state.shareResult?.urlPrefix === urlPrefix
  ) {
    try {
      await copyShareUrl(state.shareResult.url)
      setStatus(`已复制配置组「${name}」`, 'success')
    } catch (error) {
      setStatus(errorText(error), 'warning')
    }
    return
  }

  state.sharing = true
  renderShareButton()
  renderShareDialog()
  setStatus(`正在创建配置组「${name}」`, 'busy')
  let created = false
  try {
    const group = await api('/api/v1/config-groups', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        name,
        ...(urlPrefix ? { urlPrefix } : {}),
        environmentSlug: snapshot.environmentSlug,
        siteBindingId: snapshot.bindingId,
        items: snapshot.items,
      }),
    })
    const url = configurationGroupShareDisplayUrl(state.controlOrigin, group, urlPrefix)
    state.shareResult = {
      name,
      url,
      token: group.token,
      fingerprint: snapshot.fingerprint,
      urlPrefix,
    }
    created = true
    await copyShareUrl(url)
    setStatus(`配置组「${name}」已创建并复制`, 'success')
  } catch (error) {
    setStatus(`分享失败：${errorText(error)}`, 'warning')
  } finally {
    if (created) await refreshConfigurationGroups()
    state.sharing = false
    renderShareButton()
    renderShareDialog()
  }
}

function configurationGroupEnvironmentName(slug) {
  const environment = state.environments.find((candidate) => candidate.slug === slug)
  return environment?.name || slug
}

function renderConfigurationGroupState(message, { retry = false } = {}) {
  const stateView = createUiElement('div')
  setUiClass(stateView, 'requirement-state')
  const copy = createUiElement('span')
  copy.textContent = message
  stateView.append(copy)
  if (retry) {
    const button = createUiElement('button')
    setUiClass(button, 'text-button')
    button.type = 'button'
    button.textContent = '重新读取'
    button.addEventListener('click', () => void refreshConfigurationGroups())
    stateView.append(button)
  }
  elements.requirementsList.append(stateView)
}

function renderConfigurationGroups() {
  elements.requirementsList.replaceChildren()
  elements.requirementsList.setAttribute(
    'aria-busy',
    String(Boolean(state.configurationGroupsLoading))
  )
  elements.requirementsRefresh.disabled =
    state.configurationGroupsLoading || Boolean(state.configurationGroupActionToken)

  if (state.configurationGroupsLoading) {
    elements.requirementsSummary.textContent = '正在读取'
    const loading = createUiElement('div')
    setUiClass(loading, 'requirement-state')
    const spinner = createUiElement('span')
    setUiClass(spinner, 'module-loading-spinner')
    spinner.setAttribute('aria-hidden', 'true')
    const label = createUiElement('span')
    label.textContent = '正在读取所有提测需求'
    loading.append(spinner, label)
    elements.requirementsList.append(loading)
    return
  }
  if (state.configurationGroupsError) {
    elements.requirementsSummary.textContent = '读取失败'
    renderConfigurationGroupState(state.configurationGroupsError, { retry: true })
    return
  }
  elements.requirementsSummary.textContent = `${state.configurationGroups.length} 个需求 · 按创建时间倒序`
  if (!state.configurationGroups.length) {
    renderConfigurationGroupState('还没有人创建提测需求，请先在“按分支”中选好版本后分享。')
    return
  }

  const fragment = document.createDocumentFragment()
  for (const group of state.configurationGroups) {
    const actionBusy = state.configurationGroupActionToken === group.token
    const anotherActionBusy =
      Boolean(state.configurationGroupActionToken) &&
      state.configurationGroupActionToken !== group.token
    const row = createUiElement('article')
    setUiClass(row, 'requirement-row')

    const use = createUiElement('button')
    setUiClass(use, 'requirement-use')
    use.type = 'button'
    use.disabled = actionBusy || anotherActionBusy
    use.setAttribute('aria-label', `使用需求 ${group.name}`)
    use.addEventListener('click', () => void applyConfigurationGroup(group))

    const titleLine = createUiElement('span')
    setUiClass(titleLine, 'requirement-title-line')
    const title = createUiElement('strong')
    title.textContent = actionBusy ? `${group.name} · 处理中` : group.name
    title.title = group.name
    const environment = createUiElement('span')
    setUiClass(environment, 'requirement-environment')
    environment.textContent = configurationGroupEnvironmentName(group.environmentSlug)
    titleLine.append(title, environment)

    const branches = createUiElement('span')
    setUiClass(branches, 'requirement-branches')
    branches.textContent = configurationGroupBranchSummary(group, state.targetNames)
    branches.title = branches.textContent

    const meta = createUiElement('span')
    setUiClass(meta, 'requirement-meta')
    const creator = group.createdBy || '未知操作人'
    meta.textContent = `${creator} · ${formatTime(group.createdAt)} · ${group.siteBindingId}`
    meta.title = `由 ${creator} 创建于 ${fullTime(group.createdAt)}；最后更新 ${fullTime(group.updatedAt || group.createdAt)}`
    use.append(titleLine, branches, meta)

    const actions = createUiElement('span')
    setUiClass(actions, 'requirement-actions')
    const action = (label, handler, className = '') => {
      const button = createUiElement('button')
      setUiClass(button, `requirement-action ${className}`.trim())
      button.type = 'button'
      button.textContent = label
      button.disabled = actionBusy || anotherActionBusy
      button.setAttribute('aria-label', `${label}需求 ${group.name}`)
      button.addEventListener('click', handler)
      return button
    }
    actions.append(
      action('复制', () => void copyConfigurationGroup(group)),
      action('编辑', () => openConfigurationGroupEdit(group)),
      action('删除', () => openConfigurationGroupDelete(group), 'danger-text')
    )
    row.append(use, actions)
    fragment.append(row)
  }
  elements.requirementsList.append(fragment)
}

async function refreshConfigurationGroups() {
  if (!state.authenticated) return
  const generation = ++configurationGroupsGeneration
  state.configurationGroupsLoading = true
  state.configurationGroupsError = ''
  renderConfigurationGroups()
  try {
    const body = await api('/api/v1/config-groups')
    if (generation !== configurationGroupsGeneration) return
    state.configurationGroups = normalizeConfigurationGroups(body)
  } catch (error) {
    if (generation !== configurationGroupsGeneration) return
    state.configurationGroupsError = errorText(error)
  } finally {
    if (generation === configurationGroupsGeneration) {
      state.configurationGroupsLoading = false
      renderConfigurationGroups()
    }
  }
}

async function copyConfigurationGroup(group) {
  try {
    const url = configurationGroupShareDisplayUrl(state.controlOrigin, group)
    await copyShareUrl(url)
    setStatus(`已复制需求「${group.name}」的分享链接`, 'success')
  } catch (error) {
    setStatus(`复制失败：${errorText(error)}`, 'warning')
  }
}

function finishConfigurationGroupSiteChoice(choice = 'cancel') {
  const resolve = configurationGroupSiteChoiceResolve
  configurationGroupSiteChoiceResolve = null
  if (elements.configurationGroupSiteDialog.open) elements.configurationGroupSiteDialog.close()
  if (resolve) resolve(choice)
}

function chooseConfigurationGroupSiteMode(confirmation) {
  const currentBranch =
    typeof confirmation?.currentBranch === 'string' && confirmation.currentBranch.trim()
      ? confirmation.currentBranch.trim().slice(0, 80)
      : '官方原版'
  const targetBranch =
    typeof confirmation?.targetBranch === 'string' && confirmation.targetBranch.trim()
      ? confirmation.targetBranch.trim().slice(0, 240)
      : '指定分支'
  elements.configurationGroupSiteCurrent.textContent = currentBranch
  elements.configurationGroupSiteTarget.textContent = targetBranch
  elements.configurationGroupSiteTarget.title = targetBranch
  if (!elements.configurationGroupSiteDialog.open) {
    elements.configurationGroupSiteDialog.showModal()
  }
  elements.configurationGroupSiteCancel.focus()
  return new Promise((resolve) => {
    configurationGroupSiteChoiceResolve = resolve
  })
}

async function applyConfigurationGroup(group) {
  if (state.configurationGroupActionToken || !Number.isInteger(state.tab?.id)) return
  state.configurationGroupActionToken = group.token
  renderConfigurationGroups()
  setStatus(`正在使用需求「${group.name}」`, 'busy')
  try {
    await requireExtensionCapabilities((message) => chrome.runtime.sendMessage(message))
    if (state.inPlaceRule && state.tab?.url) {
      await ensureOriginPermission(new URL(state.tab.url).origin)
    }
    let applicationMode = ''
    let confirmedSiteBranch = ''
    let response
    while (true) {
      response = await chrome.runtime.sendMessage({
        type: APPLY_CONFIGURATION_GROUP_COMMAND,
        tabId: state.tab.id,
        token: group.token,
        ...(applicationMode ? { applicationMode, confirmedSiteBranch } : {}),
      })
      if (response?.ok) break
      if (
        response?.code === 'CONFIG_GROUP_SITE_OVERRIDE_CONFIRMATION_REQUIRED' &&
        response.confirmation
      ) {
        const choice = await chooseConfigurationGroupSiteMode(response.confirmation)
        if (choice === 'cancel') {
          setStatus(`已取消应用需求「${group.name}」`)
          return
        }
        applicationMode = choice
        confirmedSiteBranch = response.confirmation.targetBranch
        setStatus(
          choice === 'remote-only'
            ? `正在仅应用需求「${group.name}」的热更版本`
            : `正在完整应用需求「${group.name}」`,
          'busy'
        )
        continue
      }
      const message = extensionCommandErrorMessage(response, '需求应用失败')
      if (response?.selectionPersisted) await load().catch(() => undefined)
      throw new Error(message)
    }
    state.active = response.active || null
    renderActive()
    const appliedInPlace = applicationMode === 'remote-only' || response.active?.mode === 'remote'
    setStatus(
      pcInPlaceOnly || appliedInPlace
        ? `需求「${group.name}」的热更版本已应用，正在刷新 KOOK`
        : `需求「${group.name}」已应用，正在打开预览站点`,
      'success'
    )
  } catch (error) {
    setStatus(`需求应用失败：${errorText(error)}`, 'warning')
  } finally {
    if (state.configurationGroupActionToken === group.token) {
      state.configurationGroupActionToken = null
      renderConfigurationGroups()
    }
  }
}

function overwriteCurrentConfigurationReason() {
  return shareUnavailableReason()
}

function renderConfigurationGroupEditDialog() {
  const group = state.editingConfigurationGroup
  if (!group) return
  const reason = overwriteCurrentConfigurationReason()
  const snapshot = currentConfigurationGroupSnapshot()
  const busy = state.configurationGroupActionToken === group.token
  elements.configurationGroupEditContext.textContent = `${configurationGroupEnvironmentName(group.environmentSlug)} · 修订 ${group.revision} · 链接保持不变`
  elements.configurationGroupOverwrite.disabled = Boolean(reason || busy)
  if (reason) elements.configurationGroupOverwrite.checked = false
  elements.configurationGroupOverwriteHint.textContent = reason
    ? reason
    : `可替换为 ${state.environment?.name || snapshot.environmentSlug} 的 ${snapshot.items.length} 个项目选择`
  elements.configurationGroupEditName.disabled = busy
  elements.configurationGroupEditSubmit.disabled =
    busy || !elements.configurationGroupEditName.value.trim()
  elements.configurationGroupEditSubmit.textContent = busy ? '保存中' : '保存'
}

function openConfigurationGroupEdit(group) {
  state.editingConfigurationGroup = group
  elements.configurationGroupEditName.value = group.name
  elements.configurationGroupOverwrite.checked = false
  renderConfigurationGroupEditDialog()
  if (!elements.configurationGroupEditDialog.open) elements.configurationGroupEditDialog.showModal()
  elements.configurationGroupEditName.focus()
  elements.configurationGroupEditName.select()
}

function closeConfigurationGroupEdit() {
  if (state.editingConfigurationGroup && state.configurationGroupActionToken) return
  state.editingConfigurationGroup = null
  if (elements.configurationGroupEditDialog.open) elements.configurationGroupEditDialog.close()
}

async function updateConfigurationGroup(event) {
  event.preventDefault()
  const group = state.editingConfigurationGroup
  if (!group || state.configurationGroupActionToken) return
  const snapshot = elements.configurationGroupOverwrite.checked
    ? currentConfigurationGroupSnapshot()
    : null
  let body
  try {
    body = configurationGroupUpdateInput(group, {
      name: elements.configurationGroupEditName.value,
      snapshot,
    })
  } catch (error) {
    setStatus(errorText(error), 'warning')
    return
  }

  state.configurationGroupActionToken = group.token
  renderConfigurationGroupEditDialog()
  renderConfigurationGroups()
  setStatus(`正在保存需求「${group.name}」`, 'busy')
  try {
    await api(`/api/v1/config-groups/${encodeURIComponent(group.token)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    state.configurationGroupActionToken = null
    state.editingConfigurationGroup = null
    elements.configurationGroupEditDialog.close()
    await refreshConfigurationGroups()
    setStatus(`需求「${body.name}」已更新`, 'success')
  } catch (error) {
    state.configurationGroupActionToken = null
    if (isConfigurationGroupRevisionConflict(error)) {
      state.editingConfigurationGroup = null
      elements.configurationGroupEditDialog.close()
      await refreshConfigurationGroups()
      setStatus('需求已被其他人修改，请刷新后重新编辑', 'warning')
    } else {
      renderConfigurationGroupEditDialog()
      setStatus(`保存失败：${errorText(error)}`, 'warning')
    }
  } finally {
    renderConfigurationGroups()
  }
}

function renderConfigurationGroupDeleteDialog() {
  const group = state.deletingConfigurationGroup
  if (!group) return
  const busy = state.configurationGroupActionToken === group.token
  elements.configurationGroupDeleteCopy.textContent = `确认删除「${group.name}」？所有人将无法再通过原链接使用它；已经应用的标签页会继续服役至本次预览到期。`
  elements.configurationGroupDeleteSubmit.disabled = busy
  elements.configurationGroupDeleteSubmit.textContent = busy ? '删除中' : '确认删除'
}

function openConfigurationGroupDelete(group) {
  state.deletingConfigurationGroup = group
  renderConfigurationGroupDeleteDialog()
  if (!elements.configurationGroupDeleteDialog.open)
    elements.configurationGroupDeleteDialog.showModal()
  elements.configurationGroupDeleteCancel.focus()
}

function closeConfigurationGroupDelete() {
  if (state.deletingConfigurationGroup && state.configurationGroupActionToken) return
  state.deletingConfigurationGroup = null
  if (elements.configurationGroupDeleteDialog.open) elements.configurationGroupDeleteDialog.close()
}

async function deleteConfigurationGroup(event) {
  event.preventDefault()
  const group = state.deletingConfigurationGroup
  if (!group || state.configurationGroupActionToken) return
  state.configurationGroupActionToken = group.token
  renderConfigurationGroupDeleteDialog()
  renderConfigurationGroups()
  setStatus(`正在删除需求「${group.name}」`, 'busy')
  try {
    await api(`/api/v1/config-groups/${encodeURIComponent(group.token)}`, { method: 'DELETE' })
    state.configurationGroupActionToken = null
    state.deletingConfigurationGroup = null
    elements.configurationGroupDeleteDialog.close()
    await refreshConfigurationGroups()
    setStatus(`需求「${group.name}」已删除`, 'success')
  } catch (error) {
    state.configurationGroupActionToken = null
    renderConfigurationGroupDeleteDialog()
    setStatus(`删除失败：${errorText(error)}`, 'warning')
  } finally {
    renderConfigurationGroups()
  }
}

function previewOrigin() {
  if (!state.binding) return null
  try {
    const current = new URL(state.tab?.url || '')
    const protocol = current.hostname === state.binding.hostname ? current.protocol : 'https:'
    return `${protocol}//${state.binding.hostname}`
  } catch {
    return `https://${state.binding.hostname}`
  }
}

function isLocalhostTab() {
  try {
    return new URL(state.tab?.url || '').hostname.toLowerCase() === 'localhost'
  } catch {
    return false
  }
}

function isTtttRemoteSourceBranch(branch) {
  return branch === TTTT_REMOTE_SOURCE_BRANCH
}

function displayBranchName(branch) {
  return isTtttRemoteSourceBranch(branch) ? '走tttt' : branch
}

function activeSummary() {
  if (!state.active?.preview) return ''
  const labels = []
  if (state.active.preview.siteArtifactId && state.binding) {
    const branch =
      state.active.preview.siteSelection?.branch ||
      branchForArtifact(state.binding.targetId, state.active.preview.siteArtifactId)
    labels.push(`${state.binding.name} · ${branch || '页面产物'}`)
  }
  for (const selection of state.active.preview.selections || []) {
    labels.push(`${selection.moduleKey} · ${selection.branch}`)
  }
  return labels.join('；') || '页面与热更均使用官网版本'
}

function renderActive() {
  elements.activePanel.hidden = !state.active
  if (!state.active) return
  const servingSlug = state.active.preview?.environmentSlug || ''
  const servingEnvironment = state.environments.find(
    (environment) => environment.slug === servingSlug
  )
  const servingName = servingEnvironment?.name || servingSlug || '未知环境'
  const editingSlug = state.environment?.slug || ''
  const editingName = state.environment?.name || editingSlug
  const mismatched = Boolean(servingSlug && editingSlug && servingSlug !== editingSlug)
  elements.activePanel.classList.toggle('environment-mismatch', mismatched)
  elements.activeTitle.textContent = mismatched
    ? `当前仍在 ${servingName}`
    : state.active.mode === 'remote'
      ? `此标签页正在原地热更 · ${servingName}`
      : `此标签页正在预览 · ${servingName}`
  elements.activeSummary.textContent = mismatched
    ? `应用后切换至 ${editingName}；${activeSummary()}`
    : activeSummary()
}

function renderEnvironmentPicker() {
  const environments = state.environments || []
  elements.environmentBar.hidden = false
  elements.environmentSelect.replaceChildren()
  if (!environments.length) {
    const option = createUiElement('option')
    option.value = ''
    option.textContent = '暂无可用环境'
    elements.environmentSelect.append(option)
    elements.environmentSelect.disabled = true
    elements.environmentHint.textContent = '请先配置'
    elements.environmentHint.removeAttribute('title')
    return
  }

  for (const environment of environments) {
    const option = createUiElement('option')
    option.value = environment.slug
    option.textContent = environmentOptionLabel(environment)
    option.selected = environment.slug === state.environment?.slug
    elements.environmentSelect.append(option)
  }
  const locked = Boolean(state.inPlaceRule)
  elements.environmentSelect.disabled = state.environmentChanging || locked
  elements.environmentHint.textContent = locked
    ? state.environment
      ? `URL 规则锁定 · ${state.environment.name}`
      : 'URL 规则环境不可用'
    : `${environments.length} 个可选`
  if (locked) {
    elements.environmentHint.title = `完整 URL 命中「${state.inPlaceRule.pattern}」，固定使用 ${state.inPlaceRule.environmentSlug} 环境且只允许原地热更`
  } else if (state.environment?.backendOrigin) {
    elements.environmentHint.title = `业务后端：${state.environment.backendOrigin}`
  } else {
    elements.environmentHint.removeAttribute('title')
  }
}

function targetBranchItems(target, catalog, selectedBranch) {
  const items = prepareTargetBranchItems({
    target,
    catalog,
    selectedBranch: isTtttRemoteSourceBranch(selectedBranch) ? '' : selectedBranch,
    environmentStatus: state.environment?.status || '',
  })
  if (target.id !== state.siteTargetId && isLocalhostTab()) {
    return [
      {
        branch: TTTT_REMOTE_SOURCE_BRANCH,
        label: '走tttt',
        detail: '使用 tttt 当前下发的热更版本',
        synthetic: true,
        pinned: true,
        latestArtifact: null,
        latestJob: null,
      },
      ...items,
    ]
  }
  return items
}

function officialChoice(isSite) {
  if (!isSite && isLocalhostTab()) {
    return {
      label: '走本地devserver',
      detail: '不接管这个热更模块',
      status: { label: '不接管', tone: 'official' },
    }
  }
  return isSite
    ? { label: '官网页面', detail: '不替换页面产物' }
    : { label: '官方热更', detail: '由 KOOK 官方热更响应决定' }
}

function openTargetBranchPicker(target, trigger) {
  if (branchPicker.targetId === target.id) {
    branchPicker.close()
    return
  }
  const isSite = target.id === state.siteTargetId
  if (isSite && state.inPlaceRule) return
  const catalog = state.branches[target.id] || { items: [], remoteAvailable: false }
  const selectedBranch =
    isSite && !state.siteOverrideEnabled ? '' : state.selectedBranches[target.id] || ''
  branchPicker.open({
    targetId: target.id,
    targetName: target.name,
    items: targetBranchItems(target, catalog, selectedBranch),
    queue: state.queue,
    environmentSlug: state.environment?.slug || '',
    selectedBranch,
    official: officialChoice(isSite),
    trigger,
    onSelect: (branch) => {
      if (state.selectedBranches[target.id] !== branch) {
        delete state.submittedBuildBranches[target.id]
      }
      if (isSite) state.siteOverrideEnabled = Boolean(branch)
      state.selectedBranches[target.id] = branch
      renderModules()
      void persistCurrentPopupState()
    },
  })
}

function refreshOpenBranchPicker() {
  const target = state.targets.find((candidate) => candidate.id === branchPicker.targetId)
  if (!target) {
    if (branchPicker.targetId) branchPicker.close({ restoreFocus: false })
    return
  }
  const selectedBranch =
    target.id === state.siteTargetId && !state.siteOverrideEnabled
      ? ''
      : state.selectedBranches[target.id] || ''
  const catalog = state.branches[target.id] || { items: [], remoteAvailable: false }
  branchPicker.update({
    items: targetBranchItems(target, catalog, selectedBranch),
    queue: state.queue,
    environmentSlug: state.environment?.slug || '',
    selectedBranch,
  })
}

function renderModules() {
  elements.moduleList.replaceChildren()
  elements.moduleList.removeAttribute('aria-busy')
  if (!state.targets.length) {
    const empty = createUiElement('div')
    setUiClass(empty, 'empty-state')
    empty.innerHTML = state.binding
      ? '<strong>这个站点还没有可用项目</strong><span>检查页面项目、Remote 项目是否已启用并配置 Git 仓库。</span>'
      : '<strong>当前页面没有站点绑定</strong><span>在管理后台添加站点，并把它对应到当前官网地址。</span>'
    elements.moduleList.append(empty)
  }

  for (const target of state.targets) {
    const isSite = target.id === state.siteTargetId
    const catalog = state.branches[target.id] || { items: [], remoteAvailable: false }
    const branch =
      isSite && !state.siteOverrideEnabled ? '' : state.selectedBranches[target.id] || ''
    const branchItems = targetBranchItems(target, catalog, branch)
    const branchItem = branch ? branchItems.find((item) => item.branch === branch) : null
    const ttttSource = isTtttRemoteSourceBranch(branch)
    const artifact = ttttSource ? null : branchItem?.latestArtifact || null
    const buildPresentation =
      branch && !ttttSource
        ? describeBranchBuild({
            item: branchItem,
            queueItems: flattenBuildQueue(state.queue),
            targetId: target.id,
            environmentSlug: state.environment?.slug || '',
          })
        : null
    const row = createUiElement('article')
    setUiClass(row, `module-row ${isSite ? 'site-module' : 'remote-module'}`)

    const heading = createUiElement('div')
    setUiClass(heading, 'module-heading')
    const name = createUiElement('strong')
    name.textContent = target.name
    heading.append(name)
    if (isSite) {
      const kind = createUiElement('span')
      setUiClass(kind, 'module-kind site-kind')
      kind.textContent = '页面'
      heading.append(kind)
    }

    const controls = createUiElement('div')
    setUiClass(controls, 'module-controls')
    const pickerTrigger = createUiElement('button')
    pickerTrigger.type = 'button'
    setUiClass(pickerTrigger, 'branch-picker-trigger')
    pickerTrigger.dataset.targetId = target.id
    pickerTrigger.setAttribute('aria-label', `${target.name} 分支`)
    pickerTrigger.setAttribute('aria-haspopup', 'listbox')
    pickerTrigger.setAttribute('aria-expanded', 'false')
    pickerTrigger.setAttribute('aria-controls', 'branch-picker-list')
    if (isSite && state.inPlaceRule) {
      pickerTrigger.disabled = true
      pickerTrigger.title = '当前 URL 命中原地应用规则，页面项目固定使用官网页面'
    }
    const pickerCopy = createUiElement('span')
    setUiClass(pickerCopy, 'branch-picker-trigger-copy')
    const pickerValue = createUiElement('span')
    setUiClass(pickerValue, 'branch-picker-trigger-value')
    pickerValue.textContent = branch ? displayBranchName(branch) : officialChoice(isSite).label
    pickerValue.title = pickerValue.textContent
    const pickerStatus = createUiElement('small')
    const selectedStatus = !branch
      ? { label: !isSite && isLocalhostTab() ? '不接管' : '官方', tone: 'official' }
      : ttttSource
        ? { label: '测试环境', tone: 'working' }
        : buildPresentation?.tone === 'failed' && artifact
          ? { label: '上次打包失败 · 已有可用包', tone: 'failed' }
          : buildPresentation?.tone === 'ready' && artifact
            ? { label: `已有可用包 · 上次打包 ${formatTime(artifact.builtAt)}`, tone: 'ready' }
            : buildPresentation || { label: '尚未打包', tone: 'idle' }
    setUiClass(pickerStatus, `branch-picker-trigger-status ${selectedStatus.tone}`)
    pickerStatus.textContent = selectedStatus.label
    pickerStatus.title = selectedStatus.label
    pickerCopy.append(pickerValue, pickerStatus)
    const pickerChevron = createUiElement('span')
    setUiClass(pickerChevron, 'branch-picker-trigger-chevron')
    pickerChevron.setAttribute('aria-hidden', 'true')
    pickerChevron.textContent = '⌄'
    pickerTrigger.append(pickerCopy, pickerChevron)
    pickerTrigger.addEventListener('click', () => openTargetBranchPicker(target, pickerTrigger))
    const build = createUiElement('button')
    build.type = 'button'
    setUiClass(build, 'secondary-button build-button')
    const submitting = operationMatchesContext(
      state.busyTargets.get(target.id),
      currentOperationContext(target.id, branch),
      { requireBranch: true }
    )
    const submitted = isBuildSubmissionLocked(state.submittedBuildBranches, target.id, branch)
    const activeBuild = Boolean(buildPresentation?.active)
    const environmentActive = state.environment?.status === 'ACTIVE'
    build.textContent = submitting
      ? '提交中'
      : submitted
        ? '已提交'
        : activeBuild
          ? buildPresentation.status === 'QUEUED'
            ? '已排队'
            : '构建中'
          : '打最新包'
    build.disabled =
      submitting ||
      submitted ||
      activeBuild ||
      !branch ||
      ttttSource ||
      !environmentActive ||
      !target.enabled ||
      !target.configured
    if (submitted) {
      build.title = '任务已提交；刷新数据或切换分支后可再次提交'
    } else if (activeBuild) {
      build.title = '该分支已有活动任务，可点击下方进度状态查看详情'
    } else if (!branch) {
      build.title = '请先选择要打包的分支'
    } else if (!environmentActive || !target.enabled || !target.configured) {
      build.title = !target.configured
        ? '项目未配置 Git 仓库，只能选择已有产物进行预览'
        : state.environment?.status === 'FROZEN'
          ? '环境已冻结，只能选择已有产物进行预览'
          : state.environment?.status === 'ARCHIVED'
            ? '环境已归档，不能发起构建'
            : '项目当前不可构建'
    }
    build.addEventListener('click', () => void createBuild(target.id, branch))
    controls.append(pickerTrigger, build)

    const meta = createUiElement('div')
    setUiClass(meta, 'module-meta')
    const builtAt = createUiElement('span')
    builtAt.textContent = ttttSource
      ? '使用 tttt 当前下发的热更版本'
      : !branch
        ? isSite
          ? `使用 ${state.binding?.officialOrigin || '官网页面'}`
          : '由 KOOK 官方热更响应决定'
        : artifact
          ? `上次打包 ${formatTime(artifact.builtAt)}`
          : '这个分支还没有可用产物'
    const buildState = createUiElement(buildPresentation?.jobId ? 'button' : 'span')
    if (buildState instanceof HTMLButtonElement) {
      buildState.type = 'button'
      setUiClass(buildState, 'queue-job-link')
      buildState.title = '打开当前构建的详情和日志'
      buildState.addEventListener('click', () => void openJobDetail(buildPresentation.jobId))
    }
    if (ttttSource) {
      buildState.textContent = '仅接管这个热更模块'
    } else if (!branch) {
      buildState.textContent = isSite ? '不替换页面' : '不覆盖'
    } else if (buildPresentation?.active) {
      buildState.classList.add('working')
      buildState.textContent = buildPresentation.label
    } else if (buildPresentation?.tone === 'failed') {
      buildState.classList.add('failed')
      buildState.textContent = buildPresentation.label
    } else if (buildPresentation?.tone === 'canceled') {
      buildState.textContent = buildPresentation.label
    } else if (state.environment?.status === 'FROZEN') {
      buildState.textContent = '环境已冻结，可预览已有包'
    } else if (!target.configured) {
      buildState.textContent = '未配置 Git，可预览已有包'
    } else if (!target.enabled) {
      buildState.textContent = '当前环境不可构建'
    } else {
      buildState.textContent = catalog.remoteAvailable ? 'Git 已连接' : '使用本地分支记录'
    }
    if (branch || isSite) {
      meta.append(builtAt, buildState)
      row.append(heading, controls, meta)
    } else {
      row.append(heading, controls)
    }
    elements.moduleList.append(row)
  }

  const selected = selectedArtifacts()
  const sourceOverrides = selectedSourceOverrides()
  const plan = planPreviewApplication({
    binding: state.binding,
    environmentSlug: state.environment?.slug || '',
    previewOrigin: previewOrigin(),
    currentUrl: state.tab?.url || '',
    siteArtifactId: selected.siteArtifactId,
    selections: [...selected.selections, ...sourceOverrides],
    inPlaceRule: state.inPlaceRule,
  })
  const effectiveBranches = effectiveSelectedBranches()
  const labels = state.targets
    .filter((target) => effectiveBranches[target.id])
    .map((target) => `${target.name} · ${effectiveBranches[target.id]}`)
  for (const override of sourceOverrides) {
    const target = state.targets.find((candidate) => candidate.id === override.moduleKey)
    labels.push(`${target?.name || override.moduleKey} · 走tttt`)
  }
  elements.selectionSummary.textContent = labels.length
    ? labels.join('；')
    : isLocalhostTab()
      ? '页面走本地 devserver，热更均不覆盖'
      : '全部使用官网版本'
  const missingReason = selected.missing.length
    ? `${selected.missing[0].targetName} 的 ${selected.missing[0].branch} 尚无成功可用的产物${selected.missing.length > 1 ? `，另有 ${selected.missing.length - 1} 项也未就绪` : ''}`
    : ''
  const applyDisabledReason = state.applyingToken
    ? '正在应用到当前标签页，请稍候'
    : state.inPlaceRuleError || missingReason || plan.reason || ''
  elements.applyButton.textContent = state.applyingToken
    ? '应用中'
    : plan.mode === 'remote' || state.inPlaceRule
      ? '应用'
      : plan.mode === 'official'
        ? isLocalhostTab()
          ? '走本地 devserver'
          : '使用官方版本'
        : `应用并打开 ${productName}`
  elements.applyButton.disabled = Boolean(applyDisabledReason)
  elements.applyButton.title = applyDisabledReason
  elements.applyButtonWrap.title = applyDisabledReason
  elements.applyButtonWrap.tabIndex = applyDisabledReason ? 0 : -1
  if (applyDisabledReason) {
    elements.applyButtonWrap.setAttribute('aria-label', `无法应用：${applyDisabledReason}`)
  } else {
    elements.applyButtonWrap.removeAttribute('aria-label')
  }
  elements.applyButton.setAttribute(
    'aria-label',
    applyDisabledReason
      ? `无法应用：${applyDisabledReason}`
      : plan.mode === 'official'
        ? '在当前官网标签页恢复页面与热更的官网版本'
        : plan.mode === 'remote' || state.inPlaceRule
          ? '在当前官网标签页原地应用热更'
          : `应用后打开 ${productName} 预览站点`
  )
  renderShareButton()
  refreshOpenBranchPicker()
}

function renderModuleLoading() {
  elements.moduleList.replaceChildren()
  elements.moduleList.setAttribute('aria-busy', 'true')

  const loading = createUiElement('div')
  setUiClass(loading, 'module-loading')
  loading.setAttribute('role', 'status')

  const spinner = createUiElement('span')
  setUiClass(spinner, 'module-loading-spinner')
  spinner.setAttribute('aria-hidden', 'true')

  const label = createUiElement('span')
  label.textContent = '正在读取站点、项目和分支'
  loading.append(spinner, label)
  elements.moduleList.append(loading)
}

function fullTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function targetDisplayName(targetId) {
  return state.targetNames[targetId] || targetId
}

function renderProgress(presentation, className = 'build-progress') {
  const wrap = createUiElement('span')
  setUiClass(wrap, className)
  const track = createUiElement('span')
  setUiClass(track, 'build-progress-track')
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  track.setAttribute('aria-valuenow', String(presentation.progress))
  track.setAttribute('aria-label', `${presentation.label}，阶段进度 ${presentation.progressLabel}`)
  const value = createUiElement('span')
  setUiClass(value, `build-progress-value ${presentation.tone}`)
  value.style.width = `${presentation.progress}%`
  track.append(value)
  const label = createUiElement('span')
  setUiClass(label, 'build-progress-label')
  label.textContent = presentation.progressLabel
  wrap.append(track, label)
  return wrap
}

function renderBuildQueue() {
  const jobs = orderedBuildQueue(state.queue)
  const runningCount = state.queue?.running?.length || 0
  const queuedCount = state.queue?.queued?.length || 0
  elements.queueTabCount.textContent = String(jobs.length)
  elements.queueTab.setAttribute(
    'aria-label',
    `构建队列，运行 ${runningCount}，排队 ${queuedCount}`
  )
  const queueSummary = buildQueueSummary(state.queue)
  if (state.queueRefreshError) {
    const lastSuccess = state.queueLastSuccessAt
      ? `最后成功 ${formatTime(state.queueLastSuccessAt)}`
      : '尚无成功刷新'
    elements.queueSummary.textContent = `${queueSummary} · 刷新中断 · ${lastSuccess}`
    elements.queueSummary.title = `队列刷新失败：${state.queueRefreshError}`
  } else {
    elements.queueSummary.textContent = queueSummary
    elements.queueSummary.removeAttribute('title')
  }
  elements.queueList.replaceChildren()
  if (!jobs.length) {
    const empty = createUiElement('div')
    setUiClass(empty, 'queue-empty')
    empty.textContent =
      state.queueRefreshError && !state.queueLastSuccessAt
        ? '构建队列刷新中断，暂时无法确认打包机状态。'
        : '打包机当前空闲，没有排队或运行中的任务。'
    elements.queueList.append(empty)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const job of jobs) {
    const presentation = buildJobPresentation(job)
    const item = createUiElement('article')
    setUiClass(
      item,
      `queue-item ${presentation.tone}${
        job.environmentSlug === state.environment?.slug ? ' current-environment' : ''
      }`
    )

    const open = createUiElement('button')
    open.type = 'button'
    setUiClass(open, 'queue-job-open')
    open.title = '打开任务详情、命令和实时日志'
    open.addEventListener('click', () => void openJobDetail(job.id))

    const heading = createUiElement('span')
    setUiClass(heading, 'queue-job-heading')
    const name = createUiElement('strong')
    name.textContent = `${targetDisplayName(job.targetId)} · ${job.branch}`
    name.title = `${job.targetId} · ${job.branch}`
    const status = createUiElement('span')
    setUiClass(status, `queue-status ${presentation.tone}`)
    status.textContent = presentation.label
    heading.append(name, status)

    const meta = createUiElement('span')
    setUiClass(meta, 'queue-job-meta')
    const actor = job.requestedBy || '未记录操作人'
    meta.textContent = `${job.environmentSlug || '未记录环境'} · ${
      job.isMine ? '我（' + actor + '）' : actor
    } · ${formatTime(job.startedAt || job.createdAt)}`
    open.append(heading, meta, renderProgress(presentation))
    item.append(open)

    if (presentation.cancelable) {
      const cancel = createUiElement('button')
      cancel.type = 'button'
      setUiClass(cancel, 'queue-cancel-button')
      cancel.textContent = state.cancelingJobs.has(job.id) ? '中断中' : '中断'
      cancel.disabled = state.cancelingJobs.has(job.id)
      cancel.title = job.status === 'QUEUED' ? '取消这个排队任务' : '请求 Runner 中断这个任务'
      cancel.addEventListener('click', () => void cancelBuildJob(job.id))
      item.append(cancel)
    }
    fragment.append(item)
  }
  elements.queueList.append(fragment)
}

function formatBuildDuration(job) {
  const start = Date.parse(job.startedAt || job.createdAt || '')
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '耗时未知'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function renderBuildHistoryControls() {
  const targetIds = new Set([
    ...Object.keys(state.targetNames),
    ...state.buildHistory.items.map((job) => job.targetId),
  ])
  if (state.buildHistoryTargetId) targetIds.add(state.buildHistoryTargetId)
  const targetOptions = document.createDocumentFragment()
  const allTargets = createUiElement('option')
  allTargets.value = ''
  allTargets.textContent = '全部项目'
  targetOptions.append(allTargets)
  for (const targetId of [...targetIds].sort((left, right) =>
    targetDisplayName(left).localeCompare(targetDisplayName(right), 'zh-CN')
  )) {
    const option = createUiElement('option')
    option.value = targetId
    option.textContent = targetDisplayName(targetId)
    targetOptions.append(option)
  }
  elements.buildHistoryTarget.replaceChildren(targetOptions)
  elements.buildHistoryTarget.value = state.buildHistoryTargetId

  const statusOptions = document.createDocumentFragment()
  const allStatuses = createUiElement('option')
  allStatuses.value = ''
  allStatuses.textContent = '全部状态'
  statusOptions.append(allStatuses)
  for (const status of BUILD_HISTORY_STATUSES) {
    const option = createUiElement('option')
    option.value = status
    option.textContent = buildJobPresentation(status).label
    statusOptions.append(option)
  }
  elements.buildHistoryStatus.replaceChildren(statusOptions)
  elements.buildHistoryStatus.value = state.buildHistoryStatus
  if (elements.buildHistoryQuery.value !== state.buildHistoryQuery) {
    elements.buildHistoryQuery.value = state.buildHistoryQuery
  }

  const pageSizeOptions = document.createDocumentFragment()
  for (const pageSize of BUILD_HISTORY_PAGE_SIZES) {
    const option = createUiElement('option')
    option.value = String(pageSize)
    option.textContent = `${pageSize} 条`
    pageSizeOptions.append(option)
  }
  elements.buildHistoryPageSize.replaceChildren(pageSizeOptions)
  elements.buildHistoryPageSize.value = String(state.buildHistory.pageSize)

  const pageOptions = document.createDocumentFragment()
  for (const page of buildHistoryPageNumbers(state.buildHistory.totalPages)) {
    const option = createUiElement('option')
    option.value = String(page)
    option.textContent = `第 ${page} / ${state.buildHistory.totalPages} 页`
    pageOptions.append(option)
  }
  elements.buildHistoryPage.replaceChildren(pageOptions)
  elements.buildHistoryPage.value = String(state.buildHistory.page)

  const unavailable = !state.authenticated || !state.environment
  elements.buildHistoryTarget.disabled = unavailable
  elements.buildHistoryStatus.disabled = unavailable
  elements.buildHistoryQuery.disabled = unavailable
  elements.buildHistoryRefresh.disabled = unavailable || state.buildHistoryLoading
  elements.buildHistoryPageSize.disabled = unavailable || state.buildHistoryLoading
  elements.buildHistoryPage.disabled =
    unavailable || state.buildHistoryLoading || state.buildHistory.totalPages <= 1
  elements.buildHistoryPrevious.disabled =
    unavailable || state.buildHistoryLoading || state.buildHistory.page <= 1
  elements.buildHistoryNext.disabled =
    unavailable ||
    state.buildHistoryLoading ||
    state.buildHistory.page >= state.buildHistory.totalPages
}

function renderBuildHistory() {
  renderBuildHistoryControls()
  const environmentName = state.environment?.name || state.environment?.slug || ''
  if (!state.environment) {
    elements.buildHistorySummary.textContent = '请选择环境'
  } else if (state.buildHistoryLoading) {
    elements.buildHistorySummary.textContent = `${environmentName} · 正在读取`
  } else if (state.buildHistoryError) {
    elements.buildHistorySummary.textContent = `${environmentName} · 读取失败`
  } else {
    elements.buildHistorySummary.textContent = `${environmentName} · 第 ${state.buildHistory.page}/${state.buildHistory.totalPages} 页${state.buildHistoryDirty ? ' · 待刷新' : ''}`
  }
  elements.buildHistorySummary.title = state.buildHistoryError
    ? `构建记录读取失败：${state.buildHistoryError}`
    : ''
  elements.buildHistoryTotal.textContent = `共 ${state.buildHistory.total} 条`
  elements.buildHistoryList.setAttribute('aria-busy', String(state.buildHistoryLoading))
  elements.buildHistoryList.replaceChildren()

  if (state.buildHistoryError) {
    const error = createUiElement('div')
    setUiClass(error, 'build-history-message error')
    const message = createUiElement('span')
    message.textContent = `读取失败：${state.buildHistoryError}`
    const retry = createUiElement('button')
    retry.type = 'button'
    setUiClass(retry, 'text-button')
    retry.textContent = '重试'
    retry.addEventListener('click', () => void refreshBuildHistory())
    error.append(message, retry)
    elements.buildHistoryList.append(error)
  }

  if (state.buildHistoryLoading && !state.buildHistory.items.length) {
    const loading = createUiElement('div')
    setUiClass(loading, 'build-history-loading')
    const spinner = createUiElement('span')
    setUiClass(spinner, 'module-loading-spinner')
    spinner.setAttribute('aria-hidden', 'true')
    const label = createUiElement('span')
    label.textContent = '正在读取完整构建记录'
    loading.append(spinner, label)
    elements.buildHistoryList.append(loading)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const job of state.buildHistory.items) {
    const presentation = buildJobPresentation(job)
    const item = createUiElement('article')
    setUiClass(item, `queue-item build-history-item ${presentation.tone} current-environment`)

    const open = createUiElement('button')
    open.type = 'button'
    setUiClass(open, 'queue-job-open')
    open.title = '打开任务详情、命令和日志'
    open.addEventListener('click', () => void openJobDetail(job.id))

    const heading = createUiElement('span')
    setUiClass(heading, 'queue-job-heading')
    const name = createUiElement('strong')
    name.textContent = `${targetDisplayName(job.targetId)} · ${job.branch}`
    name.title = `${job.targetId} · ${job.branch}`
    const status = createUiElement('span')
    setUiClass(status, `queue-status ${presentation.tone}`)
    status.textContent = presentation.label
    heading.append(name, status)

    const meta = createUiElement('span')
    setUiClass(meta, 'queue-job-meta')
    meta.textContent = `${job.requestedBy || '未记录操作人'} · ${formatTime(
      job.startedAt || job.createdAt
    )} · ${formatBuildDuration(job)}`
    open.append(heading, meta)
    if (job.failureCode || job.failureMessage) {
      const failure = createUiElement('span')
      setUiClass(failure, 'build-history-failure')
      failure.textContent = job.failureCode || 'BUILD_FAILED'
      failure.title = job.failureMessage || job.failureCode || '构建失败'
      open.append(failure)
    }
    item.append(open)

    if (presentation.cancelable) {
      const cancel = createUiElement('button')
      cancel.type = 'button'
      setUiClass(cancel, 'queue-cancel-button')
      cancel.textContent = state.cancelingJobs.has(job.id) ? '中断中' : '中断'
      cancel.disabled = state.cancelingJobs.has(job.id)
      cancel.title = job.status === 'QUEUED' ? '取消这个排队任务' : '请求 Runner 中断这个任务'
      cancel.addEventListener('click', () => void cancelBuildJob(job.id))
      item.append(cancel)
    }
    fragment.append(item)
  }
  elements.buildHistoryList.append(fragment)

  if (!state.buildHistoryLoading && !state.buildHistory.items.length && !state.buildHistoryError) {
    const empty = createUiElement('div')
    setUiClass(empty, 'queue-empty')
    empty.textContent = '没有符合当前筛选条件的构建记录。'
    elements.buildHistoryList.append(empty)
  }
}

function clearBuildHistoryQueryTimer() {
  if (buildHistoryQueryTimer === null) return
  window.clearTimeout(buildHistoryQueryTimer)
  buildHistoryQueryTimer = null
}

function invalidateBuildHistory() {
  clearBuildHistoryQueryTimer()
  buildHistoryGeneration += 1
  state.buildHistory = normalizeBuildHistoryPage({
    items: [],
    page: 1,
    pageSize: state.buildHistory.pageSize,
    total: 0,
    totalPages: 1,
  })
  state.buildHistoryLoading = false
  state.buildHistoryError = ''
  state.buildHistoryDirty = true
  state.buildHistoryEnvironmentSlug = ''
  renderBuildHistory()
}

function markBuildHistoryDirty() {
  buildHistoryGeneration += 1
  state.buildHistoryLoading = false
  state.buildHistoryDirty = true
  renderBuildHistory()
}

async function refreshBuildHistory() {
  clearBuildHistoryQueryTimer()
  const environmentSlug = state.environment?.slug || ''
  if (!state.authenticated || !environmentSlug) {
    renderBuildHistory()
    return
  }
  const filters = {
    environmentSlug,
    targetId: state.buildHistoryTargetId,
    status: state.buildHistoryStatus,
    query: state.buildHistoryQuery,
    page: state.buildHistory.page,
    pageSize: state.buildHistory.pageSize,
  }
  const generation = ++buildHistoryGeneration
  state.buildHistoryLoading = true
  state.buildHistoryError = ''
  renderBuildHistory()
  try {
    const body = await api(buildHistoryQuery(filters))
    if (generation !== buildHistoryGeneration || state.environment?.slug !== environmentSlug) return
    state.buildHistory = normalizeBuildHistoryPage(body, filters)
    state.buildHistoryEnvironmentSlug = environmentSlug
    state.buildHistoryDirty = false
  } catch (error) {
    if (generation !== buildHistoryGeneration || state.environment?.slug !== environmentSlug) return
    state.buildHistoryError = errorText(error)
  } finally {
    if (generation === buildHistoryGeneration && state.environment?.slug === environmentSlug) {
      state.buildHistoryLoading = false
      renderBuildHistory()
    }
  }
}

function updateBuildHistoryFilter(field, value, { debounce = false } = {}) {
  clearBuildHistoryQueryTimer()
  buildHistoryGeneration += 1
  state[field] = value
  state.buildHistory = { ...state.buildHistory, page: 1 }
  state.buildHistoryLoading = false
  state.buildHistoryError = ''
  state.buildHistoryDirty = true
  if (debounce) {
    buildHistoryQueryTimer = window.setTimeout(() => {
      buildHistoryQueryTimer = null
      void refreshBuildHistory()
    }, BUILD_HISTORY_QUERY_DEBOUNCE_MS)
    return
  }
  void refreshBuildHistory()
}

function changeBuildHistoryPage(page) {
  const nextPage = Number(page)
  if (
    !Number.isInteger(nextPage) ||
    nextPage < 1 ||
    nextPage > state.buildHistory.totalPages ||
    nextPage === state.buildHistory.page
  ) {
    return
  }
  state.buildHistory = { ...state.buildHistory, page: nextPage }
  void refreshBuildHistory()
}

function appendDetailField(list, labelText, valueText, title = '') {
  const row = createUiElement('div')
  const label = createUiElement('dt')
  label.textContent = labelText
  const value = createUiElement('dd')
  value.textContent = valueText
  if (title) value.title = title
  row.append(label, value)
  list.append(row)
}

function sectionTitle(text) {
  const heading = createUiElement('h3')
  heading.textContent = text
  return heading
}

function renderJobOverview(detail) {
  const fragment = document.createDocumentFragment()
  const presentation = buildJobPresentation(detail.job)
  const snapshotEnvironment = detail.job.targetSnapshot?.environment || null
  const summary = createUiElement('section')
  setUiClass(summary, 'job-summary-card')
  const status = createUiElement('div')
  setUiClass(status, 'job-summary-status')
  const badge = createUiElement('strong')
  setUiClass(badge, `queue-status ${presentation.tone}`)
  badge.textContent = presentation.label
  status.append(badge, renderProgress(presentation, 'build-progress detail-progress'))
  summary.append(status)

  const fields = createUiElement('dl')
  setUiClass(fields, 'job-detail-fields')
  appendDetailField(fields, '项目', targetDisplayName(detail.job.targetId), detail.job.targetId)
  appendDetailField(
    fields,
    '环境',
    snapshotEnvironment?.name
      ? `${snapshotEnvironment.name} · ${detail.job.environmentSlug}`
      : detail.job.environmentSlug || '未记录'
  )
  appendDetailField(
    fields,
    '业务后端',
    snapshotEnvironment?.backendOrigin || '历史任务未记录',
    snapshotEnvironment?.backendOrigin || ''
  )
  appendDetailField(fields, '操作人', detail.job.requestedBy || '未记录')
  appendDetailField(fields, '提交', fullTime(detail.job.createdAt))
  appendDetailField(fields, '开始', fullTime(detail.job.startedAt))
  appendDetailField(fields, '结束', fullTime(detail.job.finishedAt))
  summary.append(fields)

  if (detail.job.failureMessage) {
    const failure = createUiElement('div')
    setUiClass(failure, 'job-failure')
    const code = createUiElement('strong')
    code.textContent = detail.job.failureCode || 'BUILD_FAILED'
    const message = createUiElement('span')
    message.textContent = detail.job.failureMessage
    failure.append(code, message)
    summary.append(failure)
  }
  fragment.append(summary)

  const timeline = createUiElement('section')
  setUiClass(timeline, 'job-detail-section')
  timeline.append(sectionTitle('执行时间线'))
  const events = createUiElement('ol')
  setUiClass(events, 'job-timeline')
  for (const event of detail.events || []) {
    const row = createUiElement('li')
    const dot = createUiElement('span')
    setUiClass(dot, `timeline-dot ${buildJobPresentation(event).tone}`)
    const copy = createUiElement('span')
    const name = createUiElement('strong')
    name.textContent = buildJobPresentation(event).label
    const time = createUiElement('time')
    time.textContent = fullTime(event.createdAt)
    copy.append(name, time)
    row.append(dot, copy)
    events.append(row)
  }
  if (!events.children.length) {
    const empty = createUiElement('p')
    setUiClass(empty, 'detail-empty-copy')
    empty.textContent = '暂无执行事件'
    timeline.append(empty)
  } else {
    timeline.append(events)
  }
  fragment.append(timeline)

  const commands = createUiElement('section')
  setUiClass(commands, 'job-detail-section')
  commands.append(sectionTitle('执行命令'))
  const commandList = createUiElement('div')
  setUiClass(commandList, 'job-command-list')
  for (const step of detail.commands || []) {
    const row = createUiElement('div')
    const label = createUiElement('span')
    label.textContent = step.label
    const command = createUiElement('code')
    command.textContent = step.command
    row.append(label, command)
    commandList.append(row)
  }
  if (!commandList.children.length) {
    const empty = createUiElement('p')
    setUiClass(empty, 'detail-empty-copy')
    empty.textContent = '历史任务没有保存命令快照'
    commands.append(empty)
  } else {
    commands.append(commandList)
  }
  fragment.append(commands)

  const result = createUiElement('section')
  setUiClass(result, 'job-detail-section job-result')
  result.append(sectionTitle('构建结果'))
  if (detail.artifact) {
    const resultFields = createUiElement('dl')
    setUiClass(resultFields, 'job-detail-fields compact-fields')
    appendDetailField(resultFields, 'Artifact', detail.artifact.id.slice(0, 12), detail.artifact.id)
    appendDetailField(resultFields, '文件', `${detail.artifact.fileCount} 个`)
    appendDetailField(resultFields, '生成', fullTime(detail.artifact.builtAt))
    result.append(resultFields)
  } else {
    const empty = createUiElement('p')
    setUiClass(empty, 'detail-empty-copy')
    empty.textContent = TERMINAL_BUILD_STATUSES.has(detail.job.status)
      ? '任务没有生成可用产物'
      : '构建完成后显示产物信息'
    result.append(empty)
  }
  fragment.append(result)
  return fragment
}

function renderJobLog(detail, log) {
  const section = createUiElement('section')
  setUiClass(section, 'job-log-section')
  const toolbar = createUiElement('div')
  setUiClass(toolbar, 'job-log-toolbar')
  const stateText = createUiElement('span')
  stateText.textContent = log
    ? `${log.complete ? '日志已结束' : '实时日志'}${log.truncated ? ' · 已截断' : ''}`
    : '正在读取日志'
  const actions = createUiElement('span')
  setUiClass(actions, 'job-log-actions')
  const copy = createUiElement('button')
  copy.type = 'button'
  setUiClass(copy, 'text-button compact-action')
  copy.textContent = '复制'
  copy.disabled = !log?.content
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(log?.content || '')
      setStatus('日志已复制', 'success')
    } catch (error) {
      setStatus(`复制失败：${errorText(error)}`, 'warning')
    }
  })
  const download = createUiElement('a')
  setUiClass(download, 'text-link compact-action')
  download.href = `${state.controlOrigin.replace(/\/$/, '')}/api/v1/build-jobs/${encodeURIComponent(
    detail.job.id
  )}/log?download=1`
  download.target = '_blank'
  download.rel = 'noreferrer'
  download.textContent = '下载'
  actions.append(copy, download)
  toolbar.append(stateText, actions)
  const consoleView = createUiElement('pre')
  setUiClass(consoleView, 'job-console')
  consoleView.tabIndex = 0
  consoleView.textContent = log?.content || (log?.complete ? '没有日志输出' : '等待 Runner 输出...')
  consoleView.addEventListener('scroll', () => {
    state.jobLogScrollTop = consoleView.scrollTop
    state.jobLogFollow =
      consoleView.scrollHeight - consoleView.scrollTop - consoleView.clientHeight < 28
  })
  section.append(toolbar, consoleView)
  window.requestAnimationFrame(() => {
    if (state.jobLogFollow) {
      consoleView.scrollTop = consoleView.scrollHeight
    } else {
      consoleView.scrollTop = state.jobLogScrollTop
    }
  })
  return section
}

function renderJobDetail() {
  const detail = state.jobDetail
  const preservedScrollTop = state.jobDetailScrollTop
  elements.jobOverviewTab.classList.toggle('active', state.jobDetailTab === 'overview')
  elements.jobLogTab.classList.toggle('active', state.jobDetailTab === 'log')
  elements.jobOverviewTab.setAttribute('aria-selected', String(state.jobDetailTab === 'overview'))
  elements.jobLogTab.setAttribute('aria-selected', String(state.jobDetailTab === 'log'))
  elements.jobDetailContent.replaceChildren()
  const expectedJobId = state.selectedJobId
  const expectedTab = state.jobDetailTab
  window.requestAnimationFrame(() => {
    if (state.selectedJobId === expectedJobId && state.jobDetailTab === expectedTab) {
      elements.jobDetailContent.scrollTop = preservedScrollTop
      state.jobDetailScrollTop = preservedScrollTop
    }
  })

  if (detail) {
    elements.jobDetailTitle.textContent = detail.job.branch
    const environmentName = detail.job.targetSnapshot?.environment?.name
    elements.jobDetailContext.textContent = `${targetDisplayName(detail.job.targetId)} · ${
      environmentName
        ? `${environmentName} · ${detail.job.environmentSlug}`
        : detail.job.environmentSlug || '未记录环境'
    } · ${detail.job.requestedBy || '未记录操作人'} · ${detail.job.id.slice(0, 8)}`
    const presentation = buildJobPresentation(detail.job)
    elements.jobDetailRetry.hidden = !presentation.retryable
    elements.jobDetailRetry.disabled = state.retryingJobs.has(detail.job.id)
    elements.jobDetailRetry.textContent = state.retryingJobs.has(detail.job.id)
      ? '正在重试'
      : '重试构建'
    elements.jobDetailCancel.hidden = !presentation.cancelable
    elements.jobDetailCancel.disabled = state.cancelingJobs.has(detail.job.id)
    elements.jobDetailCancel.textContent = state.cancelingJobs.has(detail.job.id)
      ? '正在中断'
      : '中断构建'
    const refreshHint = TERMINAL_BUILD_STATUSES.has(detail.job.status)
      ? '任务已结束'
      : '任务进行中，每 2.5 秒自动刷新'
    elements.jobDetailRefreshHint.textContent = state.jobDetailRefreshError
      ? `${refreshHint} · 刷新中断`
      : refreshHint
    if (state.jobDetailRefreshError) {
      elements.jobDetailRefreshHint.title = state.jobDetailRefreshError
    } else {
      elements.jobDetailRefreshHint.removeAttribute('title')
    }
  } else {
    elements.jobDetailTitle.textContent = '构建任务'
    elements.jobDetailContext.textContent = state.selectedJobId?.slice(0, 8) || '正在读取任务'
    elements.jobDetailRetry.hidden = true
    elements.jobDetailCancel.hidden = true
  }

  if (state.jobDetailError) {
    const error = createUiElement('div')
    setUiClass(error, 'job-detail-message error')
    const message = createUiElement('span')
    message.textContent = state.jobDetailError
    const retry = createUiElement('button')
    retry.type = 'button'
    setUiClass(retry, 'text-button')
    retry.textContent = '重试'
    retry.addEventListener('click', () => void refreshJobDetail())
    error.append(message, retry)
    elements.jobDetailContent.append(error)
    return
  }
  if (!detail) {
    const loading = createUiElement('div')
    setUiClass(loading, 'job-detail-message')
    loading.textContent = state.jobDetailLoading ? '正在读取任务详情…' : '暂无任务详情'
    elements.jobDetailContent.append(loading)
    return
  }
  elements.jobDetailContent.append(
    state.jobDetailTab === 'log' ? renderJobLog(detail, state.jobLog) : renderJobOverview(detail)
  )
}

async function refreshJobDetail() {
  const jobId = state.selectedJobId
  if (!jobId) return
  const generation = ++jobDetailGeneration
  state.jobDetailLoading = !state.jobDetail
  state.jobDetailError = ''
  renderJobDetail()
  try {
    const wantsLog = state.jobDetailTab === 'log'
    const [detail, log] = await Promise.all([
      api(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/detail`),
      wantsLog
        ? api(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/log`)
        : Promise.resolve(state.jobLog),
    ])
    if (generation !== jobDetailGeneration || state.selectedJobId !== jobId) return
    state.jobDetail = detail
    if (wantsLog) state.jobLog = log
    state.jobDetailRefreshError = ''
  } catch (error) {
    if (generation !== jobDetailGeneration || state.selectedJobId !== jobId) return
    if (state.jobDetail) {
      state.jobDetailRefreshError = `刷新失败：${errorText(error)}`
    } else {
      state.jobDetailError = `读取失败：${errorText(error)}`
    }
  } finally {
    if (generation === jobDetailGeneration && state.selectedJobId === jobId) {
      state.jobDetailLoading = false
      renderJobDetail()
    }
  }
}

async function openJobDetail(jobId) {
  state.selectedJobId = jobId
  state.jobDetail = null
  state.jobLog = null
  state.jobLogFollow = true
  state.jobLogScrollTop = 0
  state.jobDetailScrollTop = 0
  state.jobDetailTab = 'overview'
  state.jobDetailError = ''
  state.jobDetailRefreshError = ''
  state.jobDetailLoading = true
  renderJobDetail()
  if (!elements.jobDetailDialog.open) {
    elements.jobDetailDialog.showModal()
    window.requestAnimationFrame(() => elements.jobDetailClose.focus())
  }
  await refreshJobDetail()
}

function closeJobDetail() {
  jobDetailGeneration += 1
  state.selectedJobId = null
  state.jobDetail = null
  state.jobLog = null
  state.jobDetailScrollTop = 0
  state.jobDetailError = ''
  state.jobDetailRefreshError = ''
  if (elements.jobDetailDialog.open) elements.jobDetailDialog.close()
}

async function changeJobDetailTab(tab) {
  if (tab !== 'overview' && tab !== 'log') return
  state.jobDetailTab = tab
  state.jobDetailScrollTop = 0
  renderJobDetail()
  if (tab === 'log') await refreshJobDetail()
}

async function cancelBuildJob(jobId) {
  if (!jobId || state.cancelingJobs.has(jobId)) return
  state.cancelingJobs.add(jobId)
  renderBuildQueue()
  renderBuildHistory()
  renderJobDetail()
  setStatus('正在提交中断请求', 'busy')
  let canceled = null
  try {
    canceled = await api(`/api/v1/build-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    })
  } catch (error) {
    setStatus(`中断失败：${errorText(error)}`, 'warning')
    return
  } finally {
    if (!canceled) {
      state.cancelingJobs.delete(jobId)
      renderBuildQueue()
      renderBuildHistory()
      renderJobDetail()
    }
  }

  try {
    state.queue = replaceBuildQueueJob(state.queue, canceled)
    if (state.jobDetail?.job.id === jobId) {
      state.jobDetail = { ...state.jobDetail, job: canceled }
    }
    state.buildHistory = {
      ...state.buildHistory,
      items: state.buildHistory.items.map((job) =>
        job.id === canceled.id ? { ...job, ...canceled } : job
      ),
    }
    state.buildHistoryDirty = true
    setStatus(
      canceled.status === 'CANCELED' ? '构建已取消' : '已提交中断请求',
      canceled.status === 'CANCELED' ? 'success' : 'busy'
    )
    renderBuildQueue()
    renderBuildHistory()
    renderJobDetail()
    scheduleQueuePoll(300)
    if (state.workspaceTab === 'queue' && state.buildTaskTab === 'history') {
      void refreshBuildHistory()
    }
  } finally {
    state.cancelingJobs.delete(jobId)
    renderBuildQueue()
    renderBuildHistory()
    renderJobDetail()
  }
}

async function retryBuildJob(jobId) {
  const failedJob = state.jobDetail?.job
  if (
    !jobId ||
    failedJob?.id !== jobId ||
    failedJob.status !== 'FAILED' ||
    state.retryingJobs.has(jobId)
  ) {
    return
  }
  state.retryingJobs.add(jobId)
  renderJobDetail()
  setStatus(`${failedJob.branch} 正在重新提交打包任务`, 'busy')
  try {
    const retried = await api('/api/v1/build-jobs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        environmentSlug: failedJob.environmentSlug,
        targetId: failedJob.targetId,
        branch: failedJob.branch,
        profile: failedJob.profile || 'qa-web',
      }),
    })
    state.queue = {
      ...state.queue,
      queued: [
        ...(state.queue.queued || []).filter((item) => item.id !== retried.id),
        {
          id: retried.id,
          environmentId: retried.environmentId,
          environmentSlug: retried.environmentSlug,
          targetId: retried.targetId,
          branch: retried.branch,
          status: retried.status,
          requestedBy: retried.requestedBy,
          createdAt: retried.createdAt,
          startedAt: retried.startedAt,
          queuePosition: null,
          isMine: true,
        },
      ],
    }
    markBuildHistoryDirty()
    renderBuildQueue()
    setStatus(`${failedJob.branch} 已重新加入 ${failedJob.environmentSlug} 环境构建队列`, 'success')
    scheduleQueuePoll(300)
    void openJobDetail(retried.id)
  } catch (error) {
    setStatus(`重试失败：${errorText(error)}`, 'warning')
    state.jobDetailError = `重试失败：${errorText(error)}`
    renderJobDetail()
  } finally {
    state.retryingJobs.delete(jobId)
    renderJobDetail()
  }
}

async function resolveBindings(tabUrl, preferredBinding = null) {
  if (!tabUrl) return { candidates: [], preferenceKey: null }
  const url = new URL(tabUrl)
  const directPreview = await optionalApi(
    `/api/v1/config-groups/resolve-preview?hostname=${encodeURIComponent(url.hostname)}`
  )
  const directConfigurationGroup = normalizeConfigurationGroup(directPreview?.configurationGroup)
  const directBindingCandidates = normalizeBindingCandidates(directPreview?.siteBinding)
  if (
    directConfigurationGroup &&
    directBindingCandidates.some((binding) => binding.id === directConfigurationGroup.siteBindingId)
  ) {
    const directBinding = directBindingCandidates.find(
      (binding) => binding.id === directConfigurationGroup.siteBindingId
    )
    return {
      candidates: [
        directBinding,
        ...directBindingCandidates.filter((binding) => binding !== directBinding),
      ],
      preferenceKey: directBinding.officialOrigin,
      directConfigurationGroup,
    }
  }
  if (
    typeof preferredBinding?.id === 'string' &&
    preferredBinding.id &&
    typeof preferredBinding?.hostname === 'string' &&
    preferredBinding.hostname
  ) {
    try {
      const preferred = normalizeBindingCandidates(
        await optionalApi(
          `/api/v1/site-bindings/resolve?hostname=${encodeURIComponent(preferredBinding.hostname)}`
        )
      )
      const exact = preferred.find((binding) => binding.id === preferredBinding.id)
      if (exact)
        return {
          candidates: [exact, ...preferred.filter((binding) => binding !== exact)],
          preferenceKey: exact.officialOrigin,
        }
    } catch {
      // The current page can still resolve normally if a saved requirement binding was removed.
    }
  }
  const byHostname = normalizeBindingCandidates(
    await optionalApi(`/api/v1/site-bindings/resolve?hostname=${encodeURIComponent(url.hostname)}`)
  )
  if (byHostname.length) return { candidates: byHostname, preferenceKey: null }

  const origins = [url.origin]
  const environmentClass = environmentClassForUrl(url.origin)
  if (environmentClass === 'test') origins.push('https://tttt-www.dev.chuanyuapp.com')
  if (environmentClass === 'online') origins.push('https://www.kookapp.cn')
  for (const origin of [...new Set(origins)]) {
    const candidates = normalizeBindingCandidates(
      await optionalApi(
        `/api/v1/site-bindings/candidates?officialOrigin=${encodeURIComponent(origin)}`
      )
    )
    if (candidates.length) return { candidates, preferenceKey: origin }
  }
  return { candidates: [], preferenceKey: url.origin }
}

async function loadActive() {
  const stored = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY] || {}
  const active = stored[String(state.tab.id)] || null
  const expiresAt = Date.parse(active?.preview?.expiresAt || '')
  if (
    active &&
    (!['site', 'remote'].includes(active.mode) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now())
  ) {
    const result = await chrome.runtime.sendMessage({
      type: REMOVE_PREVIEW_TRANSACTION_COMMAND,
      tabId: state.tab.id,
    })
    state.active = result?.ok ? null : active
  } else {
    state.active = active
  }
  renderActive()
}

async function refreshBranchCatalog(targetId) {
  if (!state.targets.some((target) => target.id === targetId)) return false
  const bindingId = state.binding?.id || ''
  const environmentSlug = state.environment?.slug || ''
  if (!bindingId || !environmentSlug) return false
  try {
    const catalog = await api(
      `/api/v1/build-targets/${encodeURIComponent(targetId)}/branches?environment=${encodeURIComponent(environmentSlug)}`
    )
    if (state.binding?.id !== bindingId) return false
    state.branches[targetId] = catalog
    return true
  } catch {
    return false
  }
}

function queueSnapshotSignature(snapshot) {
  return flattenBuildQueue(snapshot)
    .map(
      (job) =>
        `${job.id}:${job.environmentSlug || ''}:${job.status}:${job.queuePosition ?? ''}:${job.startedAt || ''}:${job.createdAt}:${job.requestedBy || ''}:${job.isMine ? 'mine' : ''}`
    )
    .sort()
    .join('|')
}

async function applyQueueSnapshot(nextQueue, { refreshEnded = true } = {}) {
  const previousJobs = flattenBuildQueue(state.queue)
  const previousSignature = queueSnapshotSignature(state.queue)
  state.queue = nextQueue || emptyQueue
  const queueChanged = previousSignature !== queueSnapshotSignature(state.queue)
  if (queueChanged) {
    renderModules()
    renderBuildQueue()
  }

  if (refreshEnded && previousJobs.length) {
    for (const targetId of endedQueueTargetIds(
      { running: previousJobs, queued: [] },
      state.queue,
      state.targets.map((target) => target.id),
      state.environment?.slug || ''
    )) {
      state.dirtyCatalogTargets.add(targetId)
    }
  }

  const retryTargets = [...state.dirtyCatalogTargets].filter((targetId) =>
    state.targets.some((target) => target.id === targetId)
  )
  if (!retryTargets.length) return
  const results = await Promise.all(
    retryTargets.map(async (targetId) => [targetId, await refreshBranchCatalog(targetId)])
  )
  let refreshed = false
  for (const [targetId, succeeded] of results) {
    if (!succeeded) continue
    state.dirtyCatalogTargets.delete(targetId)
    refreshed = true
  }
  if (refreshed) renderModules()
}

function scheduleQueuePoll(delay = BUILD_QUEUE_POLL_MS) {
  if (!state.authenticated) return
  if (queuePollTimer !== null) window.clearTimeout(queuePollTimer)
  queuePollTimer = window.setTimeout(() => {
    queuePollTimer = null
    void pollBuildQueue()
  }, delay)
}

async function pollBuildQueue() {
  if (queuePollRunning || !state.authenticated) return
  if (queuePollTimer !== null) {
    window.clearTimeout(queuePollTimer)
    queuePollTimer = null
  }
  queuePollRunning = true
  try {
    const nextQueue = await api('/api/v1/build-queue')
    state.queueLastSuccessAt = Date.now()
    state.queueRefreshError = ''
    await applyQueueSnapshot(nextQueue)
    renderBuildQueue()
    if (state.selectedJobId && shouldPollBuildJob(state.jobDetail)) {
      await refreshJobDetail()
    }
  } catch (error) {
    // Keep the last known queue state; a transient polling error must not hide branch choices.
    state.queueRefreshError = errorText(error)
    renderBuildQueue()
  } finally {
    queuePollRunning = false
    scheduleQueuePoll()
  }
}

async function load({ resetSubmitted = false } = {}) {
  const generation = ++loadGeneration
  setStatus('正在读取站点、项目和分支', 'busy')
  renderModuleLoading()
  if (resetSubmitted) {
    state.submittedBuildBranches = {}
    await persistCurrentPopupState()
    if (generation !== loadGeneration) return
  }
  const previousBindingId = state.binding?.id || null
  const previousEnvironmentSlug = state.environment?.slug || null
  const previousSelectedBranches = { ...state.selectedBranches }
  const previousSubmittedBuildBranches = { ...state.submittedBuildBranches }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (generation !== loadGeneration) return
  state.tab = tab
  const saved = await chrome.storage.local.get([
    CONTROL_KEY,
    ENVIRONMENT_PREFS_KEY,
    TAB_ENVIRONMENT_PREFS_KEY,
    PROJECT_VERSION_TAB_KEY,
  ])
  if (generation !== loadGeneration) return
  state.controlOrigin = saved[CONTROL_KEY] || DEFAULT_CONTROL_ORIGIN
  state.environmentPreferences =
    saved[ENVIRONMENT_PREFS_KEY] && typeof saved[ENVIRONMENT_PREFS_KEY] === 'object'
      ? saved[ENVIRONMENT_PREFS_KEY]
      : {}
  state.tabEnvironmentPreferences =
    saved[TAB_ENVIRONMENT_PREFS_KEY] && typeof saved[TAB_ENVIRONMENT_PREFS_KEY] === 'object'
      ? saved[TAB_ENVIRONMENT_PREFS_KEY]
      : {}
  state.projectVersionTab = normalizeProjectVersionTab(saved[PROJECT_VERSION_TAB_KEY])
  setProjectVersionTab(state.projectVersionTab)
  elements.controlOrigin.value = state.controlOrigin
  elements.pageTitle.textContent = tab?.title || '当前标签页'
  elements.pageMeta.textContent = tab?.url || '无法读取页面地址'

  state.authenticated = false
  state.authLoading = true
  state.authHint = '正在检查登录状态'
  state.identity = null
  state.csrfToken = ''
  if (queuePollTimer !== null) {
    window.clearTimeout(queuePollTimer)
    queuePollTimer = null
  }
  renderAuthentication()
  let session
  try {
    session = await readAuthSession(state.controlOrigin)
  } catch (error) {
    if (generation !== loadGeneration) return
    expireAuthentication(`无法检查登录状态：${errorText(error)}`)
    return
  }
  if (generation !== loadGeneration) return
  if (!session) {
    expireAuthentication('请使用飞书登录后继续')
    return
  }
  setAuthenticatedSession(session)
  void refreshConfigurationGroups()
  await loadActive()
  if (generation !== loadGeneration) return

  try {
    const tabConfigurationPreference =
      Number.isInteger(tab?.id) &&
      state.tabEnvironmentPreferences[String(tab.id)]?.configurationGroupBindingId
        ? {
            id: state.tabEnvironmentPreferences[String(tab.id)].configurationGroupBindingId,
            hostname:
              state.tabEnvironmentPreferences[String(tab.id)].configurationGroupHostname || '',
          }
        : null
    let [resolution, environmentBody, runtimeBody, queueResult] = await Promise.all([
      resolveBindings(tab?.url, tabConfigurationPreference),
      api('/api/v1/environments'),
      api('/api/v1/runtime'),
      api('/api/v1/build-queue')
        .then((queue) => ({ queue, error: null }))
        .catch((error) => ({ queue: state.queue, error })),
    ])
    if (generation !== loadGeneration) return
    state.inPlaceUrlRules = normalizeInPlaceUrlRules(runtimeBody?.inPlaceUrlRules)
    state.previewBaseDomain =
      typeof runtimeBody?.previewBaseDomain === 'string' && runtimeBody.previewBaseDomain
        ? runtimeBody.previewBaseDomain
        : new URL(state.controlOrigin).hostname
    state.inPlaceRule = matchInPlaceUrlRule(tab?.url || '', state.inPlaceUrlRules)
    state.environments = normalizeEnvironments(environmentBody)
    const tabEnvironmentClass = environmentClassForUrl(tab?.url || '')
    const ruleEnvironment = state.environments.find(
      (environment) => environment.slug === state.inPlaceRule?.environmentSlug
    )
    if (
      state.inPlaceRule &&
      tabEnvironmentClass &&
      environmentClassForUrl(ruleEnvironment?.backendOrigin) !== tabEnvironmentClass
    ) {
      state.inPlaceRule = null
    }
    let binding = chooseBindingCandidate({
      candidates: resolution.candidates,
      activeSiteBindingId: state.active?.preview?.siteBindingId || '',
      environmentSlug:
        resolution.directConfigurationGroup?.environmentSlug ||
        state.inPlaceRule?.environmentSlug ||
        '',
    })
    if (state.inPlaceRule && !binding && tabConfigurationPreference) {
      resolution = await resolveBindings(tab?.url, null)
      if (generation !== loadGeneration) return
      binding = chooseBindingCandidate({
        candidates: resolution.candidates,
        activeSiteBindingId: state.active?.preview?.siteBindingId || '',
        environmentSlug: state.inPlaceRule.environmentSlug,
      })
    }
    if (pcInPlaceOnly && binding && !state.inPlaceRule && tab?.url) {
      state.inPlaceRule = {
        pattern: new URL(tab.url).hostname,
        environmentSlug: binding.environmentSlug,
      }
    }
    state.binding = binding
    const lockedEnvironment = inPlaceRuleEnvironment(state.inPlaceRule, state.environments)
    state.inPlaceRuleError = state.inPlaceRule
      ? !lockedEnvironment
        ? `URL 已命中规则，但环境 ${state.inPlaceRule.environmentSlug} 不可用`
        : !binding
          ? `URL 已命中规则，但 ${state.inPlaceRule.environmentSlug} 环境没有对应的站点绑定`
          : ''
      : ''
    const officialOrigin = selectedOfficialOrigin()
    const tabEnvironmentSlug = readTabEnvironmentPreference(state.tabEnvironmentPreferences, {
      tabId: tab?.id,
      officialOrigin,
    })
    const activeEnvironmentSlug =
      state.active?.preview?.siteBindingId === binding?.id
        ? state.active?.preview?.environmentSlug || ''
        : ''
    const directConfigurationGroupEnvironment = state.environments.find(
      (environment) =>
        environment.slug === resolution.directConfigurationGroup?.environmentSlug &&
        environment.status !== 'ARCHIVED'
    )
    state.environment = resolution.directConfigurationGroup
      ? directConfigurationGroupEnvironment || null
      : state.inPlaceRule
        ? lockedEnvironment
        : chooseEnvironment({
            environments: state.environments,
            tabEnvironmentSlug,
            activeEnvironmentSlug,
            rememberedEnvironmentSlug: officialOrigin
              ? state.environmentPreferences[officialOrigin] || ''
              : '',
            tabUrl: tab?.url || '',
          })
    if (previousEnvironmentSlug !== (state.environment?.slug || null)) {
      invalidateBuildHistory()
    }
    const sameScope =
      previousBindingId === (binding?.id || null) &&
      previousEnvironmentSlug === (state.environment?.slug || null)
    if (!sameScope) {
      state.dirtyCatalogTargets.clear()
      state.submittedBuildBranches = {}
      state.busyTargets.clear()
      state.targets = []
      state.targetNames = {}
      state.branches = {}
      state.selectedBranches = {}
      state.siteOverrideEnabled = false
      branchPicker.close({ restoreFocus: false })
    }
    state.queue = queueResult.queue || emptyQueue
    if (queueResult.error) {
      state.queueRefreshError = errorText(queueResult.error)
    } else {
      state.queueLastSuccessAt = Date.now()
      state.queueRefreshError = ''
    }
    renderEnvironmentPicker()

    if (binding && state.environment) {
      const targetBody = await api(
        `/api/v1/build-targets?environment=${encodeURIComponent(state.environment.slug)}`
      )
      if (generation !== loadGeneration) return
      const allTargets = targetBody.items || []
      state.targetNames = Object.fromEntries(allTargets.map((target) => [target.id, target.name]))
      state.environment = targetBody.environment || state.environment
      const allowedIds = new Set([binding.targetId, ...(binding.remoteTargetIds || [])])
      state.targets = allTargets.filter(
        (target) => allowedIds.has(target.id) && (!pcInPlaceOnly || target.id !== binding.targetId)
      )
      state.siteTargetId = pcInPlaceOnly
        ? null
        : state.targets.some((target) => target.id === binding.targetId)
          ? binding.targetId
          : null
      elements.pageTitle.textContent = resolution.directConfigurationGroup?.name || binding.name
    } else {
      state.targets = []
      state.targetNames = {}
      state.siteTargetId = null
      state.siteOverrideEnabled = false
    }

    const catalogs = await Promise.all(
      state.targets.map(async (target) => [
        target.id,
        await api(
          `/api/v1/build-targets/${encodeURIComponent(target.id)}/branches?environment=${encodeURIComponent(state.environment?.slug || '')}`
        ),
      ])
    )
    if (generation !== loadGeneration) return
    state.branches = Object.fromEntries(catalogs)
    const persistedPopupState =
      binding && state.environment
        ? await readPersistedPopupState(tab?.id, binding.id, state.environment.slug).catch(
            () => null
          )
        : null
    if (generation !== loadGeneration) return
    const defaultSelectedBranches = {}
    const activeMatchesScope =
      state.active?.preview?.siteBindingId === binding?.id &&
      state.active?.preview?.environmentSlug === state.environment?.slug
    for (const target of state.targets) {
      defaultSelectedBranches[target.id] = ''
      if (!activeMatchesScope) continue
      if (target.id === state.siteTargetId) {
        defaultSelectedBranches[target.id] = state.active?.preview?.siteArtifactId
          ? state.active?.preview?.siteSelection?.branch ||
            branchForArtifact(target.id, state.active.preview.siteArtifactId)
          : ''
        continue
      }
      const activeSelection = state.active?.preview?.selections?.find(
        (item) => item.targetId === target.id
      )
      defaultSelectedBranches[target.id] = activeSelection
        ? activeSelection.source === 'tttt'
          ? TTTT_REMOTE_SOURCE_BRANCH
          : activeSelection.branch || branchForArtifact(target.id, activeSelection.artifactId)
        : ''
    }
    const directConfigurationGroupSelections = resolution.directConfigurationGroup
      ? Object.fromEntries(
          resolution.directConfigurationGroup.items.map((item) => [
            item.targetId,
            item.mode === 'branch' ? item.branch : '',
          ])
        )
      : null
    const inMemoryPopupState = sameScope
      ? {
          selectedBranches: previousSelectedBranches,
          submittedBuildBranches: previousSubmittedBuildBranches,
          siteOverrideEnabled: state.siteOverrideEnabled,
        }
      : null
    // During an in-place refresh the popup's current selection is newer than the persisted
    // snapshot. On a newly opened popup there is no in-memory scope, so the worker snapshot wins.
    const restoredPopupState = chooseRestoredPopupState(inMemoryPopupState, persistedPopupState)
    state.selectedBranches = directConfigurationGroupSelections
      ? mergeSelectedBranches({
          sameBinding: true,
          previous: directConfigurationGroupSelections,
          defaults: defaultSelectedBranches,
        })
      : mergeSelectedBranches({
          sameBinding: Boolean(restoredPopupState),
          previous: restoredPopupState?.selectedBranches || {},
          defaults: defaultSelectedBranches,
        })
    for (const [targetId, branch] of Object.entries(state.selectedBranches)) {
      if (
        branch === LEGACY_TTTT_PAGE_ROUTE_BRANCH ||
        (!isLocalhostTab() && isTtttRemoteSourceBranch(branch))
      ) {
        state.selectedBranches[targetId] = ''
      }
    }
    state.siteOverrideEnabled = directConfigurationGroupSelections
      ? Boolean(state.siteTargetId && directConfigurationGroupSelections[state.siteTargetId])
      : restoredPopupState?.siteOverrideEnabled === true
    if (state.inPlaceRule) state.siteOverrideEnabled = false
    const allowedTargetIds = new Set(state.targets.map((target) => target.id))
    state.submittedBuildBranches = Object.fromEntries(
      Object.entries(restoredPopupState?.submittedBuildBranches || {}).filter(([targetId]) =>
        allowedTargetIds.has(targetId)
      )
    )
    void persistCurrentPopupState()
    if (state.environment && !tabEnvironmentSlug && !state.inPlaceRule) {
      void persistEnvironmentSelection(state.environment.slug, { rememberGlobally: false })
    }
    renderActive()
    renderModules()
    renderConfigurationGroups()
    renderBuildQueue()
    renderBuildHistory()
    setStatus(
      binding
        ? resolution.directConfigurationGroup
          ? `正在预览配置组「${resolution.directConfigurationGroup.name}」 · ${state.environment?.name || '暂无环境'}`
          : `已关联 ${binding.hostname} · ${state.environment?.name || '暂无环境'}`
        : `${SITE_BINDING_REQUIRED}，Remote 热更不能单独应用到官网标签页`,
      binding ? '' : 'warning'
    )
    if (state.workspaceTab === 'queue' && state.buildTaskTab === 'history') {
      await refreshBuildHistory()
      if (generation !== loadGeneration) return
    }
    scheduleQueuePoll()
  } catch (error) {
    if (generation !== loadGeneration) return
    state.binding = null
    state.environment = null
    state.environments = []
    state.targets = []
    state.targetNames = {}
    state.siteTargetId = null
    invalidateBuildHistory()
    renderEnvironmentPicker()
    renderActive()
    renderModules()
    renderBuildQueue()
    renderBuildHistory()
    setStatus(`连接失败：${errorText(error)}`, 'warning')
  }
}

async function createBuild(targetId, branch) {
  const operation = {
    ...currentOperationContext(targetId, branch),
    controlOrigin: state.controlOrigin,
    csrfToken: state.csrfToken,
    token: crypto.randomUUID(),
  }
  if (!operation.environmentSlug) {
    setStatus('当前页面没有可用环境，无法发起打包', 'warning')
    return
  }
  const target = state.targets.find((candidate) => candidate.id === targetId)
  if (!target?.enabled || !target.configured || state.environment?.status !== 'ACTIVE') {
    setStatus(
      !target?.configured
        ? '项目没有配置 Git 仓库，只能选择已有产物进行预览'
        : state.environment?.status === 'FROZEN'
          ? '当前环境已冻结，只能选择已有产物进行预览'
          : '项目当前不可构建',
      'warning'
    )
    return
  }
  state.busyTargets.set(targetId, operation)
  renderModules()
  setStatus(`${branch} 正在提交打包任务`, 'busy')
  try {
    const job = await apiWithContext(operation, '/api/v1/build-jobs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        environmentSlug: operation.environmentSlug,
        targetId,
        branch,
        profile: 'qa-web',
      }),
    })
    scheduleQueuePoll(300)
    const operationStillInScope = operationMatchesContext(
      operation,
      currentOperationContext(targetId, state.selectedBranches[targetId] || '')
    )
    if (!operationStillInScope) return
    const sameSelectedBranch = operationMatchesContext(
      operation,
      currentOperationContext(targetId, state.selectedBranches[targetId] || ''),
      { requireBranch: true }
    )
    if (sameSelectedBranch) {
      state.submittedBuildBranches[targetId] = branch
      void persistCurrentPopupState()
    }
    state.queue = {
      ...state.queue,
      queued: [
        ...(state.queue.queued || []).filter((item) => item.id !== job.id),
        {
          id: job.id,
          environmentId: job.environmentId,
          environmentSlug: job.environmentSlug,
          targetId: job.targetId,
          branch: job.branch,
          status: job.status,
          requestedBy: job.requestedBy,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          queuePosition: null,
          isMine: true,
        },
      ],
    }
    renderBuildQueue()
    markBuildHistoryDirty()
    setStatus(`${branch} 已加入 ${operation.environmentSlug} 环境的全局队列`, 'success')
  } catch (error) {
    if (
      operationMatchesContext(
        operation,
        currentOperationContext(targetId, state.selectedBranches[targetId] || '')
      )
    ) {
      setStatus(`提交失败：${errorText(error)}`, 'warning')
    }
  } finally {
    if (state.busyTargets.get(targetId)?.token === operation.token) {
      state.busyTargets.delete(targetId)
      renderModules()
    }
  }
}

async function applyPreview() {
  if (state.applyingToken) return
  const tab = state.tab ? { id: state.tab.id, url: state.tab.url } : null
  const selectedSnapshot = selectedArtifacts()
  const sourceOverrides = selectedSourceOverrides()
  const selected = {
    siteArtifactId: selectedSnapshot.siteArtifactId,
    selections: selectedSnapshot.selections.map((selection) => ({ ...selection })),
    missing: selectedSnapshot.missing.map((item) => ({ ...item })),
  }
  if (selected.missing.length) {
    const first = selected.missing[0]
    setStatus(`${first.targetName} 的 ${first.branch} 尚无成功可用的产物，请先打包`, 'warning')
    return
  }
  const binding = state.binding
    ? {
        ...state.binding,
        remoteTargetIds: [...(state.binding.remoteTargetIds || [])],
      }
    : null
  const operation = {
    ...currentOperationContext(),
    controlOrigin: state.controlOrigin,
    csrfToken: state.csrfToken,
    binding,
    tab,
    token: crypto.randomUUID(),
  }
  const plan = planPreviewApplication({
    binding,
    environmentSlug: operation.environmentSlug,
    previewOrigin: previewOrigin(),
    currentUrl: tab?.url || '',
    siteArtifactId: selected.siteArtifactId,
    selections: [...selected.selections, ...sourceOverrides],
    inPlaceRule: state.inPlaceRule,
  })
  if (!tab?.id) return
  if (!plan.canApply) {
    setStatus(plan.reason, 'warning')
    return
  }
  state.applyingToken = operation.token
  renderModules()
  setStatus(
    plan.mode === 'official'
      ? '正在恢复官网版本'
      : plan.mode === 'remote'
        ? '正在创建原地热更预览'
        : '正在创建标签页预览',
    'busy'
  )
  let preview = null
  try {
    await requireExtensionCapabilities((message) => chrome.runtime.sendMessage(message))

    if (plan.mode === 'official') {
      const result = await chrome.runtime.sendMessage({
        type: REMOVE_PREVIEW_TRANSACTION_COMMAND,
        tabId: tab.id,
      })
      if (!result?.ok) throw new Error(extensionCommandErrorMessage(result, '官网版本应用失败'))
      if (operationMatchesContext(operation, currentOperationContext())) {
        state.active = null
        renderActive()
        setStatus(
          pcInPlaceOnly || isLocalhostTab()
            ? `${state.environment?.name || operation.environmentSlug} 已保留本地 devserver，正在刷新当前页面`
            : `${state.environment?.name || operation.environmentSlug} 已应用，页面与热更使用官网版本`,
          'success'
        )
      }
      return
    }

    const requestedOrigins = [
      `${plan.requestedOrigin}/*`,
      ...(plan.mode === 'remote' ? [`${plan.pageOrigin}/*`] : []),
    ].filter((origin, index, items) => items.indexOf(origin) === index)
    for (const origin of requestedOrigins) await ensureOriginPermission(origin)

    preview = await apiWithContext(operation, '/api/v1/previews', {
      method: 'POST',
      body: JSON.stringify(
        createPreviewRequest({
          binding,
          environmentSlug: operation.environmentSlug,
          siteArtifactId: selected.siteArtifactId,
          selections: selected.selections,
        })
      ),
    })

    const origin = plan.requestedOrigin
    const result = await chrome.runtime.sendMessage(
      plan.mode === 'remote'
        ? {
            type: APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
            tabId: tab.id,
            previewOrigin: origin,
            pageOrigin: plan.pageOrigin,
            controlOrigin: operation.controlOrigin,
            officialOrigin: binding.officialOrigin,
            bindingEnvironmentSlug: binding.environmentSlug,
            sourceOverrides,
            inPlaceRule: plan.inPlaceRule || null,
            originalUrl: tab.url,
            preview,
          }
        : {
            type: APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
            tabId: tab.id,
            previewOrigin: origin,
            controlOrigin: operation.controlOrigin,
            officialOrigin: binding.officialOrigin,
            originalUrl: tab.url,
            targetUrl: previewDestinationUrl(origin, tab.url),
            preview,
          }
    )
    if (!result?.ok) throw new Error(extensionCommandErrorMessage(result, '扩展规则应用失败'))
    if (operationMatchesContext(operation, currentOperationContext())) {
      state.active = result.active
      renderActive()
      setStatus(
        pcInPlaceOnly
          ? selected.selections.length || sourceOverrides.length
            ? '热更预览已原地应用，正在刷新 KOOK'
            : `${state.environment?.name || operation.environmentSlug} 已恢复官方热更，正在刷新 KOOK`
          : selected.siteArtifactId
            ? '页面与热更预览已应用，正在打开预览域名'
            : selected.selections.length || sourceOverrides.length
              ? plan.mode === 'remote'
                ? '热更预览已原地应用，正在刷新当前页面'
                : '热更预览已应用，正在打开隔离预览域名'
              : `${state.environment?.name || operation.environmentSlug} 已应用，页面与热更使用官网版本`,
        'success'
      )
    }
  } catch (error) {
    if (preview?.token) {
      await apiWithContext(operation, `/api/v1/previews/${encodeURIComponent(preview.token)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => undefined)
    }
    if (operationMatchesContext(operation, currentOperationContext())) {
      setStatus(`应用失败：${errorText(error)}`, 'warning')
    }
  } finally {
    if (state.applyingToken === operation.token) {
      state.applyingToken = null
      renderModules()
    }
  }
}

async function removePreview() {
  if (!state.tab?.id) return
  setStatus('正在停用当前标签页预览', 'busy')
  const result = await chrome.runtime.sendMessage({
    type: REMOVE_PREVIEW_TRANSACTION_COMMAND,
    tabId: state.tab.id,
  })
  if (!result?.ok) {
    setStatus(`停用失败：${extensionCommandErrorMessage(result, '扩展规则移除失败')}`, 'warning')
    return
  }
  state.active = null
  state.siteOverrideEnabled = false
  void persistCurrentPopupState()
  renderActive()
  renderModules()
  setStatus('预览已停用', 'success')
}

async function changeEnvironment() {
  if (state.inPlaceRule) return
  const environment = state.environments.find(
    (candidate) => candidate.slug === elements.environmentSelect.value
  )
  if (!environment || environment.slug === state.environment?.slug) return

  state.environmentChanging = true
  renderEnvironmentPicker()
  setStatus(`正在切换到 ${environmentOptionLabel(environment)}`, 'busy')
  try {
    await persistEnvironmentSelection(environment.slug)
    await load()
  } catch (error) {
    renderEnvironmentPicker()
    setStatus(`环境切换失败：${errorText(error)}`, 'warning')
  } finally {
    state.environmentChanging = false
    renderEnvironmentPicker()
  }
}

async function saveSettings(event) {
  event.preventDefault()
  const origin = new URL(elements.controlOrigin.value).origin
  const permission = `${origin}/*`
  const granted = await chrome.permissions.request({ origins: [permission] })
  if (!granted) {
    setStatus(`未获得 ${origin} 的访问权限，服务地址没有修改`, 'warning')
    return
  }
  state.controlOrigin = origin
  await chrome.storage.local.set({ [CONTROL_KEY]: origin })
  elements.settingsDialog.close()
  await load()
}

elements.refreshButton.addEventListener('click', () => void load({ resetSubmitted: true }))
elements.loginButton.addEventListener('click', () => void startFeishuLogin())
elements.logoutButton.addEventListener('click', () => void logout())
elements.identityAvatar.addEventListener('error', () => {
  elements.identityAvatar.hidden = true
  elements.identityAvatarFallback.hidden = false
})
elements.shareButton.addEventListener('click', openShareDialog)
elements.shareClose.addEventListener('click', () => elements.shareDialog.close())
elements.shareCancel.addEventListener('click', () => elements.shareDialog.close())
elements.shareForm.addEventListener('submit', (event) => void shareConfiguration(event))
elements.shareName.addEventListener('input', renderShareDialog)
elements.shareUrlPrefix.addEventListener('input', renderShareDialog)
elements.shareDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  if (!state.sharing) elements.shareDialog.close()
})
elements.shareDialog.addEventListener('click', (event) => {
  if (event.target === elements.shareDialog && !state.sharing) elements.shareDialog.close()
})
elements.projectsTab.addEventListener('click', () => setWorkspaceTab('projects'))
elements.queueTab.addEventListener('click', () => {
  setWorkspaceTab('queue')
  if (state.buildTaskTab === 'history') void refreshBuildHistory()
})
elements.projectsTab.addEventListener('keydown', handleWorkspaceTabKey)
elements.queueTab.addEventListener('keydown', handleWorkspaceTabKey)
elements.buildQueueTab.addEventListener('click', () => setBuildTaskTab('queue'))
elements.buildHistoryTab.addEventListener('click', () =>
  setBuildTaskTab('history', { refresh: true })
)
elements.buildQueueTab.addEventListener('keydown', handleBuildTaskTabKey)
elements.buildHistoryTab.addEventListener('keydown', handleBuildTaskTabKey)
elements.buildHistoryRefresh.addEventListener('click', () => void refreshBuildHistory())
elements.buildHistoryTarget.addEventListener('change', () =>
  updateBuildHistoryFilter('buildHistoryTargetId', elements.buildHistoryTarget.value)
)
elements.buildHistoryStatus.addEventListener('change', () =>
  updateBuildHistoryFilter('buildHistoryStatus', elements.buildHistoryStatus.value)
)
elements.buildHistoryQuery.addEventListener('input', () =>
  updateBuildHistoryFilter('buildHistoryQuery', elements.buildHistoryQuery.value, {
    debounce: true,
  })
)
elements.buildHistoryQuery.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  void refreshBuildHistory()
})
elements.buildHistoryPageSize.addEventListener('change', () => {
  const pageSize = Number(elements.buildHistoryPageSize.value)
  if (!BUILD_HISTORY_PAGE_SIZES.includes(pageSize)) return
  state.buildHistory = { ...state.buildHistory, page: 1, pageSize }
  void refreshBuildHistory()
})
elements.buildHistoryPage.addEventListener('change', () =>
  changeBuildHistoryPage(elements.buildHistoryPage.value)
)
elements.buildHistoryPrevious.addEventListener('click', () =>
  changeBuildHistoryPage(state.buildHistory.page - 1)
)
elements.buildHistoryNext.addEventListener('click', () =>
  changeBuildHistoryPage(state.buildHistory.page + 1)
)
elements.requirementsTab.addEventListener('click', () =>
  setProjectVersionTab('requirements', { persist: true })
)
elements.branchesTab.addEventListener('click', () =>
  setProjectVersionTab('branches', { persist: true })
)
elements.requirementsTab.addEventListener('keydown', handleProjectVersionTabKey)
elements.branchesTab.addEventListener('keydown', handleProjectVersionTabKey)
elements.requirementsRefresh.addEventListener('click', () => void refreshConfigurationGroups())
elements.configurationGroupEditForm.addEventListener(
  'submit',
  (event) => void updateConfigurationGroup(event)
)
elements.configurationGroupEditName.addEventListener('input', renderConfigurationGroupEditDialog)
elements.configurationGroupOverwrite.addEventListener('change', renderConfigurationGroupEditDialog)
elements.configurationGroupEditClose.addEventListener('click', closeConfigurationGroupEdit)
elements.configurationGroupEditCancel.addEventListener('click', closeConfigurationGroupEdit)
elements.configurationGroupEditDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  closeConfigurationGroupEdit()
})
elements.configurationGroupEditDialog.addEventListener('click', (event) => {
  if (event.target === elements.configurationGroupEditDialog) closeConfigurationGroupEdit()
})
elements.configurationGroupDeleteForm.addEventListener(
  'submit',
  (event) => void deleteConfigurationGroup(event)
)
elements.configurationGroupDeleteClose.addEventListener('click', closeConfigurationGroupDelete)
elements.configurationGroupDeleteCancel.addEventListener('click', closeConfigurationGroupDelete)
elements.configurationGroupDeleteDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  closeConfigurationGroupDelete()
})
elements.configurationGroupDeleteDialog.addEventListener('click', (event) => {
  if (event.target === elements.configurationGroupDeleteDialog) closeConfigurationGroupDelete()
})
elements.configurationGroupSiteForm.addEventListener('submit', (event) => {
  event.preventDefault()
  finishConfigurationGroupSiteChoice('complete')
})
elements.configurationGroupSiteRemote.addEventListener('click', () =>
  finishConfigurationGroupSiteChoice('remote-only')
)
elements.configurationGroupSiteClose.addEventListener('click', () =>
  finishConfigurationGroupSiteChoice('cancel')
)
elements.configurationGroupSiteCancel.addEventListener('click', () =>
  finishConfigurationGroupSiteChoice('cancel')
)
elements.configurationGroupSiteDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  finishConfigurationGroupSiteChoice('cancel')
})
elements.configurationGroupSiteDialog.addEventListener('close', () =>
  finishConfigurationGroupSiteChoice('cancel')
)
elements.configurationGroupSiteDialog.addEventListener('click', (event) => {
  if (event.target === elements.configurationGroupSiteDialog) {
    finishConfigurationGroupSiteChoice('cancel')
  }
})
elements.settingsButton.addEventListener('click', () => {
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal()
  elements.controlOrigin.focus()
})
elements.settingsCancel.addEventListener('click', () => elements.settingsDialog.close())
elements.settingsClose.addEventListener('click', () => elements.settingsDialog.close())
elements.settingsForm.addEventListener('submit', (event) => void saveSettings(event))
elements.environmentSelect.addEventListener('change', () => void changeEnvironment())
elements.applyButton.addEventListener('click', () => void applyPreview())
elements.removeButton.addEventListener('click', () => void removePreview())
elements.jobDetailClose.addEventListener('click', closeJobDetail)
elements.jobOverviewTab.addEventListener('click', () => void changeJobDetailTab('overview'))
elements.jobLogTab.addEventListener('click', () => void changeJobDetailTab('log'))
elements.jobDetailRetry.addEventListener('click', () => {
  if (state.selectedJobId) void retryBuildJob(state.selectedJobId)
})
elements.jobDetailCancel.addEventListener('click', () => {
  if (state.selectedJobId) void cancelBuildJob(state.selectedJobId)
})
elements.jobDetailContent.addEventListener('scroll', () => {
  state.jobDetailScrollTop = elements.jobDetailContent.scrollTop
})
elements.jobDetailDialog.addEventListener('cancel', (event) => {
  event.preventDefault()
  closeJobDetail()
})
elements.jobDetailDialog.addEventListener('click', (event) => {
  if (event.target === elements.jobDetailDialog) closeJobDetail()
})
window.addEventListener('unload', () => {
  if (queuePollTimer !== null) window.clearTimeout(queuePollTimer)
  clearBuildHistoryQueryTimer()
})

setWorkspaceTab(state.workspaceTab)
setBuildTaskTab(state.buildTaskTab)
elements.extensionVersion.textContent = `v${extensionManifest.version}`
elements.extensionVersion.title = `${productName} 浏览器扩展 ${extensionManifest.version}`
renderConfigurationGroups()
renderBuildHistory()
void load().finally(() => scheduleQueuePoll())
