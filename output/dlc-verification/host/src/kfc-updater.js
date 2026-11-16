const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { compareVersions, parseVersion } = require('./versions')
const { readZip, readArchive, MAX_ARCHIVE } = require('./dlc-archive')
const { createDlcImporter, acquireLock } = require('./dlc-importer')
const { within: safeWithin, LEGACY_PLUGINS, readLocalDlcPackages } = require('./dlc-provider')
const { createCredentialStore } = require('./kfc-auth')
const { requestBytes, kfcError } = require('./kfc-client')

const HOST_ID = 'kook-plugin-tools'
const RUNTIME_FILES = ['dlc-provider.js', 'dlc-archive.js', 'dlc-importer.js', 'versions.js', 'kfc-auth.js', 'kfc-client.js', 'kfc-updater.js']
const BROWSER_FILES = ['plugin-api.js', 'plugin-loader.js', 'plugin-ui.js', 'plugin-dlc-bridge.js']
const within = (root, relative) => safeWithin(root, relative, true)
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const stable = version => parseVersion(version) && !version.includes('-')
function compatible(dlc, version) {
  return dlc?.hostId === HOST_ID && dlc.apiVersion === 1 &&
    (!dlc.minHostVersion || (parseVersion(dlc.minHostVersion) && compareVersions(version, dlc.minHostVersion) >= 0)) &&
    (!dlc.maxHostVersionExclusive || (parseVersion(dlc.maxHostVersionExclusive) && compareVersions(version, dlc.maxHostVersionExclusive) < 0))
}

function createKfcUpdater(build, options = {}) {
  build = path.resolve(build)
  const credentials = options.credentials || createCredentialStore()
  const request = options.request || requestBytes
  let pending = null, busy = false, controller = null
  const currentHost = () => readJson(within(build, 'plugin-runtime/host.json')).version
  function installed() {
    const plugins = readJson(within(build, 'user-plugins/manifest.json')).plugins
    if (!Array.isArray(plugins)) throw new Error('当前插件列表无法读取，请先重新应用注入器')
    const ownershipFile = within(build, '.kfc-dlc-files.json')
    const ownership = fs.existsSync(ownershipFile) ? readJson(ownershipFile) : { packages: [] }
    if (ownership.packages && !Array.isArray(ownership.packages)) throw new Error('当前插件安装记录无法读取')
    const records = new Map((ownership.packages || []).map(item => [item.id, item.version]))
    for (const local of readLocalDlcPackages(build)) records.set(local.manifest.id, local.manifest.version)
    const packages = new Map()
    for (const plugin of plugins) {
      const id = plugin.dlcId || (LEGACY_PLUGINS.includes(plugin.id) ? `${HOST_ID}-${plugin.id}` : null)
      if (id) {
        // A DLC may bundle plugins with different individual version numbers.
        const version = records.get(id) || plugin.version
        if (!/^kook-plugin-tools-[a-z0-9-]+$/.test(id) || !parseVersion(version)) throw new Error(`无法识别 ${plugin.name || plugin.id} 的版本，请先重新应用注入器`)
        const previous = packages.get(id)
        if (previous && previous.version !== version) throw new Error('同一 DLC 的插件版本不一致，请先重新应用注入器')
        packages.set(id, { id, version })
      }
    }
    return { hostVersion: currentHost(), packages: [...packages.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  }
  async function token() {
    let value
    try { value = await credentials.get() } catch { throw kfcError('本机 KFC 连接已失效，请重新连接', 'KFC_AUTH_REQUIRED') }
    if (!value) throw kfcError('请先连接 KFC，再检查插件更新', 'KFC_AUTH_REQUIRED')
    return value
  }
  async function json(route, auth, signal) {
    const bytes = await request(route, auth, { signal })
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('KFC 返回的信息无法读取，请稍后重试') }
  }
  async function exclusive(operation) {
    if (busy) throw new Error('已有更新任务正在进行')
    busy = true
    controller = new AbortController()
    try { return await operation(controller.signal) } finally { busy = false; controller = null }
  }
  function cancel() { pending = null; controller?.abort() }
  async function connect(value) {
    return exclusive(async signal => {
      if (typeof value !== 'string' || value.trim().length < 16 || value.length > 16384 || /\s/.test(value.trim())) throw new Error('请输入有效的 KFC 令牌')
      const auth = value.trim()
      const catalog = await json('/api/catalog', auth, signal)
      if (!Array.isArray(catalog.tools) || !catalog.tools.some(item => item.id === HOST_ID)) throw new Error('此 KFC 账号暂时无法访问注入器')
      if (signal.aborted) throw kfcError('已取消连接', 'CANCELLED')
      await credentials.save(auth)
      return { connected: true }
    })
  }
  async function check() {
    return exclusive(async signal => {
      pending = null
      const before = installed(), auth = await token()
      if (!parseVersion(before.hostVersion)) throw new Error('无法识别当前注入器版本，请先重新应用注入器')
      const catalog = await json('/api/catalog', auth, signal)
      const host = Array.isArray(catalog.tools) ? catalog.tools.find(item => item.id === HOST_ID) : null
      if (!host || !Array.isArray(host.dlcs)) throw new Error('KFC 未返回 DLC 信息，请稍后重试')
      const notes = [], changes = []
      async function releases(id) {
        const data = await json(`/api/tools/${encodeURIComponent(id)}/versions`, auth, signal)
        if (!Array.isArray(data.versions)) throw new Error('KFC 版本列表无法读取')
        if (data.versions.some(item => stable(item.version) && item.manifest?.id === id && item.platforms?.['windows-x64'] && !/^[a-f0-9]{64}$/i.test(item.platforms['windows-x64'].sha256 || ''))) throw new Error('KFC 安装包缺少有效校验信息，暂时无法更新')
        return data.versions.filter(item => stable(item.version) && item.manifest?.id === id && /^[a-f0-9]{64}$/i.test(item.platforms?.['windows-x64']?.sha256 || '')).sort((a, b) => compareVersions(b.version, a.version))
      }
      const hostReleases = await releases(HOST_ID)
      if (hostReleases.some(item => compareVersions(item.version, before.hostVersion) > 0 && (item.manifest.dlcHost?.apiVersion !== 1 || parseVersion(item.version).numbers[0] !== 1))) notes.push('KFC 有需要新版安装组件的注入器版本，请下载新版注入器完成升级')
      // This runtime implements host API v1. Major migrations need a newer injector.
      const newHost = hostReleases.find(item => item.manifest.dlcHost?.apiVersion === 1 && parseVersion(item.version).numbers[0] === 1 && compareVersions(item.version, before.hostVersion) > 0)
      let targetHost = newHost?.version || before.hostVersion
      const locals = readLocalDlcPackages(build)
      // Do not move an installed DLC outside its declared compatibility range.
      for (const local of locals) {
        if (!before.packages.some(item => item.id === local.manifest.id)) continue
        if (!compatible({ hostId: HOST_ID, apiVersion: 1, ...local.manifest }, targetHost)) targetHost = before.hostVersion
      }
      if (newHost && targetHost === newHost.version) changes.push({ id: HOST_ID, name: '注入器', currentVersion: before.hostVersion, version: newHost.version, release: newHost, kind: 'host' })
      else if (newHost) notes.push('新版注入器超出已安装插件的兼容范围，暂未选择更新')
      for (const current of before.packages) {
        const entry = host.dlcs.find(item => item.id === current.id)
        if (!entry) { notes.push(`${current.id} 暂未在 KFC 上架`); continue }
        const versions = await releases(current.id)
        const newer = versions.filter(item => compareVersions(item.version, current.version) > 0)
        const release = newer.find(item => compatible(item.manifest.dlc, targetHost))
        if (release) changes.push({ id: current.id, name: entry.name || current.id, currentVersion: current.version, version: release.version, release, kind: 'dlc' })
        else if (newer.length) notes.push(`${entry.name || current.id} 的新版本与当前注入器不兼容`)
      }
      if (signal.aborted) throw kfcError('已取消检查', 'CANCELLED')
      if (JSON.stringify(installed()) !== JSON.stringify(before)) throw new Error('插件状态已变化，请重新检查更新')
      const id = crypto.randomUUID()
      pending = { id, before, changes, targetHost }
      return { id, hostVersion: before.hostVersion, changes: changes.map(({ release, ...item }) => ({ ...item, changelog: typeof release.changelog === 'string' ? release.changelog.slice(0, 6000) : '' })), notes }
    })
  }

  function readHost(bytes, release) {
    const { files } = readZip(bytes)
    function metadata(name) {
      try { return JSON.parse(files.get(name).toString('utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('注入器安装包缺少有效的版本信息') }
    }
    const manifest = metadata('kfc.manifest.json')
    if (metadata('package.json').version !== release.version || manifest.id !== HOST_ID || manifest.dlcHost?.apiVersion !== 1) throw new Error('注入器安装包版本与已确认的信息不一致')
    const output = new Map()
    for (const name of BROWSER_FILES) {
      if (!files.get(`plugins/${name}`)?.length) throw new Error(`注入器安装包缺少 ${name}`)
      output.set(name, files.get(`plugins/${name}`))
    }
    for (const name of RUNTIME_FILES) {
      if (!files.get(`src/${name}`)?.length) throw new Error(`安装包不支持当前在线更新方式，缺少 ${name}，请下载新版注入器`)
      output.set(`plugin-runtime/${name}`, files.get(`src/${name}`))
    }
    if (files.has('plugin-icon.png')) output.set('plugin-icon.png', files.get('plugin-icon.png'))
    output.set('plugin-runtime/host.json', Buffer.from(JSON.stringify({ version: release.version })))
    return output
  }

  function collect(root, names) {
    const result = new Map()
    function visit(name) {
      const file = within(root, name)
      if (!fs.existsSync(file)) { result.set(name, null); return }
      if (fs.statSync(file).isDirectory()) {
        for (const child of fs.readdirSync(file).sort()) visit(`${name}/${child}`)
      } else result.set(name, fs.readFileSync(file))
    }
    for (const name of names) visit(name)
    return result
  }
  function same(a, b) {
    const names = new Set([...a.keys(), ...b.keys()])
    return [...names].every(name => (a.get(name) ?? null) === null ? (b.get(name) ?? null) === null : b.get(name) && a.get(name).equals(b.get(name)))
  }

  async function install(id) {
    return exclusive(async signal => {
      const plan = pending
      pending = null
      if (!plan || plan.id !== id || !plan.changes.length) throw new Error('更新确认已失效，请重新检查')
      if (JSON.stringify(installed()) !== JSON.stringify(plan.before)) throw new Error('插件状态已变化，请重新检查更新')
      const auth = await token(), downloads = []
      for (const item of plan.changes) {
        const bytes = await request(`/api/tools/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}/windows-x64`, auth, { limit: MAX_ARCHIVE, signal })
        if (hash(bytes).toLowerCase() !== item.release.platforms['windows-x64'].sha256.toLowerCase()) throw new Error(`${item.name} 下载校验失败，尚未安装任何更新`)
        if (item.kind === 'host') downloads.push({ item, host: readHost(bytes, item.release) })
        else {
          const archive = readArchive(bytes)
          if (archive.manifest.id !== item.id || archive.manifest.version !== item.version || !compatible({ hostId: HOST_ID, apiVersion: 1, ...archive.manifest }, plan.targetHost)) throw new Error(`${item.name} 安装包与已确认的信息不一致`)
          downloads.push({ item, bytes, archive })
        }
      }
      if (signal.aborted) throw kfcError('已取消更新', 'CANCELLED')
      const lock = within(build, '.kook-local-dlcs/install.lock')
      fs.mkdirSync(path.dirname(lock), { recursive: true })
      const descriptor = acquireLock(lock)
      let stage
      try {
        stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kook-online-update-'))
        if (JSON.stringify(installed()) !== JSON.stringify(plan.before)) throw new Error('插件状态已变化，请重新检查更新')
        const names = new Set(['user-plugins', 'plugin-runtime', '.kook-local-dlcs/installed.json', '.kfc-dlc-files.json', '.kook-plugin-tools.json', 'index.htm', 'index.html', 'bifrost-hot-module-bootstrap.js', 'hot-module-version-bootstrap.js', 'environment-switcher.js', 'restart-kook-environment.ps1'])
        const ownership = fs.existsSync(within(build, '.kfc-dlc-files.json')) ? readJson(within(build, '.kfc-dlc-files.json')) : { files: [] }
        for (const name of ownership.files || []) names.add(name)
        // Local package caches are included so the importer can preserve their metadata.
        if (fs.existsSync(within(build, '.kook-local-dlcs'))) {
          for (const name of fs.readdirSync(within(build, '.kook-local-dlcs'))) if (name !== 'install.lock') names.add(`.kook-local-dlcs/${name}`)
        }
        for (const data of downloads) {
          for (const name of data.host?.keys() || []) names.add(name)
          for (const file of data.archive?.contributions || []) names.add(file.target)
        }
        const before = collect(build, names)
        for (const [name, bytes] of before) if (bytes !== null) {
          const file = within(stage, name)
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
        }
        for (const data of downloads) {
          if (data.host) {
            for (const [name, bytes] of data.host) {
              const file = within(stage, name)
              fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
            }
            fs.rmSync(within(stage, '.kook-plugin-tools.json'), { force: true })
          } else {
            const importer = createDlcImporter(stage, plan.targetHost)
            importer.install(data.bytes, importer.inspect(data.bytes))
          }
        }
        const afterNames = new Set([...names, '.kook-local-dlcs'])
        const after = collect(stage, afterNames)
        if (!same(before, collect(build, names))) throw new Error('文件已被其他操作修改，请重新检查更新')
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(name => {
          const a = before.get(name), b = after.get(name)
          return a ? !b || !a.equals(b) : !!b
        })
        // The commit is synchronous under the shared DLC lock. Never execute package code.
        const written = []
        try {
          for (const name of changed) {
            const file = within(build, name), bytes = after.get(name)
            written.push(name)
            options.beforeWrite?.(name)
            if (bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
            else fs.rmSync(file, { force: true })
          }
        } catch (error) {
          const failures = []
          for (const name of written.reverse()) {
            try {
              const file = within(build, name), bytes = before.get(name)
              if (bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
              else fs.rmSync(file, { force: true })
            } catch { failures.push(name) }
          }
          if (failures.length) throw new Error(`更新失败，部分文件无法恢复，请重新应用注入器：${failures.join('、')}`)
          throw new Error('更新失败，已恢复原有文件：' + error.message)
        }
        return { reloadRequired: true, installed: plan.changes.map(({ id, version, name }) => ({ id, version, name })) }
      } finally {
        fs.closeSync(descriptor); fs.unlinkSync(lock)
        if (stage) fs.rmSync(stage, { recursive: true, force: true })
      }
    })
  }
  return { check, install, connect, cancel }
}

module.exports = { createKfcUpdater, RUNTIME_FILES, compatible }
