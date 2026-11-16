const ACTIVE_KEY = 'cuddly.activePreviews'
const CONTROL_KEY = 'cuddly.controlOrigin'
const POPUP_SCOPED_STATE_KEY = 'cuddly.popupStateByTabBindingEnvironment.v2'
const TAB_ENVIRONMENT_PREFS_KEY = 'cuddly.environmentByTab.v1'
const READ_POPUP_SCOPED_STATE_COMMAND = 'read-popup-scoped-state'
const WRITE_POPUP_SCOPED_STATE_COMMAND = 'write-popup-scoped-state'
const READ_IN_PLACE_HOT_MODULE_CONFIG_COMMAND = 'read-in-place-hot-module-config'
const REMEMBER_HOT_MODULE_REQUEST_CONTEXT_COMMAND = 'remember-hot-module-request-context'
const HOT_MODULE_REQUEST_CONTEXT_KEY = 'cuddly.hotModuleRequestContextByTab.v1'
const LOCALHOST_REMOTE_HANDOFF_KEY = '__BIFROST_LOCALHOST_REMOTE_HANDOFF_V1__'
const MAX_SCOPED_STATES = 100
const PREVIEW_ALARM_PREFIX = 'cuddly.previewExpiry.'
const EXTENSION_PROTOCOL_VERSION = 13
const EXTENSION_CAPABILITIES_COMMAND = 'get-extension-capabilities'
const APPLY_CONFIGURATION_GROUP_COMMAND = 'apply-configuration-group'
const APPLY_SITE_PREVIEW_TRANSACTION_COMMAND = 'apply-site-preview-transaction'
const APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND = 'apply-remote-preview-transaction'
const REMOVE_PREVIEW_TRANSACTION_COMMAND = 'remove-preview-transaction'
const DEFAULT_CONTROL_ORIGIN = 'https://bifrost.vanillacake.cn'
const CONFIGURATION_GROUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/
const CONFIGURATION_GROUP_SITE_CONFIRMATION_CODE =
  'CONFIG_GROUP_SITE_OVERRIDE_CONFIRMATION_REQUIRED'
const EXTENSION_RELOAD_REQUIRED =
  '扩展前后台版本不一致，请在 chrome://extensions 重新加载浏览器扩展'
const PREVIEW_REVOKE_TIMEOUT_MS = 3_000
const TTTT_HOT_MODULE_TIMEOUT_MS = 5_000
const TTTT_PAGE_IDENTITY_TIMEOUT_MS = 8_000
const SITE_PREVIEW_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]
let mutationQueue = Promise.resolve()
let popupScopedStorageArea = null

function serializeMutation(task) {
  const result = mutationQueue.then(task, task)
  mutationQueue = result.catch(() => undefined)
  return result
}

function normalizeHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

function pageEnvironmentClass(value) {
  let hostname = ''
  try {
    hostname = new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'test'
  if (hostname === 'dev.chuanyuapp.com' || hostname.endsWith('.dev.chuanyuapp.com')) return 'test'
  if (hostname === 'kookapp.cn' || hostname.endsWith('.kookapp.cn')) return 'online'
  return ''
}

function originsShareEnvironment(left, right) {
  try {
    const leftOrigin = new URL(left).origin
    const rightOrigin = new URL(right).origin
    if (leftOrigin === rightOrigin) return true
    const leftClass = pageEnvironmentClass(leftOrigin)
    return Boolean(leftClass && leftClass === pageEnvironmentClass(rightOrigin))
  } catch {
    return false
  }
}

function normalizedSourceOverrides(value) {
  if (!Array.isArray(value) || value.length > 40) return []
  const seen = new Set()
  return value.flatMap((candidate) => {
    const moduleKey = typeof candidate?.moduleKey === 'string' ? candidate.moduleKey.trim() : ''
    if (
      candidate?.source !== 'tttt' ||
      !/^[A-Za-z0-9_]{1,80}$/.test(moduleKey) ||
      seen.has(moduleKey)
    ) {
      return []
    }
    seen.add(moduleKey)
    return [{ moduleKey, source: 'tttt' }]
  })
}

function normalizedHotModuleApp(value) {
  return typeof value === 'string' &&
    value &&
    value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : ''
}

function normalizedAuthorization(value) {
  return typeof value === 'string' &&
    value &&
    value.length <= 16 * 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : ''
}

async function rememberHotModuleRequestContext(message, sender) {
  const tabId = sender?.tab?.id
  const app = normalizedHotModuleApp(message?.app)
  let pageOrigin = ''
  try {
    pageOrigin = new URL(sender?.tab?.url || '').origin
  } catch {
    // The sender must be an injected top-frame script on a supported HTTP(S) page.
  }
  if (!Number.isInteger(tabId) || tabId < 0 || sender?.frameId !== 0 || !pageOrigin || !app) {
    throw new Error('Hot-module request context is invalid')
  }
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(HOT_MODULE_REQUEST_CONTEXT_KEY)
  const current =
    stored[HOT_MODULE_REQUEST_CONTEXT_KEY] &&
    typeof stored[HOT_MODULE_REQUEST_CONTEXT_KEY] === 'object' &&
    !Array.isArray(stored[HOT_MODULE_REQUEST_CONTEXT_KEY])
      ? stored[HOT_MODULE_REQUEST_CONTEXT_KEY]
      : {}
  const next = {
    ...current,
    [String(tabId)]: { app, pageOrigin, updatedAt: Date.now() },
  }
  await area.set({ [HOT_MODULE_REQUEST_CONTEXT_KEY]: next })
}

async function readHotModuleRequestContext(tabId, pageOrigin) {
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(HOT_MODULE_REQUEST_CONTEXT_KEY)
  const context = stored[HOT_MODULE_REQUEST_CONTEXT_KEY]?.[String(tabId)]
  return context?.pageOrigin === pageOrigin && normalizedHotModuleApp(context.app) ? context : null
}

async function removeHotModuleRequestContext(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(HOT_MODULE_REQUEST_CONTEXT_KEY)
  const current = stored[HOT_MODULE_REQUEST_CONTEXT_KEY]
  if (
    !current ||
    typeof current !== 'object' ||
    Array.isArray(current) ||
    !current[String(tabId)]
  ) {
    return
  }
  const next = { ...current }
  delete next[String(tabId)]
  await area.set({ [HOT_MODULE_REQUEST_CONTEXT_KEY]: next })
}

function hotModuleRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if ('code' in body && body.code !== 0 && body.code !== '0') return null
  const root = 'data' in body ? body.data : body
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  if (Array.isArray(root.modules)) {
    return Object.fromEntries(
      root.modules.flatMap((item) =>
        item && typeof item === 'object' && typeof item.key === 'string' ? [[item.key, item]] : []
      )
    )
  }
  if (root.modules && typeof root.modules === 'object' && !Array.isArray(root.modules)) {
    return root.modules
  }
  return root
}

function remoteEntrySelection(moduleKey, record) {
  const candidates =
    moduleKey === 'base' ? [record[moduleKey], record.base_new] : [record[moduleKey]]
  const item = candidates.find(
    (candidate) =>
      typeof candidate === 'string' ||
      (candidate && typeof candidate === 'object' && typeof candidate.entry === 'string')
  )
  const entryValue = typeof item === 'string' ? item : item?.entry
  let entry
  try {
    entry = new URL(entryValue)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password) return null
  const pathParts = entry.pathname.split('/').filter(Boolean)
  const entryIndex = pathParts.lastIndexOf('remoteEntry.js')
  const derivedName = entryIndex > 0 ? pathParts[entryIndex - 1] : moduleKey
  const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : derivedName
  const version =
    typeof item?.version === 'string' && item.version.trim() ? item.version.trim() : name
  if (!name || name.length > 160 || !version || version.length > 320) return null
  return {
    source: 'tttt',
    moduleKey,
    targetId: moduleKey,
    branch: '走tttt',
    providerName: name,
    version,
    entry: entry.href,
    restartRequired: true,
  }
}

function ttttSourceSelections(sourceOverrides, record) {
  const selections = sourceOverrides.map(({ moduleKey }) => remoteEntrySelection(moduleKey, record))
  return selections.every(Boolean) ? selections : null
}

async function readPageRequestIdentity(tabId, pageOrigin) {
  const tab = await chrome.tabs.get(tabId)
  if (!tab?.url || new URL(tab.url).origin !== pageOrigin) {
    throw new Error('当前标签页已经变化，请重新打开扩展后再试')
  }
  const storedContext = await readHotModuleRequestContext(tabId, pageOrigin)
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      let app = ''
      try {
        const config = window.__KOOK_HOST_CONTEXT__?.services?.config
        const getAppVersion = config?.getAppVersion
        const version =
          typeof getAppVersion === 'function'
            ? await Promise.resolve(getAppVersion.call(config))
            : null
        if (typeof version === 'string' || typeof version === 'number') app = String(version)
      } catch {
        // Local devservers may expose only part of __KOOK_HOST_CONTEXT__ during early bootstrap.
      }
      try {
        if (!app) {
          const entries = performance.getEntriesByType('resource')
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const url = new URL(entries[index].name, window.location.href)
            if (
              url.origin === window.location.origin &&
              (url.pathname === '/api/v3/version/hot-module' ||
                url.pathname === '/v3/version/hot-module')
            ) {
              app = url.searchParams.get('app') || ''
              if (app) break
            }
          }
        }
      } catch {
        // The host context and document-start hook remain the primary version sources.
      }
      return { authorization: localStorage.getItem('authorization'), app }
    },
  })
  const pageIdentity = results?.[0]?.result
  const authorization = pageIdentity?.authorization
  const app =
    normalizedHotModuleApp(storedContext?.app) || normalizedHotModuleApp(pageIdentity?.app)
  if (typeof authorization !== 'string' || !authorization) {
    throw new Error('未读取到当前页面 localStorage.authorization，请先登录测试环境')
  }
  if (!app) {
    throw new Error(
      '无法从 __KOOK_HOST_CONTEXT__ 或 hot-module 请求中读取 app 版本，请确认本地页面已完成初始化'
    )
  }
  return { authorization, app }
}

function ttttHotModuleUrl(origin, app) {
  const url = new URL('/api/v3/version/hot-module', origin)
  url.searchParams.set('app', app)
  return url
}

async function readTtttHotModuleWithPageIdentity(officialUrl, identity) {
  const hotModuleUrl = ttttHotModuleUrl(officialUrl, identity.app)
  let temporaryTabId = null
  try {
    const temporaryTab = await chrome.tabs.create({ url: officialUrl.origin, active: false })
    if (!Number.isInteger(temporaryTab?.id)) return null
    temporaryTabId = temporaryTab.id

    const deadline = Date.now() + TTTT_PAGE_IDENTITY_TIMEOUT_MS
    let loadedTab = temporaryTab
    while (loadedTab.status !== 'complete') {
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
      loadedTab = await chrome.tabs.get(temporaryTabId)
    }
    if (!loadedTab.url || new URL(loadedTab.url).origin !== officialUrl.origin) return null

    const results = await chrome.scripting.executeScript({
      target: { tabId: temporaryTabId },
      world: 'MAIN',
      args: [hotModuleUrl.href, identity.authorization],
      func: async (url, authorization) => {
        const response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          headers: { accept: 'application/json', Authorization: authorization },
        })
        return {
          ok: response.ok,
          status: response.status,
          body: await response.json().catch(() => null),
        }
      },
    })
    const result = results?.[0]?.result
    return result?.ok ? hotModuleRecord(result.body) : null
  } catch {
    return null
  } finally {
    if (temporaryTabId !== null) await chrome.tabs.remove(temporaryTabId).catch(() => undefined)
  }
}

async function resolveTtttSourceSelections(sourceOverrides, pageOrigin, officialOrigin, tabId) {
  if (!sourceOverrides.length) return []
  const pageUrl = new URL(pageOrigin)
  const officialUrl = new URL(officialOrigin)
  if (
    pageUrl.hostname.toLowerCase() !== 'localhost' ||
    pageEnvironmentClass(officialUrl.origin) !== 'test'
  ) {
    throw new Error('走tttt 只能用于 localhost 的测试环境页面')
  }
  const identity = await readPageRequestIdentity(tabId, pageUrl.origin)
  const candidates = [
    ttttHotModuleUrl(pageUrl, identity.app).href,
    ttttHotModuleUrl(officialUrl, identity.app).href,
  ].filter((value, index, items) => items.indexOf(value) === index)
  for (const url of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TTTT_HOT_MODULE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
        headers: { accept: 'application/json', Authorization: identity.authorization },
        signal: controller.signal,
      })
      if (!response.ok) continue
      const record = hotModuleRecord(await response.json().catch(() => null))
      if (!record) continue
      const selections = ttttSourceSelections(sourceOverrides, record)
      if (selections) return selections
    } catch {
      // Try the bound tttt origin when the local devserver does not proxy this endpoint.
    } finally {
      clearTimeout(timeout)
    }
  }
  const pageRecord = await readTtttHotModuleWithPageIdentity(officialUrl, identity)
  const pageSelections = pageRecord ? ttttSourceSelections(sourceOverrides, pageRecord) : null
  if (pageSelections) return pageSelections
  throw new Error('无法读取 tttt 当前热更版本，请确认本地代理或 tttt 登录状态')
}

function normalizeInPlaceUrlRules(value) {
  if (!Array.isArray(value)) return []
  const seenPatterns = new Set()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const pattern = typeof candidate.pattern === 'string' ? candidate.pattern.trim() : ''
    const environmentSlug =
      typeof candidate.environmentSlug === 'string' ? candidate.environmentSlug.trim() : ''
    if (
      !pattern ||
      pattern.length > 2048 ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(environmentSlug) ||
      seenPatterns.has(pattern)
    ) {
      return []
    }
    seenPatterns.add(pattern)
    return [{ pattern, environmentSlug }]
  })
}

function matchInPlaceUrlRule(url, rules) {
  if (typeof url !== 'string' || !url) return null
  return normalizeInPlaceUrlRules(rules).reduce((best, rule) => {
    if (!url.includes(rule.pattern)) return best
    return !best || rule.pattern.length > best.pattern.length ? rule : best
  }, null)
}

async function runtimeInPlaceUrlRules(controlOrigin, context = null) {
  const origin = new URL(controlOrigin).origin
  const response = context
    ? await authenticatedRequest(context, '/api/v1/runtime', { method: 'GET', cache: 'no-store' })
    : await fetch(`${origin}/api/v1/runtime`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
      })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error('无法读取官网原地应用规则，请检查登录状态后重试')
  return normalizeInPlaceUrlRules(body?.inPlaceUrlRules)
}

async function configuredInPlaceUrlRule(controlOrigin, tabUrl, context = null) {
  return matchInPlaceUrlRule(tabUrl, await runtimeInPlaceUrlRules(controlOrigin, context))
}

function sameInPlaceUrlRule(left, right) {
  return (
    Boolean(left) === Boolean(right) &&
    (!left || (left.pattern === right.pattern && left.environmentSlug === right.environmentSlug))
  )
}

function staticInPlaceScriptsCoverOrigin(origin) {
  const match = `${origin}/*`
  return (chrome.runtime.getManifest?.().content_scripts || []).some((entry) =>
    Array.isArray(entry.matches) ? entry.matches.includes(match) : false
  )
}

function dynamicInPlaceScriptHash(value) {
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`
}

function dynamicInPlaceScriptIds(origin) {
  const hash = dynamicInPlaceScriptHash(new URL(origin).origin)
  return [`cuddly-in-place-main-${hash}`, `cuddly-in-place-bridge-${hash}`]
}

function dynamicInPlaceScripts(origin) {
  const normalizedOrigin = new URL(origin).origin
  const ids = dynamicInPlaceScriptIds(normalizedOrigin)
  return [
    {
      id: ids[0],
      matches: [`${normalizedOrigin}/*`],
      js: ['in-place-hot-module-main.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true,
    },
    {
      id: ids[1],
      matches: [`${normalizedOrigin}/*`],
      js: ['in-place-hot-module-bridge.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      persistAcrossSessions: true,
    },
  ]
}

async function ensureDynamicInPlaceScripts(origin) {
  if (staticInPlaceScriptsCoverOrigin(origin)) return []
  if (
    !chrome.scripting?.registerContentScripts ||
    !chrome.scripting?.getRegisteredContentScripts ||
    !chrome.scripting?.updateContentScripts
  ) {
    throw new Error('当前扩展版本无法为这个官网地址启用原地热更，请重新加载扩展')
  }
  const normalizedOrigin = new URL(origin).origin
  const permission = { origins: [`${normalizedOrigin}/*`] }
  if (!(await chrome.permissions.contains(permission))) {
    throw new Error(`尚未获得 ${normalizedOrigin} 的页面访问权限，请从扩展面板重新应用`)
  }
  const scripts = dynamicInPlaceScripts(normalizedOrigin)
  const ids = scripts.map((script) => script.id)
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids })
  const registeredIds = new Set(registered.map((script) => script.id))
  const updates = scripts.filter((script) => registeredIds.has(script.id))
  const additions = scripts.filter((script) => !registeredIds.has(script.id))
  if (updates.length) await chrome.scripting.updateContentScripts(updates)
  if (additions.length) await chrome.scripting.registerContentScripts(additions)
  return ids
}

async function reconcileDynamicInPlaceScripts() {
  if (!chrome.scripting?.getRegisteredContentScripts) return
  const active = await readActivePreviews()
  let canRemoveLegacyScripts = true
  for (const preview of Object.values(active)) {
    if (preview?.mode !== 'remote' || !preview?.inPlaceRule || !preview?.pageOrigin) continue
    try {
      await ensureDynamicInPlaceScripts(preview.pageOrigin)
    } catch {
      canRemoveLegacyScripts = false
    }
  }
  if (!canRemoveLegacyScripts || !chrome.scripting?.unregisterContentScripts) return
  const registered = await chrome.scripting.getRegisteredContentScripts()
  const legacyIds = registered
    .map((script) => script.id)
    .filter((id) => /^cuddly-in-place-(?:main|bridge)-\d+$/.test(id))
  if (legacyIds.length) await chrome.scripting.unregisterContentScripts({ ids: legacyIds })
}

async function configuredControlOrigin() {
  const stored = await chrome.storage.local.get(CONTROL_KEY)
  return normalizeHttpOrigin(stored[CONTROL_KEY]) || DEFAULT_CONTROL_ORIGIN
}

async function authenticatedRequestContext(controlOrigin, init = {}) {
  const origin = new URL(controlOrigin).origin
  const sessionResponse = await fetch(`${origin}/api/v1/auth/session`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    ...(init.signal ? { signal: init.signal } : {}),
  })
  const session = await sessionResponse.json().catch(() => null)
  const csrfToken =
    sessionResponse.ok && session?.authenticated === true && typeof session.csrfToken === 'string'
      ? session.csrfToken.trim()
      : ''
  if (!csrfToken) throw new Error('飞书登录状态无效，请重新登录')
  return { origin, csrfToken }
}

function authenticatedRequest(context, pathname, init = {}) {
  return fetch(`${context.origin}${pathname}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...init.headers,
      'x-cuddly-csrf': context.csrfToken,
    },
  })
}

async function authenticatedMutation(controlOrigin, pathname, init = {}) {
  const context = await authenticatedRequestContext(controlOrigin, init)
  return authenticatedRequest(context, pathname, init)
}

function configurationShareUrl(value, controlOrigin) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.origin !== controlOrigin) return null
    const match = /^\/s\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)
    if (!match || !CONFIGURATION_GROUP_TOKEN_PATTERN.test(match[1])) return null
    return {
      token: match[1],
      url: `${controlOrigin}/s/${match[1]}`,
    }
  } catch {
    return null
  }
}

function configurationGroupSelection(body, expectedToken) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Configuration group response is invalid')
  }
  const wrapped = body.configurationGroup !== undefined
  if (wrapped && body.mode !== 'preview' && body.mode !== 'official') {
    throw new Error('Configuration group response mode is invalid')
  }
  const group = wrapped ? body.configurationGroup : body
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error('Configuration group is missing')
  }
  if (group.token !== expectedToken) throw new Error('Configuration group token does not match')
  const name = typeof group.name === 'string' ? group.name.trim() : ''
  const environmentSlug =
    typeof group.environmentSlug === 'string' ? group.environmentSlug.trim() : ''
  if (!name || name.length > 80 || !environmentSlug) {
    throw new Error('Configuration group identity is invalid')
  }
  const hasRevision = group.revision !== undefined
  const revision = hasRevision ? Number(group.revision) : null
  if (hasRevision && (!Number.isInteger(revision) || revision < 1)) {
    throw new Error('Configuration group revision is invalid')
  }
  const binding = group.siteBinding
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('Configuration group site binding is missing')
  }
  const bindingId = typeof binding.id === 'string' ? binding.id.trim() : ''
  const hostname = typeof binding.hostname === 'string' ? binding.hostname.trim().toLowerCase() : ''
  const siteTargetId = typeof binding.targetId === 'string' ? binding.targetId.trim() : ''
  const officialOrigin = normalizeHttpOrigin(binding.officialOrigin)
  const bindingEnvironmentSlug =
    typeof binding.environmentSlug === 'string' ? binding.environmentSlug.trim() : ''
  if (!bindingId || !hostname || !officialOrigin || !bindingEnvironmentSlug) {
    throw new Error('Configuration group site binding is invalid')
  }
  if (!Array.isArray(group.items) || !group.items.length || group.items.length > 40) {
    throw new Error('Configuration group items are invalid')
  }
  const selectedBranches = {}
  for (const item of group.items) {
    const targetId = typeof item?.targetId === 'string' ? item.targetId.trim() : ''
    if (!targetId || targetId.length > 80 || Object.hasOwn(selectedBranches, targetId)) {
      throw new Error('Configuration group project is invalid')
    }
    if (item.mode === 'official') {
      selectedBranches[targetId] = ''
    } else if (
      item.mode === 'branch' &&
      typeof item.branch === 'string' &&
      item.branch.trim() &&
      item.branch.trim().length <= 240
    ) {
      selectedBranches[targetId] = item.branch.trim()
    } else {
      throw new Error('Configuration group branch selection is invalid')
    }
  }
  return {
    mode: wrapped ? body.mode : 'detail',
    group,
    bindingId,
    hostname,
    siteTargetId,
    officialOrigin,
    bindingEnvironmentSlug,
    name,
    environmentSlug,
    revision,
    selectedBranches,
    siteOverrideEnabled: Boolean(selectedBranches[siteTargetId]),
  }
}

function validatedPreviewResponse(body, selection) {
  if (selection.mode !== 'preview') return null
  const preview = body.preview
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new Error('Configuration group preview is missing')
  }
  if (
    typeof preview.token !== 'string' ||
    !preview.token ||
    preview.siteBindingId !== selection.bindingId ||
    preview.environmentSlug !== selection.environmentSlug ||
    !Number.isFinite(Date.parse(preview.expiresAt || '')) ||
    Date.parse(preview.expiresAt) <= Date.now()
  ) {
    throw new Error('Configuration group preview is invalid')
  }
  const previewOrigin = normalizeHttpOrigin(body.previewOrigin)
  if (!previewOrigin || new URL(previewOrigin).hostname.toLowerCase() !== selection.hostname) {
    throw new Error('Configuration group preview origin does not match its site binding')
  }
  return { preview, previewOrigin }
}

function stringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => typeof key === 'string' && typeof entry === 'string'
    )
  )
}

function popupStateScopeKey(tabId, bindingId, environmentSlug) {
  if (
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    typeof bindingId !== 'string' ||
    !bindingId ||
    typeof environmentSlug !== 'string' ||
    !environmentSlug
  ) {
    return ''
  }
  return `${tabId}:${bindingId}:${environmentSlug}`
}

function readScopedPopupState(store, { tabId, bindingId, environmentSlug }) {
  const key = popupStateScopeKey(tabId, bindingId, environmentSlug)
  const entry = key && store && typeof store === 'object' ? store[key] : null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return {
    selectedBranches: stringRecord(entry.selectedBranches),
    submittedBuildBranches: stringRecord(entry.submittedBuildBranches),
    siteOverrideEnabled: entry.siteOverrideEnabled === true,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
  }
}

function writeScopedPopupState(
  store,
  {
    tabId,
    bindingId,
    environmentSlug,
    selectedBranches,
    submittedBuildBranches,
    siteOverrideEnabled = false,
    updatedAt = Date.now(),
  }
) {
  const key = popupStateScopeKey(tabId, bindingId, environmentSlug)
  if (!key) throw new Error('Popup state scope is invalid')
  const next = {
    ...(store && typeof store === 'object' && !Array.isArray(store) ? store : {}),
    [key]: {
      selectedBranches: stringRecord(selectedBranches),
      submittedBuildBranches: stringRecord(submittedBuildBranches),
      siteOverrideEnabled: siteOverrideEnabled === true,
      updatedAt,
    },
  }
  return Object.fromEntries(
    Object.entries(next)
      .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
      .slice(0, MAX_SCOPED_STATES)
  )
}

function removeScopedPopupStatesForTab(store, tabId) {
  const prefix = `${tabId}:`
  return Object.fromEntries(
    Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {}).filter(
      ([key]) => !key.startsWith(prefix)
    )
  )
}

function retainScopedPopupStatesForTabs(store, tabIds) {
  const activeTabIds = new Set(tabIds)
  return Object.fromEntries(
    Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {}).filter(
      ([key]) => {
        const separator = key.indexOf(':')
        if (separator <= 0) return false
        const tabId = Number(key.slice(0, separator))
        return Number.isInteger(tabId) && activeTabIds.has(tabId)
      }
    )
  )
}

async function getPopupScopedStorageArea() {
  if (popupScopedStorageArea) return popupScopedStorageArea
  const session = chrome.storage?.session
  if (session?.get && session?.set) {
    try {
      await session.get(POPUP_SCOPED_STATE_KEY)
      popupScopedStorageArea = session
      return popupScopedStorageArea
    } catch {
      // Older Chromium builds can expose storage.session without making it usable here.
    }
  }
  popupScopedStorageArea = chrome.storage.local
  return popupScopedStorageArea
}

async function readPersistedPopupState(tabId, bindingId, environmentSlug) {
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(POPUP_SCOPED_STATE_KEY)
  return readScopedPopupState(stored[POPUP_SCOPED_STATE_KEY] || {}, {
    tabId,
    bindingId,
    environmentSlug,
  })
}

async function persistPopupState(message) {
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(POPUP_SCOPED_STATE_KEY)
  const next = writeScopedPopupState(stored[POPUP_SCOPED_STATE_KEY] || {}, message)
  await area.set({ [POPUP_SCOPED_STATE_KEY]: next })
  return readScopedPopupState(next, message)
}

async function persistActiveSiteOverride(tabId, active, enabled) {
  const bindingId =
    typeof active?.preview?.siteBindingId === 'string' ? active.preview.siteBindingId.trim() : ''
  const environmentSlug =
    typeof active?.preview?.environmentSlug === 'string'
      ? active.preview.environmentSlug.trim()
      : ''
  if (!bindingId || !environmentSlug) return
  const current = await readPersistedPopupState(tabId, bindingId, environmentSlug)
  await persistPopupState({
    tabId,
    bindingId,
    environmentSlug,
    selectedBranches: current?.selectedBranches || {},
    submittedBuildBranches: current?.submittedBuildBranches || {},
    siteOverrideEnabled: enabled === true,
  })
}

async function removePersistedPopupStatesForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return
  const area = await getPopupScopedStorageArea()
  const stored = await area.get(POPUP_SCOPED_STATE_KEY)
  const current = stored[POPUP_SCOPED_STATE_KEY] || {}
  const next = removeScopedPopupStatesForTab(current, tabId)
  if (Object.keys(next).length !== Object.keys(current).length) {
    await area.set({ [POPUP_SCOPED_STATE_KEY]: next })
  }
}

async function reconcilePersistedPopupStates() {
  const area = await getPopupScopedStorageArea()
  const [stored, tabs] = await Promise.all([
    area.get(POPUP_SCOPED_STATE_KEY),
    chrome.tabs.query({}),
  ])
  const current = stored[POPUP_SCOPED_STATE_KEY] || {}
  const next = retainScopedPopupStatesForTabs(
    current,
    tabs.flatMap((tab) => (Number.isInteger(tab.id) ? [tab.id] : []))
  )
  if (Object.keys(next).length !== Object.keys(current).length) {
    await area.set({ [POPUP_SCOPED_STATE_KEY]: next })
  }
}

function nextTabEnvironmentPreferences(
  store,
  {
    tabId,
    officialOrigin,
    environmentSlug,
    configurationGroupBindingId = '',
    configurationGroupHostname = '',
    updatedAt = Date.now(),
  }
) {
  const origin = normalizeHttpOrigin(officialOrigin)
  const slug = typeof environmentSlug === 'string' ? environmentSlug.trim() : ''
  const current = store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  if (!Number.isInteger(tabId) || tabId < 0 || !origin || !slug) return { ...current }
  return Object.fromEntries(
    Object.entries({
      ...current,
      [String(tabId)]: {
        officialOrigin: origin,
        environmentSlug: slug,
        ...(typeof configurationGroupBindingId === 'string' && configurationGroupBindingId
          ? {
              configurationGroupBindingId,
              configurationGroupHostname:
                typeof configurationGroupHostname === 'string'
                  ? configurationGroupHostname.trim().toLowerCase()
                  : '',
            }
          : {}),
        updatedAt,
      },
    })
      .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
      .slice(0, MAX_SCOPED_STATES)
  )
}

async function persistTabEnvironmentPreference(input) {
  const stored = await chrome.storage.local.get(TAB_ENVIRONMENT_PREFS_KEY)
  const next = nextTabEnvironmentPreferences(stored[TAB_ENVIRONMENT_PREFS_KEY] || {}, input)
  await chrome.storage.local.set({ [TAB_ENVIRONMENT_PREFS_KEY]: next })
}

async function removeTabEnvironmentPreference(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return
  const stored = await chrome.storage.local.get(TAB_ENVIRONMENT_PREFS_KEY)
  const current = stored[TAB_ENVIRONMENT_PREFS_KEY] || {}
  if (!Object.hasOwn(current, String(tabId))) return
  const next = { ...current }
  delete next[String(tabId)]
  await chrome.storage.local.set({ [TAB_ENVIRONMENT_PREFS_KEY]: next })
}

async function reconcileTabEnvironmentPreferences() {
  const [stored, tabs] = await Promise.all([
    chrome.storage.local.get(TAB_ENVIRONMENT_PREFS_KEY),
    chrome.tabs.query({}),
  ])
  const activeTabIds = new Set(
    tabs.flatMap((tab) => (Number.isInteger(tab.id) ? [String(tab.id)] : []))
  )
  const current = stored[TAB_ENVIRONMENT_PREFS_KEY] || {}
  const next = Object.fromEntries(
    Object.entries(current).filter(([tabId]) => activeTabIds.has(tabId))
  )
  if (Object.keys(next).length !== Object.keys(current).length) {
    await chrome.storage.local.set({ [TAB_ENVIRONMENT_PREFS_KEY]: next })
  }
}

async function readActivePreviews() {
  return (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY] || {}
}

async function writeActivePreviews(value) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: value })
}

function previewAlarmName(tabId) {
  return `${PREVIEW_ALARM_PREFIX}${tabId}`
}

function previewAlarmTabId(name) {
  if (!name.startsWith(PREVIEW_ALARM_PREFIX)) return null
  const tabId = Number(name.slice(PREVIEW_ALARM_PREFIX.length))
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null
}

function previewExpiresAt(active) {
  return Date.parse(active?.preview?.expiresAt || '')
}

async function schedulePreviewExpiry(tabId, active) {
  const when = previewExpiresAt(active)
  if (!Number.isFinite(when) || when <= Date.now()) {
    throw new Error('Preview session has already expired')
  }
  await chrome.alarms.create(previewAlarmName(tabId), { when })
}

async function revokeActivePreview(active) {
  const token = active?.preview?.token
  if (typeof token !== 'string' || !token || !active?.controlOrigin) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PREVIEW_REVOKE_TIMEOUT_MS)
  try {
    const origin = new URL(active.controlOrigin).origin
    const response = await authenticatedMutation(
      origin,
      `/api/v1/previews/${encodeURIComponent(token)}`,
      {
        method: 'DELETE',
        cache: 'no-store',
        keepalive: true,
        signal: controller.signal,
      }
    )
    return response.ok || response.status === 404
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function clearPreviewState(tabId) {
  const active = await readActivePreviews()
  const current = active[String(tabId)] || null
  if (current?.ruleIds?.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: current.ruleIds })
  }
  delete active[String(tabId)]
  await writeActivePreviews(active)
  await chrome.alarms.clear(previewAlarmName(tabId))
  return current
}

async function removePreview(tabId) {
  const current = await clearPreviewState(tabId)
  await clearLocalhostRemoteHandoff(tabId, current?.pageOrigin).catch(() => undefined)
  await persistActiveSiteOverride(tabId, current, false).catch(() => undefined)
  await revokeActivePreview(current)
  return current
}

async function nextRuleIds(count) {
  const rules = await chrome.declarativeNetRequest.getSessionRules()
  const first = rules.reduce((maximum, rule) => Math.max(maximum, rule.id), 1000) + 1
  return Array.from({ length: count }, (_value, index) => first + index)
}

function sitePreviewRules({ tabId, previewOrigin, token, previewHeaderRuleId }) {
  const origin = new URL(previewOrigin).origin
  return [
    {
      id: previewHeaderRuleId,
      priority: 3,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'x-cuddly-preview-token',
            operation: 'set',
            value: token,
          },
        ],
      },
      condition: {
        urlFilter: `|${origin}/`,
        resourceTypes: SITE_PREVIEW_RESOURCE_TYPES,
        tabIds: [tabId],
      },
    },
  ]
}

async function verifySitePreviewRule(tabId, targetUrl, ruleId) {
  if (typeof chrome.declarativeNetRequest.testMatchOutcome !== 'function') return
  let outcome
  try {
    outcome = await chrome.declarativeNetRequest.testMatchOutcome({
      url: targetUrl,
      type: 'main_frame',
      tabId,
    })
  } catch {
    // testMatchOutcome needs either activeTab or feedback permission. Automatic configuration
    // links may not have either, while the installed session rule still remains effective.
    return
  }
  const matched = outcome?.matchedRules?.some(
    (candidate) => (candidate?.ruleId ?? candidate?.rule?.ruleId) === ruleId
  )
  if (!matched) throw new Error('预览请求规则未命中当前页面，请重新加载扩展后再试')
}

function activeInPlaceUrlRule(active) {
  return normalizeInPlaceUrlRules(active?.inPlaceRule ? [active.inPlaceRule] : [])[0] || null
}

function rulesForActivePreview(tabId, active) {
  try {
    if (
      active?.mode === 'site' &&
      active.ruleIds?.length === 1 &&
      typeof active.preview?.token === 'string'
    ) {
      return sitePreviewRules({
        tabId,
        previewOrigin: active.previewOrigin,
        token: active.preview.token,
        previewHeaderRuleId: active.ruleIds[0],
      })
    }
    const inPlaceRule = activeInPlaceUrlRule(active)
    if (
      active?.mode === 'remote' &&
      active.ruleIds?.length === 0 &&
      typeof active.preview?.token === 'string' &&
      !active.preview.siteArtifactId &&
      Array.isArray(active.preview.selections) &&
      active.preview.selections.length > 0 &&
      active.pageOrigin &&
      active.previewOrigin &&
      active.bindingEnvironmentSlug &&
      active.preview.environmentSlug === active.bindingEnvironmentSlug &&
      (!active.inPlaceRule ||
        (inPlaceRule && inPlaceRule.environmentSlug === active.bindingEnvironmentSlug)) &&
      originsShareEnvironment(active.pageOrigin, active.officialOrigin)
    ) {
      return []
    }
  } catch {
    return null
  }
  return null
}

function activePreviewMatchesTab(active, tab) {
  if (!tab?.url) return false
  try {
    const expectedOrigin =
      active?.mode === 'site'
        ? active.previewOrigin
        : active?.mode === 'remote'
          ? active.pageOrigin
          : null
    const inPlaceRule = activeInPlaceUrlRule(active)
    return (
      Boolean(expectedOrigin) &&
      new URL(tab.url).origin === new URL(expectedOrigin).origin &&
      (!active?.inPlaceRule || (inPlaceRule && tab.url.includes(inPlaceRule.pattern)))
    )
  } catch {
    return false
  }
}

function remotePreviewSharesPageOrigin(active, tab) {
  if (active?.mode !== 'remote' || !active?.pageOrigin || !tab?.url) return false
  try {
    return new URL(tab.url).origin === new URL(active.pageOrigin).origin
  } catch {
    return false
  }
}

function inPlaceHotModuleEntry(previewOrigin, selection) {
  if (selection?.source === 'tttt') {
    try {
      const entry = new URL(selection.entry)
      return ['http:', 'https:'].includes(entry.protocol) && !entry.username && !entry.password
        ? entry.href
        : null
    } catch {
      return null
    }
  }
  if (
    typeof selection?.artifactId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selection.artifactId) ||
    typeof selection.providerName !== 'string' ||
    !/^[A-Za-z0-9_]+$/.test(selection.providerName) ||
    typeof selection.entryPath !== 'string'
  ) {
    return null
  }
  const entryPath = selection.entryPath.replaceAll('\\', '/')
  if (
    !entryPath ||
    entryPath.startsWith('/') ||
    entryPath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return null
  }
  try {
    const base = new URL(
      `/__cuddly/preview-artifacts/${selection.artifactId}/${selection.providerName}/`,
      previewOrigin
    )
    const entry = new URL(entryPath, base)
    return entry.origin === base.origin && entry.pathname.startsWith(base.pathname)
      ? entry.href
      : null
  } catch {
    return null
  }
}

function inPlaceHotModuleConfig(active, tab) {
  const inPlaceRule = activeInPlaceUrlRule(active)
  if (
    active?.mode !== 'remote' ||
    !activePreviewMatchesTab(active, tab) ||
    previewExpiresAt(active) <= Date.now() ||
    active.preview?.siteArtifactId ||
    !active.bindingEnvironmentSlug ||
    active.preview?.environmentSlug !== active.bindingEnvironmentSlug ||
    (active.inPlaceRule &&
      (!inPlaceRule || inPlaceRule.environmentSlug !== active.preview?.environmentSlug)) ||
    !originsShareEnvironment(active.pageOrigin, active.officialOrigin) ||
    !Array.isArray(active.preview?.selections)
  ) {
    return []
  }
  return active.preview.selections.flatMap((selection) => {
    const moduleKey = typeof selection?.moduleKey === 'string' ? selection.moduleKey.trim() : ''
    const name = typeof selection?.providerName === 'string' ? selection.providerName.trim() : ''
    const version = typeof selection?.version === 'string' ? selection.version.trim() : ''
    const entry = inPlaceHotModuleEntry(active.previewOrigin, selection)
    if (!moduleKey || moduleKey.length > 80 || !name || !version || !entry) return []
    return [{ moduleKey, name, entry, version, restartRequired: true }]
  })
}

function exactLocalhostOrigin(value) {
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' ? url.origin : null
  } catch {
    return null
  }
}

async function setLocalhostRemoteHandoff(tabId, pageOrigin, handoff) {
  const origin = exactLocalhostOrigin(pageOrigin)
  if (!origin) return false
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [LOCALHOST_REMOTE_HANDOFF_KEY, origin, handoff],
    func: (storageKey, expectedOrigin, nextHandoff) => {
      if (window.location.hostname !== 'localhost' || window.location.origin !== expectedOrigin) {
        return false
      }
      if (nextHandoff) window.sessionStorage.setItem(storageKey, JSON.stringify(nextHandoff))
      else window.sessionStorage.removeItem(storageKey)
      return true
    },
  })
  if (results?.[0]?.result !== true) {
    throw new Error('localhost Remote 配置写入失败，请确认当前标签页未发生变化')
  }
  return true
}

async function writeLocalhostRemoteHandoff(tabId, active, tab) {
  const origin = exactLocalhostOrigin(active?.pageOrigin)
  if (!origin) return false
  const modules = inPlaceHotModuleConfig(active, tab)
  if (!modules.length) throw new Error('localhost Remote 配置为空，无法应用')
  return setLocalhostRemoteHandoff(tabId, origin, {
    origin,
    expiresAt: previewExpiresAt(active),
    modules,
  })
}

async function clearLocalhostRemoteHandoff(tabId, pageOrigin) {
  return setLocalhostRemoteHandoff(tabId, pageOrigin, null)
}

async function readInPlaceHotModuleConfig(sender) {
  const tab = sender?.tab
  if (!Number.isInteger(tab?.id) || sender?.frameId !== 0) return []
  const active = await readActivePreviews()
  return inPlaceHotModuleConfig(active[String(tab.id)] || null, tab)
}

function officialUrlForActivePreview(active, tab) {
  if (active?.mode !== 'site' || !activePreviewMatchesTab(active, tab) || !active?.officialOrigin) {
    return null
  }
  try {
    const destination = new URL(active.officialOrigin)
    const current = new URL(tab.url)
    destination.pathname = current.pathname
    destination.search = current.search
    destination.hash = current.hash
    return destination.href
  } catch {
    return null
  }
}

function shareUrlForActivePreview(active) {
  const controlOrigin = normalizeHttpOrigin(active?.controlOrigin)
  if (!controlOrigin || !CONFIGURATION_GROUP_TOKEN_PATTERN.test(active?.configGroupToken || '')) {
    return null
  }
  const share = configurationShareUrl(active?.shareUrl, controlOrigin)
  return share?.token === active.configGroupToken ? share.url : null
}

function recoveryUrlForActivePreview(active, tab) {
  if (active?.mode === 'remote') return null
  return shareUrlForActivePreview(active) || officialUrlForActivePreview(active, tab)
}

async function storeActive(tabId, value) {
  const active = await readActivePreviews()
  active[String(tabId)] = value
  await writeActivePreviews(active)
  try {
    await schedulePreviewExpiry(tabId, value)
  } catch (error) {
    delete active[String(tabId)]
    await writeActivePreviews(active)
    await chrome.alarms.clear(previewAlarmName(tabId))
    throw error
  }
  return value
}

async function restoreActive(tabId, value) {
  if (!value) return null
  const rules = rulesForActivePreview(tabId, value)
  if (!rules) throw new Error('Previous preview state cannot be restored')
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules })
  try {
    return await storeActive(tabId, value)
  } catch (error) {
    if (rules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map((rule) => rule.id),
      })
    }
    throw error
  }
}

async function discardPreviewState(tabId, value) {
  const ruleIds = Array.isArray(value?.ruleIds) ? value.ruleIds : []
  if (ruleIds.length) {
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: ruleIds })
      .catch(() => undefined)
  }

  const active = await readActivePreviews().catch(() => null)
  const current = active?.[String(tabId)] || null
  const samePendingPreview =
    current?.mode === value?.mode &&
    typeof current?.preview?.token === 'string' &&
    current.preview.token === value?.preview?.token
  if (
    active &&
    (samePendingPreview || current?.ruleIds?.some((ruleId) => ruleIds.includes(ruleId)))
  ) {
    delete active[String(tabId)]
    await writeActivePreviews(active).catch(() => undefined)
  }
  await chrome.alarms.clear(previewAlarmName(tabId)).catch(() => undefined)
}

async function reconcilePreviewLifecycles() {
  const active = await readActivePreviews()
  const tabs = await chrome.tabs.query({})
  const tabsById = new Map(tabs.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab]])))
  const expectedAlarms = new Set()
  const restoredRules = []
  const restoredPreviews = []
  const stalePreviews = []
  const redirects = []
  const reloads = []
  const usedRuleIds = new Set()

  for (const [tabKey, preview] of Object.entries(active)) {
    const tabId = Number(tabKey)
    const tab = tabsById.get(tabId)
    const expiresAt = previewExpiresAt(preview)
    const rules =
      Number.isInteger(tabId) && tabId >= 0
        ? rulesForActivePreview(tabId, preview)
        : null
    const ruleIds = rules?.map((rule) => rule.id) || []
    const rulesAreUnique = ruleIds.every(
      (ruleId) => Number.isInteger(ruleId) && ruleId > 0 && !usedRuleIds.has(ruleId)
    )
    if (
      !tab ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      !rules ||
      !rulesAreUnique ||
      !activePreviewMatchesTab(preview, tab)
    ) {
      const shouldReload = remotePreviewSharesPageOrigin(preview, tab)
      delete active[tabKey]
      stalePreviews.push(preview)
      const recoveryUrl = recoveryUrlForActivePreview(preview, tab)
      if (recoveryUrl) redirects.push([tabId, recoveryUrl])
      else if (shouldReload) reloads.push(tabId)
      if (Number.isInteger(tabId) && tabId >= 0) await chrome.alarms.clear(previewAlarmName(tabId))
      continue
    }
    for (const ruleId of ruleIds) usedRuleIds.add(ruleId)
    restoredRules.push(...rules)
    restoredPreviews.push([tabId, preview])
    expectedAlarms.add(previewAlarmName(tabId))
  }

  const currentRules = await chrome.declarativeNetRequest.getSessionRules()
  if (currentRules.length || restoredRules.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: currentRules.map((rule) => rule.id),
      addRules: restoredRules,
    })
  }
  await writeActivePreviews(active)
  await Promise.all(stalePreviews.map((preview) => revokeActivePreview(preview)))
  for (const [tabId, preview] of restoredPreviews) {
    await schedulePreviewExpiry(tabId, preview)
  }

  const alarms = await chrome.alarms.getAll()
  await Promise.all(
    alarms
      .filter(
        (alarm) => alarm.name.startsWith(PREVIEW_ALARM_PREFIX) && !expectedAlarms.has(alarm.name)
      )
      .map((alarm) => chrome.alarms.clear(alarm.name))
  )
  await Promise.all(
    redirects.map(([tabId, url]) => chrome.tabs.update(tabId, { url }).catch(() => undefined))
  )
  await Promise.all(reloads.map((tabId) => chrome.tabs.reload(tabId).catch(() => undefined)))
}

function transactionTargetUrl(message, previewOrigin) {
  const target = new URL(message.targetUrl)
  if (target.origin !== previewOrigin) {
    throw new Error('Preview target must use the configured preview origin')
  }
  return target.href
}

function configurationShareMetadata(message, controlOrigin) {
  const hasShareMetadata =
    message.shareUrl !== undefined ||
    message.configGroupToken !== undefined ||
    message.name !== undefined
  if (!hasShareMetadata) return {}
  const share = configurationShareUrl(message.shareUrl, controlOrigin)
  const name = typeof message.name === 'string' ? message.name.trim() : ''
  if (!share || share.token !== message.configGroupToken || !name || name.length > 80) {
    throw new Error('Configuration group preview metadata is invalid')
  }
  return {
    shareUrl: share.url,
    configGroupToken: share.token,
    name,
  }
}

async function applySitePreview(
  message,
  { navigate = false, allowInPlaceNavigation = false } = {}
) {
  const tabId = message.tabId
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Preview tab is invalid')
  const origin = new URL(message.previewOrigin).origin
  const controlOrigin = new URL(message.controlOrigin).origin
  const officialOrigin = new URL(message.officialOrigin).origin
  const targetUrl = navigate ? transactionTargetUrl(message, origin) : message.targetUrl
  const tab = await chrome.tabs.get(tabId)
  const inPlaceRule = await configuredInPlaceUrlRule(controlOrigin, tab?.url || '')
  if (inPlaceRule && !allowInPlaceNavigation) {
    throw new Error(
      `当前 URL 命中「${inPlaceRule.pattern}」，只能原地应用并固定使用 ${inPlaceRule.environmentSlug} 环境`
    )
  }
  const [previewHeaderRuleId] = await nextRuleIds(1)
  const shareMetadata = configurationShareMetadata(message, controlOrigin)
  const pending = {
    mode: 'site',
    ruleIds: [previewHeaderRuleId],
    preview: message.preview,
    previewOrigin: origin,
    controlOrigin,
    officialOrigin,
    originalUrl: message.originalUrl,
    targetUrl,
    appliedAt: new Date().toISOString(),
    ...shareMetadata,
  }
  const rules = sitePreviewRules({
    tabId,
    previewOrigin: origin,
    token: message.preview.token,
    previewHeaderRuleId,
  })
  const previous = await clearPreviewState(tabId)
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules })
    await verifySitePreviewRule(tabId, targetUrl, previewHeaderRuleId)
    const active = await storeActive(tabId, pending)
    await persistActiveSiteOverride(tabId, active, Boolean(active.preview?.siteArtifactId)).catch(
      () => undefined
    )
    if (navigate) await chrome.tabs.update(tabId, { url: targetUrl })
    await revokeActivePreview(previous)
    return active
  } catch (error) {
    await discardPreviewState(tabId, pending)
    try {
      await restoreActive(tabId, previous)
    } catch {
      await revokeActivePreview(previous)
    }
    await revokeActivePreview(pending)
    throw error
  }
}

async function applyRemotePreview(message, options = {}) {
  const tabId = message.tabId
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Preview tab is invalid')
  const tab = await chrome.tabs.get(tabId)
  const pageOrigin = new URL(message.pageOrigin).origin
  if (!tab?.url || new URL(tab.url).origin !== pageOrigin) {
    throw new Error('当前标签页与所选环境的官方页面不一致')
  }
  const previewOrigin = new URL(message.previewOrigin).origin
  const controlOrigin = new URL(message.controlOrigin).origin
  const officialOrigin = new URL(message.officialOrigin).origin
  const sourceOverrides = normalizedSourceOverrides(message.sourceOverrides)
  const sourceSelections = await resolveTtttSourceSelections(
    sourceOverrides,
    pageOrigin,
    officialOrigin,
    tabId
  )
  const artifactSelections = Array.isArray(message.preview?.selections)
    ? message.preview.selections
    : []
  const artifactModuleKeys = new Set(artifactSelections.map((selection) => selection?.moduleKey))
  if (sourceSelections.some((selection) => artifactModuleKeys.has(selection.moduleKey))) {
    throw new Error('同一个热更模块不能同时选择 tttt 和打包产物')
  }
  const preview = {
    ...message.preview,
    selections: [...artifactSelections, ...sourceSelections],
  }
  const configuredRule = Object.hasOwn(options, 'configuredRule')
    ? options.configuredRule
    : await configuredInPlaceUrlRule(controlOrigin, tab.url)
  const requestedRule =
    normalizeInPlaceUrlRules(message.inPlaceRule ? [message.inPlaceRule] : [])[0] || null
  if (!sameInPlaceUrlRule(configuredRule, requestedRule)) {
    throw new Error('官网原地应用规则已经变化，请重新打开扩展后再应用')
  }
  const bindingEnvironmentSlug =
    typeof message.bindingEnvironmentSlug === 'string' ? message.bindingEnvironmentSlug.trim() : ''
  if (!originsShareEnvironment(pageOrigin, officialOrigin)) {
    throw new Error('原地热更只能用于与站点绑定相同环境的页面')
  }
  if (
    !bindingEnvironmentSlug ||
    preview.environmentSlug !== bindingEnvironmentSlug ||
    preview.siteArtifactId ||
    preview.selections.length === 0
  ) {
    throw new Error('原地热更与站点环境或预览产物不匹配')
  }
  if (
    configuredRule &&
    (configuredRule.environmentSlug !== bindingEnvironmentSlug ||
      configuredRule.environmentSlug !== preview.environmentSlug)
  ) {
    throw new Error(`当前 URL 已锁定 ${configuredRule.environmentSlug} 环境，所选预览不匹配`)
  }
  if (configuredRule) await ensureDynamicInPlaceScripts(pageOrigin)
  const shareMetadata = configurationShareMetadata(message, controlOrigin)
  const pending = {
    mode: 'remote',
    ruleIds: [],
    preview,
    previewOrigin,
    pageOrigin,
    controlOrigin,
    officialOrigin,
    bindingEnvironmentSlug,
    ...(configuredRule ? { inPlaceRule: configuredRule } : {}),
    originalUrl: tab.url,
    targetUrl: tab.url,
    appliedAt: new Date().toISOString(),
    ...shareMetadata,
  }
  const previous = await clearPreviewState(tabId)
  let localhostHandoffWritten = false
  try {
    const active = await storeActive(tabId, pending)
    await persistActiveSiteOverride(tabId, active, false).catch(() => undefined)
    localhostHandoffWritten = await writeLocalhostRemoteHandoff(tabId, active, tab)
    await chrome.tabs.reload(tabId)
    await revokeActivePreview(previous)
    return active
  } catch (error) {
    await discardPreviewState(tabId, pending)
    let previousRestored = false
    try {
      await restoreActive(tabId, previous)
      previousRestored = true
    } catch {
      await revokeActivePreview(previous)
    }
    if (localhostHandoffWritten) {
      if (previousRestored) {
        const previousWritten = await writeLocalhostRemoteHandoff(tabId, previous, tab).catch(
          () => false
        )
        if (!previousWritten) {
          await clearLocalhostRemoteHandoff(tabId, pageOrigin).catch(() => undefined)
        }
      } else {
        await clearLocalhostRemoteHandoff(tabId, pageOrigin).catch(() => undefined)
      }
    }
    await revokeActivePreview(pending)
    throw error
  }
}

async function removePreviewAndNavigate(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Preview tab is invalid')
  const active = await readActivePreviews()
  const current = active[String(tabId)] || null
  if (!current) return null

  const tab = await chrome.tabs.get(tabId)
  const expired = previewExpiresAt(current) <= Date.now()
  const destinationUrl = expired
    ? recoveryUrlForActivePreview(current, tab)
    : officialUrlForActivePreview(current, tab)
  const previous = await clearPreviewState(tabId)
  await persistActiveSiteOverride(tabId, previous, false).catch(() => undefined)
  try {
    await clearLocalhostRemoteHandoff(tabId, current.pageOrigin)
    if (destinationUrl) {
      await chrome.tabs.update(tabId, { url: destinationUrl })
    } else if (current.mode !== 'site') {
      await chrome.tabs.reload(tabId)
    }
  } catch (error) {
    let previousRestored = false
    try {
      await restoreActive(tabId, previous)
      previousRestored = true
    } catch {
      await revokeActivePreview(previous)
    }
    if (previousRestored) {
      await writeLocalhostRemoteHandoff(tabId, previous, tab).catch(() => undefined)
    }
    throw error
  }
  await revokeActivePreview(previous)
  return previous
}

async function requestConfigurationGroup(authContext, token) {
  const response = await authenticatedRequest(
    authContext,
    `/api/v1/config-groups/${encodeURIComponent(token)}`,
    { method: 'GET', cache: 'no-store' }
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    const error = new Error(message || `Configuration group returned HTTP ${response.status}`)
    error.status = response.status
    error.code = typeof body?.code === 'string' ? body.code : ''
    throw error
  }
  return body
}

async function requestConfigurationGroupPreview(
  authContext,
  token,
  expectedRevision,
  applicationMode = 'complete'
) {
  const init = { method: 'POST', cache: 'no-store' }
  const payload = {}
  if (Number.isInteger(expectedRevision) && expectedRevision > 0) {
    payload.expectedRevision = expectedRevision
  }
  if (applicationMode === 'remote-only') payload.applicationMode = 'remote-only'
  if (Object.keys(payload).length) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(payload)
  }
  const response = await authenticatedRequest(
    authContext,
    `/api/v1/config-groups/${encodeURIComponent(token)}/previews`,
    init
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const missingArtifacts =
      body?.code === 'CONFIG_GROUP_ARTIFACTS_NOT_READY' && Array.isArray(body.missing)
        ? body.missing.slice(0, 40).flatMap((item) => {
            const targetName =
              typeof item?.targetName === 'string' && item.targetName.trim()
                ? item.targetName.trim().slice(0, 80)
                : typeof item?.targetId === 'string'
                  ? item.targetId.trim().slice(0, 80)
                  : ''
            const branch = typeof item?.branch === 'string' ? item.branch.trim().slice(0, 240) : ''
            return targetName && branch ? [`${targetName} · ${branch}`] : []
          })
        : []
    const message = missingArtifacts.length
      ? `缺少可用打包产物：${missingArtifacts.join('；')}`
      : typeof body?.message === 'string'
        ? body.message.trim()
        : ''
    const error = new Error(
      message || `Configuration group preview returned HTTP ${response.status}`
    )
    error.status = response.status
    error.code = typeof body?.code === 'string' ? body.code : ''
    throw error
  }
  return body
}

function configurationShareForToken(token, controlOrigin) {
  if (typeof token !== 'string' || !CONFIGURATION_GROUP_TOKEN_PATTERN.test(token)) {
    throw new Error('Configuration group token is invalid')
  }
  return { token, url: `${controlOrigin}/s/${token}` }
}

function configurationGroupDestinationUrl(
  tabUrl,
  destinationOrigin,
  officialOrigin,
  { preserveLocation = false } = {}
) {
  const destination = new URL(destinationOrigin)
  if (!preserveLocation) return new URL('/', destination).href
  try {
    const current = new URL(tabUrl)
    if (current.origin !== destination.origin && current.origin !== officialOrigin) {
      return new URL('/', destination).href
    }
    destination.pathname = current.pathname
    destination.search = current.search
    destination.hash = current.hash
    return destination.href
  } catch {
    return new URL('/', destination).href
  }
}

async function persistConfigurationGroupSelection(tabId, selection) {
  await Promise.all([
    persistPopupState({
      tabId,
      bindingId: selection.bindingId,
      environmentSlug: selection.environmentSlug,
      selectedBranches: selection.selectedBranches,
      submittedBuildBranches: {},
      siteOverrideEnabled: selection.siteOverrideEnabled,
    }),
    persistTabEnvironmentPreference({
      tabId,
      officialOrigin: selection.officialOrigin,
      environmentSlug: selection.environmentSlug,
      configurationGroupBindingId: selection.bindingId,
      configurationGroupHostname: selection.hostname,
    }),
  ])
}

function configurationGroupSiteConfirmation(selection) {
  const targetBranch = selection.selectedBranches[selection.siteTargetId]
  const error = new Error(
    `当前页面使用官方原版，本需求希望将本体切换到 ${targetBranch || '指定分支'}`
  )
  error.code = CONFIGURATION_GROUP_SITE_CONFIRMATION_CODE
  error.confirmation = {
    currentBranch: '官方原版',
    targetBranch: targetBranch || '指定分支',
  }
  return error
}

function configurationGroupApplicationMode(value) {
  if (value === undefined || value === null || value === '') return 'auto'
  if (value === 'remote-only' || value === 'complete') return value
  throw new Error('Configuration group application mode is invalid')
}

async function applyConfigurationGroup(
  tab,
  share,
  { preserveLocation = false, applicationMode: requestedMode, confirmedSiteBranch = '' } = {}
) {
  if (!Number.isInteger(tab?.id) || !tab.url) throw new Error('Preview tab is invalid')
  const applicationMode = configurationGroupApplicationMode(requestedMode)
  const controlOrigin = await configuredControlOrigin()
  if (share.url !== `${controlOrigin}/s/${share.token}`) {
    throw new Error('Configuration group share URL is invalid')
  }
  const authContext = await authenticatedRequestContext(controlOrigin)
  const [groupBody, inPlaceRule] = await Promise.all([
    requestConfigurationGroup(authContext, share.token),
    configuredInPlaceUrlRule(controlOrigin, tab.url, authContext),
  ])
  const groupSelection = configurationGroupSelection(groupBody, share.token)
  if (
    inPlaceRule &&
    applicationMode !== 'complete' &&
    (groupSelection.environmentSlug !== inPlaceRule.environmentSlug ||
      groupSelection.bindingEnvironmentSlug !== inPlaceRule.environmentSlug)
  ) {
    throw new Error(`当前 URL 已锁定 ${inPlaceRule.environmentSlug} 环境，这个需求使用了其他环境`)
  }
  if (inPlaceRule && groupSelection.siteOverrideEnabled) {
    const siteBranch = groupSelection.selectedBranches[groupSelection.siteTargetId]
    if (applicationMode === 'auto' || confirmedSiteBranch !== siteBranch) {
      throw configurationGroupSiteConfirmation(groupSelection)
    }
  }

  // A share selects branch intent even when its latest Artifact is not ready. Persist the draft
  // before requesting a Preview so a failed apply still leaves the popup ready to build it.
  await persistConfigurationGroupSelection(tab.id, groupSelection)

  let previewToRevoke = null
  try {
    let selection = groupSelection
    let body
    try {
      body = await requestConfigurationGroupPreview(
        authContext,
        share.token,
        selection.revision,
        applicationMode === 'remote-only' ? 'remote-only' : 'complete'
      )
    } catch (error) {
      if (error?.code !== 'CONFIG_GROUP_REVISION_CONFLICT') throw error

      const refreshedBody = await requestConfigurationGroup(authContext, share.token)
      selection = configurationGroupSelection(refreshedBody, share.token)
      await persistConfigurationGroupSelection(tab.id, selection)
      body = await requestConfigurationGroupPreview(
        authContext,
        share.token,
        selection.revision,
        applicationMode === 'remote-only' ? 'remote-only' : 'complete'
      )
    }
    selection = configurationGroupSelection(body, share.token)
    if (
      inPlaceRule &&
      applicationMode !== 'complete' &&
      (selection.environmentSlug !== inPlaceRule.environmentSlug ||
        selection.bindingEnvironmentSlug !== inPlaceRule.environmentSlug)
    ) {
      throw new Error('这个需求的页面或环境已经变化，不再符合当前 URL 的原地应用规则')
    }
    if (
      inPlaceRule &&
      selection.siteOverrideEnabled &&
      (applicationMode === 'auto' ||
        confirmedSiteBranch !== selection.selectedBranches[selection.siteTargetId])
    ) {
      throw configurationGroupSiteConfirmation(selection)
    }
    const previewResponse = validatedPreviewResponse(body, selection)
    previewToRevoke = previewResponse?.preview || null

    // The group may have been edited between GET and POST. The Preview response is authoritative;
    // persist it again before any navigation so the visible branch draft matches what was applied.
    await persistConfigurationGroupSelection(tab.id, selection)

    if (selection.mode === 'official') {
      await removePreview(tab.id)
      await persistTabEnvironmentPreference({
        tabId: tab.id,
        officialOrigin: selection.officialOrigin,
        environmentSlug: selection.environmentSlug,
      })
      await chrome.tabs.update(tab.id, {
        url: configurationGroupDestinationUrl(
          tab.url,
          selection.officialOrigin,
          selection.officialOrigin,
          { preserveLocation }
        ),
      })
      return null
    }

    const previewMessage = {
      tabId: tab.id,
      previewOrigin: previewResponse.previewOrigin,
      controlOrigin,
      officialOrigin: selection.officialOrigin,
      bindingEnvironmentSlug: selection.bindingEnvironmentSlug,
      originalUrl: tab.url,
      preview: previewResponse.preview,
      shareUrl: share.url,
      configGroupToken: share.token,
      name: selection.name,
    }
    const remoteOnlyOnOfficialPage =
      !previewResponse.preview.siteArtifactId &&
      previewResponse.preview.selections?.length > 0 &&
      selection.environmentSlug === selection.bindingEnvironmentSlug &&
      originsShareEnvironment(new URL(tab.url).origin, selection.officialOrigin)
    if (inPlaceRule && applicationMode !== 'complete' && !remoteOnlyOnOfficialPage) {
      throw new Error('当前 URL 只允许原地热更，但这个需求没有可原地应用的热更产物')
    }
    const active = remoteOnlyOnOfficialPage
      ? await applyRemotePreview(
          {
            ...previewMessage,
            pageOrigin: new URL(tab.url).origin,
            inPlaceRule,
          },
          { configuredRule: inPlaceRule }
        )
      : await applySitePreview(
          {
            ...previewMessage,
            targetUrl: configurationGroupDestinationUrl(
              tab.url,
              previewResponse.previewOrigin,
              selection.officialOrigin,
              { preserveLocation }
            ),
          },
          { navigate: true, allowInPlaceNavigation: applicationMode === 'complete' }
        )
    await persistTabEnvironmentPreference({
      tabId: tab.id,
      officialOrigin: selection.officialOrigin,
      environmentSlug: selection.environmentSlug,
    })
    previewToRevoke = null
    return active
  } catch (error) {
    if (previewToRevoke) {
      await revokeActivePreview({ preview: previewToRevoke, controlOrigin })
    }
    if (error && typeof error === 'object') error.selectionPersisted = true
    throw error
  }
}

async function applyConfigurationGroupCommand(message) {
  if (!Number.isInteger(message?.tabId) || message.tabId < 0) {
    throw new Error('Preview tab is invalid')
  }
  const controlOrigin = await configuredControlOrigin()
  const share = configurationShareForToken(message.token, controlOrigin)
  const tab = await chrome.tabs.get(message.tabId)
  return applyConfigurationGroup(tab, share, {
    preserveLocation: true,
    applicationMode: message.applicationMode,
    confirmedSiteBranch:
      typeof message.confirmedSiteBranch === 'string' ? message.confirmedSiteBranch : '',
  })
}

async function applyConfigurationShare(tab) {
  if (!Number.isInteger(tab?.id) || !tab.url) return false
  const controlOrigin = await configuredControlOrigin()
  const expectedShare = configurationShareUrl(tab.url, controlOrigin)
  if (!expectedShare) return false

  // Multiple onUpdated events can carry the same stale landing URL. Re-read the tab only when the
  // queued task starts so a previous task's navigation prevents a duplicate Preview creation.
  const currentTab = await chrome.tabs.get(tab.id).catch(() => null)
  const currentShare = configurationShareUrl(currentTab?.url, controlOrigin)
  if (!currentShare || currentShare.token !== expectedShare.token) return false

  try {
    await applyConfigurationGroup(currentTab, currentShare)
    return true
  } catch {
    return false
  }
}

async function scanConfigurationShareTabs() {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) await applyConfigurationShare(tab)
}

function extensionCapabilities() {
  return {
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    commands: [
      APPLY_CONFIGURATION_GROUP_COMMAND,
      'apply-site-preview',
      'remove-preview',
      APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
      APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
      REMOVE_PREVIEW_TRANSACTION_COMMAND,
    ],
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const task =
    message?.type === READ_IN_PLACE_HOT_MODULE_CONFIG_COMMAND
      ? readInPlaceHotModuleConfig(sender)
      : serializeMutation(() => {
          if (message?.type === EXTENSION_CAPABILITIES_COMMAND) return extensionCapabilities()
          if (message?.type === REMEMBER_HOT_MODULE_REQUEST_CONTEXT_COMMAND) {
            return rememberHotModuleRequestContext(message, sender)
          }
          if (message?.type === READ_POPUP_SCOPED_STATE_COMMAND) {
            return readPersistedPopupState(
              message.tabId,
              message.bindingId,
              message.environmentSlug
            )
          }
          if (message?.type === WRITE_POPUP_SCOPED_STATE_COMMAND) return persistPopupState(message)
          if (message?.type === APPLY_CONFIGURATION_GROUP_COMMAND) {
            return applyConfigurationGroupCommand(message)
          }
          if (message?.type === 'apply-site-preview') return applySitePreview(message)
          if (message?.type === 'remove-preview') return removePreview(message.tabId)
          if (message?.type === APPLY_SITE_PREVIEW_TRANSACTION_COMMAND) {
            return applySitePreview(message, { navigate: true })
          }
          if (message?.type === APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND) {
            return applyRemotePreview(message)
          }
          if (message?.type === REMOVE_PREVIEW_TRANSACTION_COMMAND) {
            return removePreviewAndNavigate(message.tabId)
          }
          if (message?.type === 'apply-preview' || message?.type === 'apply-remote-preview') {
            return Promise.reject(new Error(EXTENSION_RELOAD_REQUIRED))
          }
          return Promise.reject(new Error('Unsupported extension command'))
        })

  task
    .then((result) =>
      respond(
        message?.type === EXTENSION_CAPABILITIES_COMMAND
          ? { ok: true, capabilities: result }
          : message?.type === READ_POPUP_SCOPED_STATE_COMMAND ||
              message?.type === WRITE_POPUP_SCOPED_STATE_COMMAND
            ? { ok: true, state: result }
            : message?.type === READ_IN_PLACE_HOT_MODULE_CONFIG_COMMAND
              ? { ok: true, config: result }
              : message?.type === REMEMBER_HOT_MODULE_REQUEST_CONTEXT_COMMAND
                ? { ok: true }
                : { ok: true, active: result }
      )
    )
    .catch((error) =>
      respond({
        ok: false,
        message: error.message,
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.selectionPersisted ? { selectionPersisted: true } : {}),
        ...(error?.confirmation ? { confirmation: error.confirmation } : {}),
      })
    )
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void serializeMutation(async () => {
    try {
      await removePreview(tabId)
    } finally {
      await Promise.all([
        removePersistedPopupStatesForTab(tabId),
        removeTabEnvironmentPreference(tabId),
        removeHotModuleRequestContext(tabId),
      ])
    }
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return
  void serializeMutation(async () => {
    const currentTab = await chrome.tabs.get(tabId).catch(() => tab)
    if (currentTab?.url !== changeInfo.url) return
    const active = await readActivePreviews()
    const current = active[String(tabId)] || null
    if (current && !activePreviewMatchesTab(current, currentTab)) {
      const shouldReload = remotePreviewSharesPageOrigin(current, currentTab)
      await removePreview(tabId)
      if (shouldReload) {
        await chrome.tabs.reload(tabId).catch(() => undefined)
        return
      }
    }
    await applyConfigurationShare(currentTab)
  })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  const tabId = previewAlarmTabId(alarm.name)
  if (tabId === null) return
  void serializeMutation(async () => {
    const active = await readActivePreviews()
    const current = active[String(tabId)] || null
    if (!current) {
      await chrome.alarms.clear(alarm.name)
      return
    }
    if (previewExpiresAt(current) > Date.now()) {
      await schedulePreviewExpiry(tabId, current)
      return
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const recoveryUrl = recoveryUrlForActivePreview(current, tab)
    const shouldReload = remotePreviewSharesPageOrigin(current, tab)
    await removePreview(tabId)
    if (recoveryUrl) await chrome.tabs.update(tabId, { url: recoveryUrl }).catch(() => undefined)
    else if (shouldReload) await chrome.tabs.reload(tabId).catch(() => undefined)
  })
})

async function reconcileExtensionLifecycles() {
  try {
    await reconcileDynamicInPlaceScripts()
    await reconcilePreviewLifecycles()
  } finally {
    await Promise.all([reconcilePersistedPopupStates(), reconcileTabEnvironmentPreferences()])
  }
  await scanConfigurationShareTabs()
}

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel()
  void serializeMutation(reconcileExtensionLifecycles)
})

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel()
  void serializeMutation(reconcileExtensionLifecycles)
})

async function configureSidePanel() {
  if (typeof chrome.sidePanel?.setPanelBehavior !== 'function') return
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined)
}
