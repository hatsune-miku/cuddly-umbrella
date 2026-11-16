globalThis.BIFROST_PC_UI_MANIFEST = {"name":"Bifrost PC","short_name":"Bifrost","version":"0.12.10"};
;(() => {
  const CHANNEL = 'bifrost:pc-plugin:v1'
  const CONTROL_ORIGIN = window.location.origin
  const ACTIVE_KEY = 'cuddly.activePreviews'
  const CONTROL_KEY = 'cuddly.controlOrigin'
  const POPUP_STATE_KEY = 'cuddly.popupStateByTabBindingEnvironment.v2'
  const AUTH_TOKEN_KEY = 'bifrost.pc.auth-token.v1'
  const AUTH_PENDING_KEY = 'bifrost.pc.pending-login.v1'
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
    let response = await nativeFetch(input, {
      ...init,
      headers,
      ...(sameControlApi && token ? { credentials: 'omit' } : {}),
    })
    if (sameControlApi && url.pathname === '/api/v1/auth/session') {
      let session = await response
        .clone()
        .json()
        .catch(() => null)
      // Retire legacy Guest/expired bearer sessions without masking an existing Feishu cookie.
      if (
        token &&
        (response.status === 401 || session?.guest === true || session?.authenticated === false)
      ) {
        localStorage.removeItem(AUTH_TOKEN_KEY)
        headers.delete('authorization')
        response = await nativeFetch(input, { ...init, headers })
        session = await response
          .clone()
          .json()
          .catch(() => null)
      }
      if (response.ok && (session?.authenticated === false || session?.guest === true)) {
        return new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      }
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

  let loginAttempt = null

  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  }

  function loginHint(message) {
    globalThis.BIFROST_PC_AUTH_HINT = message
    window.dispatchEvent(new CustomEvent('bifrost:pc-auth-status', { detail: message }))
  }

  function stopLogin() {
    if (!loginAttempt) return
    loginAttempt.stopped = true
    window.clearTimeout(loginAttempt.timer)
    window.clearTimeout(loginAttempt.expiryTimer)
    loginAttempt.controller.abort()
    loginAttempt = null
  }

  function pollLogin(login) {
    stopLogin()
    globalThis.BIFROST_PC_AUTH_HINT = `在浏览器中确认登录，验证码 ${login.code}。确认后这里会自动更新`
    const attempt = {
      stopped: false,
      controller: new AbortController(),
      timer: null,
      expiryTimer: null,
    }
    loginAttempt = attempt

    function finish(message) {
      if (attempt.stopped) return
      stopLogin()
      localStorage.removeItem(AUTH_PENDING_KEY)
      if (message) loginHint(message)
    }

    async function poll() {
      if (attempt.stopped) return
      try {
        const response = await nativeFetch(`/api/v1/auth/pc-login/${login.id}/claim`, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verifier: login.verifier }),
          signal: attempt.controller.signal,
        })
        if (attempt.stopped) return
        const body = await response.json()
        if (attempt.stopped) return
        if (response.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(body?.token || '')) {
          localStorage.setItem(AUTH_TOKEN_KEY, body.token)
          finish('')
          window.location.reload()
          return
        }
        if (response.status >= 400 && response.status < 500) {
          finish(
            body?.code === 'PC_LOGIN_DENIED' ? '已取消登录，可重新发起' : '登录请求已失效，请重试'
          )
          return
        }
      } catch {
        // Brief outages are retryable; the absolute expiry below also aborts stalled requests.
      }
      if (!attempt.stopped) attempt.timer = window.setTimeout(poll, 2_000)
    }

    attempt.expiryTimer = window.setTimeout(
      () => finish('登录等待已超时，请重试'),
      Math.max(0, login.expiresAt - Date.now())
    )
    attempt.timer = window.setTimeout(poll, 100)
  }

  async function startPcLogin() {
    stopLogin()
    localStorage.removeItem(AUTH_PENDING_KEY)
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    )
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 10_000)
    let response
    try {
      response = await nativeFetch('/api/v1/auth/pc-login', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge }),
        signal: controller.signal,
      })
    } finally {
      window.clearTimeout(timer)
    }
    if (!response.ok) throw new Error('无法发起 PC 登录，请稍后重试')
    const body = await response.json()
    const url = new URL(body.authorizationUrl)
    if (
      url.origin !== CONTROL_ORIGIN ||
      url.pathname !== '/api/v1/auth/pc-login/authorize' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.id || '') ||
      url.searchParams.get('request') !== body.id ||
      !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(body.code || '') ||
      !Number.isFinite(body.expiresAt) ||
      !Number.isInteger(body.expiresInMs) ||
      body.expiresInMs <= 0 ||
      body.expiresInMs > 5 * 60_000
    ) {
      throw new Error('PC 登录接口返回了无效请求')
    }
    // Client and server wall clocks need not agree, even to the millisecond.
    // The server still enforces its own absolute expiry on every claim.
    const login = {
      id: body.id,
      verifier,
      code: body.code,
      expiresAt: Date.now() + body.expiresInMs,
    }
    localStorage.setItem(AUTH_PENDING_KEY, JSON.stringify(login))
    // Electron can open the system browser and return null. No opener is required.
    window.open(url.href, '_blank')
    pollLogin(login)
    return {
      id: 2,
      url: url.href,
      authHint: `在浏览器中确认登录，验证码 ${body.code}。确认后这里会自动更新`,
    }
  }

  window.addEventListener('pagehide', stopLogin)
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_PENDING_KEY) || 'null')
    if (
      saved &&
      /^[A-Za-z0-9_-]{43}$/.test(saved.id) &&
      /^[A-Za-z0-9_-]{43}$/.test(saved.verifier) &&
      /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(saved.code) &&
      Number.isFinite(saved.expiresAt) &&
      saved.expiresAt > Date.now() &&
      saved.expiresAt <= Date.now() + 5 * 60_000
    ) {
      pollLogin(saved)
    } else localStorage.removeItem(AUTH_PENDING_KEY)
  } catch {
    localStorage.removeItem(AUTH_PENDING_KEY)
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
      const target = new URL(url, CONTROL_ORIGIN)
      if (target.origin === CONTROL_ORIGIN && target.pathname === '/api/v1/auth/feishu/start')
        return startPcLogin()
      window.open(target.href, '_blank')
      return { id: 2, url: target.href }
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
