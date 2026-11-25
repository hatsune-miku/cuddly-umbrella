import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createArtifactStore, type FileArtifactStore } from '@cuddly/artifact-store'
import {
  createOnlineH5Manifest,
  createRemoteManifest,
  createStaticManifest,
} from '@cuddly/build-adapters'
import {
  CHINA_NPM_REGISTRY,
  runnerArtifactDeleteSchema,
  runnerJobSchema,
  type RunnerEvent,
  type RunnerJobInput,
  type RunnerStage,
} from '@cuddly/contracts'
import { decryptSetting, gitSshCommand, readOrCreateSecret } from '@cuddly/domain'
import { PRODUCT_NAME } from '@cuddly/product'
import express, { type Request, type Response } from 'express'
import { disableWorkspaceTypeChecking } from './typescript-build'
import { applySentryBuildPolicy } from './sentry-build-policy'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  installTimeoutFromEnvironment,
  prepareDependencyEnvironment,
} from './build-dependencies'

import {
  DEFAULT_REPOSITORY_CACHE_POLICY,
  RepositoryCache,
  RepositoryCacheDiskPressureError,
  RepositoryCacheUnavailableError,
  reserveRepositoryCheckoutCapacity,
  type RepositoryCheckoutInput,
} from './repository-cache'

export class RunnerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly commandOutput: string = ''
  ) {
    super(message)
    this.name = 'RunnerFailure'
  }
}

export interface RunnerOptions {
  internalToken: string
  runnerRoot: string
  artifactStore: FileArtifactStore
  keepWorkspace: boolean
  settingsSecret: string
  repositoryCache?: Pick<RepositoryCache, 'checkout'>
  availableDiskBytes?: (directory: string) => Promise<number>
  readGitSshIdentity?: () => Promise<Buffer>
  installTimeoutMs?: number
}

function authorized(req: Request, token: string): boolean {
  const value = req.headers.authorization
  if (!value?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function writeEvent(res: Response, event: RunnerEvent): void {
  if (res.destroyed || res.writableEnded) return
  res.write(`${JSON.stringify(event)}\n`)
}

export function writeRunnerHeartbeat(
  res: Pick<Response, 'destroyed' | 'writableEnded' | 'write'>
): boolean {
  if (res.destroyed || res.writableEnded) return false
  res.write('\n')
  return true
}

function writeLog(stream: WriteStream, value: string): void {
  stream.write(value.endsWith('\n') ? value : `${value}\n`)
}

interface RunnerCommandInput {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  log: WriteStream
  displayCommand?: string
  captureStdout?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  timeoutCode?: string
  progressIntervalMs?: number
}

type RunnerCommand = (input: RunnerCommandInput) => Promise<string>

const GIT_SSH_IDENTITY_PATH = '/srv/cuddly/secrets/git_id_ed25519'

function cancellationFailure(): RunnerFailure {
  return new RunnerFailure('BUILD_CANCELED', 'Build cancellation was requested')
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationFailure()
}

function awaitWithCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfCanceled(signal)
  return new Promise<T>((resolve, reject) => {
    const canceled = () => {
      cleanup()
      reject(cancellationFailure())
    }
    const cleanup = () => signal.removeEventListener('abort', canceled)
    signal.addEventListener('abort', canceled, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function killCommandProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The process may already have exited between the cancellation check and the signal.
  }
}

export async function runCommand(input: RunnerCommandInput): Promise<string> {
  throwIfCanceled(input.signal)
  writeLog(input.log, `\n$ ${input.displayCommand || `${input.command} ${input.args.join(' ')}`}`)
  return new Promise<string>((resolve, reject) => {
    let stdout = ''
    let outputTail = ''
    let canceled = false
    let timedOut = false
    let settled = false
    let forceKill: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    let progress: NodeJS.Timeout | undefined
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env || process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const cleanup = () => {
      input.signal?.removeEventListener('abort', cancel)
      if (forceKill) clearTimeout(forceKill)
      if (deadline) clearTimeout(deadline)
      if (progress) clearInterval(progress)
    }
    const stoppedFailure = () =>
      timedOut
        ? new RunnerFailure(
            input.timeoutCode || 'COMMAND_TIMEOUT',
            `Command exceeded ${input.timeoutMs} ms; process group terminated`,
            outputTail
          )
        : cancellationFailure()
    const stop = () => {
      killCommandProcess(child, 'SIGTERM')
      forceKill = setTimeout(() => {
        killCommandProcess(child, 'SIGKILL')
        // An escaped descendant may keep stdout open. The deadline must still settle.
        if (settled) return
        settled = true
        child.stdout.destroy()
        child.stderr.destroy()
        cleanup()
        reject(stoppedFailure())
      }, 5_000)
      forceKill.unref()
    }
    const cancel = () => {
      if (canceled || timedOut || settled) return
      canceled = true
      writeLog(input.log, '[CANCELING] Stopping command process group')
      stop()
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    if (input.timeoutMs !== undefined && !canceled) {
      deadline = setTimeout(() => {
        if (settled || canceled) return
        timedOut = true
        writeLog(
          input.log,
          `[TIMEOUT] ${input.timeoutMs} ms deadline reached; stopping command process group`
        )
        stop()
      }, input.timeoutMs)
      deadline.unref()
    }
    if (input.progressIntervalMs) {
      progress = setInterval(() => {
        writeLog(
          input.log,
          `[INSTALL] elapsed=${Math.floor((Date.now() - startedAt) / 1000)}s output-idle=${Math.floor((Date.now() - lastOutputAt) / 1000)}s; waiting for package manager / lifecycle script`
        )
      }, input.progressIntervalMs)
      progress.unref()
    }
    const rememberOutput = (chunk: Buffer) => {
      lastOutputAt = Date.now()
      outputTail = `${outputTail}${chunk.toString('utf8')}`.slice(-64 * 1024)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      input.log.write(chunk)
      rememberOutput(chunk)
      if (input.captureStdout) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      input.log.write(chunk)
      rememberOutput(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (canceled || timedOut) killCommandProcess(child, 'SIGKILL')
      cleanup()
      reject(
        canceled || timedOut
          ? stoppedFailure()
          : new RunnerFailure('COMMAND_START_FAILED', error.message)
      )
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (canceled || timedOut) killCommandProcess(child, 'SIGKILL')
      cleanup()
      if (canceled || timedOut) {
        reject(stoppedFailure())
        return
      }
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new RunnerFailure(
          'COMMAND_FAILED',
          `${input.command} exited with ${code ?? `signal ${signal || 'unknown'}`}`,
          outputTail
        )
      )
    })
  })
}

function unsafeHttpRepositoryUrl(repositoryUrl: string): boolean {
  const trimmed = repositoryUrl.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return (
      Boolean(parsed.username || parsed.password) ||
      /^https?:\/\/[^/?#]*@/i.test(trimmed) ||
      trimmed.includes('?') ||
      trimmed.includes('#')
    )
  } catch {
    return false
  }
}

function repositoryUsesSsh(repositoryUrl: string): boolean {
  const trimmed = repositoryUrl.trim()
  if (/^ssh:\/\//i.test(trimmed)) return true
  return /^[^/@:\s]+@[^/:\s]+:.+/.test(trimmed)
}

async function repositoryCredentialScope(
  repositoryUrl: string,
  authorizationHeader: string | undefined,
  readGitSshIdentity: () => Promise<Buffer>
): Promise<string | null> {
  if (!repositoryUsesSsh(repositoryUrl)) {
    return authorizationHeader ? `http-header:${authorizationHeader}` : 'anonymous'
  }

  try {
    const identity = await readGitSshIdentity()
    return `ssh-key:${createHash('sha256').update(identity).digest('hex')}`
  } catch {
    return null
  }
}

let directCloneTail: Promise<void> = Promise.resolve()

async function withDirectCloneQueue<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = directCloneTail
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  directCloneTail = tail
  try {
    await awaitWithCancellation(
      previous.catch(() => {}),
      signal
    )
    throwIfCanceled(signal)
    return await action()
  } finally {
    release()
    if (directCloneTail === tail) directCloneTail = Promise.resolve()
  }
}

async function filesystemAvailableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

function diskPressureFailure(availableBytes: number): RunnerFailure {
  const pressure = new RepositoryCacheDiskPressureError(availableBytes)
  return new RunnerFailure('RUNNER_DISK_PRESSURE', pressure.message)
}

export async function checkoutRepository(input: {
  job: RunnerJobInput
  options: RunnerOptions
  jobDirectory: string
  sourceDirectory: string
  log: WriteStream
  runCommand?: RunnerCommand
  signal?: AbortSignal
}): Promise<void> {
  const executeCommand = input.runCommand || runCommand
  if (unsafeHttpRepositoryUrl(input.job.project.repositoryUrl)) {
    throw new RunnerFailure(
      'UNSAFE_REPOSITORY_URL',
      'HTTP(S) Git repository URLs must not contain credentials, query parameters, or fragments; configure an encrypted Authorization header instead'
    )
  }
  const authorizationHeader = input.job.project.gitAuthorization
    ? decryptSetting(input.job.project.gitAuthorization, input.options.settingsSecret)
    : undefined
  const gitEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(authorizationHeader
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: authorizationHeader,
        }
      : {}),
    ...projectGitEnvironment(process.env),
  }
  const availableDiskBytes = input.options.availableDiskBytes || filesystemAvailableBytes
  const directClone = () =>
    withDirectCloneQueue(async () => {
      throwIfCanceled(input.signal)
      await executeCommand({
        command: 'git',
        args: ['check-ref-format', '--branch', input.job.branch],
        cwd: input.jobDirectory,
        env: gitEnvironment,
        log: input.log,
        displayCommand: 'git check-ref-format <branch>',
        signal: input.signal,
      })
      let releaseCapacity: () => void
      try {
        releaseCapacity = await reserveRepositoryCheckoutCapacity({
          root: input.options.runnerRoot,
          estimatedBytes:
            DEFAULT_REPOSITORY_CACHE_POLICY.cleanupFreeBytes -
            DEFAULT_REPOSITORY_CACHE_POLICY.rejectFreeBytes,
          rejectFreeBytes: DEFAULT_REPOSITORY_CACHE_POLICY.rejectFreeBytes,
          availableBytes: availableDiskBytes,
        })
      } catch (error) {
        if (error instanceof RepositoryCacheDiskPressureError) {
          throw diskPressureFailure(error.availableBytes)
        }
        throw error
      }
      try {
        await executeCommand({
          command: 'git',
          args: [
            'clone',
            '--depth',
            '1',
            '--single-branch',
            '--branch',
            input.job.branch,
            '--',
            input.job.project.repositoryUrl,
            input.sourceDirectory,
          ],
          cwd: input.jobDirectory,
          env: gitEnvironment,
          log: input.log,
          displayCommand: `git clone --depth 1 --single-branch --branch ${input.job.branch} <repository> ${input.sourceDirectory}`,
          signal: input.signal,
        })
        const afterClone = await availableDiskBytes(input.jobDirectory)
        if (afterClone < DEFAULT_REPOSITORY_CACHE_POLICY.rejectFreeBytes) {
          await rm(input.sourceDirectory, { recursive: true, force: true })
          throw diskPressureFailure(afterClone)
        }
      } finally {
        releaseCapacity()
      }
    }, input.signal)

  if (!input.options.repositoryCache) {
    await directClone()
    return
  }
  const credentialScope = await repositoryCredentialScope(
    input.job.project.repositoryUrl,
    authorizationHeader,
    input.options.readGitSshIdentity || (() => readFile(GIT_SSH_IDENTITY_PATH))
  )
  if (credentialScope === null) {
    writeLog(
      input.log,
      '[WARN] Git cache skipped because the configured SSH identity could not be fingerprinted safely'
    )
    await directClone()
    return
  }

  const checkoutInput: RepositoryCheckoutInput = {
    repositoryUrl: input.job.project.repositoryUrl,
    credentialScope,
    branch: input.job.branch,
    destination: input.sourceDirectory,
    cwd: input.jobDirectory,
    runGit: (request) =>
      executeCommand({
        command: 'git',
        args: request.args,
        cwd: request.cwd,
        env: gitEnvironment,
        log: input.log,
        displayCommand: request.displayCommand,
        captureStdout: request.captureStdout,
        signal: input.signal,
      }),
    log: (message) => writeLog(input.log, message),
    signal: input.signal,
  }

  try {
    await input.options.repositoryCache.checkout(checkoutInput)
  } catch (error) {
    if (input.signal?.aborted) throw cancellationFailure()
    if (error instanceof RepositoryCacheDiskPressureError) {
      throw new RunnerFailure('RUNNER_DISK_PRESSURE', error.message)
    }
    if (!(error instanceof RepositoryCacheUnavailableError)) throw error
    writeLog(
      input.log,
      `[WARN] Git cache unavailable (${error instanceof Error ? error.message : String(error)}); retrying the original shallow clone`
    )
    await rm(input.sourceDirectory, { recursive: true, force: true })
    await directClone()
  }
}

function shellCommand(command: string): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-lc', command] }
}

const OUTDATED_PNPM_LOCKFILE =
  /ERR_PNPM_(?:OUTDATED_LOCKFILE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE)/

export function pnpmOutdatedLockfileFallbackCommand(
  installCommand: string,
  error: unknown
): string | null {
  if (!commandUsesPnpm(installCommand) || !installCommand.includes('--frozen-lockfile')) return null
  if (!(error instanceof RunnerFailure) || error.code !== 'COMMAND_FAILED') return null
  if (!OUTDATED_PNPM_LOCKFILE.test(error.commandOutput)) return null
  return installCommand.replace(/--frozen-lockfile(?=$|[\s;&|)])/g, '--no-frozen-lockfile')
}

export async function runInstallCommand(
  installCommand: string,
  input: Omit<RunnerCommandInput, 'command' | 'args' | 'displayCommand'>,
  executeCommand: RunnerCommand = runCommand
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const deadlineAt = Date.now() + timeoutMs
  const execute = async (command: string) => {
    throwIfCanceled(input.signal)
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0)
      throw new RunnerFailure('INSTALL_TIMEOUT', `Dependency installation exceeded ${timeoutMs} ms`)
    await executeCommand({
      ...shellCommand(command),
      ...input,
      timeoutMs: remaining,
      timeoutCode: 'INSTALL_TIMEOUT',
      progressIntervalMs: input.progressIntervalMs ?? 30_000,
      displayCommand: command,
    })
  }
  writeLog(
    input.log,
    `[INSTALL] deadline=${timeoutMs}ms; lifecycle output enabled; lockfile fallback shares this deadline`
  )
  try {
    await execute(installCommand)
  } catch (error) {
    const fallbackCommand = pnpmOutdatedLockfileFallbackCommand(installCommand, error)
    if (!fallbackCommand) throw error
    writeLog(
      input.log,
      '[WARN] pnpm-lock.yaml is out of date on this branch; retrying once with --no-frozen-lockfile in the disposable build workspace'
    )
    await execute(fallbackCommand)
  }
}

export function packageManagerEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  useChinaRegistry: boolean,
  allowPnpmDependencyBuilds = false
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment }
  delete environment.npm_config_registry
  delete environment.NPM_CONFIG_REGISTRY
  delete environment.COREPACK_NPM_REGISTRY
  delete environment.npm_config_dangerously_allow_all_builds
  delete environment.pnpm_config_dangerously_allow_all_builds
  if (useChinaRegistry) {
    environment.npm_config_registry = CHINA_NPM_REGISTRY
    environment.COREPACK_NPM_REGISTRY = CHINA_NPM_REGISTRY
  }
  if (allowPnpmDependencyBuilds) {
    // pnpm 10 reads the npm-prefixed key; pnpm 11 reads the pnpm-prefixed key.
    environment.npm_config_dangerously_allow_all_builds = 'true'
    environment.pnpm_config_dangerously_allow_all_builds = 'true'
  }
  return environment
}

export function projectInstallEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  useChinaRegistry: boolean,
  allowPnpmDependencyBuilds = false
): NodeJS.ProcessEnv {
  const environment = packageManagerEnvironment(
    baseEnvironment,
    useChinaRegistry,
    allowPnpmDependencyBuilds
  )
  delete environment.npm_config_omit
  delete environment.NPM_CONFIG_OMIT
  delete environment.npm_config_production
  delete environment.NPM_CONFIG_PRODUCTION
  delete environment.npm_config_only
  delete environment.NPM_CONFIG_ONLY
  return {
    ...environment,
    NODE_ENV: 'development',
    HUSKY: '0',
  }
}

/**
 * Project-owned package manifests may reference private Git dependencies. Reuse the
 * Runner's mounted identity and proxy-aware SSH command for install and build steps,
 * while keeping Git non-interactive in unattended jobs.
 */
export function projectGitEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: gitSshCommand(baseEnvironment),
  }
}

/**
 * Stable inputs inherited by project commands. An explicit assignment inside the configured
 * shell command still wins, so existing project-owned command semantics are preserved.
 */
export function projectEnvironmentVariables(
  job: Pick<RunnerJobInput, 'environmentId' | 'environmentSlug' | 'project'>
): NodeJS.ProcessEnv {
  return {
    CUDDLY_ENVIRONMENT_SLUG: job.environmentSlug,
    CUDDLY_BACKEND_ORIGIN: job.project.environment.backendOrigin,
  }
}

export function runnerEnvironmentMatchesSnapshot(
  job: Pick<RunnerJobInput, 'environmentId' | 'environmentSlug' | 'project'>
): boolean {
  return (
    job.environmentId === job.project.environment.id &&
    job.environmentSlug === job.project.environment.slug
  )
}

export function commandUsesPnpm(command: string): boolean {
  return /(?:^|[;&|()]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:corepack\s+)?pnpm(?:@[\w.-]+)?(?=$|\s|[;&|()])/i.test(
    command
  )
}

export function packageManagerLockfileWarning(
  installCommand: string,
  lockfiles: { packageLock: boolean; pnpmLock: boolean }
): string | null {
  if (commandUsesPnpm(installCommand) && lockfiles.packageLock && !lockfiles.pnpmLock) {
    return "Install command uses pnpm, but the repository only contains package-lock.json; dependency resolution may differ from the project's intended npm workflow"
  }
  const usesNpm =
    /(?:^|[;&|()]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:corepack\s+)?npm(?:@[\w.-]+)?(?=$|\s|[;&|()])/i.test(
      installCommand
    )
  if (usesNpm && lockfiles.pnpmLock && !lockfiles.packageLock) {
    return "Install command uses npm, but the repository only contains pnpm-lock.yaml; dependency resolution may differ from the project's intended pnpm workflow"
  }
  return null
}

async function warnPackageManagerLockfileMismatch(
  projectDirectory: string,
  installCommand: string,
  log: WriteStream
): Promise<void> {
  const [packageLock = false, pnpmLock = false] = await Promise.all(
    ['package-lock.json', 'pnpm-lock.yaml'].map((filename) =>
      access(path.join(projectDirectory, filename)).then(
        () => true,
        () => false
      )
    )
  )
  const warning = packageManagerLockfileWarning(installCommand, { packageLock, pnpmLock })
  if (warning) writeLog(log, `[WARN] ${warning}`)
}

export function remoteProviderName(targetId: string, artifactId: string): string {
  const target = targetId.replace(/[^A-Za-z0-9_]/g, '_')
  return `${target}_${artifactId.replaceAll('-', '').slice(0, 12)}`
}

export function remoteArtifactPublicBase(artifactId: string, providerName: string): string {
  return `/__cuddly/preview-artifacts/${artifactId}/${providerName}/`
}

// Remote Artifacts can be loaded either from a Bifrost preview origin or cross-origin from an
// official KOOK page. A root-relative publicPath would resolve dynamic chunks against the host
// document (for example www.kookapp.cn), not against remoteEntry.js. Rspack's `auto` mode derives
// the chunk base from the entry script URL and therefore keeps one immutable Artifact portable
// across both serving modes.
export function remoteBuildPublicPath(): 'auto' {
  return 'auto'
}

export function remoteBuildEnvironment(job: Pick<RunnerJobInput, 'targetId' | 'artifactId'>) {
  const providerName = remoteProviderName(job.targetId, job.artifactId)
  return {
    VERSION: providerName,
    npm_config_VERSION: providerName,
    CUDDLY_DISABLE_SENTRY_UPLOAD: '1',
    CUDDLY_ASSET_PREFIX: remoteBuildPublicPath(),
    // New KOOK configs also call the helper for the release manifest and cache key.
    // Those need a real, artifact-specific path, not Rspack's special `auto` value.
    // Keep it origin-relative so one artifact works on every Bifrost preview origin.
    REMOTE_ASSET_PUBLIC_PATH: remoteArtifactPublicBase(job.artifactId, providerName),
  }
}

export function buildPublicPath(
  job: Pick<RunnerJobInput, 'artifactId' | 'project'>,
  remotePublicBase: string
): string | undefined {
  if (job.project.siteAdapter === 'kook-remote-v1') return remotePublicBase
  if (job.project.kind === 'webapp' || (!job.project.kind && job.project.id === 'webapp')) {
    return `/__cuddly/artifacts/${job.artifactId}/app/`
  }
  return undefined
}

async function closeLog(log: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    log.on('error', reject)
    log.end(resolve)
  })
}

export function patchOnlineH5AssetPrefixSource(source: string): string {
  let patched = source
  for (const [key, required] of [
    ['test', true],
    ['online', true],
    ['dev', false],
  ] as const) {
    const propertyPattern = new RegExp(`(^\\s*(?:${key}|["']${key}["'])\\s*:\\s*)`, 'm')
    const match = propertyPattern.exec(patched)
    if (!match) {
      if (!required) continue
      throw new RunnerFailure(
        'ONLINE_H5_ASSET_PREFIX_UNSUPPORTED',
        `Online H5 CDN config does not expose the expected ${key} property`
      )
    }
    const valueStart = match.index + match[0].length
    if (/^process\.env\.CUDDLY_ASSET_PREFIX\s*\|\|/.test(patched.slice(valueStart))) continue
    patched = patched.replace(propertyPattern, '$1process.env.CUDDLY_ASSET_PREFIX || ')
  }
  return patched
}

const ONLINE_H5_ASSET_PREFIX_CONFIG_CANDIDATES = [
  path.join('rsbuild-config', 'cdnPath.js'),
  path.join('config', 'cdnPath.js'),
] as const

export async function resolveOnlineH5AssetPrefixConfigPath(
  sourceDirectory: string
): Promise<string> {
  for (const relativePath of ONLINE_H5_ASSET_PREFIX_CONFIG_CANDIDATES) {
    const targetPath = path.join(sourceDirectory, relativePath)
    try {
      await access(targetPath)
      return targetPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new RunnerFailure(
        'ONLINE_H5_ASSET_PREFIX_CONFIG_MISSING',
        `Online H5 CDN config is unavailable: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  throw new RunnerFailure(
    'ONLINE_H5_ASSET_PREFIX_CONFIG_MISSING',
    `Online H5 CDN config is unavailable; tried ${ONLINE_H5_ASSET_PREFIX_CONFIG_CANDIDATES.join(', ')}`
  )
}

async function applyAssetPrefixPatch(sourceDirectory: string, log: WriteStream) {
  const targetPath = await resolveOnlineH5AssetPrefixConfigPath(sourceDirectory)
  let current: string
  try {
    current = await readFile(targetPath, 'utf8')
  } catch (error) {
    throw new RunnerFailure(
      'ONLINE_H5_ASSET_PREFIX_CONFIG_MISSING',
      `Online H5 CDN config is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const patched = patchOnlineH5AssetPrefixSource(current)
  if (patched === current) {
    writeLog(log, 'CUDDLY_ASSET_PREFIX support is already present; patch skipped')
    return
  }
  await writeFile(targetPath, patched, 'utf8')
  writeLog(
    log,
    `Applied CUDDLY_ASSET_PREFIX support to ${path.relative(sourceDirectory, targetPath)}`
  )
}

export function patchRemoteAssetPrefixSource(source: string): string {
  // Only override output.publicPath. The helper's other callers (release manifest and
  // persistent cache) must retain their real path from REMOTE_ASSET_PUBLIC_PATH.
  const pattern =
    /(^[\t ]*const\s+publicPath\s*=\s*)(process\.env\.CUDDLY_ASSET_PREFIX\s*\|\|\s*)?(`\$\{process\.env\.PUB_PATH\}\$\{(?:templateName|remoteName)\}\/`|get_remote_asset_public_path\(\s*\))(?=[\t ]*(?:;?[\t ]*(?:\/\/[^\r\n]*)?(?:\r?\n|$)))/m
  if (!pattern.test(source)) {
    throw new RunnerFailure(
      'REMOTE_ASSET_PREFIX_UNSUPPORTED',
      'Remote build config must declare publicPath using PUB_PATH with templateName/remoteName or get_remote_asset_public_path()'
    )
  }
  return source.replace(pattern, (match, declaration, override, expression) =>
    override ? match : `${declaration}process.env.CUDDLY_ASSET_PREFIX || ${expression}`
  )
}

export function patchRemoteProviderVersionSource(source: string): string {
  const versionAwareDeclaration =
    /^\s*(?:const|let)\s+(?:templateName|remoteName)\s*=\s*(?:process\.env\.(?:VERSION|npm_config_VERSION|npm_config_version)\b|resolve_build_remote_version\s*\()/m
  if (versionAwareDeclaration.test(source)) return source

  const declaration = /^(\s*(?:const|let)\s+(?:templateName|remoteName)\s*=\s*)([^\r\n]+)$/m
  if (!declaration.test(source)) {
    throw new RunnerFailure(
      'REMOTE_PROVIDER_VERSION_UNSUPPORTED',
      'Remote build config does not expose a supported templateName or remoteName declaration'
    )
  }
  return source.replace(declaration, '$1process.env.VERSION || $2')
}

export function patchKookLogicModelsSelfImportSource(source: string): string {
  return source.replaceAll(
    '@/models/ReactiveData/ProxyReactiveData',
    '../../ReactiveData/ProxyReactiveData'
  )
}

async function applyKookLogicModelsSelfImportPatch(sourceDirectory: string, log: WriteStream) {
  const targetPath = path.join(
    sourceDirectory,
    'packages',
    'logicModels',
    'src',
    'models',
    'virturalScroll',
    'core',
    'listCoreReactive.ts'
  )
  let current: string
  try {
    current = await readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new RunnerFailure(
      'REMOTE_LOGIC_MODELS_SOURCE_UNAVAILABLE',
      `KOOK logicModels source is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const patched = patchKookLogicModelsSelfImportSource(current)
  if (patched === current) return
  await writeFile(targetPath, patched, 'utf8')
  writeLog(
    log,
    `Resolved KOOK logicModels self-import in ${path.relative(sourceDirectory, targetPath)}`
  )
}

export function patchStandaloneRemoteConfigSource(source: string): string {
  // Standalone Remotes use the shared version resolver directly, rather than get_config.js.
  if (!/^[\t ]*const\s+version\s*=\s*resolve_build_remote_version\s*\(/m.test(source)) {
    throw new RunnerFailure(
      'REMOTE_PROVIDER_VERSION_UNSUPPORTED',
      'Standalone Remote config must use resolve_build_remote_version for its version'
    )
  }
  // Override only output.publicPath; release metadata must keep the concrete artifact path.
  const outputPath =
    /(^[\t ]*output\s*:\s*\{[^{}]*?\r?\n)([\t ]*)publicPath(\s*:\s*process\.env\.CUDDLY_ASSET_PREFIX\s*\|\|\s*publicPath)?[\t ]*,/m
  if (!outputPath.test(source)) {
    throw new RunnerFailure(
      'REMOTE_ASSET_PREFIX_UNSUPPORTED',
      'Standalone Remote config must expose output.publicPath as a shorthand property'
    )
  }
  return source.replace(outputPath, (match, before, indent, override) =>
    override
      ? match
      : `${before}${indent}publicPath: process.env.CUDDLY_ASSET_PREFIX || publicPath,`
  )
}

export async function applyRemoteBuildPatches(outputDirectory: string, log: WriteStream) {
  const projectDirectory = path.dirname(outputDirectory)
  const configPath = path.join(projectDirectory, 'scripts', 'get_config.js')
  let current: string
  try {
    current = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const standalonePath = path.join(projectDirectory, 'rspack.config.ts')
      let standalone: string
      try {
        standalone = await readFile(standalonePath, 'utf8')
      } catch (standaloneError) {
        throw new RunnerFailure(
          'REMOTE_ASSET_PREFIX_CONFIG_MISSING',
          `Remote build config is unavailable; tried scripts/get_config.js and rspack.config.ts: ${standaloneError instanceof Error ? standaloneError.message : String(standaloneError)}`
        )
      }
      const patched = patchStandaloneRemoteConfigSource(standalone)
      if (patched !== standalone) await writeFile(standalonePath, patched, 'utf8')
      writeLog(log, 'Applied standalone Remote build support to rspack.config.ts')
      return
    }
    throw new RunnerFailure(
      'REMOTE_ASSET_PREFIX_CONFIG_MISSING',
      `Remote build config is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const patched = patchRemoteAssetPrefixSource(patchRemoteProviderVersionSource(current))
  if (patched === current) {
    writeLog(log, 'CUDDLY_ASSET_PREFIX support is already present; Remote patch skipped')
  } else {
    await writeFile(configPath, patched, 'utf8')
    writeLog(
      log,
      `Applied CUDDLY_ASSET_PREFIX support to ${path.relative(projectDirectory, configPath)}`
    )
  }
}

async function executeBuild(
  job: RunnerJobInput,
  options: RunnerOptions,
  res: Response,
  cancellationSignal: AbortSignal
): Promise<void> {
  if (!runnerEnvironmentMatchesSnapshot(job)) {
    throw new RunnerFailure(
      'RUNNER_ENVIRONMENT_MISMATCH',
      'Runner job environment does not match its project configuration snapshot'
    )
  }
  const jobDirectory = path.join(options.runnerRoot, 'runner-jobs', job.jobId)
  const sourceDirectory = path.join(jobDirectory, 'source')
  const outputDirectory = path.resolve(sourceDirectory, job.project.outputDirectory)
  const relativeOutput = path.relative(sourceDirectory, outputDirectory)
  if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new RunnerFailure(
      'INVALID_OUTPUT_DIRECTORY',
      'Output directory must stay inside the repository'
    )
  }
  const logDirectory = path.join(options.runnerRoot, 'logs')
  const logPath = path.join(logDirectory, `${job.jobId}.log`)
  let publishedStorageKey: string | null = null

  await mkdir(logDirectory, { recursive: true })
  await rm(jobDirectory, { recursive: true, force: true })
  await mkdir(jobDirectory, { recursive: true })
  const log = createWriteStream(logPath, { flags: 'a' })
  writeLog(log, 'POWERED BY 打包嘟嘟')
  writeLog(log, `Environment: ${job.environmentSlug}`)
  writeLog(log, `Backend origin: ${job.project.environment.backendOrigin}`)

  const stage = (value: RunnerStage) => {
    throwIfCanceled(cancellationSignal)
    const at = new Date().toISOString()
    writeLog(log, `\n[${at}] ${value}`)
    writeEvent(res, { type: 'stage', stage: value, at })
  }

  try {
    throwIfCanceled(cancellationSignal)
    stage('CHECKOUT')
    await checkoutRepository({
      job,
      options,
      jobDirectory,
      sourceDirectory,
      log,
      signal: cancellationSignal,
    })
    throwIfCanceled(cancellationSignal)
    const uncheckedConfigs = await disableWorkspaceTypeChecking(sourceDirectory)
    writeLog(
      log,
      `TypeScript type checking: disabled across workspace (${uncheckedConfigs} tsconfig files; noCheck). Parse, emit and bundler failures remain fatal.`
    )
    await warnPackageManagerLockfileMismatch(sourceDirectory, job.project.installCommand, log)
    if (job.project.siteAdapter === 'kook-online-h5-v1') {
      await applyAssetPrefixPatch(sourceDirectory, log)
    } else if (job.project.siteAdapter === 'kook-remote-v1') {
      await applyRemoteBuildPatches(outputDirectory, log)
      if (job.project.buildCommand.includes('packages/logicModels')) {
        await applyKookLogicModelsSelfImportPatch(sourceDirectory, log)
      }
    }
    throwIfCanceled(cancellationSignal)

    stage('INSTALLING')
    const useChinaRegistry = job.project.useChinaRegistry !== false
    const allowPnpmDependencyBuilds = commandUsesPnpm(job.project.installCommand)
    const dependencies = await prepareDependencyEnvironment(
      options.runnerRoot,
      job.project,
      allowPnpmDependencyBuilds || commandUsesPnpm(job.project.buildCommand)
    )
    const installEnvironment = projectInstallEnvironment(
      { ...process.env, ...dependencies.environment },
      useChinaRegistry,
      allowPnpmDependencyBuilds
    )
    Object.assign(installEnvironment, projectGitEnvironment(installEnvironment))
    Object.assign(installEnvironment, projectEnvironmentVariables(job))
    writeLog(log, `Dependency cache: ${dependencies.cacheRoot}`)
    writeLog(
      log,
      useChinaRegistry
        ? `Package registry: ${CHINA_NPM_REGISTRY}`
        : 'Package registry: project or package-manager default'
    )
    if (allowPnpmDependencyBuilds) {
      writeLog(log, 'pnpm dependency build scripts: enabled for trusted project build')
    }
    await runInstallCommand(job.project.installCommand, {
      cwd: sourceDirectory,
      env: installEnvironment,
      log,
      signal: cancellationSignal,
      timeoutMs: options.installTimeoutMs,
    })

    throwIfCanceled(cancellationSignal)
    const sentryPolicy = await applySentryBuildPolicy(sourceDirectory)
    writeLog(
      log,
      `Sentry build policy: disabled ${sentryPolicy.references} plugin imports in ${sentryPolicy.files} files (${sentryPolicy.packages.join(', ') || 'none'}). Runtime SDKs and sourcemap generation unchanged.`
    )
    throwIfCanceled(cancellationSignal)
    stage('BUILDING')
    const build = shellCommand(job.project.buildCommand)
    const artifactPublicBase = `/__cuddly/preview-artifacts/${job.artifactId}/`
    const providerName = remoteProviderName(job.targetId, job.artifactId)
    const remotePublicBase = remoteArtifactPublicBase(job.artifactId, providerName)
    const publicPath = buildPublicPath(job, artifactPublicBase)
    await runCommand({
      ...build,
      cwd: sourceDirectory,
      env: {
        ...packageManagerEnvironment(
          { ...process.env, ...dependencies.environment },
          useChinaRegistry
        ),
        ...projectGitEnvironment(process.env),
        ...projectEnvironmentVariables(job),
        NODE_ENV: 'production',
        PUB_PATH: publicPath,
        ...(job.project.siteAdapter === 'kook-remote-v1'
          ? remoteBuildEnvironment(job)
          : {
              VERSION: undefined,
              npm_config_VERSION: undefined,
              CUDDLY_DISABLE_SENTRY_UPLOAD: undefined,
              CUDDLY_ASSET_PREFIX: publicPath || `/__cuddly/artifacts/${job.artifactId}/`,
            }),
      },
      log,
      displayCommand: job.project.buildCommand,
      signal: cancellationSignal,
    })

    throwIfCanceled(cancellationSignal)
    stage('VALIDATING')
    const builtAt = new Date().toISOString()
    const manifest =
      job.project.siteAdapter === 'kook-online-h5-v1'
        ? await createOnlineH5Manifest({
            outputDirectory,
            artifactId: job.artifactId,
            targetId: job.targetId,
            branch: job.branch,
            builtAt,
          })
        : job.project.siteAdapter === 'kook-remote-v1'
          ? await createRemoteManifest({
              outputDirectory,
              artifactId: job.artifactId,
              targetId: job.targetId,
              branch: job.branch,
              builtAt,
              publicBase: remotePublicBase,
              siteAdapter: job.project.siteAdapter,
              moduleKey: job.targetId,
              providerName,
            })
          : await createStaticManifest({
              outputDirectory,
              artifactId: job.artifactId,
              targetId: job.targetId,
              branch: job.branch,
              builtAt,
              siteAdapter: job.project.siteAdapter,
              publicBase: publicPath,
            })

    throwIfCanceled(cancellationSignal)
    stage('UPLOADING')
    const storageKey = await options.artifactStore.publishDirectory({
      sourceDirectory: outputDirectory,
      targetId: job.targetId,
      artifactId: job.artifactId,
      manifest,
    })
    publishedStorageKey = storageKey
    throwIfCanceled(cancellationSignal)
    writeLog(log, '打包完成~')
    writeEvent(res, {
      type: 'result',
      artifactId: job.artifactId,
      storageKey,
      manifest,
      builtAt,
      logPath,
    })
  } catch (error) {
    const failure =
      error instanceof RunnerFailure ? error : new RunnerFailure('RUNNER_FAILED', String(error))
    if (failure.code === 'BUILD_CANCELED' && publishedStorageKey) {
      await options.artifactStore
        .deleteArtifactDirectory({ artifactId: job.artifactId, storageKey: publishedStorageKey })
        .catch((cleanupError) =>
          writeLog(
            log,
            `[WARN] Canceled Artifact cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          )
        )
    }
    writeLog(log, `\n[FAILED] ${failure.stack || failure.message}`)
    writeEvent(res, {
      type: 'error',
      code: failure.code,
      message: failure.message,
      logPath,
    })
  } finally {
    await closeLog(log)
    if (!options.keepWorkspace) await rm(jobDirectory, { recursive: true, force: true })
  }
}

export type RunnerExecutor = (
  job: RunnerJobInput,
  options: RunnerOptions,
  res: Response,
  cancellationSignal: AbortSignal
) => Promise<void>

export function createRunnerApp(options: RunnerOptions, runBuild: RunnerExecutor = executeBuild) {
  const app = express()
  const activeTargets = new Map<string, string>()
  const activeJobs = new Map<string, AbortController>()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))

  app.get('/health/live', (_req, res) => res.json({ ok: true }))
  app.get('/health/ready', async (_req, res) => {
    await options.artifactStore.initialize()
    res.json({
      ok: true,
      busy: activeTargets.size > 0,
      activeCount: activeTargets.size,
      activeTargets: [...activeTargets.keys()],
    })
  })

  app.get('/internal/artifacts/inventory', async (req, res) => {
    if (!authorized(req, options.internalToken)) {
      res.status(401).json({ code: 'UNAUTHENTICATED' })
      return
    }
    res.json({ artifacts: await options.artifactStore.listArtifactInventory() })
  })

  app.post('/internal/artifacts/delete', async (req, res) => {
    if (!authorized(req, options.internalToken)) {
      res.status(401).json({ code: 'UNAUTHENTICATED' })
      return
    }
    const parsed = runnerArtifactDeleteSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    await options.artifactStore.deleteArtifactDirectory(parsed.data)
    res.status(204).end()
  })

  app.post('/internal/runs/:jobId/cancel', (req, res) => {
    if (!authorized(req, options.internalToken)) {
      res.status(401).json({ code: 'UNAUTHENTICATED' })
      return
    }
    const cancellation = activeJobs.get(req.params.jobId)
    if (!cancellation) {
      res.status(404).json({ code: 'RUNNER_JOB_NOT_FOUND' })
      return
    }
    cancellation.abort(cancellationFailure())
    res.status(202).json({ jobId: req.params.jobId, status: 'CANCELING' })
  })

  app.post('/internal/run', async (req, res) => {
    if (!authorized(req, options.internalToken)) {
      res.status(401).json({ code: 'UNAUTHENTICATED' })
      return
    }
    const parsed = runnerJobSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      return
    }
    if (!runnerEnvironmentMatchesSnapshot(parsed.data)) {
      res.status(400).json({ code: 'RUNNER_ENVIRONMENT_MISMATCH' })
      return
    }
    const activeJobId = activeTargets.get(parsed.data.targetId)
    if (activeJobId) {
      res.status(409).json({
        code: 'RUNNER_TARGET_BUSY',
        targetId: parsed.data.targetId,
        activeJobId,
      })
      return
    }

    const cancellation = new AbortController()
    activeTargets.set(parsed.data.targetId, parsed.data.jobId)
    activeJobs.set(parsed.data.jobId, cancellation)
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.flushHeaders()
    const heartbeat = setInterval(() => writeRunnerHeartbeat(res), 15_000)
    heartbeat.unref()
    const cancelOnDisconnect = () => {
      if (!res.writableEnded) cancellation.abort(cancellationFailure())
    }
    res.once('close', cancelOnDisconnect)
    try {
      await runBuild(parsed.data, options, res, cancellation.signal)
    } finally {
      clearInterval(heartbeat)
      res.off('close', cancelOnDisconnect)
      activeTargets.delete(parsed.data.targetId)
      activeJobs.delete(parsed.data.jobId)
      res.end()
    }
  })

  return app
}

export async function createRunnerOptions(): Promise<RunnerOptions> {
  const runnerRoot = process.env.NODE_ENV === 'production' ? '/srv/cuddly' : path.resolve('data')
  const settingsSecret = await readOrCreateSecret(
    process.env.NODE_ENV === 'production'
      ? '/srv/cuddly/secrets/settings.key'
      : path.resolve('data/secrets/settings.key')
  )
  return {
    internalToken: 'cuddly-internal-runner-v1',
    runnerRoot,
    artifactStore: createArtifactStore(),
    keepWorkspace: false,
    installTimeoutMs: installTimeoutFromEnvironment(process.env),
    settingsSecret,
    repositoryCache: new RepositoryCache({
      root: path.join(runnerRoot, 'git-cache', 'v1'),
      secret: settingsSecret,
    }),
  }
}
