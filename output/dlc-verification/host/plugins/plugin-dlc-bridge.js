// Trusted host bridge. Archive inspection never evaluates the imported plugin.
if (!window.KOOKDlcInstaller) {
  window.KOOKDlcInstaller = (() => {
    let importer, updater, context
    function getContext() {
      if (context) return context
      const nodeRequire = typeof window.require === 'function' ? window.require : (typeof require === 'function' ? require : null)
      if (!nodeRequire) throw new Error('当前客户端无法安装 ZIP，请先使用新版注入器更新此 KOOK 实例')
      const path = nodeRequire('path')
      const fs = nodeRequire('fs')
      const nodeProcess = nodeRequire('process')
      const resources = nodeProcess.resourcesPath || path.join(path.dirname(nodeProcess.execPath), 'resources')
      const build = path.join(resources, 'app', 'webapp', 'build')
      const config = JSON.parse(fs.readFileSync(path.join(build, 'plugin-runtime', 'host.json'), 'utf8'))
      context = { nodeRequire, path, build, config }
      return context
    }
    function getImporter() {
      if (importer) return importer
      const { nodeRequire, path, build, config } = getContext()
      importer = nodeRequire(path.join(build, 'plugin-runtime', 'dlc-importer.js')).createDlcImporter(build, config.version)
      return importer
    }
    function getUpdater() {
      if (updater) return updater
      const { nodeRequire, path, build } = getContext()
      updater = nodeRequire(path.join(build, 'plugin-runtime', 'kfc-updater.js')).createKfcUpdater(build)
      return updater
    }
    return {
      async inspect(bytes) {
        const preview = getImporter().inspect(new Uint8Array(bytes))
        const imported = window.KOOKPluginLoader?.getImportedPlugins?.() || {}
        if (preview.plugins.some(plugin => Object.prototype.hasOwnProperty.call(imported, plugin.id))) throw new Error('此安装包与已导入的脚本重名，请先移除同名脚本')
        return preview
      },
      async install(bytes, preview) {
        const checked = await this.inspect(bytes)
        if (checked.sha256 !== preview.sha256 || checked.stateToken !== preview.stateToken) throw new Error('插件状态已变化，请重新选择安装包')
        return getImporter().install(new Uint8Array(bytes), preview)
      },
      async inspectRemoval(pluginId) {
        return getImporter().inspectRemoval(pluginId)
      },
      async remove(pluginId, preview) {
        return getImporter().remove(pluginId, preview)
      },
      async checkUpdates() { return getUpdater().check() },
      async installUpdates(id) { return getUpdater().install(id) },
      async connectKfc(token) { return getUpdater().connect(token) },
      cancelUpdates() { updater?.cancel() }
    }
  })()
}
