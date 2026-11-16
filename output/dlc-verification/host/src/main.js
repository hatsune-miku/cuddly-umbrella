const path = require('path')
const { findKookInstallations } = require('./installations')
const { prepareInstallation } = require('./kook-package')
const { clearKookCache, startKook, stopKookProcesses } = require('./process-control')
const { selectInstallation } = require('./version-selector')
const { resolveDlcSelection } = require('./dlc-provider')

const toolRoot = path.join(__dirname, '..')

function info(message) {
  console.log(`\x1b[32m✓ ${message}\x1b[0m`)
}

function verbose(message) {
  console.log(`  ${message}`)
}

function fail(message) {
  console.error(`\x1b[31m错误：${message}\x1b[0m`)
  process.exitCode = 1
}

function selectFromArgument(installations, requestedPath) {
  if (!requestedPath) {
    return null
  }
  const normalizedPath = path.resolve(requestedPath).toLowerCase()
  return installations.find(installation => installation.appDir.toLowerCase() === normalizedPath) || null
}

function parseLaunchArguments(args) {
  const result = { requestedPath: null, dlcManifestPath: null }
  let acceptsPositionalPath = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--kfc-dlc-manifest' || arg === '--path') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      if (arg === '--path') result.requestedPath = value
      else result.dlcManifestPath = value
    } else if (arg.startsWith('-')) {
      // Unknown options can have values (including KFC's --klt token).
      // Ignore subsequent positional arguments; --path remains unambiguous.
      acceptsPositionalPath = false
    } else if (acceptsPositionalPath && !result.requestedPath) {
      result.requestedPath = arg
    }
  }
  return result
}

async function main() {
  console.log('=================================')
  console.log('  KOOK PC 注入工具')
  console.log('=================================\n')

  const installations = findKookInstallations()
  if (installations.length === 0) {
    fail('没有找到传统安装或 KVM 管理的 KOOK 实例')
    return
  }

  let requestedPath, dlcManifestPath, dlcSelection
  try {
    ({ requestedPath, dlcManifestPath } = parseLaunchArguments(process.argv.slice(2)))
    dlcSelection = resolveDlcSelection(toolRoot, dlcManifestPath)
  } catch (error) {
    fail(error.message)
    return
  }
  const selectedFromArgument = selectFromArgument(installations, requestedPath)
  if (requestedPath && (!selectedFromArgument || !selectedFromArgument.isUsable)) {
    fail('指定的 KOOK 实例不存在或安装不完整，请检查 --path')
    return
  }
  if (!selectedFromArgument) {
    verbose('等待在版本选择窗口中确认要启动的 KOOK 版本...')
  }
  const selected = selectedFromArgument || await selectInstallation(installations, {
    dlcs: dlcSelection.packages.map((item) => item.manifest), dlcSource: dlcSelection.source
  })
  if (!selected) {
    console.log('未选择 KOOK 版本，操作已取消')
    return
  }

  console.log(`已选择 ${selected.sourceLabel}: ${selected.label}`)
  console.log(`路径: ${selected.appDir}\n`)

  let stopped = false
  try {
    const currentSelection = resolveDlcSelection(toolRoot, dlcManifestPath)
    if (currentSelection.fingerprint !== dlcSelection.fingerprint) throw new Error('DLC 已发生变化，请重新打开注入器确认后再应用')
    verbose('正在检查并关闭已有的 KOOK 进程...')
    stopped = await stopKookProcesses()
    if (stopped) {
      info('KOOK 已关闭')
    }

    const result = await prepareInstallation(selected, { toolRoot, verbose, dlcSelection })
    if (result.extraction.extracted) {
      info('app.asar 已按 KVM 目录态方案解包')
    } else {
      info('实例已经解包，已跳过重复解包')
    }

    if (result.injection.injected) {
      info('插件运行时已注入')
    } else {
      info('插件运行时已经是当前版本，已跳过重复注入')
    }

    const cacheResult = clearKookCache()
    if (cacheResult.cleared) {
      info('KOOK 缓存已清理')
    } else if (cacheResult.error) {
      verbose(`KOOK 缓存清理失败，继续启动: ${cacheResult.error.message}`)
    }

    startKook(selected)
    info('KOOK 已启动')
  } catch (error) {
    fail(error?.message || String(error))
    if (stopped && error.rollbackComplete) {
      startKook(selected)
      verbose('已重新启动 KOOK；插件安装未完成，请检查上述错误')
    }
  }
}

if (require.main === module) {
  void main()
}

module.exports = { main, selectFromArgument, parseLaunchArguments }
