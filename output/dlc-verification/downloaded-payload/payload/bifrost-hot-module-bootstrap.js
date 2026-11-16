// Adapted from kook-plugin-tools, author rin (MIT). Stable PC preview storage/protocol.
;(() => {
  const CONFIG_KEY = 'bifrost.pc.in-place-preview.v1'
  const INSTALLATION_MARKER = '__BIFROST_PC_HOT_MODULE_INSTALLED__'
  if (window[INSTALLATION_MARKER]) return
  window[INSTALLATION_MARKER] = true

  const nativeFetch = window.fetch
  const NativeXMLHttpRequest = window.XMLHttpRequest
  const NativeResponse = window.Response

  function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }

  function previewEntry(previewOrigin, selection) {
    if (
      typeof selection?.artifactId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(selection.artifactId) ||
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

  function readConfiguration() {
    try {
      const active = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')
      if (
        !isRecord(active) ||
        active.mode !== 'remote' ||
        active.preview?.siteArtifactId ||
        !Array.isArray(active.preview?.selections) ||
        !Number.isFinite(Date.parse(active.preview?.expiresAt || '')) ||
        Date.parse(active.preview.expiresAt) <= Date.now()
      ) {
        return []
      }
      const modules = active.preview.selections.flatMap((selection) => {
        const moduleKey = typeof selection?.moduleKey === 'string' ? selection.moduleKey.trim() : ''
        const name =
          typeof selection?.providerName === 'string' ? selection.providerName.trim() : ''
        const version = typeof selection?.version === 'string' ? selection.version.trim() : ''
        const entry = previewEntry(active.previewOrigin, selection)
        if (!moduleKey || !name || !version || !entry) return []
        return [{ moduleKey, name, entry, version, restartRequired: true }]
      })
      return modules.length === active.preview.selections.length ? modules : []
    } catch {
      return []
    }
  }

  const modules = readConfiguration()
  window.__BIFROST_PC_HOT_MODULE_ACTIVE__ = modules.length > 0
  if (!modules.length) return

  function isHotModuleUrl(requestUrl, method = 'GET') {
    try {
      const url = new URL(requestUrl, window.location.href)
      return (
        String(method).trim().toUpperCase() === 'GET' &&
        ['http:', 'https:'].includes(url.protocol) &&
        (url.pathname === '/api/v3/version/hot-module' || url.pathname === '/v3/version/hot-module')
      )
    } catch {
      return false
    }
  }

  function applyOverlay(responseBody) {
    if (!isRecord(responseBody)) return false
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
          restartRequired: true,
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
          restartRequired: true,
        }
      }
      root.modules = next
      return true
    }

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
        restartRequired: true,
      }
    }
    return true
  }

  if (typeof nativeFetch === 'function') {
    window.fetch = function bifrostPcFetch(...args) {
      const [input, init] = args
      const requestUrl = input instanceof Request ? input.url : String(input)
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      const responsePromise = Reflect.apply(nativeFetch, this, args)
      if (!isHotModuleUrl(requestUrl, method)) return responsePromise
      return Promise.resolve(responsePromise).then(async (response) => {
        try {
          if (!response?.ok) return response
          const body = await response.clone().json()
          if (!applyOverlay(body)) return response
          const headers = new Headers(response.headers)
          headers.delete('content-encoding')
          headers.delete('content-length')
          return new Response(JSON.stringify(body), {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        } catch {
          return response
        }
      })
    }
  }

  const responsePrototype = NativeResponse?.prototype
  const nativeJson = responsePrototype?.json
  const nativeText = responsePrototype?.text
  if (responsePrototype && typeof nativeJson === 'function' && typeof nativeText === 'function') {
    const shouldTransform = (response) => response?.ok && isHotModuleUrl(response.url || '', 'GET')
    responsePrototype.json = function bifrostPcResponseJson(...args) {
      const parsed = Reflect.apply(nativeJson, this, args)
      if (!shouldTransform(this)) return parsed
      return Promise.resolve(parsed).then((body) => {
        try {
          applyOverlay(body)
        } catch {
          // Keep the official response on unsupported data.
        }
        return body
      })
    }
    responsePrototype.text = function bifrostPcResponseText(...args) {
      const parsed = Reflect.apply(nativeText, this, args)
      if (!shouldTransform(this)) return parsed
      return Promise.resolve(parsed).then((body) => {
        try {
          const decoded = JSON.parse(body)
          return applyOverlay(decoded) ? JSON.stringify(decoded) : body
        } catch {
          return body
        }
      })
    }
  }

  const xhrPrototype = NativeXMLHttpRequest?.prototype
  const nativeOpen = xhrPrototype?.open
  const responseTextDescriptor = xhrPrototype
    ? Object.getOwnPropertyDescriptor(xhrPrototype, 'responseText')
    : null
  const responseDescriptor = xhrPrototype
    ? Object.getOwnPropertyDescriptor(xhrPrototype, 'response')
    : null
  if (
    xhrPrototype &&
    typeof nativeOpen === 'function' &&
    typeof responseTextDescriptor?.get === 'function' &&
    typeof responseDescriptor?.get === 'function'
  ) {
    const requests = new WeakMap()
    const cached = new WeakMap()
    xhrPrototype.open = function bifrostPcXhrOpen(method, url, ...args) {
      requests.set(this, { method, url: String(url) })
      cached.delete(this)
      return Reflect.apply(nativeOpen, this, [method, url, ...args])
    }
    const transformed = (xhr, raw, kind) => {
      try {
        const request = requests.get(xhr)
        if (
          !request ||
          !isHotModuleUrl(request.url, request.method) ||
          xhr.status < 200 ||
          xhr.status >= 300
        ) {
          return raw
        }
        const previous = cached.get(xhr)
        if (previous?.source === raw && previous[kind] !== undefined) return previous[kind]
        const body = kind === 'text' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw))
        if (!applyOverlay(body)) return raw
        const result = { source: raw, text: JSON.stringify(body), json: body }
        cached.set(xhr, result)
        return result[kind]
      } catch {
        return raw
      }
    }
    try {
      Object.defineProperty(xhrPrototype, 'responseText', {
        ...responseTextDescriptor,
        get() {
          return transformed(this, Reflect.apply(responseTextDescriptor.get, this, []), 'text')
        },
      })
      Object.defineProperty(xhrPrototype, 'response', {
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
      // Old Electron versions may expose non-configurable XHR accessors.
    }
  }
})()
