const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { readArchive } = require('./dlc-archive')
const { within: withinPath, writeJsonAtomic, readLocalDlcPackages, LOCAL_DLC_ROOT, OWNERSHIP_FILE, LEGACY_PLUGINS, LEGACY_COMPANIONS } = require('./dlc-provider')
const within = (root, relative) => withinPath(root, relative, true)

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const optionalJson = (file, fallback) => fs.existsSync(file) ? readJson(file) : fallback

function acquireLock(filename) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(filename, 'wx')
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }))
      return descriptor
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = readJson(filename) } catch { throw new Error('安装锁无法读取，请重新应用注入器以修复安装组件') }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('安装锁无效，请重新应用注入器以修复安装组件')
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error.code === 'ESRCH') { fs.unlinkSync(filename); continue }
      }
      throw new Error('已有安装任务正在进行，请稍后重试')
    }
  }
  throw new Error('安装锁已变化，请重新选择安装包')
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}

function rewriteEarlyScripts(html, removed, added) {
  const scripts = new Set()
  const stripped = html.replace(/<script\b[^>]*\bdata-(?:kfc-dlc-bootstrap|bifrost-pc-bootstrap|hot-module-version-bootstrap)\b[^>]*><\/script>\s*/gi, tag => {
    const name = tag.match(/\bsrc=["']\/app\/([a-zA-Z0-9._-]+\.js)["']/)?.[1]
    if (name && !removed.includes(name)) scripts.add(name)
    return ''
  })
  for (const name of added) scripts.add(name)
  const tags = [...scripts].sort().map(name => `<script src="/app/${name}" data-kfc-dlc-bootstrap></script>`).join('\n')
  if (/<head(?:\s[^>]*)?>/i.test(stripped)) return stripped.replace(/(<head(?:\s[^>]*)?>)/i, `$1\n${tags}\n`)
  throw new Error('当前 KOOK 页面结构无法识别，请先使用注入器更新此实例')
}

function createDlcImporter(build, hostVersion) {
  build = path.resolve(build)
  function plan(input) {
    const archive = readArchive(input)
    const { manifest } = archive
    if (manifest.minHostVersion && (!/^\d+\.\d+\.\d+$/.test(manifest.minHostVersion) || compareVersions(hostVersion, manifest.minHostVersion) < 0)) throw new Error(`此插件需要注入器 ${manifest.minHostVersion} 或更高版本`)
    if (manifest.maxHostVersionExclusive && (!/^\d+\.\d+\.\d+$/.test(manifest.maxHostVersionExclusive) || compareVersions(hostVersion, manifest.maxHostVersionExclusive) >= 0)) throw new Error('此安装包与当前注入器版本不兼容')
    const pluginFile = within(build, 'user-plugins/manifest.json')
    const current = optionalJson(pluginFile, { plugins: [] })
    if (!Array.isArray(current.plugins)) throw new Error('当前插件列表无法读取，请先使用注入器修复')
    const ownership = optionalJson(within(build, OWNERSHIP_FILE), { format: 1, files: [], packages: [] })
    if (ownership.format !== 1 || !Array.isArray(ownership.files) || (ownership.packages && (!Array.isArray(ownership.packages) || ownership.packages.some(item => !item || !Array.isArray(item.files) || !Array.isArray(item.earlyScripts))))) throw new Error('当前插件安装记录无法读取')
    const locals = readLocalDlcPackages(build)
    const priorLocal = locals.find(item => item.manifest.id === manifest.id)
    if (priorLocal?.manifest.version === manifest.version && priorLocal.localEntry.sha256 !== archive.sha256) throw new Error('相同版本的安装包内容不同，请使用新的版本号')
    const previous = ownership.packages?.find(item => item.id === manifest.id)
    const legacyId = LEGACY_PLUGINS.find(id => manifest.id === `kook-plugin-tools-${id}`)
    const oldPlugins = current.plugins.filter(plugin => plugin.dlcId === manifest.id || (!plugin.dlcId && plugin.id === legacyId))
    const oldFiles = new Set([
      ...(priorLocal?.files.map(file => file.target) || []),
      ...(previous?.files || []),
      ...oldPlugins.map(plugin => `user-plugins/${plugin.file}`),
      ...(oldPlugins.length ? LEGACY_COMPANIONS[legacyId] || [] : []),
    ])
    const oldScripts = priorLocal?.manifest.earlyScripts || previous?.earlyScripts || (oldPlugins.length ? (LEGACY_COMPANIONS[legacyId] || []).filter(file => !file.includes('/') && file.endsWith('.js')) : [])
    for (const name of oldFiles) within(build, name)
    const pluginIds = new Set(manifest.plugins.map(plugin => plugin.id))
    const otherPlugins = current.plugins.filter(plugin => !oldPlugins.includes(plugin))
    if (otherPlugins.some(plugin => pluginIds.has(plugin.id))) throw new Error('安装包与已有插件重名，请先移除冲突插件')
    for (const file of archive.contributions) {
      const target = within(build, file.target)
      if (fs.existsSync(target) && !oldFiles.has(file.target)) throw new Error(`安装包与现有文件冲突：${file.target}`)
      if (ownership.packages?.some(item => item.id !== manifest.id && item.files.some(name => name.toLowerCase() === file.target.toLowerCase()))) throw new Error(`安装包与其他插件的文件冲突：${file.target}`)
    }
    const htmlFile = ['index.htm', 'index.html'].find(name => fs.existsSync(within(build, name)))
    if (!htmlFile) throw new Error('未找到当前 KOOK 页面，请先通过注入器完成安装')
    const html = rewriteEarlyScripts(fs.readFileSync(within(build, htmlFile), 'utf8'), oldScripts, manifest.earlyScripts)
    const affected = new Set([...oldFiles, ...archive.contributions.map(file => file.target), 'user-plugins/manifest.json', OWNERSHIP_FILE, `${LOCAL_DLC_ROOT}/installed.json`, '.kook-plugin-tools.json', htmlFile])
    const backups = new Map()
    const hash = crypto.createHash('sha256')
    for (const name of [...affected].sort()) {
      const target = within(build, name)
      const bytes = fs.existsSync(target) ? fs.readFileSync(target) : null
      backups.set(target, bytes)
      hash.update(name).update('\0').update(bytes === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytes]))
    }
    return { ...archive, current, ownership, locals, previous, oldFiles, oldPlugins, htmlFile, html, backups, stateToken: hash.digest('hex') }
  }

  function inspect(input) {
    const data = plan(input)
    return { id: data.manifest.id, name: data.manifest.name || data.manifest.plugins[0].name || data.manifest.id, version: data.manifest.version, author: data.manifest.author, description: data.manifest.description || '', plugins: data.manifest.plugins.map(plugin => ({ id: plugin.id, name: plugin.name || plugin.id })), currentVersion: data.locals.find(item => item.manifest.id === data.manifest.id)?.manifest.version || data.previous?.version || data.oldPlugins[0]?.version || null, sha256: data.sha256, stateToken: data.stateToken, size: data.size }
  }

  function removalPlan(pluginId) {
    if (typeof pluginId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(pluginId)) throw new Error('插件 ID 无效')
    const current = readJson(within(build, 'user-plugins/manifest.json'))
    if (!Array.isArray(current.plugins)) throw new Error('当前插件列表无法读取')
    const plugin = current.plugins.find(item => item.id === pluginId)
    if (!plugin) throw new Error('插件已不存在，请刷新列表')
    const ownership = optionalJson(within(build, OWNERSHIP_FILE), { format: 1, files: [], packages: [] })
    if (ownership.format !== 1 || !Array.isArray(ownership.files) || (ownership.packages && (!Array.isArray(ownership.packages) || ownership.packages.some(item => !item || !Array.isArray(item.files) || !Array.isArray(item.earlyScripts))))) throw new Error('当前插件安装记录无法读取')
    const registry = optionalJson(within(build, `${LOCAL_DLC_ROOT}/installed.json`), { format: 1, packages: [] })
    if (registry.format !== 1 || !Array.isArray(registry.packages)) throw new Error('本地插件安装记录无法读取')
    const packageId = plugin.dlcId || (LEGACY_PLUGINS.includes(pluginId) ? `kook-plugin-tools-${pluginId}` : null)
    const related = current.plugins.filter(item => item === plugin || (plugin.dlcId && item.dlcId === plugin.dlcId))
    const remaining = current.plugins.filter(item => !related.includes(item))
    const record = ownership.packages?.find(item => item.id === packageId)
    const files = new Set([...(record?.files || []), ...related.map(item => `user-plugins/${item.file}`), ...(LEGACY_COMPANIONS[pluginId] || [])])
    const assetPath = item => typeof item.icon === 'string' && /^\/app\/user-plugins\/[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp|gif)$/.test(item.icon) ? item.icon.slice(5) : null
    for (const item of related) if (assetPath(item)) files.add(assetPath(item))
    const protectedFiles = new Set([
      ...remaining.flatMap(item => [`user-plugins/${item.file}`, assetPath(item)]),
      ...(ownership.packages || []).filter(item => item.id !== packageId).flatMap(item => item.files),
    ].filter(Boolean).map(name => name.toLowerCase()))
    for (const name of [...files]) {
      if (protectedFiles.has(name.toLowerCase())) { files.delete(name); continue }
      if (!/^(?:user-plugins\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:js|png|jpg|jpeg|webp|gif)|[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:js|ps1))$/.test(name) || /^plugin-(?:entry|api|loader|ui|dlc-bridge)\.js$/i.test(name)) throw new Error('插件安装记录包含不可删除的文件')
      within(build, name)
    }
    const scripts = (record?.earlyScripts || (LEGACY_COMPANIONS[pluginId] || []).filter(name => !name.includes('/') && name.endsWith('.js'))).filter(name => files.has(name))
    const htmlFile = ['index.htm', 'index.html'].find(name => fs.existsSync(within(build, name)))
    if (!htmlFile) throw new Error('未找到当前 KOOK 页面，请先修复注入')
    const html = rewriteEarlyScripts(fs.readFileSync(within(build, htmlFile), 'utf8'), scripts, [])
    const affected = new Set([...files, 'user-plugins/manifest.json', OWNERSHIP_FILE, `${LOCAL_DLC_ROOT}/installed.json`, '.kook-plugin-tools.json', htmlFile])
    const backups = new Map(), hash = crypto.createHash('sha256')
    for (const name of [...affected].sort()) {
      const target = within(build, name), bytes = fs.existsSync(target) ? fs.readFileSync(target) : null
      backups.set(target, bytes)
      hash.update(name).update('\0').update(bytes === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytes]))
    }
    return { plugin, related, remaining, packageId, files, ownership, registry, htmlFile, html, backups, stateToken: hash.digest('hex') }
  }

  function inspectRemoval(pluginId) {
    const data = removalPlan(pluginId)
    return { pluginId, name: data.plugin.name || pluginId, pluginIds: data.related.map(item => item.id), names: data.related.map(item => item.name || item.id), stateToken: data.stateToken }
  }

  function remove(pluginId, expected) {
    const lock = within(build, `${LOCAL_DLC_ROOT}/install.lock`)
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    const descriptor = acquireLock(lock)
    try {
      const data = removalPlan(pluginId)
      if (expected?.pluginId !== pluginId || expected.stateToken !== data.stateToken) throw new Error('插件安装状态已变化，请重新确认删除')
      try {
        for (const name of data.files) fs.rmSync(within(build, name), { force: true })
        writeJsonAtomic(within(build, 'user-plugins/manifest.json'), { ...readJson(within(build, 'user-plugins/manifest.json')), plugins: data.remaining })
        if (fs.existsSync(within(build, OWNERSHIP_FILE))) writeJsonAtomic(within(build, OWNERSHIP_FILE), { ...data.ownership, files: data.ownership.files.filter(name => !data.files.has(name)), packages: (data.ownership.packages || []).filter(item => item.id !== data.packageId) })
        if (fs.existsSync(within(build, `${LOCAL_DLC_ROOT}/installed.json`))) writeJsonAtomic(within(build, `${LOCAL_DLC_ROOT}/installed.json`), { ...data.registry, packages: data.registry.packages.filter(item => item.id !== data.packageId) })
        fs.writeFileSync(within(build, data.htmlFile), data.html, 'utf8')
        fs.rmSync(within(build, '.kook-plugin-tools.json'), { force: true })
      } catch (error) {
        const failures = []
        for (const [filename, bytes] of data.backups) {
          try {
            if (bytes === null) fs.rmSync(filename, { force: true })
            else { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes) }
          } catch (restoreError) { failures.push(`${path.basename(filename)}: ${restoreError.message}`) }
        }
        if (failures.length) throw new Error(`删除失败：${error.message}；部分文件未能恢复，请重新应用注入器。${failures.join('；')}`)
        throw new Error('删除失败，已恢复原有插件：' + error.message)
      }
      return { pluginIds: data.related.map(item => item.id), reloadRequired: false }
    } finally { fs.closeSync(descriptor); fs.unlinkSync(lock) }
  }

  function install(input, expected) {
    const lock = within(build, `${LOCAL_DLC_ROOT}/install.lock`)
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    const descriptor = acquireLock(lock)
    try {
      const data = plan(input)
      if (data.sha256 !== expected?.sha256 || data.stateToken !== expected?.stateToken) throw new Error('安装包或当前插件已发生变化，请重新选择安装包')
      const { manifest } = data
      const directory = `${manifest.id}/${manifest.version}-${data.sha256}`
      const cache = within(build, `${LOCAL_DLC_ROOT}/${directory}`)
      const staging = within(build, `${LOCAL_DLC_ROOT}/staging-${crypto.randomUUID()}`)
      try {
        fs.mkdirSync(staging)
        for (const [name, bytes] of data.files) {
          const target = within(staging, name)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, bytes)
        }
        if (!fs.existsSync(cache)) {
          fs.mkdirSync(path.dirname(cache), { recursive: true })
          fs.renameSync(staging, cache)
        } else {
          // The preview's bytes remain the source of truth, even on reinstallation.
          for (const [name, bytes] of data.files) if (!fs.readFileSync(within(cache, name)).equals(bytes)) throw new Error('本地安装包缓存校验失败，请使用注入器重新应用此插件')
        }
      } finally { fs.rmSync(staging, { recursive: true, force: true }) }
      const nextFiles = new Set(data.contributions.map(file => file.target))
      try {
        for (const file of data.contributions) {
          const target = within(build, file.target)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, file.bytes)
        }
        for (const old of data.oldFiles) if (!nextFiles.has(old)) fs.rmSync(within(build, old), { force: true })
        const retained = data.current.plugins.filter(plugin => !data.oldPlugins.includes(plugin))
        const plugins = manifest.plugins.map(plugin => ({ ...plugin, author: manifest.author, dlcId: manifest.id, dlcSource: 'local-package', enabled: data.oldPlugins.find(old => old.id === plugin.id)?.enabled === true }))
        writeJsonAtomic(within(build, 'user-plugins/manifest.json'), { ...data.current, plugins: [...retained, ...plugins] })
        const localEntries = data.locals.filter(item => item.manifest.id !== manifest.id).map(item => item.localEntry)
        localEntries.push({ id: manifest.id, version: manifest.version, author: manifest.author, sha256: data.sha256, directory })
        writeJsonAtomic(within(build, `${LOCAL_DLC_ROOT}/installed.json`), { format: 1, packages: localEntries })
        const ownedFiles = new Set((data.ownership.files || []).filter(file => !data.oldFiles.has(file)))
        for (const file of nextFiles) ownedFiles.add(file)
        writeJsonAtomic(within(build, OWNERSHIP_FILE), { ...data.ownership, format: 1, hostId: 'kook-plugin-tools', revision: crypto.createHash('sha256').update(data.stateToken + data.sha256).digest('hex'), files: [...ownedFiles], packages: [...(data.ownership.packages || []).filter(item => item.id !== manifest.id), { id: manifest.id, version: manifest.version, plugins: manifest.plugins.map(plugin => plugin.id), files: [...nextFiles], earlyScripts: manifest.earlyScripts }] })
        fs.writeFileSync(within(build, data.htmlFile), data.html, 'utf8')
        fs.rmSync(within(build, '.kook-plugin-tools.json'), { force: true })
      } catch (error) {
        const failures = []
        for (const [filename, bytes] of data.backups) {
          try {
            if (bytes === null) fs.rmSync(filename, { force: true })
            else { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes) }
          } catch (restoreError) { failures.push(`${path.basename(filename)}: ${restoreError.message}`) }
        }
        if (failures.length) throw new Error(`安装失败：${error.message}；部分文件未能恢复，请重新应用注入器。${failures.join('；')}`)
        throw new Error('安装失败，已恢复原有插件：' + error.message)
      }
      return { id: manifest.id, name: manifest.name || manifest.id, version: manifest.version, reloadRequired: true }
    } finally { fs.closeSync(descriptor); fs.unlinkSync(lock) }
  }
  return { inspect, install, inspectRemoval, remove }
}

module.exports = { createDlcImporter, rewriteEarlyScripts, acquireLock }
