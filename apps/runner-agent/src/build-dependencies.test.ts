import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  dependencyCacheEnvironment,
  installTimeoutFromEnvironment,
  prepareDependencyEnvironment,
} from './build-dependencies'
import { runCommand, runInstallCommand, RunnerFailure } from './runner'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bifrost-dependencies-'))
  roots.push(root)
  const filename = path.join(root, 'install.log')
  const log = createWriteStream(filename)
  return {
    root,
    log,
    close: async () => {
      await new Promise<void>((resolve) => log.end(resolve))
      return readFile(filename, 'utf8')
    },
  }
}

describe('dependency installation policy', () => {
  it('defaults to ten minutes and rejects disabled, invalid or excessive limits', () => {
    expect(installTimeoutFromEnvironment({})).toBe(600_000)
    expect(installTimeoutFromEnvironment({ CUDDLY_INSTALL_TIMEOUT_MS: '120000' })).toBe(120_000)
    for (const value of ['0', '-1', '', 'NaN', '1000.5', '7200001']) {
      expect(() => installTimeoutFromEnvironment({ CUDDLY_INSTALL_TIMEOUT_MS: value })).toThrow()
    }
  })

  it('keeps caches stable across jobs but isolates repositories and projects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bifrost-cache-'))
    roots.push(root)
    const project = { id: '../unsafe-id', repositoryUrl: 'https://git.example.test/a.git' }
    const first = await prepareDependencyEnvironment(root, project)
    expect(await prepareDependencyEnvironment(root, project)).toEqual(first)
    expect((await prepareDependencyEnvironment(root, { ...project, id: 'b' })).cacheRoot).not.toBe(
      first.cacheRoot
    )
    expect(
      (
        await prepareDependencyEnvironment(root, {
          ...project,
          repositoryUrl: 'https://git.example.test/b.git',
        })
      ).cacheRoot
    ).not.toBe(first.cacheRoot)
    expect(first.cacheRoot.startsWith(path.join(root, 'dependency-cache', 'v1'))).toBe(true)
    expect(first.cacheRoot).not.toContain('unsafe-id')
    expect(first.environment.npm_config_foreground_scripts).toBe('true')
    expect(first.environment.npm_config_ignore_scripts).toBeUndefined()
    expect(first.environment.npm_config_store_dir).toBeUndefined()
    const pnpm = dependencyCacheEnvironment(first.cacheRoot, true)
    expect(pnpm.npm_config_store_dir).toBe(pnpm.pnpm_config_store_dir)
    expect(pnpm.npm_config_store_dir).toContain('pnpm-store')
  })

  it('uses the same binary locations for installation and subsequent builds', () => {
    const environment = dependencyCacheEnvironment('/cache')
    for (const name of [
      'XDG_CACHE_HOME',
      'npm_config_cache',
      'YARN_CACHE_FOLDER',
      'PUPPETEER_CACHE_DIR',
      'PLAYWRIGHT_BROWSERS_PATH',
      'electron_config_cache',
      'CYPRESS_CACHE_FOLDER',
    ]) {
      expect(environment[name]?.startsWith(path.join('/cache'))).toBe(true)
    }
  })

  it('shares one deadline across frozen-lockfile fallback instead of restarting the clock', async () => {
    const f = await fixture()
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timeouts: number[] = []
    try {
      await runInstallCommand(
        'pnpm install --frozen-lockfile',
        { cwd: f.root, log: f.log, timeoutMs: 1000 },
        async (input) => {
          timeouts.push(input.timeoutMs!)
          if (timeouts.length === 1) {
            now += 750
            throw new RunnerFailure(
              'COMMAND_FAILED',
              'lockfile mismatch',
              'ERR_PNPM_OUTDATED_LOCKFILE'
            )
          }
          return ''
        }
      )
      expect(timeouts).toEqual([1000, 250])
    } finally {
      await f.close()
    }
  })

  it('does not retry a timed-out install', async () => {
    const f = await fixture()
    const execute = vi.fn(async () => {
      throw new RunnerFailure('INSTALL_TIMEOUT', 'deadline')
    })
    try {
      await expect(
        runInstallCommand('pnpm install --frozen-lockfile', { cwd: f.root, log: f.log }, execute)
      ).rejects.toMatchObject({ code: 'INSTALL_TIMEOUT' })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  })
})

describe('real command deadlines', () => {
  it('terminates a silent process and reports progress and timeout', async () => {
    const f = await fixture()
    try {
      await expect(
        runCommand({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: f.root,
          log: f.log,
          timeoutMs: 150,
          timeoutCode: 'INSTALL_TIMEOUT',
          progressIntervalMs: 30,
        })
      ).rejects.toMatchObject({ code: 'INSTALL_TIMEOUT' })
    } finally {
      const log = await f.close()
      expect(log).toContain('[INSTALL] elapsed=')
      expect(log).toContain('[TIMEOUT]')
    }
  })

  it('does not confuse user cancellation with timeout', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 80)
    try {
      await expect(
        runCommand({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: f.root,
          log: f.log,
          signal: controller.signal,
          timeoutMs: 2000,
        })
      ).rejects.toMatchObject({ code: 'BUILD_CANCELED' })
    } finally {
      clearTimeout(timer)
      await f.close()
    }
  })

  it('cleans up deadline timers on successful exit', async () => {
    const f = await fixture()
    try {
      const result = await runCommand({
        command: process.execPath,
        args: ['-e', 'console.log("ok")'],
        cwd: f.root,
        log: f.log,
        captureStdout: true,
        timeoutMs: 5000,
      })
      expect(result.trim()).toBe('ok')
    } finally {
      expect(await f.close()).not.toContain('[TIMEOUT]')
    }
  })
})
