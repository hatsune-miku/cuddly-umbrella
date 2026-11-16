import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  utimes,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const GIB = 1024 ** 3
const CACHE_DIRECTORY_PATTERN = /^[a-f0-9]{64}\.git$/
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const REPOSITORY_TEMPORARY_PATTERN = new RegExp(
  `^([a-f0-9]{64})\\.git\\.(init|corrupt)-${UUID_PATTERN}$`
)
const LOCK_TEMPORARY_PATTERN = new RegExp(`^([a-f0-9]{64})\\.lock\\.stale-${UUID_PATTERN}$`)
const METADATA_TEMPORARY_PATTERN = new RegExp(
  `^([a-f0-9]{64})\\.json\\.(tmp|previous)-${UUID_PATTERN}$`
)
const TEMPORARY_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CheckoutCapacityState {
  reservedBytes: number
  tail: Promise<void>
}

const checkoutCapacityByRoot = new Map<string, CheckoutCapacityState>()

export const DEFAULT_REPOSITORY_CACHE_POLICY = {
  maxBytes: GIB,
  cleanupFreeBytes: 4 * GIB,
  rejectFreeBytes: 2 * GIB,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  lockTimeoutMs: 2 * 60 * 1000,
  staleLockMs: 60 * 1000,
  lockHeartbeatMs: 5 * 1000,
}

export interface RepositoryCachePolicy {
  maxBytes: number
  cleanupFreeBytes: number
  rejectFreeBytes: number
  maxAgeMs: number
  lockTimeoutMs: number
  staleLockMs: number
  lockHeartbeatMs: number
}

export interface GitCommandRequest {
  args: string[]
  cwd: string
  displayCommand: string
  captureStdout?: boolean
}

export type GitCommandRunner = (request: GitCommandRequest) => Promise<string>

export interface RepositoryCheckoutInput {
  repositoryUrl: string
  credentialScope: string
  branch: string
  destination: string
  cwd: string
  runGit: GitCommandRunner
  log: (message: string) => void
  signal?: AbortSignal
}

export interface RepositoryCheckoutResult {
  cacheHit: boolean
  cacheKey: string
  commit: string
}

interface CacheEntry {
  key: string
  directory: string
  sizeBytes: number
  lastUsedAt: number
}

interface CacheMetadata {
  lastUsedAt: number
  sizeBytes: number
}

export class RepositoryCacheUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryCacheUnavailableError'
  }
}

export class RepositoryCacheDiskPressureError extends Error {
  constructor(readonly availableBytes: number) {
    super(`Runner disk has only ${Math.max(0, Math.floor(availableBytes / 1024 ** 2))} MiB free`)
    this.name = 'RepositoryCacheDiskPressureError'
  }
}

export function repositoryCacheKey(
  repositoryUrl: string,
  credentialScope: string,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update('cuddly-repository-cache-v1\0')
    .update(repositoryUrl.trim())
    .update('\0')
    .update(credentialScope)
    .digest('hex')
}

export function repositoryBranchRef(branch: string): {
  branchName: string
  fullRef: string
} {
  const digest = createHash('sha256').update(branch).digest('hex')
  const branchName = `cuddly-cache/${digest}`
  return { branchName, fullRef: `refs/heads/${branchName}` }
}

export function repositoryUrlForWorkspace(repositoryUrl: string): string {
  const trimmed = repositoryUrl.trim()
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return trimmed
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return trimmed
  }
}

export function selectRepositoryCacheEvictions(input: {
  entries: CacheEntry[]
  maxBytes: number
  cleanupFreeBytes: number
  freeBytes: number
  maxAgeMs: number
  now: number
  protectedKeys?: ReadonlySet<string>
}): CacheEntry[] {
  const protectedKeys = input.protectedKeys || new Set<string>()
  const candidates = input.entries
    .filter((entry) => !protectedKeys.has(entry.key))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key))
  let totalBytes = input.entries.reduce((total, entry) => total + entry.sizeBytes, 0)
  let freeBytes = input.freeBytes
  const evictions: CacheEntry[] = []

  for (const entry of candidates) {
    const expired = input.now - entry.lastUsedAt > input.maxAgeMs
    if (!expired && totalBytes <= input.maxBytes && freeBytes >= input.cleanupFreeBytes) break
    evictions.push(entry)
    totalBytes -= entry.sizeBytes
    freeBytes += entry.sizeBytes
  }
  return evictions
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : undefined
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directorySize(entryPath)
    else if (entry.isFile()) total += (await lstat(entryPath)).size
  }
  return total
}

async function availableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

export async function reserveRepositoryCheckoutCapacity(input: {
  root: string
  estimatedBytes: number
  rejectFreeBytes: number
  availableBytes?: (directory: string) => Promise<number>
}): Promise<() => void> {
  const root = path.resolve(input.root)
  let existingState = checkoutCapacityByRoot.get(root)
  if (!existingState) {
    existingState = { reservedBytes: 0, tail: Promise.resolve() }
    checkoutCapacityByRoot.set(root, existingState)
  }
  const state = existingState

  const previous = state.tail
  let releaseCapacityLock!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseCapacityLock = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  state.tail = tail
  await previous.catch(() => {})

  try {
    const freeBytes = await (input.availableBytes || availableBytes)(root)
    const projectedFreeBytes = freeBytes - state.reservedBytes - input.estimatedBytes
    if (projectedFreeBytes < input.rejectFreeBytes) {
      throw new RepositoryCacheDiskPressureError(Math.max(0, projectedFreeBytes))
    }
    state.reservedBytes += input.estimatedBytes
    let released = false
    return () => {
      if (released) return
      released = true
      state.reservedBytes = Math.max(0, state.reservedBytes - input.estimatedBytes)
    }
  } finally {
    releaseCapacityLock()
    if (state.tail === tail) state.tail = Promise.resolve()
  }
}

function destinationStaysInsideCwd(cwd: string, destination: string): boolean {
  const relative = path.relative(path.resolve(cwd), path.resolve(destination))
  return (
    Boolean(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function gitObjectSize(output: string): number | null {
  const values = new Map<string, number>()
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(': ')
    if (separator === -1) continue
    const value = Number(line.slice(separator + 2))
    if (Number.isFinite(value) && value >= 0) values.set(line.slice(0, separator), value)
  }
  const looseKiB = values.get('size')
  const packedKiB = values.get('size-pack')
  const garbageKiB = values.get('size-garbage') || 0
  if (looseKiB === undefined || packedKiB === undefined) return null
  return (looseKiB + packedKiB + garbageKiB) * 1024
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation was canceled')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
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

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds))
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const aborted = () => {
      clearTimeout(timeout)
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export class RepositoryCache {
  private readonly root: string
  private readonly repositoriesRoot: string
  private readonly locksRoot: string
  private readonly metadataRoot: string
  private readonly secret: string
  private readonly policy: RepositoryCachePolicy
  private readonly processLocks = new Map<string, Promise<void>>()
  private temporaryCleanup: Promise<void> | null = null

  constructor(options: { root: string; secret: string; policy?: Partial<RepositoryCachePolicy> }) {
    this.root = path.resolve(options.root)
    this.repositoriesRoot = path.join(this.root, 'repositories')
    this.locksRoot = path.join(this.root, 'locks')
    this.metadataRoot = path.join(this.root, 'metadata')
    this.secret = options.secret
    this.policy = { ...DEFAULT_REPOSITORY_CACHE_POLICY, ...options.policy }
    if (!this.secret) throw new TypeError('Repository cache secret must not be empty')
    if (
      this.policy.maxBytes < 0 ||
      this.policy.cleanupFreeBytes < 0 ||
      this.policy.rejectFreeBytes < 0 ||
      this.policy.rejectFreeBytes > this.policy.cleanupFreeBytes ||
      this.policy.maxAgeMs < 0 ||
      this.policy.lockTimeoutMs <= 0 ||
      this.policy.staleLockMs <= 0 ||
      this.policy.lockHeartbeatMs <= 0 ||
      this.policy.lockHeartbeatMs >= this.policy.staleLockMs
    ) {
      throw new TypeError('Repository cache policy is invalid')
    }
  }

  async checkout(input: RepositoryCheckoutInput): Promise<RepositoryCheckoutResult> {
    throwIfAborted(input.signal)
    await this.ensureRoots()
    await input.runGit({
      args: ['check-ref-format', '--branch', input.branch],
      cwd: input.cwd,
      displayCommand: 'git check-ref-format <branch>',
    })
    if (!destinationStaysInsideCwd(input.cwd, input.destination)) {
      throw new RepositoryCacheUnavailableError(
        'Repository checkout destination must stay inside the job directory'
      )
    }

    const key = repositoryCacheKey(input.repositoryUrl, input.credentialScope, this.secret)
    const cacheDirectory = this.cacheDirectory(key)
    const cacheAlreadyExists = await pathExists(cacheDirectory)
    throwIfAborted(input.signal)
    await this.prune(new Set([key]), input.log)
    const freeBytes = await availableBytes(this.root)
    if (freeBytes < this.policy.rejectFreeBytes) {
      throw new RepositoryCacheDiskPressureError(freeBytes)
    }
    if (!cacheAlreadyExists && freeBytes < this.policy.cleanupFreeBytes) {
      throw new RepositoryCacheDiskPressureError(freeBytes)
    }

    const prepared = await this.withRepositoryLock(
      key,
      async () => {
        throwIfAborted(input.signal)
        let cacheHit = await this.ensureBareRepository(cacheDirectory, input)
        const coldCacheFreeBytes = await availableBytes(this.root)
        if (coldCacheFreeBytes < this.policy.cleanupFreeBytes) {
          const hasReusableBranch =
            cacheHit && (await this.bareRepositoryHasBranches(cacheDirectory, input))
          if (!hasReusableBranch) {
            await rm(cacheDirectory, { recursive: true, force: true })
            await rm(this.metadataPath(key), { force: true })
            throw new RepositoryCacheDiskPressureError(coldCacheFreeBytes)
          }
        }
        const cacheRef = repositoryBranchRef(input.branch)
        const fetchRefspec = `+refs/heads/${input.branch}:${cacheRef.fullRef}`
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let fetchCompleted = false
          let releaseReservation: (() => void) | undefined
          try {
            await this.clearCachedTags(cacheDirectory, input)
            await input.runGit({
              args: [
                '--git-dir',
                cacheDirectory,
                'fetch',
                '--force',
                '--depth',
                '1',
                '--no-write-fetch-head',
                '--no-auto-gc',
                '--',
                input.repositoryUrl,
                fetchRefspec,
              ],
              cwd: input.cwd,
              displayCommand: `git fetch --depth 1 --force <repository> ${input.branch}`,
            })
            fetchCompleted = true
            const commit = (
              await input.runGit({
                args: [
                  '--git-dir',
                  cacheDirectory,
                  'rev-parse',
                  '--verify',
                  `${cacheRef.fullRef}^{commit}`,
                ],
                cwd: input.cwd,
                displayCommand: 'git rev-parse <cached-branch>',
                captureStdout: true,
              })
            ).trim()
            if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
              throw new RepositoryCacheUnavailableError('Git cache returned an invalid commit id')
            }

            const cacheSizeBytes = await this.markUsed(key, cacheDirectory, input)
            const { freeBytes: remainingBytes } = await this.prune(new Set([key]), input.log)
            if (remainingBytes < this.policy.rejectFreeBytes) {
              throw new RepositoryCacheDiskPressureError(remainingBytes)
            }

            releaseReservation = await this.reserveCheckoutCapacity(cacheSizeBytes)
            throwIfAborted(input.signal)
            await this.copyWorkspaceRepository(input, cacheDirectory, cacheRef)
            throwIfAborted(input.signal)
            return {
              cacheRef,
              releaseReservation,
              result: { cacheHit, cacheKey: key, commit },
            }
          } catch (error) {
            releaseReservation?.()
            await rm(input.destination, { recursive: true, force: true })
            if (
              !fetchCompleted ||
              attempt > 0 ||
              error instanceof RepositoryCacheDiskPressureError ||
              error instanceof RepositoryCacheUnavailableError ||
              (await this.cachePassesFsck(cacheDirectory, input))
            ) {
              throw error
            }
            await this.replaceBareRepository(cacheDirectory, input)
            cacheHit = false
            input.log('Rebuilt a corrupt Git repository cache')
          }
        }
        throw new RepositoryCacheUnavailableError('Git cache recovery did not complete')
      },
      input.signal
    )

    try {
      throwIfAborted(input.signal)
      await this.restoreWorkspaceRepository(input, prepared.cacheRef, prepared.result.commit)
      throwIfAborted(input.signal)
      input.log(
        `Git cache ${prepared.result.cacheHit ? 'hit' : 'miss'} ${key.slice(0, 12)}; checked out ${input.branch} at ${prepared.result.commit.slice(0, 12)}`
      )
    } catch (error) {
      await rm(input.destination, { recursive: true, force: true })
      throw error
    } finally {
      prepared.releaseReservation()
    }

    try {
      let maintenance = await this.prune(new Set([key]), input.log)
      if (maintenance.freeBytes < this.policy.cleanupFreeBytes) {
        maintenance = await this.pruneWithPolicy(new Set(), input.log, {
          maxBytes: Number.POSITIVE_INFINITY,
          maxAgeMs: Number.POSITIVE_INFINITY,
        })
      }
      if (maintenance.freeBytes < this.policy.rejectFreeBytes) {
        throw new RepositoryCacheDiskPressureError(maintenance.freeBytes)
      }
    } catch (error) {
      input.log(
        `Could not complete Git cache maintenance: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
    return prepared.result
  }

  private async copyWorkspaceRepository(
    input: RepositoryCheckoutInput,
    cacheDirectory: string,
    cacheRef: ReturnType<typeof repositoryBranchRef>
  ): Promise<void> {
    const destinationParent = path.dirname(path.resolve(input.destination))
    await mkdir(destinationParent, { recursive: true })

    await rm(input.destination, { recursive: true, force: true })
    try {
      await input.runGit({
        args: [
          'clone',
          '--no-local',
          '--no-checkout',
          '--single-branch',
          '--branch',
          cacheRef.branchName,
          '--',
          cacheDirectory,
          input.destination,
        ],
        cwd: input.cwd,
        displayCommand: `git clone --no-local --single-branch <repository-cache> ${input.destination}`,
      })
      try {
        await access(path.join(input.destination, '.git', 'objects', 'info', 'alternates'))
        throw new RepositoryCacheUnavailableError(
          'Local repository clone unexpectedly depends on the cache through alternates'
        )
      } catch (error) {
        if (error instanceof RepositoryCacheUnavailableError) throw error
        if (errorCode(error) !== 'ENOENT') throw error
      }
    } catch (error) {
      await rm(input.destination, { recursive: true, force: true })
      throw error
    }
  }

  private async clearCachedTags(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<void> {
    const output = await input.runGit({
      args: [
        '--git-dir',
        cacheDirectory,
        'for-each-ref',
        '--format=%(refname:strip=2)',
        'refs/tags',
      ],
      cwd: input.cwd,
      displayCommand: 'git for-each-ref <repository-cache-tags>',
      captureStdout: true,
    })
    const tags = output
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    for (let offset = 0; offset < tags.length; offset += 128) {
      await input.runGit({
        args: [
          '--git-dir',
          cacheDirectory,
          'tag',
          '--delete',
          '--',
          ...tags.slice(offset, offset + 128),
        ],
        cwd: input.cwd,
        displayCommand: 'git tag --delete <cached-tags>',
      })
    }
  }

  private async reserveCheckoutCapacity(estimatedObjectCopyBytes: number): Promise<() => void> {
    return reserveRepositoryCheckoutCapacity({
      root: this.root,
      estimatedBytes: estimatedObjectCopyBytes,
      rejectFreeBytes: this.policy.rejectFreeBytes,
    })
  }

  private async cachePassesFsck(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<boolean> {
    try {
      await input.runGit({
        args: ['--git-dir', cacheDirectory, 'fsck', '--connectivity-only', '--no-dangling'],
        cwd: input.cwd,
        displayCommand: 'git fsck --connectivity-only <repository-cache>',
      })
      return true
    } catch {
      return false
    }
  }

  async prune(
    protectedKeys = new Set<string>(),
    log: (message: string) => void = () => {}
  ): Promise<{
    removedKeys: string[]
    freeBytes: number
  }> {
    return this.pruneWithPolicy(protectedKeys, log)
  }

  private async pruneWithPolicy(
    protectedKeys: Set<string>,
    log: (message: string) => void,
    overrides: Partial<
      Pick<RepositoryCachePolicy, 'maxBytes' | 'cleanupFreeBytes' | 'maxAgeMs'>
    > = {}
  ): Promise<{
    removedKeys: string[]
    freeBytes: number
  }> {
    await this.ensureRoots()
    const entries = await this.listEntries()
    let freeBytes = await availableBytes(this.root)
    const effectiveProtectedKeys = new Set([...protectedKeys, ...this.processLocks.keys()])
    const selected = selectRepositoryCacheEvictions({
      entries,
      maxBytes: overrides.maxBytes ?? this.policy.maxBytes,
      cleanupFreeBytes: overrides.cleanupFreeBytes ?? this.policy.cleanupFreeBytes,
      freeBytes,
      maxAgeMs: overrides.maxAgeMs ?? this.policy.maxAgeMs,
      now: Date.now(),
      protectedKeys: effectiveProtectedKeys,
    })
    const removedKeys: string[] = []

    for (const entry of selected) {
      try {
        await this.withRepositoryLock(entry.key, async () => {
          const latestLastUsedAt = await this.lastUsedAt(entry.key, entry.directory)
          if (latestLastUsedAt > entry.lastUsedAt) return
          await rm(entry.directory, { recursive: true, force: true })
          await rm(this.metadataPath(entry.key), { force: true })
          removedKeys.push(entry.key)
          log(`Removed Git cache ${entry.key.slice(0, 12)} (${entry.sizeBytes} bytes)`)
        })
      } catch (error) {
        log(
          `Could not remove Git cache ${entry.key.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    freeBytes = await availableBytes(this.root)
    return { removedKeys, freeBytes }
  }

  private async ensureRoots(): Promise<void> {
    await Promise.all([
      mkdir(this.repositoriesRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.locksRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.metadataRoot, { recursive: true, mode: 0o700 }),
    ])
    if (!this.temporaryCleanup) {
      this.temporaryCleanup = this.cleanupTemporaryEntries().catch(() => {})
    }
    await this.temporaryCleanup
  }

  private async cleanupTemporaryEntries(): Promise<void> {
    const cutoff = Date.now() - TEMPORARY_ENTRY_MAX_AGE_MS

    const repositoryEntries = await readdir(this.repositoriesRoot, { withFileTypes: true })
    for (const entry of repositoryEntries) {
      const match = REPOSITORY_TEMPORARY_PATTERN.exec(entry.name)
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const [, key, kind] = match
      if (!key || !kind) continue
      if (await pathExists(path.join(this.locksRoot, `${key}.lock`))) continue
      await this.removeTemporaryEntryIfOld(this.repositoriesRoot, entry.name, cutoff)
    }

    const lockEntries = await readdir(this.locksRoot, { withFileTypes: true })
    for (const entry of lockEntries) {
      if (!LOCK_TEMPORARY_PATTERN.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      await this.removeTemporaryEntryIfOld(this.locksRoot, entry.name, cutoff)
    }

    const metadataEntries = await readdir(this.metadataRoot, { withFileTypes: true })
    for (const entry of metadataEntries) {
      const match = METADATA_TEMPORARY_PATTERN.exec(entry.name)
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue
      const [, key, kind] = match
      if (!key || !kind) continue
      if (await pathExists(path.join(this.locksRoot, `${key}.lock`))) continue
      await this.removeTemporaryEntryIfOld(this.metadataRoot, entry.name, cutoff)
    }
  }

  private async removeTemporaryEntryIfOld(
    parent: string,
    name: string,
    cutoff: number
  ): Promise<void> {
    const candidate = path.resolve(parent, name)
    if (path.dirname(candidate) !== parent) return
    try {
      const stats = await lstat(candidate)
      if (stats.mtimeMs > cutoff) return
      await rm(candidate, { recursive: stats.isDirectory(), force: true })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  private cacheDirectory(key: string): string {
    return path.join(this.repositoriesRoot, `${key}.git`)
  }

  private metadataPath(key: string): string {
    return path.join(this.metadataRoot, `${key}.json`)
  }

  private async ensureBareRepository(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<boolean> {
    if (
      (await pathExists(cacheDirectory)) &&
      (await this.bareRepositoryLooksValid(cacheDirectory, input))
    ) {
      return true
    }
    const replacing = await pathExists(cacheDirectory)
    await this.replaceBareRepository(cacheDirectory, input)
    if (replacing) input.log('Rebuilt an invalid Git repository cache')
    return false
  }

  private async bareRepositoryLooksValid(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<boolean> {
    try {
      const bare = (
        await input.runGit({
          args: ['--git-dir', cacheDirectory, 'rev-parse', '--is-bare-repository'],
          cwd: input.cwd,
          displayCommand: 'git rev-parse --is-bare-repository <repository-cache>',
          captureStdout: true,
        })
      ).trim()
      return bare === 'true'
    } catch {
      return false
    }
  }

  private async bareRepositoryHasBranches(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<boolean> {
    try {
      const branch = await input.runGit({
        args: [
          '--git-dir',
          cacheDirectory,
          'for-each-ref',
          '--count=1',
          '--format=%(objectname)',
          'refs/heads',
        ],
        cwd: input.cwd,
        displayCommand: 'git for-each-ref <repository-cache-branches>',
        captureStdout: true,
      })
      return Boolean(branch.trim())
    } catch {
      return false
    }
  }

  private async replaceBareRepository(
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<void> {
    const temporary = `${cacheDirectory}.init-${randomUUID()}`
    const quarantine = `${cacheDirectory}.corrupt-${randomUUID()}`
    let quarantined = false
    try {
      await input.runGit({
        args: ['init', '--bare', temporary],
        cwd: input.cwd,
        displayCommand: 'git init --bare <repository-cache>',
      })
      await input.runGit({
        args: ['--git-dir', temporary, 'config', 'gc.auto', '0'],
        cwd: input.cwd,
        displayCommand: 'git config gc.auto 0 <repository-cache>',
      })
      if (await pathExists(cacheDirectory)) {
        await rename(cacheDirectory, quarantine)
        quarantined = true
      }
      await rename(temporary, cacheDirectory)
      if (quarantined) await rm(quarantine, { recursive: true, force: true })
    } catch (error) {
      if (quarantined && !(await pathExists(cacheDirectory)) && (await pathExists(quarantine))) {
        await rename(quarantine, cacheDirectory)
      }
      throw error
    } finally {
      await rm(temporary, { recursive: true, force: true })
      if (await pathExists(cacheDirectory)) {
        await rm(quarantine, { recursive: true, force: true })
      }
    }
  }

  private async restoreWorkspaceRepository(
    input: RepositoryCheckoutInput,
    cacheRef: ReturnType<typeof repositoryBranchRef>,
    commit: string
  ): Promise<void> {
    const workspaceOrigin = repositoryUrlForWorkspace(input.repositoryUrl)
    const remoteBranchRef = `refs/remotes/origin/${input.branch}`
    await input.runGit({
      args: ['-C', input.destination, 'remote', 'set-url', 'origin', workspaceOrigin],
      cwd: input.cwd,
      displayCommand: 'git remote set-url origin <repository>',
    })
    await input.runGit({
      args: ['-C', input.destination, 'update-ref', remoteBranchRef, commit],
      cwd: input.cwd,
      displayCommand: 'git update-ref <origin-branch> <commit>',
    })
    await input.runGit({
      args: [
        '-C',
        input.destination,
        'config',
        '--replace-all',
        'remote.origin.fetch',
        `+refs/heads/${input.branch}:${remoteBranchRef}`,
      ],
      cwd: input.cwd,
      displayCommand: 'git config remote.origin.fetch <branch-refspec>',
    })
    await input.runGit({
      args: ['-C', input.destination, 'checkout', '-B', input.branch, commit],
      cwd: input.cwd,
      displayCommand: `git checkout -B ${input.branch} <commit>`,
    })
    await input.runGit({
      args: ['-C', input.destination, 'branch', '--set-upstream-to', `origin/${input.branch}`],
      cwd: input.cwd,
      displayCommand: `git branch --set-upstream-to origin/${input.branch}`,
    })
    if (cacheRef.branchName !== input.branch) {
      await input.runGit({
        args: ['-C', input.destination, 'branch', '-D', cacheRef.branchName],
        cwd: input.cwd,
        displayCommand: 'git branch -D <cached-branch>',
      })
      await input.runGit({
        args: [
          '-C',
          input.destination,
          'update-ref',
          '-d',
          `refs/remotes/origin/${cacheRef.branchName}`,
        ],
        cwd: input.cwd,
        displayCommand: 'git update-ref -d <cached-origin-branch>',
      })
    }
  }

  private async markUsed(
    key: string,
    cacheDirectory: string,
    input: RepositoryCheckoutInput
  ): Promise<number> {
    let sizeBytes: number
    try {
      const output = await input.runGit({
        args: ['--git-dir', cacheDirectory, 'count-objects', '-v'],
        cwd: input.cwd,
        displayCommand: 'git count-objects -v <repository-cache>',
        captureStdout: true,
      })
      sizeBytes = gitObjectSize(output) ?? (await directorySize(cacheDirectory))
    } catch {
      sizeBytes = await directorySize(cacheDirectory)
    }

    const temporary = `${this.metadataPath(key)}.tmp-${randomUUID()}`
    const destination = this.metadataPath(key)
    const previous = `${destination}.previous-${randomUUID()}`
    let movedPrevious = false
    try {
      await writeFile(temporary, JSON.stringify({ lastUsedAt: Date.now(), sizeBytes }), {
        encoding: 'utf8',
        mode: 0o600,
      })
      if (await pathExists(destination)) {
        await rename(destination, previous)
        movedPrevious = true
      }
      await rename(temporary, destination)
      if (movedPrevious) await rm(previous, { force: true })
    } catch (error) {
      if (movedPrevious && !(await pathExists(destination)) && (await pathExists(previous))) {
        await rename(previous, destination)
      }
      throw error
    } finally {
      await rm(temporary, { force: true })
      if (await pathExists(destination)) await rm(previous, { force: true })
    }
    return sizeBytes
  }

  private async readMetadata(key: string): Promise<CacheMetadata | null> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath(key), 'utf8')) as {
        lastUsedAt?: unknown
        sizeBytes?: unknown
      }
      if (
        typeof parsed.lastUsedAt === 'number' &&
        Number.isFinite(parsed.lastUsedAt) &&
        typeof parsed.sizeBytes === 'number' &&
        Number.isFinite(parsed.sizeBytes) &&
        parsed.sizeBytes >= 0
      ) {
        return { lastUsedAt: parsed.lastUsedAt, sizeBytes: parsed.sizeBytes }
      }
    } catch {
      // Missing or damaged metadata makes the disposable cache the oldest candidate.
    }
    return null
  }

  private async lastUsedAt(key: string, directory: string): Promise<number> {
    return (await this.readMetadata(key))?.lastUsedAt ?? (await lstat(directory)).mtimeMs
  }

  private async listEntries(): Promise<CacheEntry[]> {
    const entries = await readdir(this.repositoriesRoot, { withFileTypes: true })
    const result: CacheEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !CACHE_DIRECTORY_PATTERN.test(entry.name)) continue
      const key = entry.name.slice(0, -'.git'.length)
      const directory = path.resolve(this.repositoriesRoot, entry.name)
      if (path.dirname(directory) !== this.repositoriesRoot) continue
      const metadata = await this.readMetadata(key)
      result.push({
        key,
        directory,
        sizeBytes: metadata?.sizeBytes ?? (await directorySize(directory)),
        lastUsedAt: metadata?.lastUsedAt ?? (await lstat(directory)).mtimeMs,
      })
    }
    return result
  }

  private async withRepositoryLock<T>(
    key: string,
    action: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const previous = this.processLocks.get(key) || Promise.resolve()
    let releaseProcessLock!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseProcessLock = resolve
    })
    const tail = previous.catch(() => {}).then(() => gate)
    this.processLocks.set(key, tail)
    try {
      await awaitWithSignal(
        previous.catch(() => {}),
        signal
      )
      return await this.withFileLock(key, action, signal)
    } finally {
      releaseProcessLock()
      if (this.processLocks.get(key) === tail) this.processLocks.delete(key)
    }
  }

  private async withFileLock<T>(
    key: string,
    action: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const lockDirectory = path.join(this.locksRoot, `${key}.lock`)
    const ownerPath = path.join(lockDirectory, 'owner.json')
    const ownerToken = randomUUID()
    const startedAt = Date.now()
    while (true) {
      throwIfAborted(signal)
      try {
        await mkdir(lockDirectory, { mode: 0o700 })
        break
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        try {
          const lock = await lstat(path.join(lockDirectory, 'owner.json')).catch(() =>
            lstat(lockDirectory)
          )
          if (Date.now() - lock.mtimeMs > this.policy.staleLockMs) {
            const stale = `${lockDirectory}.stale-${randomUUID()}`
            await rename(lockDirectory, stale)
            await rm(stale, { recursive: true, force: true })
            continue
          }
        } catch (lockError) {
          if (errorCode(lockError) === 'ENOENT') continue
        }
        if (Date.now() - startedAt > this.policy.lockTimeoutMs) {
          throw new RepositoryCacheUnavailableError('Timed out waiting for repository cache lock')
        }
        await delay(100, signal)
      }
    }

    try {
      await writeFile(
        ownerPath,
        JSON.stringify({
          token: ownerToken,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }),
        { encoding: 'utf8', mode: 0o600 }
      )
    } catch (error) {
      await rm(lockDirectory, { recursive: true, force: true })
      throw error
    }
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown }
          if (owner.token !== ownerToken) return
          const now = new Date()
          await utimes(ownerPath, now, now)
        } catch {
          // Losing ownership naturally stops this heartbeat from extending a successor's lock.
        }
      })()
    }, this.policy.lockHeartbeatMs)
    heartbeat.unref()

    try {
      throwIfAborted(signal)
      return await action()
    } finally {
      clearInterval(heartbeat)
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown }
        if (owner.token === ownerToken) {
          await rm(lockDirectory, { recursive: true, force: true })
        }
      } catch {
        // A stale-lock recovery may have replaced this path; never remove an unknown owner's lock.
      }
    }
  }
}
