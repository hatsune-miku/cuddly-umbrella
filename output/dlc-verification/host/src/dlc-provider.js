const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const HOST_ID = 'kook-plugin-tools'
const OWNERSHIP_FILE = '.kfc-dlc-files.json'
const LOCAL_DLC_ROOT = '.kook-local-dlcs'
const LEGACY_PLUGINS = ['bifrost', 'environment-switcher', 'kook-resource-orb', 'kaccount-switch', 'vmic', 'hot-module-version']
const LEGACY_COMPANIONS = {
  bifrost: ['bifrost-hot-module-bootstrap.js'],
  'hot-module-version': ['hot-module-version-bootstrap.js', 'user-plugins/hot-module-version-icon.png'],
  'environment-switcher': ['environment-switcher.js', 'restart-kook-environment.ps1', 'user-plugins/environment-switcher-icon.png'],
  vmic: ['user-plugins/vmic-icon.png'],
}
const LEGACY_FILES = [
  ...LEGACY_PLUGINS.map((id) => `user-plugins/${id}.js`),
  'user-plugins/environment-switcher-icon.png',
  'user-plugins/vmic-icon.png',
  'user-plugins/hot-module-version-icon.png',
  'bifrost-hot-module-bootstrap.js',
  'hot-module-version-bootstrap.js',
  'environment-switcher.js',
  'restart-kook-environment.ps1',
]
const RESERVED = new Set(['plugin-entry.js', 'plugin-api.js', 'plugin-loader.js', 'plugin-ui.js', 'plugin-dlc-bridge.js'])

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temporary, filename)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function safeRelative(value, allowHidden = false) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (part) =>
          (allowHidden ? /^[a-zA-Z0-9_.-]+$/ : /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/).test(part) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
}

function within(root, relative, allowHidden = false) {
  if (!safeRelative(relative, allowHidden)) throw new Error(`Invalid DLC path: ${relative}`)
  const absoluteRoot = path.resolve(root)
  const result = path.resolve(absoluteRoot, relative)
  if (!result.startsWith(absoluteRoot + path.sep)) throw new Error('DLC path escaped its root')
  let current = absoluteRoot
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
    throw new Error('DLC symlinks are not supported')
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error('DLC symlinks are not supported')
  }
  return result
}

function validateDlcManifest(manifest, readSource, expected) {
  if (
    !manifest || manifest.format !== 1 ||
    manifest.hostId !== HOST_ID ||
    manifest.apiVersion !== 1 ||
    manifest.author !== 'rin' ||
    !/^kook-plugin-tools-[a-z0-9-]+$/.test(manifest.id) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    (expected &&
      (manifest.id !== expected.id || manifest.version !== expected.version || manifest.author !== expected.author))
  ) {
    throw new Error('DLC package identity, author or API does not match this injector')
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.plugins) || !Array.isArray(manifest.earlyScripts)) {
    throw new Error('Invalid DLC contributions')
  }
  const files = manifest.files.map((file) => {
    if (!file || !safeRelative(file.source)) throw new Error('Invalid DLC source path')
    if (
      !safeRelative(file.target) ||
      RESERVED.has(file.target.toLowerCase()) ||
      !/^(?:user-plugins\/[a-zA-Z0-9._-]+\.(?:js|png|jpg|jpeg|webp|gif)|[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:js|ps1))$/.test(
        file.target
      )
    ) {
      throw new Error(`Unsupported DLC destination: ${file.target}`)
    }
    return { ...readSource(file.source), target: file.target }
  })
  const targets = new Set(files.map((file) => file.target))
  if (new Set(files.map(file => file.target.toLowerCase())).size !== files.length) throw new Error('Duplicate DLC file destination')
  const pluginIds = new Set()
  for (const plugin of manifest.plugins) {
    if (
      !plugin || typeof plugin.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(plugin.id) ||
      !safeRelative(plugin.file) ||
      !targets.has(`user-plugins/${plugin.file}`) ||
      !plugin.file.endsWith('.js') || pluginIds.has(plugin.id)
    ) {
      throw new Error('Invalid DLC plugin entry')
    }
    pluginIds.add(plugin.id)
    if (typeof plugin.icon === 'string' && plugin.icon.startsWith('/app/') && !targets.has(plugin.icon.slice(5))) {
      throw new Error(`DLC icon is missing from its payload: ${plugin.icon}`)
    }
  }
  for (const script of manifest.earlyScripts) {
    if (!targets.has(script) || !script.endsWith('.js') || script.includes('/'))
      throw new Error('Invalid early DLC script')
  }
  return files
}

function readDlcPackage(directory, expected) {
  const manifest = readJson(within(directory, 'dlc.json'))
  const files = validateDlcManifest(manifest, (relative) => {
    const source = within(directory, relative)
    if (!fs.statSync(source).isFile()) throw new Error(`Missing DLC payload: ${relative}`)
    return { source, bytes: fs.readFileSync(source) }
  }, expected)
  return { manifest, directory: path.resolve(directory), files }
}

function readLocalDlcPackages(build) {
  const registry = within(build, `${LOCAL_DLC_ROOT}/installed.json`, true)
  if (!fs.existsSync(registry)) return []
  const data = readJson(registry)
  if (data.format !== 1 || !Array.isArray(data.packages)) throw new Error('Invalid local DLC registry')
  const ids = new Set()
  return data.packages.map(entry => {
    if (!entry || ids.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.directory !== `${entry.id}/${entry.version}-${entry.sha256}`) throw new Error('Invalid local DLC entry')
    ids.add(entry.id)
    const directory = within(build, `${LOCAL_DLC_ROOT}/${entry.directory}`, true)
    return { ...readDlcPackage(directory, entry), localEntry: entry }
  })
}

function resolveDlcSelection(toolRoot, manifestPath) {
  if (!manifestPath) {
    const link = path.join(toolRoot, 'kfc-dlc-link.json')
    if (fs.existsSync(link)) manifestPath = readJson(link).manifestPath
  }
  let selection
  let packages
  let source = manifestPath ? 'kfc' : 'local'
  if (manifestPath) {
    const manifestFile = path.resolve(manifestPath)
    selection = readJson(manifestFile)
    if (
      selection.format !== 1 ||
      selection.hostId !== HOST_ID ||
      selection.apiVersion !== 1 ||
      !Array.isArray(selection.dlcs) ||
      !/^[a-f0-9]{64}$/i.test(selection.revision)
    )
      throw new Error('Invalid KFC DLC selection')
    const installedVersion = readJson(path.join(toolRoot, 'package.json')).version
    if (selection.hostVersion !== installedVersion)
      throw new Error('KFC DLC selection is for a different injector version')
    const root = path.dirname(manifestFile)
    if (path.resolve(selection.receiptPath) !== path.join(root, 'applied.json'))
      throw new Error('Invalid DLC receipt path')
    packages = selection.dlcs.map((entry) => {
      const relative = path.relative(root, path.resolve(entry.directory)).split(path.sep).join('/')
      if (!relative.startsWith(`${entry.id}/${entry.version}/`))
        throw new Error('DLC directory does not belong to this host')
      return readDlcPackage(within(root, relative), entry)
    })
  } else {
    const localRoot = path.join(toolRoot, 'dlcs')
    if (!fs.existsSync(localRoot)) {
      packages = []
      if (fs.existsSync(path.join(toolRoot, 'kfc.manifest.json'))) source = 'standalone'
    } else {
      packages = fs
        .readdirSync(localRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => readDlcPackage(within(localRoot, entry.name)))
    }
    selection = { format: 1, hostId: HOST_ID, apiVersion: 1, revision: '', receiptPath: null }
  }
  const ids = new Set()
  const targets = new Set()
  const pluginIds = new Set()
  const hash = crypto.createHash('sha256').update(selection.revision)
  if (source === 'standalone') hash.update('standalone')
  for (const item of packages.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))) {
    if (ids.has(item.manifest.id)) throw new Error('Duplicate DLC id')
    ids.add(item.manifest.id)
    hash.update(JSON.stringify(item.manifest))
    for (const file of item.files) {
      if (targets.has(file.target.toLowerCase())) throw new Error(`DLC file conflict: ${file.target}`)
      targets.add(file.target.toLowerCase())
      hash.update(file.target).update(file.bytes)
    }
    for (const plugin of item.manifest.plugins) {
      if (pluginIds.has(plugin.id)) throw new Error(`DLC plugin conflict: ${plugin.id}`)
      pluginIds.add(plugin.id)
    }
  }
  return { ...selection, source, packages, fingerprint: hash.digest('hex') }
}

function deployDlcSelection(build, selection) {
  // A manually downloaded host has no DLC selection to apply or uninstall.
  if (selection.source === 'standalone') {
    const manifestPath = path.join(build, 'user-plugins', 'manifest.json')
    if (!fs.existsSync(manifestPath)) writeJsonAtomic(manifestPath, { version: '1.0', plugins: [] })
    return selection
  }
  // An explicit KFC application takes precedence for overlapping IDs; unrelated
  // packages imported into this instance survive host and other DLC updates.
  const localPackages = readLocalDlcPackages(build).filter(item => !selection.packages.some(selected => selected.manifest.id === item.manifest.id))
  const packages = [...selection.packages, ...localPackages]
  const ownershipPath = path.join(build, OWNERSHIP_FILE)
  const previous = fs.existsSync(ownershipPath) ? readJson(ownershipPath) : null
  if (previous && (previous.format !== 1 || !Array.isArray(previous.files)))
    throw new Error('Invalid DLC ownership record')
  const pluginManifestPath = path.join(build, 'user-plugins', 'manifest.json')
  const current = fs.existsSync(pluginManifestPath) ? readJson(pluginManifestPath) : { plugins: [] }
  if (!Array.isArray(current.plugins)) throw new Error('Invalid installed plugin manifest')
  // Importing one DLC creates an ownership record while other bundled plugins
  // may still be legacy installations. Adopt only known files of selected IDs.
  const legacyFiles = new Set(previous ? [] : LEGACY_FILES)
  for (const item of packages) {
    for (const plugin of item.manifest.plugins) {
      if (!LEGACY_PLUGINS.includes(plugin.id) || item.manifest.id !== `${HOST_ID}-${plugin.id}`) continue
      const installed = current.plugins.find(old => old.id === plugin.id && old.file === `${plugin.id}.js` && (!old.dlcId || old.dlcId === item.manifest.id))
      if (!installed) continue
      for (const file of [`user-plugins/${plugin.id}.js`, ...(LEGACY_COMPANIONS[plugin.id] || [])]) {
        if (previous?.packages?.some(owner => owner.id !== item.manifest.id && owner.files?.includes(file))) continue
        legacyFiles.add(file)
      }
    }
  }
  const selectedIds = new Set(packages.flatMap(item => item.manifest.plugins.map(plugin => plugin.id)))
  const retainedLegacy = current.plugins.filter(plugin => !plugin.dlcId && LEGACY_PLUGINS.includes(plugin.id) && !selectedIds.has(plugin.id) && !previous?.files.includes(`user-plugins/${plugin.file}`))
  for (const plugin of retainedLegacy) {
    for (const file of [`user-plugins/${plugin.file}`, ...(LEGACY_COMPANIONS[plugin.id] || [])]) legacyFiles.delete(file)
  }
  const oldFiles = [...new Set([...(previous?.files || []), ...legacyFiles])]
  for (const filename of oldFiles) within(build, filename)
  const nextFiles = packages.flatMap((item) => item.files)
  if (new Set(nextFiles.map(file => file.target.toLowerCase())).size !== nextFiles.length) throw new Error('DLC file conflict with a local package')
  const owned = new Set(oldFiles)
  for (const file of nextFiles) {
    const target = within(build, file.target)
    if (fs.existsSync(target) && !owned.has(file.target))
      throw new Error(`DLC cannot overwrite an unmanaged file: ${file.target}`)
  }
  const localPlugins = current.plugins.filter(plugin => !plugin.dlcId && (!LEGACY_PLUGINS.includes(plugin.id) || retainedLegacy.includes(plugin)))
  const plugins = packages.flatMap((item) =>
    item.manifest.plugins.map((plugin) => ({
      ...plugin,
      author: 'rin',
      dlcId: item.manifest.id,
      dlcSource: item.localEntry ? 'local-package' : selection.source,
      enabled: current.plugins.find(old => old.id === plugin.id)?.enabled === true,
    }))
  )
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) throw new Error('DLC plugin conflict with a local package')
  if (localPlugins.some((plugin) => plugins.some((entry) => entry.id === plugin.id)))
    throw new Error('DLC conflicts with a local plugin id')
  const affected = new Set([
    ...oldFiles,
    ...nextFiles.map((file) => file.target),
    'user-plugins/manifest.json',
    OWNERSHIP_FILE,
    `${LOCAL_DLC_ROOT}/installed.json`,
  ])
  const backups = new Map()
  for (const filename of affected) {
    const absolute = filename === OWNERSHIP_FILE ? ownershipPath : within(build, filename, true)
    backups.set(absolute, fs.existsSync(absolute) ? fs.readFileSync(absolute) : null)
  }
  // Keep a one-time copy of the legacy bundled payload before the ownership migration.
  {
    for (const filename of legacyFiles) {
      if (previous?.files.includes(filename)) continue
      const bytes = backups.get(within(build, filename))
      if (!bytes) continue
      const backup = path.join(build, '.kfc-dlc-legacy-backup', filename)
      if (!fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        fs.writeFileSync(backup, bytes, { flag: 'wx' })
      }
    }
  }
  try {
    for (const file of nextFiles) {
      const destination = within(build, file.target)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, file.bytes)
    }
    const currentTargets = new Set(nextFiles.map((file) => file.target))
    for (const filename of oldFiles) {
      if (!currentTargets.has(filename)) fs.rmSync(within(build, filename), { force: true })
    }
    writeJsonAtomic(pluginManifestPath, { ...current, version: current.version || '1.0', plugins: [...localPlugins, ...plugins] })
    writeJsonAtomic(ownershipPath, {
      format: 1,
      hostId: HOST_ID,
      revision: selection.revision || selection.fingerprint,
      files: [...currentTargets],
      packages: packages.map(item => ({ id: item.manifest.id, version: item.manifest.version, files: item.files.map(file => file.target), plugins: item.manifest.plugins.map(plugin => plugin.id), earlyScripts: item.manifest.earlyScripts })),
    })
    if (fs.existsSync(within(build, `${LOCAL_DLC_ROOT}/installed.json`, true))) writeJsonAtomic(within(build, `${LOCAL_DLC_ROOT}/installed.json`, true), { format: 1, packages: localPackages.map(item => item.localEntry) })
  } catch (error) {
    for (const [filename, bytes] of backups) {
      if (bytes === null) fs.rmSync(filename, { force: true })
      else {
        fs.mkdirSync(path.dirname(filename), { recursive: true })
        fs.writeFileSync(filename, bytes)
      }
    }
    throw error
  }
  const retainedEarlyScripts = retainedLegacy.flatMap(plugin => (LEGACY_COMPANIONS[plugin.id] || []).filter(file => !file.includes('/') && file.endsWith('.js') && fs.existsSync(within(build, file))))
  return { ...selection, packages, retainedEarlyScripts }
}

function recordDlcApplication(selection, appDir) {
  if (!selection.receiptPath) return
  const receipts = fs.existsSync(selection.receiptPath)
    ? readJson(selection.receiptPath)
    : { format: 1, hostId: HOST_ID, instances: [] }
  if (receipts.format !== 1 || receipts.hostId !== HOST_ID || !Array.isArray(receipts.instances))
    throw new Error('Invalid existing DLC receipts')
  const absolute = path.resolve(appDir)
  const instances = receipts.instances.filter(
    (instance) => String(instance.appDir).toLowerCase() !== absolute.toLowerCase()
  )
  instances.push({
    appDir: absolute,
    revision: selection.revision,
    appliedAt: new Date().toISOString(),
    dlcs: selection.packages.map((item) => ({ id: item.manifest.id, version: item.manifest.version })),
  })
  writeJsonAtomic(selection.receiptPath, { format: 1, hostId: HOST_ID, instances })
}

module.exports = {
  HOST_ID,
  LEGACY_PLUGINS,
  LEGACY_COMPANIONS,
  LEGACY_FILES,
  resolveDlcSelection,
  deployDlcSelection,
  recordDlcApplication,
  readDlcPackage,
  validateDlcManifest,
  readLocalDlcPackages,
  within,
  writeJsonAtomic,
  LOCAL_DLC_ROOT,
  OWNERSHIP_FILE,
  safeRelative,
}
