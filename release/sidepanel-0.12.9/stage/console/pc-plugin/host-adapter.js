globalThis.BIFROST_PC_UI_MANIFEST = {"name":"Bifrost PC","short_name":"Bifrost","version":"0.12.9"};
;(() => {
  const CHANNEL = 'bifrost:pc-plugin:v1'
  const CONTROL_ORIGIN = window.location.origin
  const ACTIVE_KEY = 'cuddly.activePreviews'
  const CONTROL_KEY = 'cuddly.controlOrigin'
  const POPUP_STATE_KEY = 'cuddly.popupStateByTabBindingEnvironment.v2'
  const AUTH_TOKEN_KEY = 'bifrost.pc.auth-token.v1'
  const EXTENSION_PROTOCOL_VERSION = 13
  const COMMANDS = [
    'apply-configuration-group',
    'apply-site-preview',
    'apply-site-preview-transaction',
    'apply-remote-preview-transaction',
    'remove-preview-transaction',
  ]

  globalThis.BIFROST_PC_PLUGIN = true

  const nativeFetch = globalThis.fetch.bind(globalThis)
  let guestSessionRequest = null

  async function requestGuestSession() {
    if (guestSessionRequest) return guestSessionRequest
    guestSessionRequest = (async () => {
      const response = await nativeFetch('/api/v1/auth/pc-guest', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'x-bifrost-client': 'kook-pc-plugin' },
      })
      const body = await response.json().catch(() => null)
      const token = typeof body?.token === 'string' ? body.token : ''
      if (!response.ok || body?.guest !== true || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new Error(body?.message || '无法创建 KOOK PC Guest 会话')
      }
      localStorage.setItem(AUTH_TOKEN_KEY, token)
      return token
    })().finally(() => {
      guestSessionRequest = null
    })
    return guestSessionRequest
  }

  globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url || String(input), window.location.href)
    const sameControlApi = url.origin === CONTROL_ORIGIN && url.pathname.startsWith('/api/v1/')
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || ''
    const headers = new Headers(request?.headers)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    if (sameControlApi && token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`)
    }
    let response = await nativeFetch(input, { ...init, headers })
    if (sameControlApi && url.pathname === '/api/v1/auth/session' && response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY)
      const guestToken = await requestGuestSession()
      headers.set('authorization', `Bearer ${guestToken}`)
      response = await nativeFetch(input, { ...init, headers })
    }
    if (sameControlApi && response.status === 401 && token) localStorage.removeItem(AUTH_TOKEN_KEY)
    if (sameControlApi && url.pathname === '/api/v1/auth/logout' && response.ok) {
      localStorage.removeItem(AUTH_TOKEN_KEY)
    }
    return response
  }

  let hostContext = null
  let resolveHostContext
  const hostContextReady = new Promise((resolve) => {
    resolveHostContext = resolve
  })
  const pending = new Map()
  let sequence = 0

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }

  function storageRecord() {
    try {
      return JSON.parse(localStorage.getItem('bifrost.pc.popup-storage.v1') || '{}')
    } catch {
      return {}
    }
  }

  function writeStorage(record) {
    localStorage.setItem('bifrost.pc.popup-storage.v1', JSON.stringify(record))
  }

  function activeRecord() {
    return hostContext?.active ? { 1: hostContext.active } : {}
  }

  function storageGet(keys) {
    const stored = storageRecord()
    const source = { ...stored, [CONTROL_KEY]: CONTROL_ORIGIN, [ACTIVE_KEY]: activeRecord() }
    if (keys == null) return source
    if (typeof keys === 'string') return { [keys]: source[keys] }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, source[key]]))
    }
    if (isRecord(keys)) {
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          source[key] === undefined ? fallback : source[key],
        ])
      )
    }
    return {}
  }

  function storageSet(values) {
    if (!isRecord(values)) return
    const next = { ...storageRecord(), ...values, [CONTROL_KEY]: CONTROL_ORIGIN }
    delete next[ACTIVE_KEY]
    writeStorage(next)
  }

  function hostRequest(type, payload = {}) {
    const requestId = `${Date.now().toString(36)}-${++sequence}`
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('KOOK PC 插件没有响应'))
      }, 10_000)
      pending.set(requestId, { resolve, reject, timer })
      window.parent.postMessage({ channel: CHANNEL, type, requestId, ...payload }, '*')
    })
  }

  function pcLoginUrl(value) {
    const url = new URL(value, CONTROL_ORIGIN)
    if (url.origin !== CONTROL_ORIGIN || url.pathname !== '/api/v1/auth/feishu/start') {
      return { url: url.href, channel: null }
    }
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    const nonce = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    url.searchParams.set('return_to', `/api/v1/auth/pc-complete?nonce=${encodeURIComponent(nonce)}`)
    return { url: url.href, channel: new BroadcastChannel(`bifrost-pc-auth:${nonce}`) }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.channel !== CHANNEL) return
    if (event.data.type === 'context' && isRecord(event.data.context)) {
      const previous = hostContext
      hostContext = {
        title: String(event.data.context.title || 'KOOK PC 客户端'),
        url: String(event.data.context.url || ''),
        active: isRecord(event.data.context.active) ? event.data.context.active : null,
      }
      resolveHostContext(hostContext)
      if (
        previous &&
        (previous.url !== hostContext.url ||
          JSON.stringify(previous.active) !== JSON.stringify(hostContext.active))
      ) {
        window.dispatchEvent(new Event('bifrost:host-context-changed'))
      }
      return
    }
    if (event.data.type !== 'response' || typeof event.data.requestId !== 'string') return
    const task = pending.get(event.data.requestId)
    if (!task) return
    pending.delete(event.data.requestId)
    window.clearTimeout(task.timer)
    if (event.data.ok) task.resolve(event.data.result)
    else task.reject(new Error(event.data.message || 'KOOK PC 插件操作失败'))
  })

  async function currentTab() {
    const context = hostContext || (await hostContextReady)
    if (!context.url) throw new Error('无法识别 KOOK PC 客户端当前环境')
    return { id: 1, url: context.url, title: context.title, active: true }
  }

  async function authSession() {
    const response = await fetch('/api/v1/auth/session', {
      credentials: 'include',
      cache: 'no-store',
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.authenticated !== true || !body.csrfToken) {
      throw new Error('请先使用飞书登录')
    }
    return body
  }

  async function api(pathname, init = {}) {
    const session = await authSession()
    const method = String(init.method || 'GET').toUpperCase()
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    const response = await fetch(pathname, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
        ...(mutating ? { 'x-cuddly-csrf': session.csrfToken } : {}),
      },
    })
    const body = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error(body?.message || `Bifrost 返回 HTTP ${response.status}`)
      error.code = body?.code
      throw error
    }
    return body
  }

  function normalizeOrigin(value) {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('预览地址无效')
    }
    return url.origin
  }

  function validateRemotePreview(message) {
    if (!isRecord(message.preview) || message.preview.siteArtifactId) {
      throw new Error('PC 客户端只支持原地热更，不能应用页面产物')
    }
    if (!Array.isArray(message.preview.selections) || !message.preview.selections.length) {
      throw new Error('没有可应用的热更产物')
    }
    const tabOrigin = new URL(hostContext.url).origin
    const officialOrigin = normalizeOrigin(message.officialOrigin)
    if (tabOrigin !== officialOrigin || normalizeOrigin(message.pageOrigin) !== officialOrigin) {
      throw new Error('当前 KOOK PC 环境与所选站点环境不一致')
    }
    if (
      !message.bindingEnvironmentSlug ||
      message.preview.environmentSlug !== message.bindingEnvironmentSlug
    ) {
      throw new Error('热更 Preview 与当前环境不一致')
    }
    return {
      mode: 'remote',
      ruleIds: [],
      preview: message.preview,
      previewOrigin: normalizeOrigin(message.previewOrigin),
      pageOrigin: officialOrigin,
      controlOrigin: CONTROL_ORIGIN,
      officialOrigin,
      bindingEnvironmentSlug: message.bindingEnvironmentSlug,
      ...(message.inPlaceRule ? { inPlaceRule: message.inPlaceRule } : {}),
      originalUrl: hostContext.url,
      targetUrl: hostContext.url,
      appliedAt: new Date().toISOString(),
      ...(message.shareUrl ? { shareUrl: message.shareUrl } : {}),
      ...(message.configGroupToken ? { configGroupToken: message.configGroupToken } : {}),
      ...(message.name ? { name: message.name } : {}),
    }
  }

  async function applyRemote(message) {
    const active = validateRemotePreview(message)
    const previous = hostContext.active
    if (previous?.preview?.token && previous.preview.token !== active.preview.token) {
      await api(`/api/v1/previews/${encodeURIComponent(previous.preview.token)}`, {
        method: 'DELETE',
      }).catch(() => undefined)
    }
    await hostRequest('apply', { active })
    hostContext.active = active
    return { ok: true, active }
  }

  async function removeActive() {
    const previous = hostContext?.active || null
    if (previous?.preview?.token) {
      await api(`/api/v1/previews/${encodeURIComponent(previous.preview.token)}`, {
        method: 'DELETE',
      }).catch(() => undefined)
    }
    await hostRequest('remove')
    if (hostContext) hostContext.active = null
    return { ok: true, active: null }
  }

  function persistGroupSelection(group) {
    const binding = group?.siteBinding
    if (!binding?.id || !group?.environmentSlug || !Array.isArray(group.items)) return
    const selectedBranches = Object.fromEntries(
      group.items.map((item) => [
        item.targetId,
        item.mode === 'branch' && typeof item.branch === 'string' ? item.branch : '',
      ])
    )
    const store = storageRecord()
    const scoped = isRecord(store[POPUP_STATE_KEY]) ? store[POPUP_STATE_KEY] : {}
    store[POPUP_STATE_KEY] = {
      ...scoped,
      [`1:${binding.id}:${group.environmentSlug}`]: {
        selectedBranches,
        submittedBuildBranches: {},
        siteOverrideEnabled: false,
        updatedAt: Date.now(),
      },
    }
    writeStorage(store)
  }

  async function applyConfigurationGroup(message) {
    const token = typeof message.token === 'string' ? message.token : ''
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('需求 ID 无效')
    let group = await api(`/api/v1/config-groups/${encodeURIComponent(token)}`)
    persistGroupSelection(group)
    let body
    try {
      body = await api(`/api/v1/config-groups/${encodeURIComponent(token)}/previews`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: group.revision }),
      })
    } catch (error) {
      if (error.code !== 'CONFIG_GROUP_REVISION_CONFLICT') throw error
      group = await api(`/api/v1/config-groups/${encodeURIComponent(token)}`)
      persistGroupSelection(group)
      body = await api(`/api/v1/config-groups/${encodeURIComponent(token)}/previews`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: group.revision }),
      })
    }
    const resolved = body?.configurationGroup || group
    const binding = resolved?.siteBinding
    const siteItem = resolved?.items?.find(
      (item) => item.targetId === binding?.targetId && item.mode === 'branch'
    )
    if (siteItem || body?.preview?.siteArtifactId) {
      if (body?.preview?.token) {
        await api(`/api/v1/previews/${encodeURIComponent(body.preview.token)}`, {
          method: 'DELETE',
        }).catch(() => undefined)
      }
      throw new Error('这个需求包含页面产物，PC 客户端只支持原地热更')
    }
    persistGroupSelection(resolved)
    if (!body?.preview?.selections?.length) return removeActive()
    return applyRemote({
      preview: body.preview,
      previewOrigin: body.previewOrigin,
      pageOrigin: binding.officialOrigin,
      officialOrigin: binding.officialOrigin,
      bindingEnvironmentSlug: binding.environmentSlug,
      inPlaceRule: {
        pattern: new URL(binding.officialOrigin).hostname,
        environmentSlug: binding.environmentSlug,
      },
      shareUrl: `${CONTROL_ORIGIN}/s/${token}`,
      configGroupToken: token,
      name: resolved.name,
    })
  }

  async function sendMessage(message) {
    try {
      if (message?.type === 'get-extension-capabilities') {
        return {
          ok: true,
          capabilities: { protocolVersion: EXTENSION_PROTOCOL_VERSION, commands: COMMANDS },
        }
      }
      if (message?.type === 'read-popup-scoped-state') {
        const key = `${message.tabId}:${message.bindingId}:${message.environmentSlug}`
        return { ok: true, state: storageRecord()[POPUP_STATE_KEY]?.[key] || null }
      }
      if (message?.type === 'write-popup-scoped-state') {
        const store = storageRecord()
        const scoped = isRecord(store[POPUP_STATE_KEY]) ? store[POPUP_STATE_KEY] : {}
        const key = `${message.tabId}:${message.bindingId}:${message.environmentSlug}`
        store[POPUP_STATE_KEY] = {
          ...scoped,
          [key]: {
            selectedBranches: message.selectedBranches || {},
            submittedBuildBranches: message.submittedBuildBranches || {},
            siteOverrideEnabled: false,
            updatedAt: Date.now(),
          },
        }
        writeStorage(store)
        return { ok: true, state: store[POPUP_STATE_KEY][key] }
      }
      if (message?.type === 'apply-remote-preview-transaction') return await applyRemote(message)
      if (message?.type === 'remove-preview-transaction') return await removeActive()
      if (message?.type === 'apply-configuration-group') {
        return await applyConfigurationGroup(message)
      }
      if (
        message?.type === 'apply-site-preview' ||
        message?.type === 'apply-site-preview-transaction'
      ) {
        throw new Error('PC 客户端只支持原地热更，不能应用页面产物')
      }
      throw new Error('Unsupported extension command')
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {}),
      }
    }
  }

  const chromeApi = globalThis.chrome || {}
  chromeApi.runtime = {
    getManifest: () => globalThis.BIFROST_PC_UI_MANIFEST,
    sendMessage,
  }
  chromeApi.storage = {
    local: {
      get: async (keys) => storageGet(keys),
      set: async (values) => storageSet(values),
    },
  }
  chromeApi.permissions = {
    contains: async () => true,
    request: async () => true,
  }
  chromeApi.tabs = {
    query: async () => [await currentTab()],
    get: async () => currentTab(),
    create: async ({ url }) => {
      const login = pcLoginUrl(url)
      if (login.channel) {
        const timer = window.setTimeout(() => login.channel.close(), 5 * 60_000)
        login.channel.addEventListener(
          'message',
          (event) => {
            const token = typeof event.data?.token === 'string' ? event.data.token : ''
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return
            window.clearTimeout(timer)
            localStorage.setItem(AUTH_TOKEN_KEY, token)
            login.channel.close()
            window.location.reload()
          },
          { once: true }
        )
      }
      window.open(login.url, '_blank')
      return { id: 2, url: login.url }
    },
    reload: async () => undefined,
    update: async (_tabId, update) => {
      if (update?.url) await hostRequest('navigate', { url: update.url })
      return currentTab()
    },
  }
  globalThis.chrome = chromeApi

  window.parent.postMessage({ channel: CHANNEL, type: 'ready' }, '*')
})()
