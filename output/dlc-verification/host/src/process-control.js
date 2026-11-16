const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const POWERSHELL = 'powershell.exe'
// -Name reports an error (and PowerShell exits 1) when KOOK is not running,
// even with SilentlyContinue. Filtering a successful enumeration is an empty result.
const KOOK_PROCESS_QUERY = "Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq 'KOOK' -and -not $_.HasExited }"

function getKookProcesses(options = {}) {
  const runPowerShell = options.execFileSync || execFileSync
  try {
    const script = [
      KOOK_PROCESS_QUERY,
      '| Select-Object Id,Path,MainWindowTitle',
      '| ConvertTo-Json -Compress'
    ].join(' ')
    const output = runPowerShell(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
    if (!output) {
      return []
    }
    const parsed = JSON.parse(output)
    const processes = Array.isArray(parsed) ? parsed : [parsed]
    if (!processes.every(process => process && Number.isSafeInteger(process.Id) && process.Id > 0)) {
      throw new Error('进程列表缺少有效 PID')
    }
    return processes
  } catch (error) {
    throw new Error(`无法检测 KOOK 进程: ${error?.message || error}`, { cause: error })
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function clearKookCache(options = {}) {
  const fsModule = options.fsModule || fs
  const appData = options.appData || process.env.APPDATA
  const cacheDir = appData ? path.join(appData, 'KOOK', 'Cache') : null

  if (!cacheDir || !fsModule.existsSync(cacheDir)) {
    return { cleared: false, cacheDir, reason: cacheDir ? 'not-found' : 'appdata-unavailable' }
  }

  try {
    fsModule.rmSync(cacheDir, { recursive: true, force: true })
    return { cleared: true, cacheDir }
  } catch (error) {
    return { cleared: false, cacheDir, reason: 'remove-failed', error }
  }
}

async function stopKookProcesses(options = {}) {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 10_000)
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 1_000)
  const getProcesses = options.getProcesses || (() => getKookProcesses(options))
  const runPowerShell = options.execFileSync || execFileSync
  const wait = options.delay || delay
  const now = options.now || Date.now
  const terminateProcesses = options.terminateProcesses || (() => {
    runPowerShell(POWERSHELL, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // Stop-Process can race with a process exiting by itself. Its per-process
      // errors are checked by the next enumeration, not treated as a fatal exit.
      `${KOOK_PROCESS_QUERY} | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`
    ], { stdio: 'ignore', windowsHide: true })
  })

  const deadline = now() + timeoutMs
  let remainingProcesses = getProcesses()
  if (remainingProcesses.length === 0) {
    return false
  }

  while (true) {
    terminateProcesses(remainingProcesses)

    const remainingMs = Math.max(0, deadline - now())
    if (remainingMs === 0) {
      break
    }

    await wait(Math.min(retryIntervalMs, remainingMs))
    remainingProcesses = getProcesses()
    if (remainingProcesses.length === 0) {
      return true
    }
    if (now() >= deadline) {
      break
    }
  }

  // A process may finish between the deadline snapshot and error construction.
  remainingProcesses = getProcesses()
  if (remainingProcesses.length === 0) {
    return true
  }

  const processIds = remainingProcesses
    .map(process => process.Id ?? process.id)
    .filter(id => id !== undefined && id !== null)
  const suffix = processIds.length > 0 ? `（仍检测到 PID: ${processIds.join(', ')}）` : ''
  throw new Error(`KOOK 未能在限定时间内退出${suffix}`)
}

function startKook(installation) {
  if (!installation?.launchPath) {
    throw new Error('所选实例没有可用的 KOOK 启动器')
  }
  spawn(installation.launchPath, [], {
    cwd: installation.launchCwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  }).unref()
}

module.exports = {
  clearKookCache,
  getKookProcesses,
  startKook,
  stopKookProcesses
}
