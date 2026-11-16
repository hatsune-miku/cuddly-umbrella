const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const asar = require('asar')
const { resolveDlcSelection, recordDlcApplication, readLocalDlcPackages, within, LEGACY_FILES } = require('./dlc-provider')

const INJECTION_MARKER = '.kook-plugin-tools.json'
const FINGERPRINT_PATHS = [
  'plugins',
  'user-plugins',
  'src/dlc-provider.js',
  'src/kook-package.js',
  'src/dlc-archive.js',
  'src/dlc-importer.js',
  'src/versions.js',
  'src/kfc-auth.js',
  'src/kfc-client.js',
  'src/kfc-updater.js',
  'package.json',
  'plugin-icon.png'
]
const BROWSER_PLUGIN_ASSETS = new Set(['plugin-api.js', 'plugin-loader.js', 'plugin-ui.js', 'plugin-dlc-bridge.js'])

function copyDirectoryContents(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) {
    return
  }

  fs.mkdirSync(destinationDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const destination = path.join(destinationDir, entry.name)
    fs.cpSync(source, destination, { recursive: entry.isDirectory(), force: true })
  }
}

function moveIntoBackup(source, destination) {
  if (!fs.existsSync(source)) {
    return
  }
  if (fs.existsSync(destination)) {
    throw new Error(`备份目标已存在: ${destination}`)
  }
  fs.renameSync(source, destination)
}

function extractKookPackage(resourcesDir, options = {}) {
  const asarModule = options.asarModule || asar
  const appDir = path.join(resourcesDir, 'app')
  const asarPath = path.join(resourcesDir, 'app.asar')
  const unpackedPath = path.join(resourcesDir, 'app.asar.unpacked')

  if (fs.existsSync(appDir)) {
    return { extracted: false, appDir, reason: 'already-extracted' }
  }
  if (!fs.existsSync(asarPath)) {
    throw new Error(`未找到 app.asar: ${asarPath}`)
  }

  const stagingDir = path.join(resourcesDir, `.kook-plugin-extract-${process.pid}-${Date.now()}`)
  const backupDir = path.join(resourcesDir, 'app-backup')
  const asarBackupPath = path.join(backupDir, 'app.asar')
  const unpackedBackupPath = path.join(backupDir, 'app.asar.unpacked')
  if (fs.existsSync(asarBackupPath) || (fs.existsSync(unpackedPath) && fs.existsSync(unpackedBackupPath))) {
    throw new Error(`检测到冲突的 KVM 备份目录: ${backupDir}`)
  }

  try {
    asarModule.extractAll(asarPath, stagingDir)
    copyDirectoryContents(unpackedPath, stagingDir)
    fs.mkdirSync(backupDir, { recursive: true })
    moveIntoBackup(asarPath, asarBackupPath)
    moveIntoBackup(unpackedPath, unpackedBackupPath)
    fs.renameSync(stagingDir, appDir)
    return { extracted: true, appDir, backupDir }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    if (!fs.existsSync(asarPath) && fs.existsSync(asarBackupPath)) {
      fs.renameSync(asarBackupPath, asarPath)
    }
    if (!fs.existsSync(unpackedPath) && fs.existsSync(unpackedBackupPath)) {
      fs.renameSync(unpackedBackupPath, unpackedPath)
    }
    throw error
  }
}

function listFingerprintFiles(targetPath, rootPath, files) {
  const stat = fs.statSync(targetPath)
  if (stat.isFile()) {
    files.push(path.relative(rootPath, targetPath))
    return
  }

  for (const entry of fs.readdirSync(targetPath).sort()) {
    listFingerprintFiles(path.join(targetPath, entry), rootPath, files)
  }
}

function createInjectionFingerprint(toolRoot, dlcFingerprint = '') {
  const files = []
  for (const relativePath of FINGERPRINT_PATHS) {
    const targetPath = path.join(toolRoot, relativePath)
    if (fs.existsSync(targetPath)) {
      listFingerprintFiles(targetPath, toolRoot, files)
    }
  }

  const hash = crypto.createHash('sha256')
  hash.update(dlcFingerprint)
  for (const relativePath of files.sort()) {
    hash.update(relativePath.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(toolRoot, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function getMarkerPath(appDir) {
  return path.join(appDir, 'webapp', 'build', INJECTION_MARKER)
}

function readInjectionMarker(appDir) {
  try {
    return JSON.parse(fs.readFileSync(getMarkerPath(appDir), 'utf8'))
  } catch {
    return null
  }
}

function writeInjectionMarker(appDir, fingerprint, toolRoot, installedFiles) {
  const markerPath = getMarkerPath(appDir)
  let toolVersion
  try { toolVersion = JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')).version } catch {}
  fs.writeFileSync(markerPath, JSON.stringify({ format: 1, fingerprint, toolVersion, installedFiles, injectedAt: new Date().toISOString() }, null, 2), 'utf8')
}

function snapshotPath(build, name) {
  // Existing personal assets may use spaces or Unicode names. Apply containment
  // and link checks without imposing the DLC package filename grammar on them.
  const root = path.resolve(build), file = path.resolve(root, name)
  if (!file.startsWith(root + path.sep)) throw new Error('Snapshot path escaped build directory')
  let current = root
  for (const part of ['', ...path.relative(root, file).split(path.sep)]) {
    if (part) current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Snapshot symlinks are not supported')
  }
  return file
}

function snapshotFiles(build, names) {
  const result = new Map()
  function visit(name) {
    const file = snapshotPath(build, name)
    if (!fs.existsSync(file)) { result.set(name, null); return }
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file)) visit(`${name}/${child}`)
    } else result.set(name, fs.readFileSync(file))
  }
  for (const name of names) visit(name)
  return result
}

function installedFilesMatch(build, files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false
  try {
    return Object.entries(files).every(([name, digest]) => {
      const file = snapshotPath(build, name)
      return fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === digest
    })
  } catch { return false }
}

function loadRepackPlugins(toolRoot, options = {}) {
  const pluginDir = path.join(toolRoot, 'plugins')
  if (!fs.existsSync(pluginDir)) {
    return []
  }

  const verbose = options.verbose || (() => {})
  const plugins = []
  const files = fs.readdirSync(pluginDir)
    .filter(file => file.endsWith('.js') && !file.startsWith('.') && !BROWSER_PLUGIN_ASSETS.has(file))
    .sort()

  for (const file of files) {
    const pluginPath = path.join(pluginDir, file)
    try {
      delete require.cache[require.resolve(pluginPath)]
      const plugin = require(pluginPath)
      if (plugin?.kookRepackPlugin) {
        plugins.push(plugin)
      }
    } catch (error) {
      if (file === 'plugin-entry.js') {
        throw new Error(`核心注入插件加载失败: ${error?.message || error}`)
      }
      verbose(`跳过浏览器端插件资源 ${file}: ${error?.message || error}`)
    }
  }

  return plugins
}

async function injectPlugins(appDir, options = {}) {
  const toolRoot = options.toolRoot || path.join(__dirname, '..')
  const verbose = options.verbose || (() => {})
  const dlcSelection = options.dlcSelection || resolveDlcSelection(toolRoot, options.dlcManifestPath)
  const localPackages = readLocalDlcPackages(path.join(appDir, 'webapp', 'build')).filter(item => !dlcSelection.packages.some(selected => selected.manifest.id === item.manifest.id))
  const localHash = crypto.createHash('sha256').update(dlcSelection.fingerprint)
  for (const item of localPackages) {
    localHash.update(JSON.stringify(item.manifest))
    for (const file of item.files) localHash.update(file.target).update(file.bytes)
  }
  const fingerprint = createInjectionFingerprint(toolRoot, localHash.digest('hex'))
  const marker = readInjectionMarker(appDir)
  const build = path.join(appDir, 'webapp', 'build')

  if (marker?.format === 1 && marker.fingerprint === fingerprint && installedFilesMatch(build, marker.installedFiles)) {
    recordDlcApplication(dlcSelection, options.instanceDir || appDir)
    return { injected: false, reason: 'already-current', fingerprint }
  }

  const plugins = options.plugins || loadRepackPlugins(toolRoot, { verbose })
  const names = new Set(['plugins', 'user-plugins', 'plugin-runtime', '.kook-local-dlcs/installed.json', '.kfc-dlc-files.json', INJECTION_MARKER, 'index.htm', 'index.html', 'plugin-icon.png', 'vmic-audio-bridge.js', ...BROWSER_PLUGIN_ASSETS, ...LEGACY_FILES])
  for (const item of [...dlcSelection.packages, ...localPackages]) for (const file of item.files) names.add(file.target)
  const ownershipPath = within(build, '.kfc-dlc-files.json', true)
  if (fs.existsSync(ownershipPath)) for (const name of JSON.parse(fs.readFileSync(ownershipPath, 'utf8')).files) names.add(name)
  const before = snapshotFiles(build, names)
  try {
    for (const plugin of plugins) {
      if (typeof plugin.onAfterUnpack !== 'function') continue
      verbose(`执行插件: ${plugin.name}`)
      await plugin.onAfterUnpack(appDir, {
        toolRoot,
        dlcSelection,
        userPluginDir: path.join(toolRoot, 'user-plugins'),
        verbose
      })
    }
    if (!fs.existsSync(path.dirname(getMarkerPath(appDir)))) {
      throw new Error('KOOK webapp/build 不存在，无法确认插件注入结果')
    }
    // Record deployed bytes, not just the source fingerprint. Reapplication can
    // repair a missing icon/runtime even if this source version has not changed.
    const integrityNames = new Set(['plugins', 'plugin-runtime', 'plugin-icon.png', ...BROWSER_PLUGIN_ASSETS, 'index.htm', 'index.html', 'user-plugins/manifest.json'])
    const userPluginSource = path.join(toolRoot, 'user-plugins')
    if (fs.existsSync(userPluginSource)) for (const name of fs.readdirSync(userPluginSource)) if (/\.(js|png|jpg|jpeg|webp|gif)$/.test(name)) integrityNames.add(`user-plugins/${name}`)
    for (const item of [...dlcSelection.packages, ...localPackages]) for (const file of item.files) integrityNames.add(file.target)
    const installedFiles = Object.fromEntries([...snapshotFiles(build, integrityNames)].filter(([, bytes]) => bytes !== null).map(([name, bytes]) => [name, crypto.createHash('sha256').update(bytes).digest('hex')]))
    writeInjectionMarker(appDir, fingerprint, toolRoot, installedFiles)
    recordDlcApplication(dlcSelection, options.instanceDir || appDir)
    return { injected: true, fingerprint, pluginCount: plugins.length }
  } catch (error) {
    const failures = []
    let after = new Map()
    try { after = snapshotFiles(build, names) } catch { failures.push('无法完整检查修改后的文件') }
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      try {
        const file = snapshotPath(build, name), bytes = before.get(name)
        if (bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
        else if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file)
      } catch { failures.push(name) }
    }
    if (failures.length) throw new Error(`注入失败：${error.message}；无法恢复：${failures.join('、')}`, { cause: error })
    const restored = new Error(`注入失败，已恢复原有插件文件：${error.message}`, { cause: error })
    restored.rollbackComplete = true
    throw restored
  }
}

async function prepareInstallation(installation, options = {}) {
  const extraction = extractKookPackage(installation.resourcesDir, options)
  const injection = await injectPlugins(extraction.appDir, { ...options, instanceDir: installation.appDir })
  return { extraction, injection }
}

module.exports = {
  INJECTION_MARKER,
  copyDirectoryContents,
  createInjectionFingerprint,
  extractKookPackage,
  injectPlugins,
  prepareInstallation,
  readInjectionMarker
}
