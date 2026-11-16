import { randomUUID } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RepositoryCache,
  RepositoryCacheDiskPressureError,
  repositoryBranchRef,
  repositoryCacheKey,
  repositoryUrlForWorkspace,
  reserveRepositoryCheckoutCapacity,
  selectRepositoryCacheEvictions,
  type GitCommandRequest,
  type GitCommandRunner,
} from './repository-cache'

const roots: string[] = []
const cacheSecret = 'repository-cache-test-secret'
const commit = 'a'.repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'cuddly-repository-cache-'))
  roots.push(root)
  return root
}

function repositoryCache(root: string): RepositoryCache {
  return new RepositoryCache({
    root,
    secret: cacheSecret,
    policy: {
      maxBytes: Number.MAX_SAFE_INTEGER,
      cleanupFreeBytes: 0,
      rejectFreeBytes: 0,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      lockTimeoutMs: 1_000,
      staleLockMs: 1_000,
      lockHeartbeatMs: 100,
    },
  })
}

function isGitCommand(request: GitCommandRequest, command: string): boolean {
  return request.args[0] === command || request.args.includes(command)
}

function fakeGit(
  options: {
    onFetch?: (request: GitCommandRequest) => Promise<void>
    onBareCheck?: () => Promise<string> | string
    onInit?: (directory: string) => void
    onClone?: (directory: string, request: GitCommandRequest) => Promise<void> | void
    commit?: string
  } = {}
): GitCommandRunner {
  return async (request) => {
    if (request.args[0] === 'init' && request.args[1] === '--bare') {
      const directory = request.args[2]
      if (!directory) throw new Error('git init test request has no destination')
      await mkdir(directory, { recursive: true })
      options.onInit?.(directory)
      return ''
    }
    if (request.args.includes('--is-bare-repository')) {
      return (await options.onBareCheck?.()) ?? 'true\n'
    }
    if (isGitCommand(request, 'fetch')) {
      await options.onFetch?.(request)
      return ''
    }
    if (request.args.includes('--verify')) return `${options.commit || commit}\n`
    if (request.args[0] === 'clone') {
      const directory = request.args.at(-1)
      if (!directory) throw new Error('git clone test request has no destination')
      await mkdir(directory, { recursive: true })
      await options.onClone?.(directory, request)
    }
    return ''
  }
}

function checkoutInput(input: {
  root: string
  repositoryUrl?: string
  credentialScope?: string
  branch?: string
  runGit: GitCommandRunner
}) {
  return {
    repositoryUrl: input.repositoryUrl || 'https://git.example.test/kook.git',
    credentialScope: input.credentialScope || 'Authorization: Basic credential-a',
    branch: input.branch || 'feature/cache-test',
    destination: path.join(input.root, 'jobs', randomUUID(), 'source'),
    cwd: input.root,
    runGit: input.runGit,
    log: () => {},
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('repository cache identities', () => {
  it('isolates repositories, credential scopes, and installations without exposing inputs', () => {
    const first = repositoryCacheKey(
      'https://git.example.test/kook.git',
      'Authorization: Basic credential-a',
      cacheSecret
    )

    expect(first).toBe(
      repositoryCacheKey(
        ' https://git.example.test/kook.git ',
        'Authorization: Basic credential-a',
        cacheSecret
      )
    )
    expect(first).not.toBe(
      repositoryCacheKey(
        'https://git.example.test/kook.git',
        'Authorization: Basic credential-b',
        cacheSecret
      )
    )
    expect(first).not.toBe(
      repositoryCacheKey(
        'https://git.example.test/another.git',
        'Authorization: Basic credential-a',
        cacheSecret
      )
    )
    expect(first).not.toBe(
      repositoryCacheKey(
        'https://git.example.test/kook.git',
        'Authorization: Basic credential-a',
        'another-installation-secret'
      )
    )
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain('git.example.test')
    expect(first).not.toContain('credential-a')
  })

  it('maps arbitrary branch names to deterministic non-secret cache refs', () => {
    const first = repositoryBranchRef('feature/QA-123_hot-module')
    const again = repositoryBranchRef('feature/QA-123_hot-module')
    const other = repositoryBranchRef('feature/QA-124_hot-module')

    expect(first).toEqual(again)
    expect(first).not.toEqual(other)
    expect(first.branchName).toMatch(/^cuddly-cache\/[a-f0-9]{64}$/)
    expect(first.fullRef).toBe(`refs/heads/${first.branchName}`)
    expect(first.fullRef).not.toContain('QA-123')
  })

  it('removes inline HTTP credentials before restoring the workspace origin', () => {
    expect(repositoryUrlForWorkspace('https://user:password@git.example.test/kook.git')).toBe(
      'https://git.example.test/kook.git'
    )
    expect(repositoryUrlForWorkspace('http://token@git.example.test:8080/kook.git?ref=one')).toBe(
      'http://git.example.test:8080/kook.git?ref=one'
    )
    expect(repositoryUrlForWorkspace('git@git.example.test:kook/kook.git')).toBe(
      'git@git.example.test:kook/kook.git'
    )
    expect(repositoryUrlForWorkspace('ssh://git@git.example.test/kook.git')).toBe(
      'ssh://git@git.example.test/kook.git'
    )
  })
})

describe('repository cache eviction selection', () => {
  const entry = (key: string, sizeBytes: number, lastUsedAt: number) => ({
    key,
    sizeBytes,
    lastUsedAt,
    directory: `/cache/${key}.git`,
  })

  it('evicts the least recently used entries until the soft size cap is met', () => {
    const oldest = entry('a', 60, 10)
    const newest = entry('b', 50, 20)

    expect(
      selectRepositoryCacheEvictions({
        entries: [newest, oldest],
        maxBytes: 100,
        cleanupFreeBytes: 100,
        freeBytes: 200,
        maxAgeMs: 1_000,
        now: 100,
      })
    ).toEqual([oldest])
  })

  it('also evicts by free-space watermark and maximum age', () => {
    const expired = entry('expired', 20, 0)
    const old = entry('old', 30, 80)
    const recent = entry('recent', 50, 90)

    expect(
      selectRepositoryCacheEvictions({
        entries: [recent, old, expired],
        maxBytes: 1_000,
        cleanupFreeBytes: 100,
        freeBytes: 60,
        maxAgeMs: 50,
        now: 100,
      })
    ).toEqual([expired, old])
  })

  it('never selects an active key and sorts equal timestamps deterministically', () => {
    const protectedEntry = entry('protected', 200, 0)
    const second = entry('b', 20, 10)
    const first = entry('a', 20, 10)

    expect(
      selectRepositoryCacheEvictions({
        entries: [protectedEntry, second, first],
        maxBytes: 0,
        cleanupFreeBytes: 1_000,
        freeBytes: 0,
        maxAgeMs: 0,
        now: 100,
        protectedKeys: new Set(['protected']),
      })
    ).toEqual([first, second])
  })
})

describe('repository checkout capacity reservations', () => {
  it('accounts for active cache and direct-clone reservations under the same runner root', async () => {
    const root = await temporaryRoot()
    const available = async () => 5 * 1024 ** 3
    const releaseFirst = await reserveRepositoryCheckoutCapacity({
      root,
      estimatedBytes: 2 * 1024 ** 3,
      rejectFreeBytes: 2 * 1024 ** 3,
      availableBytes: available,
    })

    await expect(
      reserveRepositoryCheckoutCapacity({
        root,
        estimatedBytes: 2 * 1024 ** 3,
        rejectFreeBytes: 2 * 1024 ** 3,
        availableBytes: available,
      })
    ).rejects.toBeInstanceOf(RepositoryCacheDiskPressureError)

    releaseFirst()
    const releaseSecond = await reserveRepositoryCheckoutCapacity({
      root,
      estimatedBytes: 2 * 1024 ** 3,
      rejectFreeBytes: 2 * 1024 ** 3,
      availableBytes: available,
    })
    releaseSecond()
  })
})

describe('repository cache temporary cleanup', () => {
  it('removes only strictly named leftovers older than one day', async () => {
    const root = await temporaryRoot()
    const repositories = path.join(root, 'repositories')
    const locks = path.join(root, 'locks')
    const metadata = path.join(root, 'metadata')
    await Promise.all([
      mkdir(repositories, { recursive: true }),
      mkdir(locks, { recursive: true }),
      mkdir(metadata, { recursive: true }),
    ])

    const key = 'c'.repeat(64)
    const uuid = '12345678-1234-4123-8123-123456789abc'
    const freshUuid = '87654321-4321-4321-8321-cba987654321'
    const oldInit = path.join(repositories, `${key}.git.init-${uuid}`)
    const oldCorrupt = path.join(repositories, `${key}.git.corrupt-${uuid}`)
    const freshInit = path.join(repositories, `${key}.git.init-${freshUuid}`)
    const nearMatch = path.join(repositories, `${key}.git.init-${uuid}-extra`)
    const oldStaleLock = path.join(locks, `${key}.lock.stale-${uuid}`)
    const oldMetadataTemporary = path.join(metadata, `${key}.json.tmp-${uuid}`)
    const oldMetadataPrevious = path.join(metadata, `${key}.json.previous-${uuid}`)
    await Promise.all([
      mkdir(oldInit),
      mkdir(oldCorrupt),
      mkdir(freshInit),
      mkdir(nearMatch),
      mkdir(oldStaleLock),
      writeFile(oldMetadataTemporary, '{}'),
      writeFile(oldMetadataPrevious, '{}'),
    ])
    const olderThanCleanupWindow = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await Promise.all([
      utimes(oldInit, olderThanCleanupWindow, olderThanCleanupWindow),
      utimes(oldCorrupt, olderThanCleanupWindow, olderThanCleanupWindow),
      utimes(nearMatch, olderThanCleanupWindow, olderThanCleanupWindow),
      utimes(oldStaleLock, olderThanCleanupWindow, olderThanCleanupWindow),
      utimes(oldMetadataTemporary, olderThanCleanupWindow, olderThanCleanupWindow),
      utimes(oldMetadataPrevious, olderThanCleanupWindow, olderThanCleanupWindow),
    ])

    await repositoryCache(root).prune()

    await expect(access(oldInit)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(oldCorrupt)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(oldStaleLock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(oldMetadataTemporary)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(oldMetadataPrevious)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(freshInit)).resolves.toBeUndefined()
    await expect(access(nearMatch)).resolves.toBeUndefined()
  })
})

describe('repository cache checkout coordination', () => {
  it('holds the same-key lock through object copy but releases it before workspace restore', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    const firstCloneStarted = deferred()
    const releaseFirstClone = deferred()
    const firstRestoreStarted = deferred()
    const releaseFirstRestore = deferred()
    const secondFetchStarted = deferred()
    let fetchCount = 0
    let cloneCount = 0
    let activeClones = 0
    let maximumActiveClones = 0
    let firstDestination = ''

    const baseGit = fakeGit({
      onFetch: async () => {
        fetchCount += 1
        if (fetchCount === 2) secondFetchStarted.resolve()
      },
      onClone: async () => {
        cloneCount += 1
        activeClones += 1
        maximumActiveClones = Math.max(maximumActiveClones, activeClones)
        if (cloneCount === 1) {
          firstCloneStarted.resolve()
          await releaseFirstClone.promise
        }
        activeClones -= 1
      },
    })
    const runGit: GitCommandRunner = async (request) => {
      if (
        request.args[0] === '-C' &&
        request.args[1] === firstDestination &&
        request.args.includes('checkout')
      ) {
        firstRestoreStarted.resolve()
        await releaseFirstRestore.promise
      }
      return baseGit(request)
    }

    const firstInput = checkoutInput({ root, runGit })
    firstDestination = firstInput.destination
    let firstSettled = false
    const first = cache.checkout(firstInput).finally(() => {
      firstSettled = true
    })
    await firstCloneStarted.promise
    const second = cache.checkout(checkoutInput({ root, runGit }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(fetchCount).toBe(1)
    expect(cloneCount).toBe(1)

    releaseFirstClone.resolve()
    await firstRestoreStarted.promise
    await Promise.race([
      secondFetchStarted.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('repository lock remained held during restore')), 1_000)
      ),
    ])
    expect(firstSettled).toBe(false)

    releaseFirstRestore.resolve()
    const results = await Promise.all([first, second])
    expect(fetchCount).toBe(2)
    expect(cloneCount).toBe(2)
    expect(maximumActiveClones).toBe(1)
    expect(results.map((result) => result.cacheHit)).toEqual([false, true])
    expect(results[0]?.cacheKey).toBe(results[1]?.cacheKey)
  })

  it('allows different cache keys to fetch concurrently', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    const bothFetchesStarted = deferred()
    const releaseFetches = deferred()
    let fetchCount = 0
    let activeFetches = 0
    let maximumActiveFetches = 0

    const runGit = fakeGit({
      onFetch: async () => {
        fetchCount += 1
        activeFetches += 1
        maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches)
        if (fetchCount === 2) bothFetchesStarted.resolve()
        await releaseFetches.promise
        activeFetches -= 1
      },
    })

    const first = cache.checkout(
      checkoutInput({ root, repositoryUrl: 'https://git.example.test/one.git', runGit })
    )
    const second = cache.checkout(
      checkoutInput({ root, repositoryUrl: 'https://git.example.test/two.git', runGit })
    )

    await Promise.race([
      bothFetchesStarted.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('different repository fetches did not overlap')), 1_000)
      ),
    ])
    expect(maximumActiveFetches).toBe(2)

    releaseFetches.resolve()
    const results = await Promise.all([first, second])
    expect(results[0]?.cacheKey).not.toBe(results[1]?.cacheKey)
  })

  it('deletes cached tags in option-safe chunks before fetching the branch', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    const repositoryUrl = 'https://git.example.test/kook.git'
    const credentialScope = 'Authorization: Basic credential-a'
    const key = repositoryCacheKey(repositoryUrl, credentialScope, cacheSecret)
    await mkdir(path.join(root, 'repositories', `${key}.git`), { recursive: true })
    const tags = Array.from({ length: 130 }, (_value, index) =>
      index === 0 ? '-option-shaped-tag' : `release/${index}`
    )
    const requests: GitCommandRequest[] = []
    const baseGit = fakeGit()
    const runGit: GitCommandRunner = async (request) => {
      requests.push(request)
      if (request.args.includes('for-each-ref')) return `${tags.join('\n')}\n`
      return baseGit(request)
    }

    await cache.checkout(checkoutInput({ root, repositoryUrl, credentialScope, runGit }))

    const listIndex = requests.findIndex((request) => request.args.includes('for-each-ref'))
    const fetchIndex = requests.findIndex((request) => request.args.includes('fetch'))
    const deleteRequests = requests.filter(
      (request) => request.args.includes('tag') && request.args.includes('--delete')
    )
    expect(listIndex).toBeGreaterThanOrEqual(0)
    expect(fetchIndex).toBeGreaterThan(listIndex)
    expect(deleteRequests).toHaveLength(2)
    expect(
      deleteRequests.map((request) => request.args.slice(request.args.indexOf('--') + 1))
    ).toEqual([tags.slice(0, 128), tags.slice(128)])
    for (const request of deleteRequests) {
      expect(requests.indexOf(request)).toBeLessThan(fetchIndex)
      expect(request.args.slice(0, request.args.indexOf('--') + 1)).toEqual([
        '--git-dir',
        path.join(root, 'repositories', `${key}.git`),
        'tag',
        '--delete',
        '--',
      ])
    }
  })

  it('does not resolve or clone a stale cached tip when the forced fetch fails', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    const repositoryUrl = 'https://git.example.test/kook.git'
    const credentialScope = 'Authorization: Basic credential-a'
    const key = repositoryCacheKey(repositoryUrl, credentialScope, cacheSecret)
    const cachedRepository = path.join(root, 'repositories', `${key}.git`)
    await mkdir(cachedRepository, { recursive: true })
    await writeFile(path.join(cachedRepository, 'stale-tip'), commit)
    const events: string[] = []
    let resolvedCommit = false
    let cloned = false

    const runGit: GitCommandRunner = async (request) => {
      if (request.args.includes('--is-bare-repository')) return 'true\n'
      if (request.args.includes('for-each-ref')) {
        events.push('list-tags')
        return 'release/stale\n'
      }
      if (request.args.includes('tag') && request.args.includes('--delete')) {
        events.push('delete-tags')
        return ''
      }
      if (isGitCommand(request, 'fetch')) {
        events.push('fetch')
        throw new Error('origin is unavailable')
      }
      if (request.args.includes('--verify')) resolvedCommit = true
      if (request.args[0] === 'clone') cloned = true
      return ''
    }

    await expect(
      cache.checkout(checkoutInput({ root, repositoryUrl, credentialScope, runGit }))
    ).rejects.toThrow('origin is unavailable')
    expect(events).toEqual(['list-tags', 'delete-tags', 'fetch'])
    expect(resolvedCommit).toBe(false)
    expect(cloned).toBe(false)
    expect(await readFile(path.join(cachedRepository, 'stale-tip'), 'utf8')).toBe(commit)
  })

  it('rejects an oversized object-copy reservation before cloning the workspace', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    let cloned = false
    const baseGit = fakeGit({
      onClone: () => {
        cloned = true
      },
    })
    const runGit: GitCommandRunner = (request) => {
      if (request.args.includes('count-objects')) {
        return Promise.resolve(
          [
            'count: 0',
            'size: 0',
            'in-pack: 1',
            `size-pack: ${Number.MAX_SAFE_INTEGER}`,
            'prune-packable: 0',
            'garbage: 0',
            'size-garbage: 0',
          ].join('\n')
        )
      }
      return baseGit(request)
    }
    const input = checkoutInput({ root, runGit })

    await expect(cache.checkout(input)).rejects.toBeInstanceOf(RepositoryCacheDiskPressureError)
    expect(cloned).toBe(false)
    await expect(access(input.destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines and rebuilds a damaged bare cache before fetching', async () => {
    const root = await temporaryRoot()
    const cache = repositoryCache(root)
    const repositoryUrl = 'https://git.example.test/kook.git'
    const credentialScope = 'Authorization: Basic credential-a'
    const key = repositoryCacheKey(repositoryUrl, credentialScope, cacheSecret)
    const cachedRepository = path.join(root, 'repositories', `${key}.git`)
    const staleMarker = path.join(cachedRepository, 'stale-tip')
    await mkdir(cachedRepository, { recursive: true })
    await writeFile(staleMarker, 'must-not-survive')
    const events: string[] = []

    const runGit = fakeGit({
      onBareCheck: () => {
        events.push('invalid-cache')
        return 'false\n'
      },
      onInit: () => {
        events.push('init')
      },
      onFetch: async () => {
        events.push('fetch')
      },
      onClone: () => {
        events.push('clone')
      },
      commit: 'b'.repeat(40),
    })

    const result = await cache.checkout(
      checkoutInput({ root, repositoryUrl, credentialScope, runGit })
    )

    expect(result).toMatchObject({ cacheHit: false, cacheKey: key, commit: 'b'.repeat(40) })
    expect(events).toEqual(['invalid-cache', 'init', 'fetch', 'clone'])
    await expect(readFile(staleMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the only just-used cache when disk space is healthy even with a zero soft cap', async () => {
    const root = await temporaryRoot()
    const cache = new RepositoryCache({
      root,
      secret: cacheSecret,
      policy: {
        maxBytes: 0,
        cleanupFreeBytes: 0,
        rejectFreeBytes: 0,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        lockTimeoutMs: 1_000,
        staleLockMs: 1_000,
        lockHeartbeatMs: 100,
      },
    })
    let cachedMarker = ''
    const runGit = fakeGit({
      onFetch: async (request) => {
        const cacheDirectory = request.args[1]
        if (!cacheDirectory) throw new Error('fetch request has no cache directory')
        cachedMarker = path.join(cacheDirectory, 'objects', 'cache-marker')
        await mkdir(path.dirname(cachedMarker), { recursive: true })
        await writeFile(cachedMarker, 'cached object')
      },
    })
    const input = checkoutInput({ root, runGit })

    const result = await cache.checkout(input)

    expect(result.cacheHit).toBe(false)
    await expect(readFile(cachedMarker, 'utf8')).resolves.toBe('cached object')
    await expect(access(input.destination)).resolves.toBeUndefined()
  })
})
