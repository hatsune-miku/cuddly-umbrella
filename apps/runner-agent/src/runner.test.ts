import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { transpileModule, ScriptTarget } from 'typescript'

import { FileArtifactStore } from '@cuddly/artifact-store'
import { runnerArtifactInventorySchema, type RunnerJobInput } from '@cuddly/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyRemoteBuildPatches,
  buildPublicPath,
  checkoutRepository,
  commandUsesPnpm,
  createRunnerApp,
  packageManagerEnvironment,
  packageManagerLockfileWarning,
  patchKookLogicModelsSelfImportSource,
  pnpmOutdatedLockfileFallbackCommand,
  patchOnlineH5AssetPrefixSource,
  patchRemoteAssetPrefixSource,
  patchRemoteProviderVersionSource,
  patchStandaloneRemoteConfigSource,
  projectEnvironmentVariables,
  projectGitEnvironment,
  projectInstallEnvironment,
  remoteArtifactPublicBase,
  remoteBuildPublicPath,
  remoteBuildEnvironment,
  remoteProviderName,
  runInstallCommand,
  RunnerFailure,
  resolveOnlineH5AssetPrefixConfigPath,
  runnerEnvironmentMatchesSnapshot,
  writeRunnerHeartbeat,
  type RunnerExecutor,
  type RunnerOptions,
} from './runner'
import {
  RepositoryCacheDiskPressureError,
  RepositoryCacheUnavailableError,
} from './repository-cache'

const roots: string[] = []
const TEST_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ENVIRONMENT_SLUG = 'shared'
const TEST_BACKEND_ORIGIN = 'https://api.kookapp.cn'

describe('build console lifecycle messages', () => {
  it.each([
    'success',
    'sentry-policy-failure',
    'validation-failure',
    'upload-failure',
    'canceled',
  ] as const)(
    'writes the banner before CHECKOUT and only completes successful uploads: %s',
    async (outcome) => {
      // Run the real orchestration body with isolated IO; never clone or launch a build.
      const source = await readFile(new URL('./runner.ts', import.meta.url), 'utf8')
      const body = source.slice(
        source.indexOf('async function executeBuild('),
        source.indexOf('export type RunnerExecutor')
      )
      const javascript = transpileModule(body, {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText
      const log: string[] = []
      const events: { type: string }[] = []
      const cancellation = new AbortController()
      const commandOrder: string[] = []
      const empty = () => ({})
      const noop = async () => undefined
      const execute = vm.runInNewContext(`${javascript}\nexecuteBuild`, {
        path,
        process: { env: {} },
        Date,
        RunnerFailure,
        runnerEnvironmentMatchesSnapshot: () => true,
        mkdir: noop,
        rm: noop,
        createWriteStream: empty,
        closeLog: noop,
        writeLog: (_stream: unknown, value: string) => log.push(value),
        writeEvent: (_res: unknown, event: { type: string }) => events.push(event),
        throwIfCanceled: (signal: AbortSignal) => {
          if (signal.aborted) throw new RunnerFailure('BUILD_CANCELED', 'canceled')
        },
        checkoutRepository: noop,
        disableWorkspaceTypeChecking: async () => 3,
        applySentryBuildPolicy: async () => {
          commandOrder.push('sentry-policy')
          if (outcome === 'sentry-policy-failure') throw new Error('unsupported Sentry plugin')
          return { files: 1, references: 1, packages: ['@sentry/webpack-plugin'] }
        },
        warnPackageManagerLockfileMismatch: noop,
        projectInstallEnvironment: empty,
        commandUsesPnpm: () => false,
        projectGitEnvironment: empty,
        projectEnvironmentVariables: empty,
        CHINA_NPM_REGISTRY: 'https://registry.example.test',
        runInstallCommand: async () => {
          commandOrder.push('install')
        },
        shellCommand: empty,
        remoteProviderName,
        remoteArtifactPublicBase,
        buildPublicPath,
        packageManagerEnvironment: empty,
        runCommand: async () => {
          commandOrder.push('build')
        },
        createStaticManifest: async () => {
          if (outcome === 'validation-failure') throw new Error('invalid artifact')
          return {}
        },
      })
      await execute(
        runnerJob('webapp'),
        {
          runnerRoot: '/fixture',
          keepWorkspace: false,
          artifactStore: {
            publishDirectory: async () => {
              if (outcome === 'upload-failure') throw new Error('upload failed')
              if (outcome === 'canceled') cancellation.abort()
              return 'ready/test'
            },
            deleteArtifactDirectory: noop,
          },
        },
        {},
        cancellation.signal
      )
      expect(log[0]).toBe('POWERED BY 打包嘟嘟')
      expect(commandOrder).toEqual(
        outcome === 'sentry-policy-failure'
          ? ['install', 'sentry-policy']
          : ['install', 'sentry-policy', 'build']
      )
      expect(log.findIndex((line) => line.includes('CHECKOUT'))).toBeGreaterThan(0)
      if (outcome === 'success') {
        expect(log.at(-1)).toBe('打包完成~')
        expect(log.findIndex((line) => line.includes('VALIDATING'))).toBeLessThan(
          log.findIndex((line) => line.includes('UPLOADING'))
        )
        expect(events.at(-1)?.type).toBe('result')
      } else {
        expect(log).not.toContain('打包完成~')
        expect(events.at(-1)?.type).toBe('error')
      }
    }
  )
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runnerJob(targetId: string): RunnerJobInput {
  return {
    jobId: randomUUID(),
    artifactId: randomUUID(),
    targetId,
    environmentId: TEST_ENVIRONMENT_ID,
    environmentSlug: TEST_ENVIRONMENT_SLUG,
    branch: 'feature/test',
    requestedBy: 'gz',
    artifactBaseUrl: 'http://localhost:9872',
    project: {
      id: targetId,
      kind: targetId === 'webapp' ? 'webapp' : 'h5-site',
      repositoryUrl: 'https://git.example.test/project.git',
      installCommand: 'pnpm install',
      buildCommand: 'pnpm build',
      outputDirectory: 'dist',
      siteAdapter: 'generic-static-v1',
      environment: {
        id: TEST_ENVIRONMENT_ID,
        slug: TEST_ENVIRONMENT_SLUG,
        name: '公共调试环境',
        backendOrigin: TEST_BACKEND_ORIGIN,
      },
    },
  }
}

async function checkoutHarness(input: {
  repositoryCache?: NonNullable<RunnerOptions['repositoryCache']>
  repositoryUrl?: string
  branch?: string
  availableDiskBytes?: (directory: string) => Promise<number>
  readGitSshIdentity?: () => Promise<Buffer>
  runCommand?: (request: {
    command: string
    args: string[]
    cwd: string
    displayCommand?: string
  }) => Promise<string>
}): Promise<{ root: string; logPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-checkout-'))
  roots.push(root)
  const logPath = path.join(root, 'checkout.log')
  const log = createWriteStream(logPath)
  const job = runnerJob('base')
  job.project.repositoryUrl = input.repositoryUrl || 'https://git.example.test/kook/kook.git'
  if (input.branch) job.branch = input.branch
  try {
    await checkoutRepository({
      job,
      options: {
        internalToken: 'runner-token',
        runnerRoot: root,
        artifactStore: new FileArtifactStore(path.join(root, 'artifacts')),
        keepWorkspace: false,
        settingsSecret: 'test-secret',
        repositoryCache: input.repositoryCache,
        availableDiskBytes: input.availableDiskBytes || (async () => 5 * 1024 ** 3),
        readGitSshIdentity: input.readGitSshIdentity,
      },
      jobDirectory: root,
      sourceDirectory: path.join(root, 'source'),
      log,
      runCommand: input.runCommand ? (request) => input.runCommand!(request) : undefined,
    })
    return { root, logPath }
  } finally {
    await new Promise<void>((resolve, reject) => {
      log.on('error', reject)
      log.end(resolve)
    })
  }
}

describe('site build public path', () => {
  it('gives webapp builds an Artifact-specific /app/ prefix', () => {
    const job = runnerJob('webapp')

    expect(buildPublicPath(job, 'https://preview.example.test/remote/')).toBe(
      `/__cuddly/artifacts/${job.artifactId}/app/`
    )
  })

  it('keeps the webapp id fallback for queued snapshots created before kind was recorded', () => {
    const job = runnerJob('webapp')
    delete job.project.kind

    expect(buildPublicPath(job, 'https://preview.example.test/remote/')).toBe(
      `/__cuddly/artifacts/${job.artifactId}/app/`
    )
  })

  it('does not apply the webapp prefix to other generic static sites', () => {
    const job = runnerJob('biz')
    job.project.kind = 'spa-site'

    expect(buildPublicPath(job, 'https://preview.example.test/remote/')).toBeUndefined()
  })

  it('passes the selected preview prefix through for Remote builds', () => {
    const job = runnerJob('base')
    job.project.kind = 'remote'
    job.project.siteAdapter = 'kook-remote-v1'

    expect(buildPublicPath(job, 'https://preview.example.test/remote/')).toBe(
      'https://preview.example.test/remote/'
    )
  })

  it('uses a host-independent root-relative base for new Remote Artifacts', () => {
    expect(
      remoteArtifactPublicBase('00000000-0000-4000-8000-000000000123', 'base_000000000000')
    ).toBe('/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/base_000000000000/')
  })

  it('lets Remote chunks derive their origin from remoteEntry instead of the host page', () => {
    expect(remoteBuildPublicPath()).toBe('auto')
  })

  it('keeps the KOOK Remote key as the provider-name prefix', () => {
    expect(remoteProviderName('discover', '00000000-0000-4000-8000-000000000123')).toBe(
      'discover_000000000000'
    )
    expect(remoteProviderName('voice-runtime', '12345678-0000-4000-8000-000000000123')).toBe(
      'voice_runtime_123456780000'
    )
  })
})

describe('runner repository cache integration', () => {
  it('passes the repository checkout to the shared cache without invoking direct clone', async () => {
    let cachedBranch = ''
    let commandCount = 0
    await checkoutHarness({
      repositoryCache: {
        checkout: async (input) => {
          cachedBranch = input.branch
          return { cacheHit: true, cacheKey: 'a'.repeat(64), commit: 'b'.repeat(40) }
        },
      },
      runCommand: async () => {
        commandCount += 1
        return ''
      },
    })

    expect(cachedBranch).toBe('feature/test')
    expect(commandCount).toBe(0)
  })

  it('falls back to the original shallow clone when cache infrastructure is unavailable', async () => {
    const commands: Array<{ args: string[]; displayCommand?: string }> = []
    await checkoutHarness({
      repositoryCache: {
        checkout: async () => {
          throw new RepositoryCacheUnavailableError('cache filesystem unavailable')
        },
      },
      runCommand: async (request) => {
        commands.push(request)
        return ''
      },
    })

    expect(commands).toHaveLength(2)
    expect(commands[0]?.args).toEqual(['check-ref-format', '--branch', 'feature/test'])
    expect(commands[1]?.args).toEqual(
      expect.arrayContaining(['clone', '--depth', '1', '--single-branch', '--branch'])
    )
    expect(commands[1]?.displayCommand).toContain('<repository>')
  })

  it('does not retry a direct clone for an unknown cache or remote fetch failure', async () => {
    let commandCount = 0
    await expect(
      checkoutHarness({
        repositoryCache: {
          checkout: async () => {
            throw new Error('origin fetch failed')
          },
        },
        runCommand: async () => {
          commandCount += 1
          return ''
        },
      })
    ).rejects.toThrow('origin fetch failed')
    expect(commandCount).toBe(0)
  })

  it('does not bypass the hard disk watermark with a direct clone', async () => {
    let commandCount = 0
    await expect(
      checkoutHarness({
        repositoryCache: {
          checkout: async () => {
            throw new RepositoryCacheDiskPressureError(1024)
          },
        },
        runCommand: async () => {
          commandCount += 1
          return ''
        },
      })
    ).rejects.toMatchObject({ code: 'RUNNER_DISK_PRESSURE' })
    expect(commandCount).toBe(0)
  })

  it.each([
    'https://user:secret@git.example.test/kook.git',
    'https://@git.example.test/kook.git',
    'https://git.example.test/kook.git?access_token=secret',
    'https://git.example.test/kook.git?',
    'https://git.example.test/kook.git#credential',
    'https://git.example.test/kook.git#',
  ])('rejects an unsafe HTTP repository URL before invoking Git: %s', async (repositoryUrl) => {
    let cacheCount = 0
    let commandCount = 0
    await expect(
      checkoutHarness({
        repositoryUrl,
        repositoryCache: {
          checkout: async () => {
            cacheCount += 1
            return { cacheHit: false, cacheKey: 'a'.repeat(64), commit: 'b'.repeat(40) }
          },
        },
        runCommand: async () => {
          commandCount += 1
          return ''
        },
      })
    ).rejects.toMatchObject({ code: 'UNSAFE_REPOSITORY_URL' })
    expect(cacheCount).toBe(0)
    expect(commandCount).toBe(0)
  })

  it('uses the guarded direct path when an SSH identity cannot be fingerprinted', async () => {
    let cacheCount = 0
    const commands: string[][] = []
    await checkoutHarness({
      repositoryUrl: 'ssh://git@git.example.test/kook.git',
      repositoryCache: {
        checkout: async () => {
          cacheCount += 1
          return { cacheHit: false, cacheKey: 'a'.repeat(64), commit: 'b'.repeat(40) }
        },
      },
      readGitSshIdentity: async () => {
        throw new Error('identity is unavailable')
      },
      runCommand: async (request) => {
        commands.push(request.args)
        return ''
      },
    })

    expect(cacheCount).toBe(0)
    expect(commands[0]).toEqual(['check-ref-format', '--branch', 'feature/test'])
    expect(commands[1]?.[0]).toBe('clone')
  })

  it('separates SSH cache scopes when the fixed identity changes', async () => {
    const credentialScopes: string[] = []
    const checkoutWithIdentity = (identity: string) =>
      checkoutHarness({
        repositoryUrl: 'ssh://git@git.example.test/kook.git',
        readGitSshIdentity: async () => Buffer.from(identity),
        repositoryCache: {
          checkout: async (input) => {
            credentialScopes.push(input.credentialScope)
            return { cacheHit: true, cacheKey: 'a'.repeat(64), commit: 'b'.repeat(40) }
          },
        },
      })

    await checkoutWithIdentity('fixed-identity-one')
    await checkoutWithIdentity('fixed-identity-two')

    expect(credentialScopes).toHaveLength(2)
    expect(credentialScopes[0]).not.toBe(credentialScopes[1])
    expect(credentialScopes[0]).toMatch(/^ssh-key:[a-f0-9]{64}$/)
    expect(credentialScopes.join('\n')).not.toContain('fixed-identity')
  })

  it('removes a direct checkout and fails when the post-clone reject watermark is crossed', async () => {
    let diskCheck = 0
    let cloneCount = 0
    await expect(
      checkoutHarness({
        repositoryCache: {
          checkout: async () => {
            throw new RepositoryCacheUnavailableError('cache filesystem unavailable')
          },
        },
        availableDiskBytes: async () => {
          diskCheck += 1
          return diskCheck === 1 ? 5 * 1024 ** 3 : 1024
        },
        runCommand: async (request) => {
          if (request.args[0] === 'clone') cloneCount += 1
          return ''
        },
      })
    ).rejects.toMatchObject({ code: 'RUNNER_DISK_PRESSURE' })
    expect(cloneCount).toBe(1)
  })

  it('rejects a direct checkout below the cleanup watermark before clone starts', async () => {
    let cloneCount = 0
    await expect(
      checkoutHarness({
        repositoryCache: {
          checkout: async () => {
            throw new RepositoryCacheUnavailableError('cache filesystem unavailable')
          },
        },
        availableDiskBytes: async () => 3 * 1024 ** 3,
        runCommand: async (request) => {
          if (request.args[0] === 'clone') cloneCount += 1
          return ''
        },
      })
    ).rejects.toMatchObject({ code: 'RUNNER_DISK_PRESSURE' })
    expect(cloneCount).toBe(0)
  })

  it('serializes direct clones before taking their disk-space snapshots', async () => {
    let activeClones = 0
    let maximumActiveClones = 0
    let releaseFirst!: () => void
    let announceFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      announceFirst = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const runDirect = () =>
      checkoutHarness({
        repositoryCache: {
          checkout: async () => {
            throw new RepositoryCacheUnavailableError('cache filesystem unavailable')
          },
        },
        availableDiskBytes: async () => 5 * 1024 ** 3,
        runCommand: async (request) => {
          if (request.args[0] !== 'clone') return ''
          activeClones += 1
          maximumActiveClones = Math.max(maximumActiveClones, activeClones)
          if (maximumActiveClones === 1) {
            announceFirst()
            await firstRelease
          }
          activeClones -= 1
          return ''
        },
      })

    const first = runDirect()
    await firstStarted
    const second = runDirect()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(maximumActiveClones).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(maximumActiveClones).toBe(1)
  })
})

describe('runner project concurrency', () => {
  it('allows different projects and rejects a second build for the same project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-'))
    roots.push(root)
    const releases = new Map<string, () => void>()
    const execute: RunnerExecutor = async (job) => {
      await new Promise<void>((resolve) => releases.set(job.targetId, resolve))
    }
    const app = createRunnerApp(
      {
        internalToken: 'runner-token',
        runnerRoot: root,
        artifactStore: new FileArtifactStore(path.join(root, 'artifacts')),
        keepWorkspace: false,
        settingsSecret: 'test-secret',
      },
      execute
    )
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('runner test server has no port')
    const url = `http://127.0.0.1:${address.port}`
    const request = (job: RunnerJobInput) =>
      fetch(`${url}/internal/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(job),
      })

    try {
      const onlineResponse = await request(runnerJob('online-h5'))
      expect(onlineResponse.status).toBe(200)

      const duplicateResponse = await request(runnerJob('online-h5'))
      expect(duplicateResponse.status).toBe(409)
      expect(await duplicateResponse.json()).toMatchObject({ code: 'RUNNER_TARGET_BUSY' })

      const webappResponse = await request(runnerJob('webapp'))
      expect(webappResponse.status).toBe(200)

      const health = await fetch(`${url}/health/ready`).then((response) => response.json())
      expect(health).toMatchObject({
        ok: true,
        busy: true,
        activeCount: 2,
        activeTargets: ['online-h5', 'webapp'],
      })

      releases.forEach((release) => release())
      await Promise.all([onlineResponse.text(), webappResponse.text()])
    } finally {
      releases.forEach((release) => release())
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('rejects a top-level environment that disagrees with the immutable snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-environment-'))
    roots.push(root)
    const execute = vi.fn<RunnerExecutor>()
    const app = createRunnerApp(
      {
        internalToken: 'runner-token',
        runnerRoot: root,
        artifactStore: new FileArtifactStore(path.join(root, 'artifacts')),
        keepWorkspace: false,
        settingsSecret: 'test-secret',
      },
      execute
    )
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('runner test server has no port')
    const job = runnerJob('online-h5')
    job.environmentSlug = 'other'

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(job),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 'INVALID_REQUEST',
        issues: [
          {
            path: ['project', 'environment', 'slug'],
          },
        ],
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('signals an active job and releases its project only after the executor exits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-cancel-'))
    roots.push(root)
    let announceStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    let announceSignaled: () => void = () => undefined
    const signaled = new Promise<void>((resolve) => {
      announceSignaled = resolve
    })
    let releaseExecutor: () => void = () => undefined
    const executorReleased = new Promise<void>((resolve) => {
      releaseExecutor = resolve
    })
    const execute: RunnerExecutor = async (job, _options, _response, cancellationSignal) => {
      if (job.branch !== 'feature/cancel-me') return
      announceStarted()
      await new Promise<void>((resolve) =>
        cancellationSignal.addEventListener('abort', () => resolve(), { once: true })
      )
      announceSignaled()
      await executorReleased
    }
    const app = createRunnerApp(
      {
        internalToken: 'runner-token',
        runnerRoot: root,
        artifactStore: new FileArtifactStore(path.join(root, 'artifacts')),
        keepWorkspace: false,
        settingsSecret: 'test-secret',
      },
      execute
    )
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('runner test server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const job = runnerJob('online-h5')
    job.branch = 'feature/cancel-me'

    try {
      const response = await fetch(`${origin}/internal/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(job),
      })
      await started

      expect(
        (
          await fetch(`${origin}/internal/runs/${job.jobId}/cancel`, {
            method: 'POST',
          })
        ).status
      ).toBe(401)
      expect(
        (
          await fetch(`${origin}/internal/runs/${randomUUID()}/cancel`, {
            method: 'POST',
            headers: { authorization: 'Bearer runner-token' },
          })
        ).status
      ).toBe(404)
      const canceled = await fetch(`${origin}/internal/runs/${job.jobId}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer runner-token' },
      })
      expect(canceled.status).toBe(202)
      expect(await canceled.json()).toEqual({ jobId: job.jobId, status: 'CANCELING' })
      await signaled
      expect(
        (
          await fetch(`${origin}/internal/runs/${job.jobId}/cancel`, {
            method: 'POST',
            headers: { authorization: 'Bearer runner-token' },
          })
        ).status
      ).toBe(202)
      const stillBusy = await fetch(`${origin}/internal/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(runnerJob('online-h5')),
      })
      expect(stillBusy.status).toBe(409)

      releaseExecutor()
      await response.text()

      const next = runnerJob('online-h5')
      const nextResponse = await fetch(`${origin}/internal/run`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(next),
      })
      expect(nextResponse.status).toBe(200)
      await nextResponse.text()
    } finally {
      releaseExecutor()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})

describe('runner Artifact cleanup endpoint', () => {
  it('requires the internal token and removes the exact Artifact directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-cleanup-'))
    roots.push(root)
    const artifactStore = new FileArtifactStore(path.join(root, 'artifacts'))
    await artifactStore.initialize()
    const artifactId = randomUUID()
    const storageKey = `ready/webapp/${artifactId}`
    const artifactDirectory = artifactStore.resolveStorageDirectory(storageKey)
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(path.join(artifactDirectory, 'index.html'), 'ready', 'utf8')
    const app = createRunnerApp({
      internalToken: 'runner-token',
      runnerRoot: root,
      artifactStore,
      keepWorkspace: false,
      settingsSecret: 'test-secret',
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('runner test server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const url = `${origin}/internal/artifacts/delete`
    const inventoryUrl = `${origin}/internal/artifacts/inventory`
    const body = JSON.stringify({ artifactId, storageKey })

    try {
      const unauthorizedInventory = await fetch(inventoryUrl)
      expect(unauthorizedInventory.status).toBe(401)
      const inventoryResponse = await fetch(inventoryUrl, {
        headers: { authorization: 'Bearer runner-token' },
      })
      expect(inventoryResponse.status).toBe(200)
      expect(runnerArtifactInventorySchema.parse(await inventoryResponse.json()).artifacts).toEqual(
        [
          expect.objectContaining({
            artifactId,
            targetId: 'webapp',
            storageKey,
            state: 'READY',
          }),
        ]
      )

      const unauthorized = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      expect(unauthorized.status).toBe(401)
      await expect(artifactStore.readText(storageKey, 'index.html')).resolves.toBe('ready')

      const deleted = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body,
      })
      expect(deleted.status).toBe(204)
      await expect(artifactStore.readText(storageKey, 'index.html')).resolves.toBeNull()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})

describe('Online H5 asset public path patch', () => {
  it('supports the current CDN config while preserving upstream fallbacks', () => {
    const source = `"use strict";

module.exports = {
  test: "/",
  online: "https://static-m.kookapp.cn/",
  dev: "https://static-m.dev.chuanyuapp.com/",
};
`

    expect(patchOnlineH5AssetPrefixSource(source)).toBe(`"use strict";

module.exports = {
  test: process.env.CUDDLY_ASSET_PREFIX || "/",
  online: process.env.CUDDLY_ASSET_PREFIX || "https://static-m.kookapp.cn/",
  dev: process.env.CUDDLY_ASSET_PREFIX || "https://static-m.dev.chuanyuapp.com/",
};
`)
  })

  it('supports quoted properties and is idempotent', () => {
    const source = `module.exports = {
  'test': process.env.CUDDLY_ASSET_PREFIX || '/',
  "online": process.env.CUDDLY_ASSET_PREFIX || '/',
}
`
    expect(patchOnlineH5AssetPrefixSource(source)).toBe(source)
  })

  it('keeps historical configs without a dev property compatible', () => {
    const source = `module.exports = {
  test: '/',
  online: 'https://static-m.kookapp.cn/',
}
`
    expect(patchOnlineH5AssetPrefixSource(source)).toBe(`module.exports = {
  test: process.env.CUDDLY_ASSET_PREFIX || '/',
  online: process.env.CUDDLY_ASSET_PREFIX || 'https://static-m.kookapp.cn/',
}
`)
  })

  it('supports the historical final property without a comma and preserves its comment', () => {
    const source = `module.exports = {
  "test": "/",
  "online": "/"// replace with the production CDN
}
`

    expect(patchOnlineH5AssetPrefixSource(source)).toBe(`module.exports = {
  "test": process.env.CUDDLY_ASSET_PREFIX || "/",
  "online": process.env.CUDDLY_ASSET_PREFIX || "/"// replace with the production CDN
}
`)
  })

  it('rejects an incompatible CDN config with a dedicated failure', () => {
    expect(() => patchOnlineH5AssetPrefixSource('module.exports = { dev: "/" }\n')).toThrow(
      'Online H5 CDN config does not expose the expected test property'
    )
  })

  it('prefers the current Rsbuild CDN config when both layouts exist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-online-h5-config-'))
    roots.push(root)
    const current = path.join(root, 'rsbuild-config', 'cdnPath.js')
    const historical = path.join(root, 'config', 'cdnPath.js')
    await Promise.all([
      mkdir(path.dirname(current), { recursive: true }),
      mkdir(path.dirname(historical), { recursive: true }),
    ])
    await Promise.all([writeFile(current, 'module.exports = {}\n'), writeFile(historical, '')])

    await expect(resolveOnlineH5AssetPrefixConfigPath(root)).resolves.toBe(current)
  })

  it('falls back to the historical Webpack CDN config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-online-h5-config-'))
    roots.push(root)
    const historical = path.join(root, 'config', 'cdnPath.js')
    await mkdir(path.dirname(historical), { recursive: true })
    await writeFile(historical, 'module.exports = {}\n')

    await expect(resolveOnlineH5AssetPrefixConfigPath(root)).resolves.toBe(historical)
  })

  it('reports every supported Online H5 config layout when neither exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-online-h5-config-'))
    roots.push(root)

    await expect(resolveOnlineH5AssetPrefixConfigPath(root)).rejects.toThrow(
      `tried ${path.join('rsbuild-config', 'cdnPath.js')}, ${path.join('config', 'cdnPath.js')}`
    )
  })
})

describe('standalone Remote build config', () => {
  const source = `const dev = !process.argv.includes('production')
const version = resolve_build_remote_version({ app_root_dir: root, package_json: pkg })
const publicPath =
  dev || !process.env.PUB_PATH
    ? 'auto'
    : get_remote_asset_public_path({ pub_path: process.env.PUB_PATH, oss_path_key: pkg.oss_path_key })
const config = {
  output: {
    path: 'dist',
    publicPath,
    clean: true,
  },
  provider: dev ? 'mini_game' : version,
  metadata: { asset_public_path: publicPath },
}
config
`

  it('keeps mini_game provider isolation and metadata while making runtime chunks auto-relative', () => {
    const patched = patchStandaloneRemoteConfigSource(source)
    expect(patchStandaloneRemoteConfigSource(patched)).toBe(patched)
    const env = {
      ...remoteBuildEnvironment(runnerJob('mini_game')),
      PUB_PATH: 'https://img.kookapp.cn/',
    }
    const result = vm.runInNewContext(patched, {
      root: '/repo/apps/mini_game',
      pkg: { oss_path_key: 'mini_game' },
      process: { argv: ['--mode', 'production'], env },
      resolve_build_remote_version: () => env.VERSION,
      get_remote_asset_public_path: () => env.REMOTE_ASSET_PUBLIC_PATH,
    })
    expect(result.provider).toBe(env.VERSION)
    expect(result.provider).toMatch(/^mini_game_/)
    expect(result.output.publicPath).toBe('auto')
    expect(result.metadata.asset_public_path).toBe(env.REMOTE_ASSET_PUBLIC_PATH)
    const official = vm.runInNewContext(patched, {
      root: '/repo/apps/mini_game',
      pkg: { oss_path_key: 'mini_game' },
      process: { argv: ['--mode', 'production'], env: { PUB_PATH: 'https://img.kookapp.cn/' } },
      resolve_build_remote_version: () => 'mini_game_v001',
      get_remote_asset_public_path: () => 'https://img.kookapp.cn/mf-assets/v1/mini_game/',
    })
    expect(official.output.publicPath).toBe('https://img.kookapp.cn/mf-assets/v1/mini_game/')
    expect(official.provider).toBe('mini_game_v001')
  })

  it('rejects unsupported versions and output expressions rather than patching unrelated metadata', () => {
    expect(() =>
      patchStandaloneRemoteConfigSource(source.replace('resolve_build_remote_version(', 'other('))
    ).toThrow('Standalone Remote config must use resolve_build_remote_version')
    expect(() =>
      patchStandaloneRemoteConfigSource(
        source.replace('    publicPath,', "    publicPath: '/fixed/',")
      )
    ).toThrow('Standalone Remote config must expose output.publicPath')
    expect(() =>
      patchStandaloneRemoteConfigSource(source.replace('  output: {', '  metadataOnly: {'))
    ).toThrow('Standalone Remote config must expose output.publicPath')
  })

  it('patches rspack.config.ts when the legacy layout is absent and preserves legacy precedence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-mini-game-config-'))
    roots.push(root)
    const configPath = path.join(root, 'rspack.config.ts')
    await writeFile(configPath, source)
    const log = createWriteStream(path.join(root, 'build.log'))
    try {
      await applyRemoteBuildPatches(path.join(root, 'dist'), log)
      expect(await readFile(configPath, 'utf8')).toBe(patchStandaloneRemoteConfigSource(source))
      await applyRemoteBuildPatches(path.join(root, 'dist'), log)
      expect(await readFile(configPath, 'utf8')).toBe(patchStandaloneRemoteConfigSource(source))

      await mkdir(path.join(root, 'scripts'))
      const legacy =
        'const templateName = process.env.VERSION\nconst publicPath = `${process.env.PUB_PATH}${templateName}/`\n'
      await writeFile(path.join(root, 'scripts/get_config.js'), legacy)
      await writeFile(path.join(root, 'scripts/rspack.config.build.js'), 'module.exports = {}\n')
      await writeFile(configPath, 'unsupported standalone config')
      await applyRemoteBuildPatches(path.join(root, 'dist'), log)
      expect(await readFile(path.join(root, 'scripts/get_config.js'), 'utf8')).toBe(
        patchRemoteAssetPrefixSource(legacy)
      )
      expect(await readFile(configPath, 'utf8')).toBe('unsupported standalone config')
    } finally {
      await new Promise<void>((resolve) => log.end(resolve))
    }
  })
})

describe('Remote build public path patch', () => {
  it('supports incremental Remote configs without changing helper calls used for metadata', () => {
    const source = `const publicPath = get_remote_asset_public_path()\nconst assetPublicPath = get_remote_asset_public_path()\n`
    const patched = patchRemoteAssetPrefixSource(source)
    expect(patched).toBe(
      `const publicPath = process.env.CUDDLY_ASSET_PREFIX || get_remote_asset_public_path()\nconst assetPublicPath = get_remote_asset_public_path()\n`
    )
    expect(patchRemoteAssetPrefixSource(patched)).toBe(patched)
  })

  it('keeps runtime chunks auto-relative while release metadata and cache use an artifact path', () => {
    const job = runnerJob('voice_runtime')
    const env = remoteBuildEnvironment(job)
    const source = `
function get_remote_asset_public_path() {
  const explicit = String(process.env.REMOTE_ASSET_PUBLIC_PATH || '').trim()
  if (explicit) return explicit.replace(/\\/+$/, '') + '/'
  return new URL('mf-assets/v1/voice_runtime/', new URL(process.env.PUB_PATH).origin).href
}
function output(mode) {
  if (mode === 'development') return { publicPath: 'auto' }
  const publicPath = get_remote_asset_public_path()
  return { publicPath, chunkFilename: 'static/js/[name].[contenthash:16].chunk.js' }
}
const assetPublicPath = get_remote_asset_public_path()
const result = { output: output('production'), dev: output('development'), assetPublicPath,
  assetUrl: assetPublicPath + 'static/js/main.123456789abcdef0.js', cachePath: assetPublicPath }
result
`
    const patched = patchRemoteAssetPrefixSource(source)
    const result = vm.runInNewContext(patched, {
      process: { env: { ...env, PUB_PATH: 'not-a-url' } },
      URL,
    })
    const expected = remoteArtifactPublicBase(job.artifactId, env.VERSION)
    expect(result.output.publicPath).toBe('auto')
    expect(result.dev.publicPath).toBe('auto')
    expect(result.assetPublicPath).toBe(expected)
    expect(result.cachePath).toBe(expected)
    expect(result.assetUrl).toBe(`${expected}static/js/main.123456789abcdef0.js`)
    expect(
      remoteBuildEnvironment({ ...job, artifactId: randomUUID() }).REMOTE_ASSET_PUBLIC_PATH
    ).not.toBe(expected)
    const official = vm.runInNewContext(patched, {
      process: { env: { PUB_PATH: 'https://img.kookapp.cn/voice_runtime/' } },
      URL,
    })
    expect(official.output.publicPath).toBe('https://img.kookapp.cn/mf-assets/v1/voice_runtime/')
    expect(official.assetPublicPath).toBe(official.output.publicPath)
  })

  it.each(['templateName', 'remoteName'])(
    'preserves old %s paths and trailing comments',
    (name) => {
      const source = `  const publicPath = \`\${process.env.PUB_PATH}\${${name}}/\`; // CDN\r\n`
      expect(patchRemoteAssetPrefixSource(source)).toBe(
        source.replace('= ', '= process.env.CUDDLY_ASSET_PREFIX || ')
      )
    }
  )

  it('does not accept an unrelated override or partially recognized expression', () => {
    expect(() =>
      patchRemoteAssetPrefixSource(
        "const unrelated = process.env.CUDDLY_ASSET_PREFIX || '/'\nconst publicPath = unknown()\n"
      )
    ).toThrow('Remote build config must declare publicPath')
    expect(() =>
      patchRemoteAssetPrefixSource("const publicPath = get_remote_asset_public_path() + '/extra'\n")
    ).toThrow('Remote build config must declare publicPath')
  })

  it('keeps existing build commands but gives the Artifact prefix priority', () => {
    const source = 'const publicPath = `${process.env.PUB_PATH}${templateName}/`\n'
    expect(patchRemoteAssetPrefixSource(source)).toBe(
      'const publicPath = process.env.CUDDLY_ASSET_PREFIX || `${process.env.PUB_PATH}${templateName}/`\n'
    )
  })

  it('is idempotent', () => {
    const source =
      'const publicPath = process.env.CUDDLY_ASSET_PREFIX || `${process.env.PUB_PATH}${remoteName}/`\n'
    expect(patchRemoteAssetPrefixSource(source)).toBe(source)
  })

  it('gives Cuddly VERSION priority on historical Remote configs', () => {
    const source = "const templateName = require('../package.json').templateName || 'base_v0'\n"
    expect(patchRemoteProviderVersionSource(source)).toBe(
      "const templateName = process.env.VERSION || require('../package.json').templateName || 'base_v0'\n"
    )
  })

  it('preserves configs that already resolve an explicit build version', () => {
    const source = `const remoteName = resolve_build_remote_version({
  app_root_dir: __dirname,
})
`
    expect(patchRemoteProviderVersionSource(source)).toBe(source)
  })

  it('resolves KOOK logicModels self-imports without changing their target module', () => {
    const source = `import ProxyReactiveClass from '@/models/ReactiveData/ProxyReactiveData'\nimport type { Schema } from '@/models/ReactiveData/ProxyReactiveData'\n`
    const patched = `import ProxyReactiveClass from '../../ReactiveData/ProxyReactiveData'\nimport type { Schema } from '../../ReactiveData/ProxyReactiveData'\n`
    expect(patchKookLogicModelsSelfImportSource(source)).toBe(patched)
    expect(patchKookLogicModelsSelfImportSource(patched)).toBe(patched)
  })
})

describe('package manager registry environment', () => {
  it('uses npmmirror for npm, pnpm, and Corepack when enabled', () => {
    const environment = packageManagerEnvironment(
      {
        PATH: '/usr/bin',
        npm_config_registry: 'https://registry.example.test',
        COREPACK_NPM_REGISTRY: 'https://registry.example.test',
      },
      true
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      npm_config_registry: 'https://registry.npmmirror.com',
      COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com',
    })
  })

  it('leaves registry selection to the project when disabled', () => {
    const environment = packageManagerEnvironment(
      {
        PATH: '/usr/bin',
        npm_config_registry: 'https://registry.example.test',
        NPM_CONFIG_REGISTRY: 'https://registry.example.test',
        COREPACK_NPM_REGISTRY: 'https://registry.example.test',
      },
      false
    )

    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('enables dependency build scripts for both pnpm 10 and pnpm 11', () => {
    const environment = packageManagerEnvironment({ PATH: '/usr/bin' }, true, true)

    expect(environment).toMatchObject({
      npm_config_dangerously_allow_all_builds: 'true',
      pnpm_config_dangerously_allow_all_builds: 'true',
    })
  })

  it('removes dependency build overrides outside the install command', () => {
    const environment = packageManagerEnvironment(
      {
        PATH: '/usr/bin',
        npm_config_dangerously_allow_all_builds: 'true',
        pnpm_config_dangerously_allow_all_builds: 'true',
      },
      true
    )

    expect(environment).not.toHaveProperty('npm_config_dangerously_allow_all_builds')
    expect(environment).not.toHaveProperty('pnpm_config_dangerously_allow_all_builds')
  })

  it('keeps project devDependencies available without installing Git hooks', () => {
    const environment = projectInstallEnvironment(
      {
        PATH: '/usr/bin',
        NODE_ENV: 'production',
        npm_config_omit: 'dev',
        NPM_CONFIG_PRODUCTION: 'true',
        npm_config_only: 'production',
      },
      true
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      NODE_ENV: 'development',
      HUSKY: '0',
    })
    expect(environment).not.toHaveProperty('npm_config_omit')
    expect(environment).not.toHaveProperty('NPM_CONFIG_PRODUCTION')
    expect(environment).not.toHaveProperty('npm_config_only')
  })

  it('keeps private Git dependencies non-interactive and proxy-aware', () => {
    const environment = projectGitEnvironment({ ALL_PROXY: 'socks5h://mihomo:7890' })

    expect(environment).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(environment.GIT_SSH_COMMAND).toContain('BatchMode=yes')
    expect(environment.GIT_SSH_COMMAND).toContain('ProxyCommand=nc -X 5 -x mihomo:7890 %h %p')
  })

  it('exposes stable environment inputs without changing the configured command', () => {
    const job = runnerJob('online-h5')

    expect(projectEnvironmentVariables(job)).toEqual({
      CUDDLY_ENVIRONMENT_SLUG: TEST_ENVIRONMENT_SLUG,
      CUDDLY_BACKEND_ORIGIN: TEST_BACKEND_ORIGIN,
    })
    expect(runnerEnvironmentMatchesSnapshot(job)).toBe(true)

    job.environmentSlug = 'other'
    expect(runnerEnvironmentMatchesSnapshot(job)).toBe(false)
  })
})

describe('pnpm command detection', () => {
  it.each([
    'pnpm install',
    'corepack pnpm install',
    'corepack pnpm@9.15.9 install',
    'pnpm@11.22.0 install',
    'CI=true pnpm install',
    'cd app && pnpm install',
  ])('%s', (command) => {
    expect(commandUsesPnpm(command)).toBe(true)
  })

  it.each(['npm install', 'yarn install', 'echo pnpm'])('%s', (command) => {
    expect(commandUsesPnpm(command)).toBe(false)
  })
})

describe('system pnpm command execution', () => {
  it('executes the configured pnpm command without a version wrapper or PATH override', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-pnpm-shell-'))
    roots.push(root)
    const log = createWriteStream(path.join(root, 'install.log'))
    try {
      await runInstallCommand(
        'pnpm install',
        {
          cwd: root,
          env: { PATH: '/usr/bin' },
          log,
        },
        async (input) => {
          expect(input.command).toBe('/bin/sh')
          expect(input.args).toEqual(['-lc', 'pnpm install'])
          expect(input.env?.PATH).toBe('/usr/bin')
          expect(input.env?.CUDDLY_PACKAGE_MANAGER_BIN).toBeUndefined()
          return ''
        }
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        log.on('error', reject)
        log.end(resolve)
      })
    }
  })
})

describe('package manager lockfile preflight', () => {
  it('warns about pnpm against an npm-only lockfile without blocking the build', () => {
    expect(
      packageManagerLockfileWarning('corepack pnpm install --frozen-lockfile', {
        packageLock: true,
        pnpmLock: false,
      })
    ).toContain('only contains package-lock.json')
  })

  it('warns about npm against a pnpm-only lockfile and stays quiet when both exist', () => {
    expect(
      packageManagerLockfileWarning('npm ci', { packageLock: false, pnpmLock: true })
    ).toContain('only contains pnpm-lock.yaml')
    expect(
      packageManagerLockfileWarning('pnpm install', { packageLock: true, pnpmLock: true })
    ).toBeNull()
  })
})

describe('pnpm outdated lockfile fallback', () => {
  it('keeps frozen installs for healthy branches', () => {
    expect(
      pnpmOutdatedLockfileFallbackCommand(
        'corepack pnpm@9.15.9 install --frozen-lockfile',
        new RunnerFailure('COMMAND_FAILED', '/bin/sh exited with 1', 'network timeout')
      )
    ).toBeNull()
  })

  it('retries only pnpm outdated-lockfile failures without frozen mode', () => {
    expect(
      pnpmOutdatedLockfileFallbackCommand(
        "corepack pnpm@9.15.9 --filter '{./apps/guild}...' install --frozen-lockfile",
        new RunnerFailure(
          'COMMAND_FAILED',
          '/bin/sh exited with 1',
          'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile'
        )
      )
    ).toBe("corepack pnpm@9.15.9 --filter '{./apps/guild}...' install --no-frozen-lockfile")
  })

  it('does not retry npm or an explicitly non-frozen pnpm install', () => {
    const failure = new RunnerFailure(
      'COMMAND_FAILED',
      '/bin/sh exited with 1',
      'ERR_PNPM_OUTDATED_LOCKFILE'
    )
    expect(pnpmOutdatedLockfileFallbackCommand('npm ci', failure)).toBeNull()
    expect(
      pnpmOutdatedLockfileFallbackCommand('pnpm install --no-frozen-lockfile', failure)
    ).toBeNull()
  })

  it('runs the relaxed command once after the exact frozen-lockfile failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cuddly-runner-install-'))
    roots.push(root)
    const log = createWriteStream(path.join(root, 'install.log'))
    const commands: string[] = []
    try {
      await runInstallCommand(
        'corepack pnpm@9.15.9 install --frozen-lockfile',
        { cwd: root, log },
        async (input) => {
          commands.push(input.displayCommand || '')
          if (commands.length === 1) {
            throw new RunnerFailure(
              'COMMAND_FAILED',
              '/bin/sh exited with 1',
              'ERR_PNPM_OUTDATED_LOCKFILE'
            )
          }
          return ''
        }
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        log.on('error', reject)
        log.end(resolve)
      })
    }

    expect(commands).toEqual([
      'corepack pnpm@9.15.9 install --frozen-lockfile',
      'corepack pnpm@9.15.9 install --no-frozen-lockfile',
    ])
  })
})

describe('runner response heartbeat', () => {
  it('writes a blank NDJSON line while the response remains open', () => {
    const chunks: string[] = []
    const written = writeRunnerHeartbeat({
      destroyed: false,
      writableEnded: false,
      write: (chunk: string) => {
        chunks.push(chunk)
        return true
      },
    })

    expect(written).toBe(true)
    expect(chunks).toEqual(['\n'])
  })

  it('does not write after the response closes', () => {
    const written = writeRunnerHeartbeat({
      destroyed: true,
      writableEnded: false,
      write: () => {
        throw new Error('should not write')
      },
    })

    expect(written).toBe(false)
  })
})
