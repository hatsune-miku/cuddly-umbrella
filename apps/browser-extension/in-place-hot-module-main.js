;(() => {
  const CHANNEL = 'bifrost:in-place-hot-module:v1'
  const CONFIG_WAIT_MS = 1_000
  const INSTALLATION_MARKER = '__BIFROST_IN_PLACE_HOT_MODULE_INSTALLED__'
  const LOCALHOST_REMOTE_HANDOFF_KEY = '__BIFROST_LOCALHOST_REMOTE_HANDOFF_V1__'
  const MF_PATCH_MARKER = '__BIFROST_LOCALHOST_REMOTE_PROVIDER_PATCHED__'
  if (window[INSTALLATION_MARKER]) return
  window[INSTALLATION_MARKER] = true

  const nativeFetch = window.fetch
  const NativeXMLHttpRequest = window.XMLHttpRequest
  const NativeResponse = window.Response
  if (
    typeof nativeFetch !== 'function' &&
    typeof NativeXMLHttpRequest !== 'function' &&
    typeof NativeResponse !== 'function'
  ) {
    return
  }

  let configuration = null
  let configurationMessageReceived = false
  let resolveConfiguration
  let lastReportedApp = ''
  const configurationReady = new Promise((resolve) => {
    resolveConfiguration = resolve
  })

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }

  function normalizedModules(value) {
    if (!Array.isArray(value) || value.length > 40) return null
    const seen = new Set()
    const modules = []
    for (const candidate of value) {
      if (!isRecord(candidate)) return null
      const moduleKey = typeof candidate.moduleKey === 'string' ? candidate.moduleKey.trim() : ''
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
      const version = typeof candidate.version === 'string' ? candidate.version.trim() : ''
      if (
        !moduleKey ||
        moduleKey.length > 80 ||
        seen.has(moduleKey) ||
        !name ||
        name.length > 160 ||
        !version ||
        version.length > 320 ||
        candidate.restartRequired !== true
      ) {
        return null
      }
      let entry
      try {
        entry = new URL(candidate.entry)
      } catch {
        return null
      }
      if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password) {
        return null
      }
      seen.add(moduleKey)
      modules.push({
        moduleKey,
        name,
        entry: entry.href,
        version,
        restartRequired: true,
      })
    }
    return modules
  }

  function consumeLocalhostRemoteHandoff() {
    if (window.location.hostname !== 'localhost') return null
    try {
      const raw = window.sessionStorage?.getItem(LOCALHOST_REMOTE_HANDOFF_KEY)
      if (raw === null || raw === undefined) return null
      window.sessionStorage.removeItem(LOCALHOST_REMOTE_HANDOFF_KEY)
      const handoff = JSON.parse(raw)
      if (
        !isRecord(handoff) ||
        handoff.origin !== window.location.origin ||
        !Number.isFinite(handoff.expiresAt) ||
        handoff.expiresAt <= Date.now()
      ) {
        return null
      }
      return normalizedModules(handoff.modules)
    } catch {
      return null
    }
  }

  const handoffConfiguration = consumeLocalhostRemoteHandoff()
  if (handoffConfiguration) {
    configuration = handoffConfiguration
    resolveConfiguration(handoffConfiguration)
  }

  function receiveConfiguration(event) {
    if (
      configurationMessageReceived ||
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.channel !== CHANNEL ||
      event.data?.type !== 'configuration'
    ) {
      return
    }
    const modules = normalizedModules(event.data.modules)
    if (!modules) return
    configurationMessageReceived = true
    configuration = modules
    window.removeEventListener('message', receiveConfiguration)
    resolveConfiguration(modules)
  }

  function overrideForRemoteKey(value) {
    if (!configuration?.length || typeof value !== 'string') return null
    const key = value.trim()
    return configuration.find((candidate) => candidate.moduleKey === key) || null
  }

  function patchMfRuntime(mf) {
    if (
      !isRecord(mf) ||
      mf[MF_PATCH_MARKER] === true ||
      typeof mf.add !== 'function' ||
      typeof mf.get !== 'function'
    ) {
      return
    }

    const nativeAdd = mf.add
    const nativeGet = mf.get
    Object.defineProperty(mf, MF_PATCH_MARKER, {
      configurable: false,
      enumerable: false,
      value: true,
    })

    mf.add = function bifrostLocalhostMfAdd(remoteConfig, ...args) {
      if (
        !isRecord(remoteConfig) ||
        typeof remoteConfig.key !== 'string' ||
        typeof remoteConfig.provider !== 'function'
      ) {
        return Reflect.apply(nativeAdd, this, [remoteConfig, ...args])
      }
      const nativeProvider = remoteConfig.provider
      const wrappedConfig = {
        ...remoteConfig,
        provider(...providerArgs) {
          const override = overrideForRemoteKey(remoteConfig.key)
          if (!override) return Reflect.apply(nativeProvider, remoteConfig, providerArgs)

          let original = null
          try {
            original = Reflect.apply(nativeProvider, remoteConfig, providerArgs)
          } catch {
            // A selected Bifrost provider remains usable if the localhost fallback resolver fails.
          }
          return {
            ...(isRecord(original) ? original : {}),
            name: override.name,
            entry: override.entry,
          }
        },
      }
      return Reflect.apply(nativeAdd, this, [wrappedConfig, ...args])
    }

    mf.get = function bifrostLocalhostMfGet(remotePath, ...args) {
      const providerKey = typeof remotePath === 'string' ? remotePath.split('/', 1)[0].trim() : ''
      if (!providerKey || providerKey === 'host' || configuration !== null) {
        return Reflect.apply(nativeGet, this, [remotePath, ...args])
      }
      return availableConfiguration().then(() =>
        Reflect.apply(nativeGet, this, [remotePath, ...args])
      )
    }
  }

  function installLocalhostMfInterceptor() {
    if (window.location.hostname !== 'localhost') return
    const property = '__MF'
    const descriptor = Object.getOwnPropertyDescriptor(window, property)
    let current = descriptor && 'value' in descriptor ? descriptor.value : window[property]
    patchMfRuntime(current)
    if (descriptor && !descriptor.configurable) return

    try {
      Object.defineProperty(window, property, {
        configurable: true,
        enumerable: descriptor?.enumerable === true,
        get() {
          return descriptor?.get ? Reflect.apply(descriptor.get, window, []) : current
        },
        set(value) {
          if (descriptor?.set) Reflect.apply(descriptor.set, window, [value])
          else current = value
          patchMfRuntime(value)
        },
      })
    } catch {
      // A non-standard host descriptor keeps the native localhost Remote behavior.
    }
  }

  function isHotModuleUrl(requestUrl, method = 'GET') {
    try {
      const url = new URL(requestUrl, window.location.href)
      return (
        String(method).trim().toUpperCase() === 'GET' &&
        url.origin === window.location.origin &&
        (url.pathname === '/api/v3/version/hot-module' || url.pathname === '/v3/version/hot-module')
      )
    } catch {
      return false
    }
  }

  function isHotModuleRequest(input, init) {
    const requestUrl = input instanceof Request ? input.url : String(input)
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    return isHotModuleUrl(requestUrl, method)
  }

  function reportHotModuleRequestContext(requestUrl, method = 'GET') {
    try {
      const url = new URL(requestUrl, window.location.href)
      if (!isHotModuleUrl(url.href, method)) return
      const app = url.searchParams.get('app')
      if (
        !app ||
        app.length > 160 ||
        /[\u0000-\u001f\u007f]/.test(app) ||
        app === lastReportedApp
      ) {
        return
      }
      lastReportedApp = app
      window.postMessage({ channel: CHANNEL, type: 'request-context', app }, window.location.origin)
    } catch {
      // Request observation must never affect the official request.
    }
  }

  function applyOverlay(responseBody, modules) {
    if (!modules.length || !isRecord(responseBody)) return false
    if ('code' in responseBody && responseBody.code !== 0 && responseBody.code !== '0') return false
    const root = 'data' in responseBody ? responseBody.data : responseBody
    if (!isRecord(root)) return false

    if (Array.isArray(root.modules)) {
      const next = [...root.modules]
      for (const override of modules) {
        const index = next.findIndex(
          (candidate) => isRecord(candidate) && candidate.key === override.moduleKey
        )
        const existing = index >= 0 && isRecord(next[index]) ? next[index] : {}
        const replacement = {
          ...existing,
          key: override.moduleKey,
          name: override.name,
          entry: override.entry,
          version: override.version,
          restartRequired: override.restartRequired,
        }
        if (index >= 0) next[index] = replacement
        else next.push(replacement)
      }
      root.modules = next
      return true
    }

    if (isRecord(root.modules)) {
      const next = { ...root.modules }
      for (const override of modules) {
        const existing = isRecord(next[override.moduleKey]) ? next[override.moduleKey] : {}
        next[override.moduleKey] = {
          ...existing,
          name: override.name,
          entry: override.entry,
          version: override.version,
          restartRequired: override.restartRequired,
        }
      }
      root.modules = next
      return true
    }

    // Some older test deployments expose the legacy flat map directly under data. Only accept
    // that shape when it already contains at least one Remote entry, so an unrelated JSON object
    // can never be turned into a hot-module response by the extension.
    const isRemoteValue = (value) =>
      (typeof value === 'string' && /^https?:\/\//i.test(value)) ||
      (isRecord(value) && typeof value.entry === 'string' && /^https?:\/\//i.test(value.entry))
    if (!Object.values(root).some(isRemoteValue)) return false
    for (const override of modules) {
      const existing = isRecord(root[override.moduleKey]) ? root[override.moduleKey] : {}
      root[override.moduleKey] = {
        ...existing,
        name: override.name,
        entry: override.entry,
        version: override.version,
        restartRequired: override.restartRequired,
      }
    }
    return true
  }

  async function availableConfiguration() {
    if (configuration !== null) return configuration
    return Promise.race([
      configurationReady,
      new Promise((resolve) => window.setTimeout(() => resolve([]), CONFIG_WAIT_MS)),
    ])
  }

  function installFetchInterceptor() {
    if (typeof nativeFetch !== 'function') return
    window.fetch = function bifrostInPlaceFetch(...args) {
      const [input, init] = args
      const requestUrl = input instanceof Request ? input.url : String(input)
      const requestMethod = init?.method || (input instanceof Request ? input.method : 'GET')
      reportHotModuleRequestContext(requestUrl, requestMethod)
      const responsePromise = Reflect.apply(nativeFetch, this, args)
      if (!isHotModuleRequest(input, init)) return responsePromise

      return Promise.resolve(responsePromise).then(async (response) => {
        try {
          if (!response?.ok) return response
          const modules = await availableConfiguration()
          if (!modules.length) return response
          const body = await response.clone().json()
          if (!applyOverlay(body, modules)) return response
          const headers = new Headers(response.headers)
          headers.delete('content-encoding')
          headers.delete('content-length')
          const replacement = new Response(JSON.stringify(body), {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
          for (const property of ['url', 'redirected', 'type']) {
            try {
              Object.defineProperty(replacement, property, { value: response[property] })
            } catch {
              // These metadata properties are non-essential to hot-module JSON consumers.
            }
          }
          return replacement
        } catch {
          return response
        }
      })
    }
  }

  // Some KOOK builds keep a reference to fetch (or wrap it) before application bootstrap. Patching
  // Response parsing as well keeps the interception effective without redirecting the signed,
  // authenticated request away from the official origin. The scope remains limited to the two
  // same-origin hot-module paths and fails open on every malformed or unsupported response.
  function installResponseInterceptor() {
    const prototype = NativeResponse?.prototype
    const nativeJson = prototype?.json
    const nativeText = prototype?.text
    if (!prototype || typeof nativeJson !== 'function' || typeof nativeText !== 'function') return

    const shouldTransform = (response) => {
      if (!response?.ok || !isHotModuleUrl(response.url || '', 'GET')) return false
      reportHotModuleRequestContext(response.url, 'GET')
      return true
    }

    prototype.json = function bifrostInPlaceResponseJson(...args) {
      const parsed = Reflect.apply(nativeJson, this, args)
      if (!shouldTransform(this)) return parsed
      return Promise.resolve(parsed).then(async (body) => {
        try {
          const modules = await availableConfiguration()
          if (modules.length) applyOverlay(body, modules)
        } catch {
          // Preserve the official parsed response when configuration or overlay validation fails.
        }
        return body
      })
    }

    prototype.text = function bifrostInPlaceResponseText(...args) {
      const parsed = Reflect.apply(nativeText, this, args)
      if (!shouldTransform(this)) return parsed
      return Promise.resolve(parsed).then(async (body) => {
        try {
          const modules = await availableConfiguration()
          if (!modules.length) return body
          const decoded = JSON.parse(body)
          return applyOverlay(decoded, modules) ? JSON.stringify(decoded) : body
        } catch {
          return body
        }
      })
    }
  }

  function installXhrInterceptor() {
    if (typeof NativeXMLHttpRequest !== 'function') return
    const prototype = NativeXMLHttpRequest.prototype
    const nativeOpen = prototype?.open
    const responseTextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'responseText')
    const responseDescriptor = Object.getOwnPropertyDescriptor(prototype, 'response')
    if (
      typeof nativeOpen !== 'function' ||
      typeof responseTextDescriptor?.get !== 'function' ||
      typeof responseDescriptor?.get !== 'function'
    ) {
      return
    }

    const requests = new WeakMap()
    const cached = new WeakMap()
    prototype.open = function bifrostInPlaceXhrOpen(method, url, ...args) {
      requests.set(this, { method, url: String(url) })
      cached.delete(this)
      reportHotModuleRequestContext(String(url), method)
      return Reflect.apply(nativeOpen, this, [method, url, ...args])
    }

    function transformed(xhr, raw, kind) {
      try {
        const request = requests.get(xhr)
        if (
          !request ||
          !isHotModuleUrl(request.url, request.method) ||
          xhr.status < 200 ||
          xhr.status >= 300 ||
          !configuration?.length
        ) {
          return raw
        }
        const previous = cached.get(xhr)
        if (previous?.source === raw && previous[kind] !== undefined) return previous[kind]
        const sourceBody = kind === 'text' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw))
        if (!applyOverlay(sourceBody, configuration)) return raw
        const result = {
          source: raw,
          text: JSON.stringify(sourceBody),
          json: sourceBody,
        }
        cached.set(xhr, result)
        return result[kind]
      } catch {
        return raw
      }
    }

    try {
      Object.defineProperty(prototype, 'responseText', {
        ...responseTextDescriptor,
        get() {
          const raw = Reflect.apply(responseTextDescriptor.get, this, [])
          return transformed(this, raw, 'text')
        },
      })
      Object.defineProperty(prototype, 'response', {
        ...responseDescriptor,
        get() {
          const raw = Reflect.apply(responseDescriptor.get, this, [])
          return this.responseType === 'json'
            ? transformed(this, raw, 'json')
            : this.responseType === '' || this.responseType === 'text'
              ? transformed(this, raw, 'text')
              : raw
        },
      })
    } catch {
      // A browser that does not expose configurable XHR response accessors keeps native behavior.
    }
  }

  window.addEventListener('message', receiveConfiguration)
  installLocalhostMfInterceptor()
  installResponseInterceptor()
  installFetchInterceptor()
  installXhrInterceptor()
})()
