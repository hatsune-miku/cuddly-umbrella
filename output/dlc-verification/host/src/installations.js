const fs = require('fs')
const path = require('path')
const { parseVersion, compareVersions: compareInjectorVersions } = require('./versions')

const APP_DIR_PATTERN = /^app-(\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?)$/

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

function isFile(targetPath) {
  try {
    return fs.statSync(targetPath).isFile()
  } catch {
    return false
  }
}

function firstExistingFile(candidates) {
  return candidates.find(isFile) || null
}

function getAppVersion(appDir) {
  return path.basename(appDir).match(APP_DIR_PATTERN)?.[1] || null
}

function readVersion(filename, field = 'version') {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))?.[field]
    return parseVersion(value) ? value : null
  } catch { return null }
}

function getInstallationState(appDir, options = {}) {
  const resourcesDir = path.join(appDir, 'resources')
  const extractedAppDir = path.join(resourcesDir, 'app')
  const asarPath = path.join(resourcesDir, 'app.asar')
  const markerPath = path.join(extractedAppDir, 'webapp', 'build', '.kook-plugin-tools.json')
  const legacyRuntimePath = path.join(extractedAppDir, 'webapp', 'build', 'plugin-loader.js')
  const isExtracted = isDirectory(extractedAppDir)
  const isPacked = isFile(asarPath)
  const hasLegacyRuntime = isExtracted && isFile(legacyRuntimePath)
  const isInjected = isExtracted && (isFile(markerPath) || hasLegacyRuntime)
  const targetInjectorVersion = options.toolVersion || require('../package.json').version
  // host.json describes the installed runtime, including hosts updated in place.
  const injectedVersion = isInjected ? readVersion(path.join(extractedAppDir, 'webapp', 'build', 'plugin-runtime', 'host.json')) || readVersion(markerPath, 'toolVersion') : null
  let injectionStatus = 'not-installed'
  let injectionLabel = '未注入'
  let injectionDetail = `将安装注入器 v${targetInjectorVersion}`

  let status = 'unavailable'
  let statusLabel = '安装不完整'
  let actionLabel = '不可用'

  if (isExtracted && isInjected) {
    status = 'ready'
    actionLabel = '更新并启动'
    if (!injectedVersion) {
      injectionStatus = 'legacy'
      injectionLabel = '旧版注入'
      injectionDetail = `版本未记录 → v${targetInjectorVersion}`
    } else {
      const difference = compareInjectorVersions(injectedVersion, targetInjectorVersion)
      injectionStatus = difference < 0 ? 'outdated' : difference > 0 ? 'newer' : 'current'
      injectionLabel = difference < 0 ? '可更新' : difference > 0 ? '已装更高版本' : '版本一致'
      injectionDetail = difference < 0 ? `注入器 v${injectedVersion} → v${targetInjectorVersion}` : difference > 0 ? `注入器 v${injectedVersion} · 本次 v${targetInjectorVersion}` : `注入器 v${injectedVersion}`
      actionLabel = difference > 0 ? '替换并启动' : difference === 0 ? '应用并启动' : '更新并启动'
    }
    statusLabel = injectionLabel
  } else if (isExtracted) {
    status = 'extracted'
    statusLabel = hasLegacyRuntime ? '已解包 / 待更新' : '已解包'
    actionLabel = '注入并启动'
  } else if (isPacked) {
    status = 'packed'
    statusLabel = '待解包'
    actionLabel = '解包并启动'
  }

  return {
    resourcesDir,
    extractedAppDir,
    asarPath,
    markerPath,
    isExtracted,
    isPacked,
    isInjected,
    hasLegacyRuntime,
    injectedVersion,
    targetInjectorVersion,
    injectionStatus,
    injectionLabel,
    injectionDetail,
    isUsable: isExtracted || isPacked,
    status,
    statusLabel,
    actionLabel
  }
}

function createInstallation({ source, sourceLabel, instanceName, appDir, launchCandidates, launchCwd, toolVersion }) {
  const version = getAppVersion(appDir)
  if (!version || !isDirectory(appDir)) {
    return null
  }

  const launchPath = firstExistingFile(launchCandidates)
  const state = getInstallationState(appDir, { toolVersion })
  const usable = Boolean(launchPath && state.isUsable)
  const label = source === 'kvm' && instanceName
    ? `${version} · ${instanceName}`
    : version

  return {
    id: `${source}:${path.resolve(appDir).toLowerCase()}`,
    source,
    sourceLabel,
    instanceName: instanceName || '',
    label,
    version,
    appDir: path.resolve(appDir),
    launchPath: launchPath ? path.resolve(launchPath) : null,
    launchCwd: path.resolve(launchCwd),
    ...state,
    isUsable: usable,
    status: usable ? state.status : 'unavailable',
    statusLabel: usable ? state.statusLabel : '安装不完整',
    actionLabel: usable ? state.actionLabel : '不可用'
  }
}

function scanTraditionalInstallations(root, options = {}) {
  if (!isDirectory(root)) {
    return []
  }

  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && APP_DIR_PATTERN.test(entry.name))
    .map(entry => {
      const appDir = path.join(root, entry.name)
      return createInstallation({
        source: 'traditional',
        toolVersion: options.toolVersion,
        sourceLabel: '传统安装',
        appDir,
        launchCandidates: [path.join(appDir, 'KOOK.exe'), path.join(root, 'KOOK.exe')],
        launchCwd: isFile(path.join(appDir, 'KOOK.exe')) ? appDir : root
      })
    })
    .filter(Boolean)
}

function scanKvmInstallations(root, options = {}) {
  if (!isDirectory(root)) {
    return []
  }

  const installations = []
  for (const instanceEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!instanceEntry.isDirectory()) {
      continue
    }

    const instanceRoot = path.join(root, instanceEntry.name)
    for (const appEntry of fs.readdirSync(instanceRoot, { withFileTypes: true })) {
      if (!appEntry.isDirectory() || !APP_DIR_PATTERN.test(appEntry.name)) {
        continue
      }

      const appDir = path.join(instanceRoot, appEntry.name)
      const version = getAppVersion(appDir)
      const versionSuffix = version ? `.${version}` : ''
      const instanceName = versionSuffix && instanceEntry.name.endsWith(versionSuffix)
        ? instanceEntry.name.slice(0, -versionSuffix.length)
        : instanceEntry.name
      const installation = createInstallation({
        source: 'kvm',
        toolVersion: options.toolVersion,
        sourceLabel: 'KVM',
        instanceName,
        appDir,
        launchCandidates: [path.join(appDir, 'KOOK.exe'), path.join(instanceRoot, 'KOOK.exe')],
        launchCwd: isFile(path.join(appDir, 'KOOK.exe')) ? appDir : instanceRoot
      })
      if (installation) {
        installations.push(installation)
      }
    }
  }

  return installations
}

function compareVersions(left, right) {
  const leftParts = String(left).split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0)
  const rightParts = String(right).split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index++) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function findKookInstallations(options = {}) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA
  const userProfile = options.userProfile || process.env.USERPROFILE
  const traditionalRoot = options.traditionalRoot || (localAppData ? path.join(localAppData, 'KOOK') : null)
  const kvmRoot = options.kvmRoot || (userProfile
    ? path.join(userProfile, '.kook-kvm', 'installations')
    : null)

  const installations = [
    ...(traditionalRoot ? scanTraditionalInstallations(traditionalRoot, options) : []),
    ...(kvmRoot ? scanKvmInstallations(kvmRoot, options) : [])
  ]
  const localLatestVersion = installations.filter(item => item.isUsable).map(item => item.version).sort(compareVersions)[0] || null

  const seen = new Set()
  return installations
    .filter(installation => {
      if (seen.has(installation.appDir)) {
        return false
      }
      seen.add(installation.appDir)
      return true
    })
    .sort((left, right) => {
      const versionOrder = compareVersions(left.version, right.version)
      if (versionOrder !== 0) {
        return versionOrder
      }
      if (left.source !== right.source) {
        return left.source === 'traditional' ? -1 : 1
      }
      return left.label.localeCompare(right.label, 'zh-CN')
    })
    .map(installation => ({
      ...installation,
      localLatestVersion,
      isNewestLocalVersion: Boolean(localLatestVersion && compareVersions(installation.version, localLatestVersion) === 0),
      isOlderLocalVersion: Boolean(localLatestVersion && compareVersions(installation.version, localLatestVersion) > 0)
    }))
}

module.exports = {
  APP_DIR_PATTERN,
  compareVersions,
  findKookInstallations,
  getInstallationState,
  scanKvmInstallations,
  scanTraditionalInstallations
}
