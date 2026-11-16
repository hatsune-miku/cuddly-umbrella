const fs = require('fs')
const path = require('path')
const { resolveDlcSelection, deployDlcSelection } = require('../src/dlc-provider')
const { RUNTIME_FILES } = require('../src/kfc-updater')

module.exports = {
  name: 'plugin-entry',
  kookRepackPlugin: true,
  description: 'Inject KOOK plugin runtime assets and local user plugins',

  async onAfterUnpack(unpackedPath, options = {}) {
    const verbose = typeof options.verbose === 'function' ? options.verbose : () => {}
    verbose('Injecting KOOK plugin runtime...')

    const webappBuildDir = path.join(unpackedPath, 'webapp', 'build')
    if (!fs.existsSync(webappBuildDir)) {
      throw new Error('KOOK webapp/build 不存在，无法注入')
    }
    if (!['index.htm', 'index.html'].some(name => fs.existsSync(path.join(webappBuildDir, name)))) throw new Error('KOOK 页面入口不存在，请修复客户端安装后再注入')

    const toolRoot = options.toolRoot || path.join(__dirname, '..')
    const selection = options.dlcSelection || resolveDlcSelection(toolRoot)
    this.copyPluginIcon(unpackedPath, verbose)
    this.ensureCorePluginManifest(unpackedPath, verbose)
    this.copyUserPluginsToKook(unpackedPath, verbose, options.userPluginDir)
    const appliedSelection = deployDlcSelection(webappBuildDir, selection)
    this.injectRuntimeScripts(unpackedPath, verbose)
    this.injectUIEntries(unpackedPath, verbose, selection.source === 'standalone'
      ? null
      : [...new Set([...appliedSelection.packages.flatMap((item) => item.manifest.earlyScripts), ...(appliedSelection.retainedEarlyScripts || [])])].sort())

    console.log('[Plugin Entry] Injection complete')
  },

  copyUserPluginsToKook(unpackedPath, verbose = () => {}, sourceDirectory) {
    const webappBuildDir = path.join(unpackedPath, 'webapp', 'build')
    const userPluginDir = path.join(webappBuildDir, 'user-plugins')
    const localUserPluginsDir = sourceDirectory || path.join(__dirname, '..', 'user-plugins')

    if (!fs.existsSync(localUserPluginsDir)) {
      verbose('local user-plugins folder not found, skipping')
      return
    }

    const files = fs.readdirSync(localUserPluginsDir)
      .filter(file => file.endsWith('.js') && !file.startsWith('.'))

    if (files.length === 0) {
      verbose('no local user plugins found')
      return
    }

    fs.mkdirSync(userPluginDir, { recursive: true })
    const oldNativeHost = path.join(userPluginDir, 'native', 'vmic_native_stdio_host.exe')
    if (fs.existsSync(oldNativeHost)) fs.rmSync(oldNativeHost)
    this.copyUserPluginAssets(localUserPluginsDir, userPluginDir, verbose)

    const manifestPath = path.join(userPluginDir, 'manifest.json')
    const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { plugins: [] }
    const plugins = (existing.plugins || []).filter((plugin) => !files.includes(plugin.file))
    for (const file of files) {
      const sourcePath = path.join(localUserPluginsDir, file)
      const destPath = path.join(userPluginDir, file)
      fs.copyFileSync(sourcePath, destPath)
      console.log(`  copied user-plugins/${file}`)

      const content = fs.readFileSync(sourcePath, 'utf8')
      const nameMatch = content.match(/name:\s*['"](.*?)['"]/)
      const descMatch = content.match(/description:\s*['"](.*?)['"]/)
      const versionMatch = content.match(/version:\s*['"](.*?)['"]/)
      const iconMatch = content.match(/icon:\s*['"](.*?)['"]/)

      plugins.push({
        id: file.replace(/\.js$/i, ''),
        name: nameMatch ? nameMatch[1] : file.replace(/\.js$/i, ''),
        description: descMatch ? descMatch[1] : '',
        version: versionMatch ? versionMatch[1] : '1.0.0',
        icon: iconMatch ? iconMatch[1] : null,
        enabled: existing.plugins?.find(plugin => plugin.id === file.replace(/\.js$/i, ''))?.enabled === true,
        file
      })
    }

    fs.writeFileSync(manifestPath, JSON.stringify({ ...existing, version: existing.version || '1.0', plugins }, null, 2), 'utf8')
    verbose(`user plugin manifest written to ${manifestPath}`)
  },

  copyUserPluginAssets(sourceDir, destDir, verbose = () => {}) {
    const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
    const assets = fs.readdirSync(sourceDir)
      .filter(file => assetExtensions.has(path.extname(file).toLowerCase()))

    for (const asset of assets) {
      fs.copyFileSync(path.join(sourceDir, asset), path.join(destDir, asset))
      verbose(`copied user-plugins/${asset}`)
    }
  },

  ensureCorePluginManifest(unpackedPath, verbose = () => {}) {
    const webappBuildDir = path.join(unpackedPath, 'webapp', 'build')
    const pluginDir = path.join(webappBuildDir, 'plugins')
    const manifestPath = path.join(pluginDir, 'manifest.json')

    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(manifestPath, this.generateManifest([]), 'utf8')
    verbose(`core plugin manifest written to ${manifestPath}`)
  },

  injectRuntimeScripts(unpackedPath, verbose = () => {}) {
    const webappBuildDir = path.join(unpackedPath, 'webapp', 'build')
    const filesToCopy = ['plugin-loader.js', 'plugin-ui.js', 'plugin-api.js', 'plugin-dlc-bridge.js']
    const oldBridge = path.join(webappBuildDir, 'vmic-audio-bridge.js')
    if (fs.existsSync(oldBridge)) fs.rmSync(oldBridge)

    for (const filename of filesToCopy) {
      const sourcePath = path.join(__dirname, filename)
      const destPath = path.join(webappBuildDir, filename)
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath)
        verbose(`copied ${filename}`)
      }
    }
    const runtime = path.join(webappBuildDir, 'plugin-runtime')
    fs.mkdirSync(path.join(runtime, 'node_modules', 'fflate'), { recursive: true })
    for (const filename of RUNTIME_FILES) {
      fs.copyFileSync(path.join(__dirname, '..', 'src', filename), path.join(runtime, filename))
    }
    const fflateRoot = path.dirname(path.dirname(require.resolve('fflate')))
    fs.copyFileSync(path.join(fflateRoot, 'umd', 'index.js'), path.join(runtime, 'node_modules', 'fflate', 'index.js'))
    fs.copyFileSync(path.join(fflateRoot, 'LICENSE'), path.join(runtime, 'node_modules', 'fflate', 'LICENSE'))
    fs.writeFileSync(path.join(runtime, 'host.json'), JSON.stringify({ version: require('../package.json').version }), 'utf8')
  },

  copyPluginIcon(unpackedPath, verbose = () => {}) {
    const iconSource = path.join(__dirname, '..', 'plugin-icon.png')
    if (!fs.existsSync(iconSource)) {
      verbose('plugin icon not found')
      return
    }

    const webappBuildDir = path.join(unpackedPath, 'webapp', 'build')
    if (!fs.existsSync(webappBuildDir)) {
      verbose('webapp/build not found')
      return
    }

    fs.copyFileSync(iconSource, path.join(webappBuildDir, 'plugin-icon.png'))
    verbose('copied plugin icon')
  },

  injectUIEntries(unpackedPath, verbose = () => {}, earlyScripts = []) {
    const candidates = [
      path.join(unpackedPath, 'webapp', 'build', 'index.htm'),
      path.join(unpackedPath, 'webapp', 'build', 'index.html')
    ]

    const htmlFile = candidates.find(file => fs.existsSync(file))
    if (!htmlFile) {
      verbose('index.htm/html not found')
      return
    }

    this.injectToHtml(htmlFile, verbose, earlyScripts)
  },

  injectToHtml(htmlFile, verbose = () => {}, earlyScripts = []) {
    let content = fs.readFileSync(htmlFile, 'utf8')

    const removeOld = [
      ...(earlyScripts === null ? [] : [
        /<script[^>]*data-kfc-dlc-bootstrap[^>]*><\/script>\s*/g,
        /<script[^>]*data-bifrost-pc-bootstrap[^>]*><\/script>\s*/g,
        /<script[^>]*data-hot-module-version-bootstrap[^>]*><\/script>\s*/g,
      ]),
      /<script[^>]*data-vmic-audio-bridge[^>]*><\/script>\s*/g,
      /<script>\s*\/\/ KOOK Plugin Safe Loader - Injected by kook-plugin-tools[\s\S]*?<\/script>\s*/g,
      /<script>\s*\/\/ KOOK Plugin UI - Injected by kook-plugin-tools[\s\S]*?<\/script>\s*/g,
      /<script>\s*\/\/ KOOK Plugin Loader - Injected by kook-plugin-tools[\s\S]*?<\/script>\s*/g
    ]

    for (const pattern of removeOld) {
      content = content.replace(pattern, '')
    }

    const dlcBootstrap = (earlyScripts || []).map((script) => `<script src="/app/${script}" data-kfc-dlc-bootstrap></script>`).join('\n')
    if (/<head(?:\s[^>]*)?>/i.test(content)) {
      content = content.replace(/(<head(?:\s[^>]*)?>)/i, `$1\n${dlcBootstrap}`)
    } else {
      content = `${dlcBootstrap}\n${content}`
    }

    const pluginScript = [
      '<script>',
      '// KOOK Plugin Safe Loader - Injected by kook-plugin-tools',
      '(function() {',
      "  'use strict';",
      '',
      '  function loadPluginRuntime() {',
      '    try {',
      '      if (window.KOOKPluginUI && window.KOOKPluginUI.toggle) {',
      '        return;',
      '      }',
      '',
      '      var scripts = [',
      "        '/app/plugin-api.js',",
      "        '/app/plugin-dlc-bridge.js',",
      "        '/app/plugin-loader.js',",
      "        '/app/plugin-ui.js'",
      '      ];',
      '',
      '      function loadNext(index) {',
      '        if (index >= scripts.length) {',
      '          return;',
      '        }',
      '',
      '        var script = document.createElement(\'script\');',
      '        script.src = scripts[index];',
      '        script.async = true;',
      '        script.onload = function() { loadNext(index + 1); };',
      '        script.onerror = function() { loadNext(index + 1); };',
      '        document.head.appendChild(script);',
      '      }',
      '',
      '      loadNext(0);',
      '    } catch (e) {',
      "      console.error('[KOOK Plugin] Load error:', e && e.message ? e.message : e);",
      '    }',
      '  }',
      '',
      "  // The entry is appended to body; KOOK's deferred bundles need not finish first.",
      "  if (!document.body && document.readyState === 'loading') {",
      "    document.addEventListener('DOMContentLoaded', loadPluginRuntime, { once: true });",
      '  } else {',
      '    loadPluginRuntime();',
      '  }',
      '})();',
      '</script>'
    ].join('\n')

    if (content.includes('</body>')) {
      content = content.replace('</body>', `${pluginScript}\n</body>`)
    } else {
      content += `\n${pluginScript}`
    }

    fs.writeFileSync(htmlFile, content, 'utf8')
    verbose('injected safe plugin loader script')
  },

  generateManifest(plugins) {
    return JSON.stringify({
      version: '1.0',
      plugins: plugins.map(plugin => ({
        author: plugin.author,
        dlcId: plugin.dlcId,
        dlcSource: plugin.dlcSource,
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        icon: plugin.icon,
        enabled: plugin.enabled,
        file: plugin.file
      }))
    }, null, 2)
  }
}
