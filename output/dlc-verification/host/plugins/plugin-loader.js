if (typeof window !== 'undefined' && window.KOOKPluginLoader) {
  console.log('[Plugin Loader] Already loaded, skipping...')
} else {
class PluginManager {
  constructor() {
    this.plugins = new Map()
    this.enabledPlugins = new Set()
    this.loadPromise = null
    this.hasLoaded = false
    this.removalInProgress = false
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async loadPlugins() {
    if (this.loadPromise) {
      return this.loadPromise
    }

    this.loadPromise = (async () => {
      try {
        const manifest = await this.fetchManifest()
        const pluginList = Array.isArray(manifest?.plugins) ? manifest.plugins : []

        for (const pluginInfo of pluginList) {
          await this.loadPlugin(pluginInfo)
        }

        await this.scanLocalPlugins()
        this.restoreImportedPlugins()
        await this.restoreEnabledState()

        this.hasLoaded = true
        console.log('[Plugin Loader] Loaded plugins:', this.plugins.size)
        return this.getPluginList()
      } finally {
        this.loadPromise = null
      }
    })()

    return this.loadPromise
  }

  async restoreEnabledState() {
    const savedState = this.loadState()
    const savedPlugins = Array.isArray(savedState?.plugins) ? savedState.plugins : []
    // Resolve every choice before activation: enablePlugin saves the full list.
    const choices = Array.from(this.plugins.values()).map(plugin => {
      const saved = savedPlugins.find(record => record?.id === plugin.id)
      return {
        id: plugin.id,
        enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : plugin.defaultEnabled === true
      }
    })

    for (const { id, enabled } of choices) {
      if (enabled) {
        try {
          await this.enablePlugin(id, { suppressToast: true, source: 'restore' })
        } catch (e) {
          console.warn('[Plugin Loader] Failed to restore plugin:', id, e?.message || e)
        }
      }
    }
  }

  async scanLocalPlugins() {
    const manifestCandidates = [
      '/app/user-plugins/manifest.json',
      '/user-plugins/manifest.json',
      '/app/plugins/user-plugins/manifest.json',
      './user-plugins/manifest.json'
    ]

    for (const manifestUrl of manifestCandidates) {
      try {
        const response = await fetch(manifestUrl, { cache: 'no-store' })
        if (!response.ok) {
          continue
        }

        const localManifest = await response.json()
        if (!Array.isArray(localManifest?.plugins) || localManifest.plugins.length === 0) {
          return []
        }

        return this.loadPluginsFromManifest(localManifest)
      } catch (e) {
        continue
      }
    }

    return []
  }

  async loadPluginsFromManifest(localManifest) {
    const loadedLocalPlugins = []

    for (const pluginInfo of localManifest.plugins || []) {
      if (!pluginInfo?.id || !pluginInfo.file) {
        continue
      }

      if (this.plugins.has(pluginInfo.id)) {
        loadedLocalPlugins.push(pluginInfo.id)
        continue
      }

      try {
        const response = await fetch(`/app/user-plugins/${pluginInfo.file}`, { cache: 'no-store' })
        if (!response.ok) {
          continue
        }

        const pluginCode = await response.text()
        const plugin = this.evaluatePlugin(pluginCode, { trusted: false, source: 'local' })
        plugin.id = pluginInfo.id
        plugin.info = pluginInfo
        plugin.loaderSource = 'local'
        plugin.enabled = false

        this.plugins.set(plugin.id, plugin)
        loadedLocalPlugins.push(pluginInfo.id)
      } catch (e) {
        console.error('[Plugin Loader] Failed to load local plugin:', pluginInfo?.name || pluginInfo?.id, e)
      }
    }

    return loadedLocalPlugins
  }

  async loadPlugin(pluginInfo) {
    try {
      const response = await fetch(`/app/plugins/${pluginInfo.file}`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const code = await response.text()
      const plugin = this.evaluatePlugin(code, { trusted: true, source: 'core' })
      plugin.id = pluginInfo.id
      plugin.info = pluginInfo
      plugin.loaderSource = 'core'
      plugin.enabled = false

      this.plugins.set(plugin.id, plugin)
      return plugin
    } catch (e) {
      console.error('[Plugin Loader] Failed to load core plugin:', pluginInfo?.name || pluginInfo?.id, e)
      return null
    }
  }

  evaluatePlugin(code, meta = {}) {
    // Userscripts run immediately and have no plugin lifecycle to undo their UI
    // or request hooks. Reject their metadata before evaluating any of the code.
    if (/^[\t \uFEFF]*\/\/[\t ]*==UserScript==[\t ]*\r?$/m.test(code)) {
      throw new Error('这是油猴脚本，请改用从 KFC 下载的 DLC ZIP 安装包。')
    }
    const module = { exports: {} }
    const exports = module.exports

    const trusted = Boolean(meta.trusted)

    const safeRequire = (name) => {
      if (!trusted) {
        return undefined
      }

      if (typeof window !== 'undefined' && typeof window.require === 'function') {
        return window.require(name)
      }

      if (typeof require === 'function') {
        return require(name)
      }

      return undefined
    }

    const safeConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console)
    }

    const safeContext = {
      console: safeConsole,
      setTimeout: setTimeout.bind(null),
      setInterval: setInterval.bind(null),
      clearTimeout,
      clearInterval
    }

    const pluginFunction = new Function('module', 'exports', 'require', 'context', `'use strict';\n${code}`)
    pluginFunction(module, exports, safeRequire, safeContext)

    if (!module.exports || typeof module.exports !== 'object') {
      throw new Error('Plugin must export an object')
    }

    if (!module.exports.name) {
      throw new Error('Plugin must have a name property')
    }

    return module.exports
  }

  getMissingPermissions(plugin) {
    if (!Array.isArray(plugin?.permissions) || plugin.permissions.length === 0) {
      return []
    }

    return plugin.permissions.filter(permission => !this.checkPermission(permission))
  }

  assertPluginPermissions(plugin) {
    const missingPerms = this.getMissingPermissions(plugin)
    if (missingPerms.length > 0) {
      throw new Error(`Missing permissions: ${missingPerms.join(', ')}`)
    }
  }

  async enablePlugin(id, options = {}) {
    if (this.removalInProgress && options.source !== 'delete-restore') throw new Error('正在删除插件，请稍后重试')
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.enabled) return

    this.assertPluginPermissions(plugin)

    const context = new PluginContext(plugin, options)
    if (typeof plugin.onActivate === 'function') {
      await plugin.onActivate(context)
    }

    plugin.enabled = true
    plugin.context = context
    this.enabledPlugins.add(id)
    this.saveState()
  }

  async disablePlugin(id, options = {}) {
    const plugin = this.plugins.get(id)
    if (!plugin || !plugin.enabled) return
    const persistState = options.persistState !== false

    if (typeof plugin.onDeactivate === 'function') {
      await plugin.onDeactivate({ source: options.source || 'disable' })
    }

    plugin.enabled = false
    plugin.context = null
    this.enabledPlugins.delete(id)
    if (persistState) {
      this.saveState()
    }
  }

  async executePlugin(id) {
    if (this.removalInProgress) return { success: false, error: '正在删除插件，请稍后重试' }
    const plugin = this.plugins.get(id)
    if (!plugin) {
      return { success: false, error: 'Plugin not found' }
    }

    try {
      this.assertPluginPermissions(plugin)

      const context = plugin.enabled && plugin.context
        ? new PluginContext(plugin, { ...(plugin.context.options || {}), suppressToast: false, source: 'execute' })
        : new PluginContext(plugin, { source: 'execute' })
      if (plugin.enabled) {
        plugin.context = context
      }

      if (typeof plugin.onExecute === 'function') {
        await plugin.onExecute(context)
      } else if (typeof plugin.onActivate === 'function') {
        await plugin.onActivate(context)
      }
      return { success: true }
    } catch (e) {
      console.error('[Plugin Loader] Execute failed:', e)
      return { success: false, error: e.message }
    }
  }

  checkPermission(permission) {
    const defaultPermissions = {
      storage: true,
      network: true,
      userInfo: true,
      channelInfo: false,
      sendMessage: false
    }

    return Boolean(defaultPermissions[permission])
  }

  getPluginList() {
    return Array.from(this.plugins.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      icon: plugin.icon,
      enabled: Boolean(plugin.enabled)
    }))
  }

  getPlugin(id) {
    return this.plugins.get(id)
  }

  async deactivateEnabledPlugins(options = {}) {
    const enabledIds = Array.from(this.enabledPlugins)
    const persistState = options.persistState !== false

    for (const id of enabledIds) {
      try {
        await this.disablePlugin(id, { persistState, source: options.source })
      } catch (e) {
        console.error('[Plugin Loader] Failed to deactivate plugin:', id, e)
      }
    }

    return enabledIds
  }

  async restoreRuntimeSnapshot(snapshot) {
    if (!snapshot) {
      return
    }

    this.plugins = new Map(snapshot.plugins)
    this.enabledPlugins = new Set()

    for (const plugin of this.plugins.values()) {
      plugin.enabled = false
      plugin.context = null
    }

    for (const id of snapshot.enabledIds) {
      if (!this.plugins.has(id)) {
        continue
      }

      try {
        await this.enablePlugin(id, { suppressToast: true, source: 'refresh-restore' })
      } catch (e) {
        console.error('[Plugin Loader] Failed to restore plugin after refresh:', id, e)
      }
    }
  }

  async refreshPluginSources(options = {}) {
    if (this.removalInProgress) throw new Error('正在删除插件，请稍后刷新')
    const maxAttempts = options.maxAttempts || 3
    const retryDelay = options.retryDelay || 800
    const snapshot = {
      plugins: new Map(this.plugins),
      enabledIds: Array.from(this.enabledPlugins)
    }
    let loadedSuccessfully = false

    await this.deactivateEnabledPlugins({ persistState: false, source: 'refresh' })

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.plugins.clear()
        this.enabledPlugins.clear()
        await this.loadPlugins()
        loadedSuccessfully = true

        const pluginList = this.getPluginList()
        if (pluginList.length > 0) {
          return pluginList
        }
      } catch (e) {
        console.error('[Plugin Loader] Refresh failed:', e)
      }

      if (attempt < maxAttempts) {
        await this.delay(retryDelay)
      }
    }

    if (!loadedSuccessfully) {
      await this.restoreRuntimeSnapshot(snapshot)
    }

    return this.getPluginList()
  }

  restoreImportedPlugins() {
    const importedPlugins = this.getImportedPlugins()
    const restoredPluginIds = []

    Object.entries(importedPlugins).forEach(([id, pluginData]) => {
      if (this.plugins.has(id) || !pluginData?.code) {
        return
      }

      try {
        const plugin = this.evaluatePlugin(pluginData.code, { trusted: false, source: 'imported' })
        plugin.id = id
        plugin.enabled = false
        plugin.file = pluginData.file || `${id}.js`
        plugin.loaderSource = 'imported'
        plugin.info = {
          id,
          name: plugin.name,
          description: plugin.description || '',
          version: plugin.version || '1.0.0',
          icon: plugin.icon || null,
          enabled: false,
          file: plugin.file
        }

        this.plugins.set(id, plugin)
        restoredPluginIds.push(id)
      } catch (e) {
        console.error('[Plugin Loader] Failed to restore imported plugin:', id, e)
      }
    })

    return restoredPluginIds
  }

  async addPlugin(code, filename) {
    try {
      if (this.removalInProgress) throw new Error('正在删除插件，请稍后导入')
      const pluginId = filename.replace(/\.js$/i, '')
      if (this.plugins.get(pluginId)?.info?.dlcId) {
        throw new Error('此插件通过 DLC 安装，请导入 ZIP 安装包或在 KFC 中更新')
      }
      const plugin = this.evaluatePlugin(code, { trusted: false, source: 'imported' })

      plugin.id = pluginId
      plugin.enabled = false
      plugin.file = filename
      plugin.loaderSource = 'imported'
      this.plugins.set(pluginId, plugin)

      const pluginData = {
        id: pluginId,
        name: plugin.name,
        description: plugin.description || '',
        version: plugin.version || '1.0.0',
        icon: plugin.icon || null,
        enabled: false,
        file: filename
      }

      this.saveImportedPlugin(pluginId, code, pluginData)
      return { success: true, plugin: pluginData }
    } catch (e) {
      console.error('[Plugin Loader] Add plugin failed:', e)
      return { success: false, error: e.message }
    }
  }

  saveImportedPlugin(id, code, pluginInfo = {}) {
    const importedPlugins = this.getImportedPlugins()
    importedPlugins[id] = {
      code,
      file: pluginInfo.file || `${id}.js`,
      name: pluginInfo.name || id,
      description: pluginInfo.description || '',
      version: pluginInfo.version || '1.0.0',
      icon: pluginInfo.icon || null,
      timestamp: Date.now()
    }
    localStorage.setItem('kook-imported-plugins', JSON.stringify(importedPlugins))
  }

  getImportedPlugins() {
    try {
      const data = localStorage.getItem('kook-imported-plugins')
      return data ? JSON.parse(data) : {}
    } catch {
      return {}
    }
  }

  deleteImportedPlugin(id) {
    const managed = this.plugins.get(id)?.info
    if (managed?.dlcId) throw new Error(managed.dlcSource === 'local-package' ? '本地 ZIP 插件暂不支持卸载，可关闭插件开关暂停使用' : '请在 KFC 的宿主详情中卸载此 DLC')
    const importedPlugins = this.getImportedPlugins()
    delete importedPlugins[id]
    localStorage.setItem('kook-imported-plugins', JSON.stringify(importedPlugins))

    const plugin = this.plugins.get(id)
    if (plugin && plugin.enabled) {
      this.disablePlugin(id).catch(() => {})
    }
    this.plugins.delete(id)
  }

  async inspectRemoval(id) {
    if (this.removalInProgress) throw new Error('正在删除插件，请稍后重试')
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error('插件已不存在，请刷新列表')
    if (plugin.loaderSource === 'core') throw new Error('此插件属于核心组件，无法从列表删除')
    const imported = plugin.loaderSource === 'imported'
    if (!imported && !window.KOOKDlcInstaller?.inspectRemoval) throw new Error('删除组件尚未就绪，请先更新注入器并重新加载 KOOK')
    const diskPreview = imported ? null : await window.KOOKDlcInstaller.inspectRemoval(id)
    const preview = diskPreview || { pluginId: id, name: plugin.name || id, pluginIds: [id], names: [plugin.name || id] }
    const token = `${Date.now()}-${Math.random()}`
    this.removalPlan = { id, token, diskPreview, pluginIds: [...preview.pluginIds], importedSnapshot: JSON.stringify(this.getImportedPlugins()[id]), instances: preview.pluginIds.map(id => this.plugins.get(id)) }
    return { ...preview, pluginIds: [...preview.pluginIds], stateToken: token }
  }

  async removePlugin(id, preview) {
    if (this.removalInProgress) throw new Error('正在删除插件，请稍后重试')
    const plan = this.removalPlan
    if (!plan || plan.id !== id || plan.token !== preview?.stateToken || plan.instances.some((plugin, index) => plugin !== this.plugins.get(plan.pluginIds[index]))) throw new Error('插件状态已变化，请重新确认删除')
    if (plan.importedSnapshot !== JSON.stringify(this.getImportedPlugins()[id])) throw new Error('插件脚本已变化，请重新确认删除')
    this.removalInProgress = true
    const ids = plan.pluginIds
    const enabled = ids.filter(id => this.plugins.get(id)?.enabled)
    const keys = ['kook-imported-plugins', 'kook-plugin-state']
    const storageBackup = new Map()
    try {
      for (const key of keys) storageBackup.set(key, localStorage.getItem(key))
      for (const id of enabled) await this.disablePlugin(id, { persistState: false, source: 'delete' })
      const imported = this.getImportedPlugins()
      for (const id of ids) delete imported[id]
      localStorage.setItem(keys[0], JSON.stringify(imported))
      const saved = this.loadState() || {}
      const liveIds = new Set(this.plugins.keys())
      const retained = (Array.isArray(saved.plugins) ? saved.plugins : []).filter(plugin => !ids.includes(plugin.id) && !liveIds.has(plugin.id))
      localStorage.setItem(keys[1], JSON.stringify({ ...saved, plugins: [...retained, ...Array.from(this.plugins.values()).filter(plugin => !ids.includes(plugin.id)).map(plugin => ({ id: plugin.id, dlcId: plugin.info?.dlcId, enabled: Boolean(plugin.enabled) }))] }))
      if (plan.diskPreview) await window.KOOKDlcInstaller.remove(id, plan.diskPreview)
      for (const id of ids) { this.plugins.delete(id); this.enabledPlugins.delete(id) }
      this.removalPlan = null
      return { pluginIds: ids }
    } catch (error) {
      const failures = []
      for (const id of enabled) {
        try { await this.enablePlugin(id, { suppressToast: true, source: 'delete-restore' }) } catch (restoreError) { failures.push(restoreError.message) }
      }
      for (const [key, value] of storageBackup) {
        try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch (restoreError) { failures.push(restoreError.message) }
      }
      throw new Error(error.message + (failures.length ? '；恢复部分状态失败：' + failures.join('；') : ''))
    } finally { this.removalInProgress = false }
  }

  saveState() {
    const savedPlugins = this.loadState()?.plugins
    const retainedDlc = (Array.isArray(savedPlugins) ? savedPlugins : []).filter(plugin => plugin?.dlcId && !this.plugins.has(plugin.id))
    const state = {
      plugins: [...retainedDlc, ...Array.from(this.plugins.values()).map(plugin => ({
        id: plugin.id,
        dlcId: plugin.info?.dlcId,
        enabled: Boolean(plugin.enabled),
        lastActivated: Date.now()
      }))]
    }

    localStorage.setItem('kook-plugin-state', JSON.stringify(state))
  }

  loadState() {
    try {
      const state = localStorage.getItem('kook-plugin-state')
      return state ? JSON.parse(state) : null
    } catch {
      return null
    }
  }

  async fetchManifest() {
    const urls = [
      '/app/plugins/manifest.json',
      '/plugins/manifest.json'
    ]

    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (response.ok) {
          return await response.json()
        }
      } catch {
        continue
      }
    }

    return null
  }
}

class PluginContext {
  constructor(plugin, options = {}) {
    this.plugin = plugin
    this.options = options
  }

  registerMenu(options) {
    console.log(`[${this.plugin.name}] registerMenu:`, options?.label)
    return options?.id
  }

  onMessage(name, handler) {
    console.log(`[${this.plugin.name}] onMessage:`, name)
    return handler
  }

  showToast(message) {
    if (this.options.suppressToast) {
      return
    }

    if (typeof window !== 'undefined' && window.KOOKPluginUI?.showNotification) {
      window.KOOKPluginUI.showNotification(`[${this.plugin.name}] ${message}`)
      return
    }

    console.log(`[${this.plugin.name}] ${message}`)
  }

  openUrl(url) {
    if (typeof window !== 'undefined' && window.open) {
      window.open(url)
    }
  }

  sendToRenderer(name, data) {
    console.log(`[${this.plugin.name}] sendToRenderer:`, name, data)
  }
}

const pluginManager = new PluginManager()

if (typeof window !== 'undefined') {
  const schedulePluginLoad = () => {
    pluginManager.loadPlugins().catch(e => {
      console.error('[Plugin Loader] Initial load failed:', e)
    })
  }

  if (document.readyState === 'complete') {
    setTimeout(schedulePluginLoad, 2000)
  } else {
    window.addEventListener('load', () => setTimeout(schedulePluginLoad, 2000), { once: true })
  }

  window.KOOKPluginLoader = pluginManager
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pluginManager
}
}
