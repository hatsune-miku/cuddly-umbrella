import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000

export function installTimeoutFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment.CUDDLY_INSTALL_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_INSTALL_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1_000 || value > 2 * 60 * 60 * 1000) {
    throw new Error('CUDDLY_INSTALL_TIMEOUT_MS must be an integer between 1000 and 7200000')
  }
  return value
}

export function dependencyCacheEnvironment(cacheRoot: string, usesPnpm = false): NodeJS.ProcessEnv {
  return {
    XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
    npm_config_cache: path.join(cacheRoot, 'npm'),
    ...(usesPnpm
      ? {
          npm_config_store_dir: path.join(cacheRoot, 'pnpm-store'),
          pnpm_config_store_dir: path.join(cacheRoot, 'pnpm-store'),
        }
      : {}),
    YARN_CACHE_FOLDER: path.join(cacheRoot, 'yarn'),
    PUPPETEER_CACHE_DIR: path.join(cacheRoot, 'puppeteer'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(cacheRoot, 'ms-playwright'),
    electron_config_cache: path.join(cacheRoot, 'electron'),
    CYPRESS_CACHE_FOLDER: path.join(cacheRoot, 'cypress'),
    npm_config_foreground_scripts: 'true',
    npm_config_progress: 'false',
    npm_config_loglevel: 'info',
    npm_config_fetch_timeout: '60000',
    npm_config_fetch_retries: '2',
    npm_config_update_notifier: 'false',
    pnpm_config_update_notifier: 'false',
  }
}

export async function prepareDependencyEnvironment(
  runnerRoot: string,
  project: { id: string; repositoryUrl: string },
  usesPnpm = false
): Promise<{ cacheRoot: string; environment: NodeJS.ProcessEnv }> {
  // Separate repositories and native runtimes; package tools retain their own version keys.
  const scope = createHash('sha256')
    .update(`${project.id}\0${project.repositoryUrl}`)
    .digest('hex')
    .slice(0, 24)
  const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  const libc = process.platform === 'linux' ? header.glibcVersionRuntime || 'musl' : 'native'
  const runtime = `${process.platform}-${process.arch}-abi${process.versions.modules}-${libc}`
  const cacheRoot = path.join(runnerRoot, 'dependency-cache', 'v1', runtime, scope)
  await mkdir(cacheRoot, { recursive: true })
  return {
    cacheRoot,
    environment: {
      ...dependencyCacheEnvironment(cacheRoot, usesPnpm),
      COREPACK_HOME: path.join(runnerRoot, 'dependency-cache', 'toolchains', 'corepack'),
    },
  }
}
