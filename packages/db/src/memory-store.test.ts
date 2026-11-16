import { createHash, randomUUID } from 'node:crypto'

import type { Artifact, SiteBinding } from '@cuddly/contracts'
import { describe, expect, it, vi } from 'vitest'

import { MemoryStore } from './memory-store'
import { kookRemoteBuildCommand, kookRemoteInstallCommand } from './project-templates'
import { PREVIEW_REVOKE_GRACE_MS } from './store'

const SHARED_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'

async function createSharedBuildJob(
  store: MemoryStore,
  record: Omit<Parameters<MemoryStore['createBuildJob']>[0], 'environmentId' | 'environmentSlug'>
) {
  await enableSharedTarget(store, record.targetId)
  return store.createBuildJob({
    ...record,
    environmentId: SHARED_ENVIRONMENT_ID,
    environmentSlug: 'shared',
  })
}

async function enableSharedTarget(store: MemoryStore, targetId: string) {
  const target = await store.getBuildTarget(targetId)
  if (!target) throw new Error(`Missing test target: ${targetId}`)
  if (!target.enabled) {
    await store.saveBuildTarget(
      { ...target, enabled: true, configurationSource: 'database' },
      'test'
    )
  }
  const config = await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, targetId)
  if (!config) throw new Error(`Missing shared test config: ${targetId}`)
  if (!config.enabled) {
    await store.saveProjectEnvironmentConfig({ ...config, enabled: true }, 'test')
  }
}

async function createSharedPreview(
  store: MemoryStore,
  record: Omit<
    Parameters<MemoryStore['createPreviewSession']>[0],
    'environmentId' | 'environmentSlug'
  >
) {
  return store.createPreviewSession({
    ...record,
    environmentId: SHARED_ENVIRONMENT_ID,
    environmentSlug: 'shared',
  })
}

async function createEnvironment(
  store: MemoryStore,
  slug: string,
  status: 'ACTIVE' | 'FROZEN' | 'ARCHIVED' = 'ACTIVE'
) {
  return store.saveEnvironment(
    {
      id: randomUUID(),
      slug,
      name: `${slug} 环境`,
      status,
      backendOrigin: `https://${slug}.api.example.test`,
      useInternalProxy: false,
      resourceProxyPrefixes: [],
      currentRevisionId: null,
    },
    'gz'
  )
}

function siteBinding(id: string, environmentSlug = 'shared'): SiteBinding {
  return {
    id,
    name: id,
    hostname: `${id}.bifrost.vanillacake.cn`,
    targetId: 'webapp',
    environmentSlug,
    fallbackOrigin: 'https://www.kookapp.cn',
    upstreamOrigin: 'https://www.kookapp.cn',
    officialOrigin: 'https://www.kookapp.cn',
    enabled: true,
    remoteTargetIds: ['base'],
    resourceProxyPrefixes: [],
  }
}

describe('built-in project templates', () => {
  it('includes every KOOK Remote as an explicit disabled build target', async () => {
    const store = new MemoryStore()
    const targets = await store.listBuildTargets(true)
    const webapp = targets.find((target) => target.id === 'webapp')
    const base = targets.find((target) => target.id === 'base')
    const voiceRuntime = targets.find((target) => target.id === 'voice_runtime')
    const miniGame = targets.find((target) => target.id === 'mini_game')

    expect(webapp).toMatchObject({
      installCommand: 'npm run i',
      buildCommand: 'npm run build_fast',
      outputDirectory: 'build',
    })
    expect(base).toMatchObject({
      kind: 'remote',
      installCommand: kookRemoteInstallCommand('base'),
      buildCommand: kookRemoteBuildCommand('base'),
      outputDirectory: 'apps/base/dist',
      siteAdapter: 'kook-remote-v1',
      enabled: false,
    })
    expect(voiceRuntime).toMatchObject({
      kind: 'remote',
      installCommand: kookRemoteInstallCommand('voice_runtime'),
      buildCommand: kookRemoteBuildCommand('voice_runtime'),
      outputDirectory: 'apps/voice_runtime/dist',
    })
    expect(miniGame).toMatchObject({
      kind: 'remote',
      installCommand: kookRemoteInstallCommand('mini_game'),
      buildCommand: kookRemoteBuildCommand('mini_game'),
      outputDirectory: 'apps/mini_game/dist',
      enabled: false,
    })
    expect(
      await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'mini_game')
    ).toMatchObject({
      targetId: 'mini_game',
      enabled: false,
      buildCommand: kookRemoteBuildCommand('mini_game'),
      outputDirectory: 'apps/mini_game/dist',
    })
  })
})

function artifact(
  jobId: string,
  branch: string,
  environmentId = SHARED_ENVIRONMENT_ID,
  environmentSlug = 'shared'
): Artifact {
  const id = randomUUID()
  const builtAt = new Date().toISOString()
  return {
    id,
    buildJobId: jobId,
    environmentId,
    environmentSlug,
    targetId: 'online-h5',
    branch,
    status: 'READY',
    storageKey: `ready/online-h5/${id}`,
    builtAt,
    createdBy: 'gz',
    manifest: {
      schemaVersion: 1,
      artifactId: id,
      target: 'online-h5',
      branch,
      builtAt,
      serve: {
        siteAdapter: 'kook-online-h5-v1',
        entrypoints: ['index.htm'],
        publicBase: `/__cuddly/artifacts/${id}/`,
      },
      files: [
        {
          path: 'index.htm',
          size: 1,
          contentType: 'text/html; charset=utf-8',
          digest: 'sha256:test',
          cacheClass: 'html',
        },
      ],
    },
  }
}

function remoteArtifact(
  branch: string,
  environmentId = SHARED_ENVIRONMENT_ID,
  environmentSlug = 'shared'
): Artifact {
  const id = randomUUID()
  const builtAt = new Date().toISOString()
  const providerName = `cuddly_base_${id.replaceAll('-', '').slice(0, 12)}`
  return {
    id,
    buildJobId: randomUUID(),
    environmentId,
    environmentSlug,
    targetId: 'base',
    branch,
    status: 'READY',
    storageKey: `ready/base/${id}`,
    builtAt,
    createdBy: 'gz',
    manifest: {
      schemaVersion: 1,
      artifactId: id,
      target: 'base',
      branch,
      builtAt,
      serve: {
        siteAdapter: 'kook-remote-v1',
        entrypoints: ['remoteEntry.js'],
        publicBase: `https://bifrost.example.test/__cuddly/preview-artifacts/${id}/${providerName}/`,
        remote: { moduleKey: 'base', providerName, entryPath: 'remoteEntry.js' },
      },
      files: [
        {
          path: 'remoteEntry.js',
          size: 1,
          contentType: 'text/javascript',
          digest: 'sha256:test',
          cacheClass: 'asset',
        },
      ],
    },
  }
}

describe('MemoryStore environment publication', () => {
  it('keeps a completed build separate from the active environment until publication', async () => {
    const store = new MemoryStore()
    const job = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/qa-panel',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const built = artifact(job.id, job.branch)
    await store.createArtifact(built)

    expect(await store.resolveCurrentArtifact('shared', 'online-h5')).toBeNull()

    const revision = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'QA publish',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: built.id }],
    })

    expect((await store.resolveCurrentArtifact('shared', 'online-h5'))?.id).toBe(built.id)
    expect(await store.isArtifactReferenced(revision.environmentId, built.id)).toBe(true)
  })

  it('keeps artifacts from older revisions referenced after switching', async () => {
    const store = new MemoryStore()
    await enableSharedTarget(store, 'online-h5')
    const first = artifact(randomUUID(), 'release/one')
    const second = artifact(randomUUID(), 'release/two')
    await store.createArtifact(first)
    await store.createArtifact(second)

    const revisionOne = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'one',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: first.id }],
    })
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: revisionOne.id,
      message: 'two',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: second.id }],
    })

    const environment = await store.getEnvironment('shared')
    expect(environment).not.toBeNull()
    expect(await store.isArtifactReferenced(environment!.id, first.id)).toBe(true)
    expect((await store.resolveCurrentArtifact('shared', 'online-h5'))?.id).toBe(second.id)
  })

  it('keeps legacy Remote selections queryable without granting runtime file access', async () => {
    const store = new MemoryStore()
    await store.saveBuildTarget(
      {
        ...(await store.getBuildTarget('base'))!,
        repositoryUrl: 'ssh://git.example.test/kook.git',
        enabled: true,
        configurationSource: 'database',
      },
      'gz'
    )
    await enableSharedTarget(store, 'base')
    const remote = remoteArtifact('feature/base')
    await store.createArtifact(remote)
    const first = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'remote on',
      createdBy: 'gz',
      selections: [{ targetId: 'base', artifactId: remote.id }],
    })

    expect((await store.resolveCurrentRemoteArtifacts('shared', ['base']))[0]?.id).toBe(remote.id)
    expect(await store.isRemoteArtifactReferenced(remote.id)).toBe(false)

    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: first.id,
      message: 'remote off',
      createdBy: 'gz',
      selections: [],
    })
    expect(await store.resolveCurrentRemoteArtifacts('shared', ['base'])).toEqual([])
    expect(await store.isRemoteArtifactReferenced(remote.id)).toBe(false)
  })
})

describe('MemoryStore environment isolation', () => {
  it('creates new environments without inherited projects and keeps archived environments admin-visible', async () => {
    const store = new MemoryStore()
    const staging = await createEnvironment(store, 'staging')

    expect(staging.useInternalProxy).toBe(false)
    const saved = await store.saveEnvironment(
      {
        ...staging,
        useInternalProxy: true,
        resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
      },
      'gz'
    )
    expect(saved).toMatchObject({
      useInternalProxy: true,
      resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
    })
    saved.resourceProxyPrefixes.push('https://unexpected.example.test/')
    const firstRead = (await store.getEnvironment(staging.id))!
    firstRead.resourceProxyPrefixes.push('https://also-unexpected.example.test/')
    expect((await store.getEnvironment(staging.slug))?.resourceProxyPrefixes).toEqual([
      'https://img.chuanyuapp.com/',
    ])
    const listed = await store.listEnvironments()
    listed
      .find((environment) => environment.id === staging.id)!
      .resourceProxyPrefixes.push('https://listed-mutation.example.test/')
    expect((await store.getEnvironment(staging.id))?.resourceProxyPrefixes).toEqual([
      'https://img.chuanyuapp.com/',
    ])
    expect(await store.listProjectEnvironmentConfigs(staging.id)).toEqual([])
    const sharedConfig = (await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'webapp'))!
    await expect(
      store.saveProjectEnvironmentConfigs(
        [sharedConfig, { ...sharedConfig, environmentId: staging.id, targetId: 'biz' }],
        'gz'
      )
    ).rejects.toThrow('must belong to one environment')
    await expect(
      store.saveProjectEnvironmentConfigs(
        [
          { ...sharedConfig, environmentId: staging.id },
          { ...sharedConfig, environmentId: staging.id },
        ],
        'gz'
      )
    ).rejects.toThrow('targets must be unique')
    expect(await store.listProjectEnvironmentConfigs(staging.id)).toEqual([])
    expect((await store.listEnvironments()).map((environment) => environment.slug)).toContain(
      'staging'
    )

    await store.saveEnvironment({ ...staging, status: 'ARCHIVED' }, 'gz')
    expect((await store.listEnvironments()).map((environment) => environment.slug)).not.toContain(
      'staging'
    )
    expect((await store.listEnvironments(true)).map((environment) => environment.slug)).toContain(
      'staging'
    )
    await expect(
      store.saveEnvironment({ ...staging, slug: 'renamed-staging' }, 'gz')
    ).rejects.toThrow('Environment slug cannot be changed')
  })

  it('requires both global and environment project switches and preserves explicit commands', async () => {
    const store = new MemoryStore()
    const config = (await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'online-h5'))!
    await store.saveProjectEnvironmentConfig(
      {
        ...config,
        enabled: true,
        installCommand: 'pnpm install --environment-specific',
        buildCommand: 'pnpm build --environment-specific',
      },
      'gz'
    )
    await expect(
      store.createBuildJob({
        id: randomUUID(),
        environmentId: SHARED_ENVIRONMENT_ID,
        environmentSlug: 'shared',
        targetId: 'online-h5',
        branch: 'master',
        profile: 'qa-web',
        requestedBy: 'gz',
        idempotencyKey: null,
        targetSnapshot: null,
      })
    ).rejects.toThrow('Project is not enabled in environment')

    const target = (await store.getBuildTarget('online-h5'))!
    await store.saveBuildTarget(
      {
        ...target,
        enabled: true,
        installCommand: 'pnpm install --global-changed',
        buildCommand: 'pnpm build --global-changed',
      },
      'gz'
    )
    expect(
      await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'online-h5')
    ).toMatchObject({
      enabled: true,
      installCommand: 'pnpm install --environment-specific',
      buildCommand: 'pnpm build --environment-specific',
    })
  })

  it('isolates jobs, branch catalogs, artifacts, and idempotency keys by environment', async () => {
    const store = new MemoryStore()
    await enableSharedTarget(store, 'online-h5')
    const staging = await createEnvironment(store, 'staging')
    const sharedConfig = (await store.getProjectEnvironmentConfig(
      SHARED_ENVIRONMENT_ID,
      'online-h5'
    ))!
    await store.saveProjectEnvironmentConfig({ ...sharedConfig, environmentId: staging.id }, 'gz')

    const sharedJob = await store.createBuildJob({
      id: randomUUID(),
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: 'online-h5',
      branch: 'feature/shared',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: 'same-request-key',
      targetSnapshot: null,
    })
    await expect(
      store.createBuildJob({
        id: randomUUID(),
        environmentId: SHARED_ENVIRONMENT_ID,
        environmentSlug: 'shared',
        targetId: 'online-h5',
        branch: 'feature/shared',
        profile: 'qa-web',
        requestedBy: 'another-retry-actor',
        idempotencyKey: 'same-request-key',
        targetSnapshot: null,
      })
    ).resolves.toMatchObject({ id: sharedJob.id })
    await expect(
      store.createBuildJob({
        id: randomUUID(),
        environmentId: staging.id,
        environmentSlug: staging.slug,
        targetId: 'online-h5',
        branch: 'feature/staging',
        profile: 'qa-web',
        requestedBy: 'gz',
        idempotencyKey: 'same-request-key',
        targetSnapshot: null,
      })
    ).rejects.toThrow('Idempotency key conflicts')

    const stagingJob = await store.createBuildJob({
      id: randomUUID(),
      environmentId: staging.id,
      environmentSlug: staging.slug,
      targetId: 'online-h5',
      branch: 'feature/staging',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const sharedArtifact = artifact(sharedJob.id, 'feature/shared')
    const stagingArtifact = artifact(stagingJob.id, 'feature/staging', staging.id, staging.slug)
    await store.createArtifact(sharedArtifact)
    await store.createArtifact(stagingArtifact)

    expect((await store.listBuildJobs(undefined, staging.id)).map((job) => job.id)).toEqual([
      stagingJob.id,
    ])
    expect(
      (await store.listArtifacts('online-h5', undefined, staging.id)).map(({ id }) => id)
    ).toEqual([stagingArtifact.id])
    expect(
      (await store.listBranchCatalog('online-h5', staging.id)).map(({ branch }) => branch)
    ).toContain('feature/staging')
    expect(
      (await store.listBranchCatalog('online-h5', staging.id)).map(({ branch }) => branch)
    ).not.toContain('feature/shared')
    await expect(
      store.publishRevision({
        environmentId: 'shared',
        baseRevisionId: null,
        message: 'cross environment',
        createdBy: 'gz',
        selections: [{ targetId: 'online-h5', artifactId: stagingArtifact.id }],
      })
    ).rejects.toThrow('Artifact environment mismatch')
    await expect(
      createSharedPreview(store, {
        token: 'cross-environment-preview',
        createdBy: 'gz',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        selections: [
          {
            moduleKey: 'base',
            targetId: 'online-h5',
            artifactId: stagingArtifact.id,
            branch: stagingArtifact.branch,
            builtAt: stagingArtifact.builtAt,
            providerName: 'test',
            version: 'test',
            entryPath: 'remoteEntry.js',
          },
        ],
      })
    ).rejects.toThrow('Artifact environment mismatch')
  })

  it('keeps a disabled serving site visible and requires it to be retained on later publishes', async () => {
    const store = new MemoryStore()
    await enableSharedTarget(store, 'online-h5')
    const serving = artifact(randomUUID(), 'master')
    await store.createArtifact(serving)
    const first = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'serve site',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: serving.id }],
    })
    const config = (await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'online-h5'))!
    await store.saveProjectEnvironmentConfig({ ...config, enabled: false }, 'gz')

    const matrix = await store.getEnvironmentMatrix('shared')
    expect(matrix?.revision?.id).toBe(first.id)
    expect(matrix?.rows.find((row) => row.target.id === 'online-h5')).toMatchObject({
      target: { enabled: false },
      current: { artifactId: serving.id },
    })
    await expect(
      store.publishRevision({
        environmentId: 'shared',
        baseRevisionId: first.id,
        message: 'must not silently remove site',
        createdBy: 'gz',
        selections: [],
      })
    ).rejects.toThrow('Disabled current target must be retained')
    await expect(
      store.publishRevision({
        environmentId: 'shared',
        baseRevisionId: first.id,
        message: 'retain site unchanged',
        createdBy: 'gz',
        selections: [{ targetId: 'online-h5', artifactId: serving.id }],
      })
    ).resolves.toMatchObject({ selections: [{ artifactId: serving.id }] })
  })

  it('keeps frozen environments serving while rejecting builds and publications, then hides archived service', async () => {
    const store = new MemoryStore()
    await enableSharedTarget(store, 'online-h5')
    const serving = artifact(randomUUID(), 'master')
    await store.createArtifact(serving)
    const revision = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'serve',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: serving.id }],
    })
    const environment = (await store.getEnvironment('shared'))!
    await store.saveEnvironment({ ...environment, status: 'FROZEN', currentRevisionId: null }, 'gz')
    expect((await store.getEnvironment('shared'))?.currentRevisionId).toBe(revision.id)
    expect((await store.resolveCurrentArtifact('shared', 'online-h5'))?.id).toBe(serving.id)
    await expect(
      createSharedBuildJob(store, {
        id: randomUUID(),
        targetId: 'online-h5',
        branch: 'master',
        profile: 'qa-web',
        requestedBy: 'gz',
        idempotencyKey: null,
        targetSnapshot: null,
      })
    ).rejects.toThrow('not active')
    await expect(
      store.publishRevision({
        environmentId: 'shared',
        baseRevisionId: revision.id,
        message: 'frozen publish',
        createdBy: 'gz',
        selections: [{ targetId: 'online-h5', artifactId: serving.id }],
      })
    ).rejects.toThrow('not active')

    await store.saveEnvironment({ ...environment, status: 'ARCHIVED' }, 'gz')
    expect(await store.resolveCurrentArtifact('shared', 'online-h5')).toBeNull()
    await expect(
      createSharedPreview(store, {
        token: 'archived-preview',
        createdBy: 'gz',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        siteArtifactId: serving.id,
        selections: [],
      })
    ).rejects.toThrow('Environment is archived')
  })
})

describe('MemoryStore build queue', () => {
  it('paginates complete build history with filters and a stable tie-breaker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T08:00:00.000Z'))
    try {
      const store = new MemoryStore()
      const records = [
        {
          id: '00000000-0000-4000-8000-000000000001',
          branch: 'feature/old-success',
          requestedBy: 'qa-one',
          status: 'SUCCEEDED' as const,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          branch: 'feature/failed-search',
          requestedBy: 'qa-two',
          status: 'FAILED' as const,
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          branch: 'feature/new-success',
          requestedBy: 'qa-three',
          status: 'SUCCEEDED' as const,
        },
        {
          id: '00000000-0000-4000-8000-000000000004',
          branch: 'feature/canceled-search',
          requestedBy: 'QA-Four',
          status: 'CANCELED' as const,
        },
      ]
      for (const record of records) {
        const session = await store.createAuthSession({
          token: record.id,
          tenantKey: 'history-fixture',
          openId: record.id,
          unionId: '',
          name: 'Private provider name',
          avatarUrl: '',
          csrfToken: '',
          createdAt: new Date().toISOString(),
          expiresAt: '2099-01-01T00:00:00Z',
        })
        await store.updateOwnProfile(session, record.requestedBy)
        const job = await createSharedBuildJob(store, {
          id: record.id,
          targetId: 'online-h5',
          branch: record.branch,
          profile: 'qa-web',
          requestedBy: `user:${session.userId}`,
          idempotencyKey: null,
          targetSnapshot: null,
        })
        await store.updateBuildJob(job.id, { status: record.status })
      }

      await expect(
        store.listBuildJobPage({
          environmentId: SHARED_ENVIRONMENT_ID,
          page: 1,
          pageSize: 2,
        })
      ).resolves.toMatchObject({
        items: [{ id: records[3]!.id }, { id: records[2]!.id }],
        page: 1,
        pageSize: 2,
        total: 4,
        totalPages: 2,
      })
      await expect(
        store.listBuildJobPage({
          environmentId: SHARED_ENVIRONMENT_ID,
          status: 'FAILED',
          query: 'FAILED-SEARCH',
          page: 1,
          pageSize: 10,
        })
      ).resolves.toMatchObject({
        items: [{ id: records[1]!.id, status: 'FAILED' }],
        total: 1,
        totalPages: 1,
      })
      await expect(
        store.listBuildJobPage({
          environmentId: SHARED_ENVIRONMENT_ID,
          query: 'qa-four',
          page: 1,
          pageSize: 10,
        })
      ).resolves.toMatchObject({
        items: [{ id: records[3]!.id, status: 'CANCELED' }],
        total: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes running jobs before queued jobs and preserves queue order', async () => {
    const store = new MemoryStore()
    const first = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000001',
      targetId: 'online-h5',
      branch: 'feature/first',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const second = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000002',
      targetId: 'online-h5',
      branch: 'feature/second',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const third = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000003',
      targetId: 'online-h5',
      branch: 'feature/third',
      profile: 'qa-web',
      requestedBy: 'qa-three',
      idempotencyKey: null,
      targetSnapshot: null,
    })

    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(first.id)

    const queue = await store.listBuildQueue()
    expect(queue.map((job) => job.id)).toEqual([first.id, second.id, third.id])

    await store.updateBuildJob(first.id, { status: 'SUCCEEDED' })
    expect((await store.listBuildQueue()).map((job) => job.id)).toEqual([second.id, third.id])
  })

  it('keeps the project execution snapshot on the queued job', async () => {
    const store = new MemoryStore()
    const snapshot = {
      id: 'online-h5',
      environment: {
        id: SHARED_ENVIRONMENT_ID,
        slug: 'shared',
        name: '公共调试环境',
        backendOrigin: 'https://www.kookapp.cn',
      },
      repositoryUrl: 'https://git.example.test/mobile.git',
      installCommand: 'pnpm install',
      buildCommand: 'pnpm build',
      outputDirectory: 'build',
      siteAdapter: 'kook-online-h5-v1',
    }
    const job = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'master',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: snapshot,
    })

    await store.saveBuildTarget(
      {
        ...(await store.getBuildTarget('online-h5'))!,
        buildCommand: 'pnpm build:changed',
        configurationSource: 'database',
      },
      'gz'
    )

    expect(job.targetSnapshot).toEqual(snapshot)
  })

  it('runs different projects in parallel while keeping each project serial', async () => {
    const store = new MemoryStore()
    const firstOnline = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000011',
      targetId: 'online-h5',
      branch: 'feature/online-first',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const secondOnline = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000012',
      targetId: 'online-h5',
      branch: 'feature/online-second',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const webapp = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000013',
      targetId: 'webapp',
      branch: 'feature/webapp',
      profile: 'qa-web',
      requestedBy: 'qa-three',
      idempotencyKey: null,
      targetSnapshot: null,
    })

    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(firstOnline.id)
    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(webapp.id)
    expect(await store.claimNextBuildJob('worker-1')).toBeNull()

    await store.updateBuildJob(firstOnline.id, { status: 'SUCCEEDED' })
    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(secondOnline.id)
  })

  it('cancels queued jobs immediately and keeps repeated requests idempotent', async () => {
    const store = new MemoryStore()
    const job = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/cancel-queued',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })

    const first = await store.requestBuildJobCancellation(job.id, 'qa-one')
    const repeated = await store.requestBuildJobCancellation(job.id, 'qa-two')

    expect(first.outcome).toBe('CANCELED')
    expect(first.job).toMatchObject({
      status: 'CANCELED',
      failureCode: 'BUILD_CANCELED',
    })
    expect(first.job?.finishedAt).not.toBeNull()
    expect(repeated).toEqual(first)
    expect(await store.claimNextBuildJob('worker-1')).toBeNull()
    expect((await store.listBuildJobEvents(job.id)).map((event) => event.status)).toEqual([
      'QUEUED',
      'CANCELED',
    ])
  })

  it('keeps a canceling project occupied and rejects stale stage updates', async () => {
    const store = new MemoryStore()
    const running = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/cancel-running',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.claimNextBuildJob('worker-1')
    const next = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/next',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    expect((await store.requestBuildJobCancellation(running.id, 'qa-one')).outcome).toBe(
      'CANCELING'
    )
    expect(
      await store.transitionBuildJob(running.id, ['LEASED'], { status: 'CHECKOUT' })
    ).toBeNull()
    expect((await store.getBuildJob(running.id))?.status).toBe('CANCELING')
    expect(await store.claimNextBuildJob('worker-1')).toBeNull()

    await store.transitionBuildJob(running.id, ['CANCELING'], {
      status: 'CANCELED',
      finishedAt: new Date().toISOString(),
      failureCode: 'BUILD_CANCELED',
      failureMessage: '构建已被提前中断',
    })
    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(next.id)
  })

  it('commits success and its Artifact atomically against cancellation', async () => {
    const store = new MemoryStore()
    const canceled = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/cancel-before-publish',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.claimNextBuildJob('worker-1')
    for (const [from, to] of [
      ['LEASED', 'CHECKOUT'],
      ['CHECKOUT', 'INSTALLING'],
      ['INSTALLING', 'BUILDING'],
      ['BUILDING', 'VALIDATING'],
      ['VALIDATING', 'UPLOADING'],
    ] as const) {
      await store.transitionBuildJob(canceled.id, [from], { status: to })
    }
    await store.requestBuildJobCancellation(canceled.id, 'qa-one')
    const canceledArtifact = artifact(canceled.id, canceled.branch)
    expect(
      await store.completeBuildJob(canceled.id, {
        artifact: canceledArtifact,
        finishedAt: new Date().toISOString(),
        logPath: '/logs/canceled.log',
      })
    ).toBeNull()
    expect(await store.getArtifact(canceledArtifact.id)).toBeNull()

    await store.transitionBuildJob(canceled.id, ['CANCELING'], {
      status: 'CANCELED',
      finishedAt: new Date().toISOString(),
    })
    const succeeded = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/success-before-cancel',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.claimNextBuildJob('worker-1')
    for (const [from, to] of [
      ['LEASED', 'CHECKOUT'],
      ['CHECKOUT', 'INSTALLING'],
      ['INSTALLING', 'BUILDING'],
      ['BUILDING', 'VALIDATING'],
      ['VALIDATING', 'UPLOADING'],
    ] as const) {
      await store.transitionBuildJob(succeeded.id, [from], { status: to })
    }
    const succeededArtifact = artifact(succeeded.id, succeeded.branch)
    expect(
      await store.completeBuildJob(succeeded.id, {
        artifact: succeededArtifact,
        finishedAt: new Date().toISOString(),
        logPath: '/logs/succeeded.log',
      })
    ).toMatchObject({ status: 'SUCCEEDED' })
    expect((await store.requestBuildJobCancellation(succeeded.id, 'qa-one')).outcome).toBe(
      'NOT_CANCELABLE'
    )
    expect((await store.getArtifact(succeededArtifact.id))?.status).toBe('READY')
  })
})

describe('MemoryStore configuration groups', () => {
  it('stores an immutable deep copy and returns a fresh copy on every read', async () => {
    const now = Date.parse('2026-08-25T12:34:56.000Z')
    const store = new MemoryStore(() => now)
    await store.saveSiteBinding(siteBinding('main'), 'gz')
    const record: Parameters<MemoryStore['createConfigurationGroup']>[0] = {
      token: 'share-token',
      previewSlug: '0123456789abcdef0123456789abcdef',
      name: '频道权限重构',
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      siteBindingId: 'main',
      schemaVersion: 1,
      items: [
        { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
      ],
      createdBy: 'gz',
    }

    const created = await store.createConfigurationGroup(record)
    record.items.push({ targetId: 'discover', mode: 'official' })
    created.items.push({ targetId: 'gift', mode: 'official' })
    const createdBranch = created.items.find((item) => item.mode === 'branch')
    if (createdBranch?.mode === 'branch') createdBranch.branch = 'mutated'

    expect(created).toMatchObject({
      token: 'share-token',
      schemaVersion: 1,
      revision: 1,
      createdAt: '2026-08-25T12:34:56.000Z',
      updatedBy: 'gz',
      updatedAt: '2026-08-25T12:34:56.000Z',
    })
    expect(await store.getConfigurationGroup('share-token')).toEqual({
      ...record,
      previewHostnamePrefix: 'p-0123456789abcdef0123456789abcdef',
      items: [
        { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
      ],
      revision: 1,
      createdAt: '2026-08-25T12:34:56.000Z',
      updatedBy: 'gz',
      updatedAt: '2026-08-25T12:34:56.000Z',
    })

    const firstRead = await store.getConfigurationGroup('share-token')
    firstRead!.items.length = 0
    expect((await store.getConfigurationGroup('share-token'))?.items).toHaveLength(2)
    expect(await store.getConfigurationGroup('missing-token')).toBeNull()
    await expect(store.createConfigurationGroup(record)).rejects.toThrow(
      'Configuration group already exists: share-token'
    )
    await expect(
      store.createConfigurationGroup({
        ...record,
        token: 'another-token',
        previewHostnamePrefix: 'p-0123456789abcdef0123456789abcdef',
      })
    ).rejects.toThrow('Configuration group preview hostname already exists')
    await expect(
      store.getConfigurationGroupByPreviewHostnamePrefix('p-0123456789abcdef0123456789abcdef')
    ).resolves.toMatchObject({ token: 'share-token' })
    await expect(store.deleteSiteBinding('main', 'gz')).rejects.toThrow(
      'Site binding is referenced by a configuration group: main'
    )
  })

  it('lists newest groups first and supports optimistic full updates and deletion', async () => {
    let now = Date.parse('2026-08-25T12:00:00.000Z')
    const store = new MemoryStore(() => now)
    await store.saveSiteBinding(siteBinding('main'), 'gz')
    const base = {
      name: '需求配置',
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      siteBindingId: 'main',
      schemaVersion: 1 as const,
      items: [{ targetId: 'webapp', mode: 'official' as const }],
      createdBy: 'gz',
    }
    const updateBase = {
      name: base.name,
      environmentId: base.environmentId,
      environmentSlug: base.environmentSlug,
      siteBindingId: base.siteBindingId,
      schemaVersion: base.schemaVersion,
      items: base.items,
    }
    await store.createConfigurationGroup({ ...base, token: 'aaaaaaaa' })
    await store.createConfigurationGroup({ ...base, token: 'bbbbbbbb' })
    now += 1_000
    await store.createConfigurationGroup({ ...base, token: 'cccccccc' })

    expect((await store.listConfigurationGroups()).map((group) => group.token)).toEqual([
      'cccccccc',
      'bbbbbbbb',
      'aaaaaaaa',
    ])
    await expect(
      store.updateConfigurationGroup(
        'missing',
        {
          ...updateBase,
          name: '不会写入',
        },
        1,
        'qa'
      )
    ).resolves.toEqual({ outcome: 'NOT_FOUND' })
    await expect(
      store.updateConfigurationGroup(
        'cccccccc',
        {
          ...updateBase,
          name: '冲突写入',
        },
        2,
        'qa'
      )
    ).resolves.toEqual({ outcome: 'CONFLICT', currentRevision: 1 })

    now += 1_000
    const updated = await store.updateConfigurationGroup(
      'cccccccc',
      {
        ...updateBase,
        name: '已更新需求',
        items: [{ targetId: 'webapp', mode: 'branch', branch: 'feature/updated' }],
      },
      1,
      'qa'
    )
    expect(updated).toEqual({
      outcome: 'UPDATED',
      group: expect.objectContaining({
        token: 'cccccccc',
        name: '已更新需求',
        revision: 2,
        createdBy: 'gz',
        createdAt: '2026-08-25T12:00:01.000Z',
        updatedBy: 'qa',
        updatedAt: '2026-08-25T12:00:02.000Z',
      }),
    })
    if (updated.outcome === 'UPDATED') updated.group.items.length = 0
    expect((await store.getConfigurationGroup('cccccccc'))?.items).toEqual([
      { targetId: 'webapp', mode: 'branch', branch: 'feature/updated' },
    ])
    expect(await store.deleteConfigurationGroup('cccccccc', 'another-qa')).toBe(true)
    expect(await store.deleteConfigurationGroup('cccccccc', 'another-qa')).toBe(false)
    expect(await store.getConfigurationGroup('cccccccc')).toBeNull()
    await expect(store.deleteSiteBinding('main', 'gz')).rejects.toThrow(
      'Site binding is referenced by a configuration group: main'
    )
  })

  it('requires a non-archived environment and an enabled site binding independently', async () => {
    const store = new MemoryStore()
    const staging = await createEnvironment(store, 'staging')
    const frozen = await createEnvironment(store, 'frozen', 'FROZEN')
    const archived = await createEnvironment(store, 'archived', 'ARCHIVED')
    await store.saveSiteBinding(siteBinding('main'), 'gz')
    await store.saveSiteBinding(siteBinding('staging-main', staging.slug), 'gz')
    await store.saveSiteBinding(siteBinding('frozen-main', frozen.slug), 'gz')
    await store.saveSiteBinding({ ...siteBinding('disabled-main'), enabled: false }, 'gz')
    const base: Parameters<MemoryStore['createConfigurationGroup']>[0] = {
      token: 'share-token',
      name: '需求配置',
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      siteBindingId: 'main',
      schemaVersion: 1,
      items: [{ targetId: 'webapp', mode: 'official' }],
      createdBy: 'gz',
    }

    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'identity-mismatch',
        environmentId: staging.id,
      })
    ).rejects.toThrow('Environment is invalid: shared')
    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'archived',
        environmentId: archived.id,
        environmentSlug: archived.slug,
        siteBindingId: 'main',
      })
    ).rejects.toThrow('Environment is archived: archived')
    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'binding-mismatch',
        siteBindingId: 'staging-main',
      })
    ).resolves.toMatchObject({ environmentSlug: 'shared', siteBindingId: 'staging-main' })
    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'binding-missing',
        siteBindingId: 'missing',
      })
    ).rejects.toThrow('Site binding is unavailable: missing')
    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'binding-disabled',
        siteBindingId: 'disabled-main',
      })
    ).rejects.toThrow('Site binding is unavailable: disabled-main')
    await expect(
      store.createConfigurationGroup({
        ...base,
        token: 'frozen',
        environmentId: frozen.id,
        environmentSlug: frozen.slug,
        siteBindingId: 'frozen-main',
      })
    ).resolves.toMatchObject({ environmentSlug: 'frozen' })
  })

  it('does not pin superseded Artifacts because groups follow branches', async () => {
    const store = new MemoryStore()
    await store.saveSiteBinding(siteBinding('main'), 'gz')
    await store.createConfigurationGroup({
      token: 'branch-following',
      name: '持续提测配置',
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      siteBindingId: 'main',
      schemaVersion: 1,
      items: [{ targetId: 'online-h5', mode: 'branch', branch: 'feature/share' }],
      createdBy: 'gz',
    })
    const old = artifact(randomUUID(), 'feature/share')
    const latest = artifact(randomUUID(), 'feature/share')
    old.builtAt = '2026-08-25T01:00:00.000Z'
    latest.builtAt = '2026-08-25T02:00:00.000Z'
    await store.createArtifact(old)
    await store.createArtifact(latest)

    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([
      expect.objectContaining({ id: old.id }),
    ])
  })
})

describe('MemoryStore preview sessions', () => {
  it('uses one enabled site binding across isolated environments', async () => {
    const store = new MemoryStore()
    const staging = await createEnvironment(store, 'staging')
    await store.saveSiteBinding(siteBinding('main'), 'gz')

    await expect(
      store.createPreviewSession({
        token: 'staging-on-main',
        environmentId: staging.id,
        environmentSlug: staging.slug,
        createdBy: 'gz',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        siteBindingId: 'main',
        selections: [],
      })
    ).resolves.toMatchObject({
      environmentSlug: 'staging',
      siteBindingId: 'main',
    })
  })

  it('expires preview tokens and stops retaining their artifacts', async () => {
    const store = new MemoryStore()
    const remote = remoteArtifact('feature/expired')
    await store.createArtifact(remote)
    await createSharedPreview(store, {
      token: 'expired-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: remote.id,
          branch: 'feature/expired',
          builtAt: new Date().toISOString(),
          providerName: 'cuddly_base_expired',
          version: 'cuddly_base_expired',
          entryPath: 'remoteEntry.js',
        },
      ],
    })

    expect(await store.getPreviewSession('expired-preview')).toBeNull()
    expect(await store.isArtifactReferencedByActivePreview(remote.id)).toBe(false)
  })

  it('revokes an exact token immediately but retains its artifact through the gateway cache grace', async () => {
    let now = Date.parse('2026-08-25T08:00:00.000Z')
    const store = new MemoryStore(() => now)
    const remote = remoteArtifact('feature/revoked')
    const latest = remoteArtifact('feature/revoked')
    remote.builtAt = '2026-08-25T07:00:00.000Z'
    latest.builtAt = '2026-08-25T07:30:00.000Z'
    await store.createArtifact(remote)
    await store.createArtifact(latest)
    await createSharedPreview(store, {
      token: 'preview-to-revoke',
      createdBy: 'gz',
      expiresAt: new Date(now + 60_000).toISOString(),
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: remote.id,
          branch: remote.branch,
          builtAt: remote.builtAt,
          providerName: remote.manifest.serve.remote!.providerName,
          version: remote.manifest.serve.remote!.providerName,
          entryPath: remote.manifest.serve.remote!.entryPath,
        },
      ],
    })

    expect(await store.isArtifactReferencedByActivePreview(remote.id)).toBe(true)
    await expect(store.revokePreviewSession('another-preview')).resolves.toBe(false)
    expect(await store.getPreviewSession('preview-to-revoke')).not.toBeNull()
    await expect(store.revokePreviewSession('preview-to-revoke')).resolves.toBe(true)
    await expect(store.revokePreviewSession('preview-to-revoke')).resolves.toBe(false)
    expect(await store.getPreviewSession('preview-to-revoke')).toBeNull()
    expect(await store.isArtifactReferencedByActivePreview(remote.id)).toBe(true)
    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([])

    now += PREVIEW_REVOKE_GRACE_MS + 1
    expect(await store.isArtifactReferencedByActivePreview(remote.id)).toBe(false)
    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([
      expect.objectContaining({ id: remote.id }),
    ])
  })
})

describe('MemoryStore Artifact retention', () => {
  it('gets a unique ordered batch of existing Artifacts by id', async () => {
    const store = new MemoryStore()
    const first = artifact(randomUUID(), 'feature/batch')
    const second = artifact(randomUUID(), 'feature/batch')
    await store.createArtifact(first)
    await store.createArtifact(second)

    await expect(
      store.getArtifactsByIds([second.id, randomUUID(), first.id, second.id])
    ).resolves.toEqual([second, first])
    await expect(store.getArtifactsByIds([])).resolves.toEqual([])
  })

  it('claims every unreferenced superseded package and keeps the newest candidate READY', async () => {
    const store = new MemoryStore()
    const oldest = artifact(randomUUID(), 'feature/one')
    const middle = artifact(randomUUID(), 'feature/one')
    const newest = artifact(randomUUID(), 'feature/one')
    oldest.builtAt = '2026-08-25T01:00:00.000Z'
    middle.builtAt = '2026-08-25T02:00:00.000Z'
    newest.builtAt = '2026-08-25T03:00:00.000Z'
    await store.createArtifact(oldest)
    await store.createArtifact(middle)
    await store.createArtifact(newest)

    const claimed = await store.claimArtifactCleanupCandidates(50)

    expect(claimed.map((candidate) => candidate.id)).toEqual([oldest.id, middle.id])
    expect((await store.getArtifact(oldest.id))?.status).toBe('DELETING')
    expect((await store.getArtifact(newest.id))?.status).toBe('READY')
    await store.completeArtifactDeletion(oldest.id)
    await store.completeArtifactDeletion(middle.id)
    expect((await store.getArtifact(oldest.id))?.status).toBe('DELETED')
    expect((await store.listArtifacts('online-h5', 'feature/one')).map((item) => item.id)).toEqual([
      newest.id,
    ])
  })

  it('keeps the serving package until a newer package becomes the current Revision', async () => {
    const store = new MemoryStore()
    await enableSharedTarget(store, 'online-h5')
    const serving = artifact(randomUUID(), 'master')
    const candidate = artifact(randomUUID(), 'master')
    serving.builtAt = '2026-08-25T01:00:00.000Z'
    candidate.builtAt = '2026-08-25T02:00:00.000Z'
    await store.createArtifact(serving)
    await store.createArtifact(candidate)
    const firstRevision = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'old package serving',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: serving.id }],
    })

    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([])

    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: firstRevision.id,
      message: 'new package serving',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: candidate.id }],
    })
    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([
      expect.objectContaining({ id: serving.id }),
    ])
  })

  it('protects an active Preview and refuses to reference a package already being deleted', async () => {
    const store = new MemoryStore()
    const previewed = remoteArtifact('feature/base')
    const newest = remoteArtifact('feature/base')
    previewed.builtAt = '2026-08-25T01:00:00.000Z'
    newest.builtAt = '2026-08-25T02:00:00.000Z'
    await store.createArtifact(previewed)
    await store.createArtifact(newest)
    const selection = {
      moduleKey: 'base',
      targetId: 'base',
      artifactId: previewed.id,
      branch: previewed.branch,
      builtAt: previewed.builtAt,
      providerName: previewed.manifest.serve.remote!.providerName,
      version: previewed.manifest.serve.remote!.providerName,
      entryPath: previewed.manifest.serve.remote!.entryPath,
    }
    await createSharedPreview(store, {
      token: 'active-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [selection],
    })
    await expect(store.claimArtifactCleanupCandidates(50)).resolves.toEqual([])

    const unreferencedStore = new MemoryStore()
    await unreferencedStore.createArtifact(previewed)
    await unreferencedStore.createArtifact(newest)
    await expect(unreferencedStore.claimArtifactCleanupCandidates(50)).resolves.toEqual([
      expect.objectContaining({ id: previewed.id }),
    ])
    await expect(
      createSharedPreview(unreferencedStore, {
        token: 'too-late',
        createdBy: 'gz',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        selections: [selection],
      })
    ).rejects.toThrow(`Artifact is not ready: ${previewed.id}`)
    await expect(
      unreferencedStore.publishRevision({
        environmentId: 'shared',
        baseRevisionId: null,
        message: 'too late',
        createdBy: 'gz',
        selections: [{ targetId: 'base', artifactId: previewed.id }],
      })
    ).rejects.toThrow(`Artifact is not ready: ${previewed.id}`)
  })

  it('restores a package after a failed physical deletion', async () => {
    const store = new MemoryStore()
    const old = artifact(randomUUID(), 'feature/retry')
    const latest = artifact(randomUUID(), 'feature/retry')
    old.builtAt = '2026-08-25T01:00:00.000Z'
    latest.builtAt = '2026-08-25T02:00:00.000Z'
    await store.createArtifact(old)
    await store.createArtifact(latest)
    await store.claimArtifactCleanupCandidates(50)

    await store.restoreArtifactDeletion(old.id)

    expect((await store.getArtifact(old.id))?.status).toBe('READY')
  })
})

describe('MemoryStore site bindings', () => {
  it('supports CRUD and enabled hostname/origin resolution', async () => {
    const store = new MemoryStore()
    const main: SiteBinding = {
      id: 'main',
      name: 'KOOK 网页端',
      hostname: 'MAIN.BIFROST.VANILLACAKE.CN.',
      targetId: 'webapp',
      environmentSlug: 'shared',
      fallbackOrigin: 'https://www.kookapp.cn/',
      upstreamOrigin: 'https://www.kookapp.cn/',
      officialOrigin: 'https://www.kookapp.cn/',
      enabled: true,
      remoteTargetIds: ['base'],
      resourceProxyPrefixes: [
        'https://static.kookapp.cn/static/',
        'https://img.kookapp.cn/assets/',
      ],
    }
    await store.saveSiteBinding(main, 'gz')
    main.resourceProxyPrefixes.push('https://unexpected.kookapp.cn/')
    await store.saveSiteBinding(
      {
        ...main,
        id: 'disabled',
        hostname: 'disabled.bifrost.vanillacake.cn',
        officialOrigin: 'https://disabled.kookapp.cn',
        enabled: false,
      },
      'gz'
    )

    expect((await store.listSiteBindings()).map((binding) => binding.id)).toEqual(['main'])
    expect(await store.getSiteBindingByHostname('MAIN.BIFROST.VANILLACAKE.CN:443')).toMatchObject({
      id: 'main',
      hostname: 'main.bifrost.vanillacake.cn',
      resourceProxyPrefixes: [
        'https://static.kookapp.cn/static/',
        'https://img.kookapp.cn/assets/',
      ],
    })
    expect(await store.getSiteBindingByOfficialOrigin('https://www.kookapp.cn/path')).toMatchObject(
      {
        id: 'main',
        officialOrigin: 'https://www.kookapp.cn',
      }
    )
    expect(await store.getSiteBindingByHostname('disabled.bifrost.vanillacake.cn')).toBeNull()
    expect(
      await store.getSiteBindingByHostname('disabled.bifrost.vanillacake.cn', true)
    ).toMatchObject({ id: 'disabled', enabled: false })

    const firstRead = await store.getSiteBinding('main')
    firstRead!.resourceProxyPrefixes.push('https://mutated.kookapp.cn/')
    expect((await store.getSiteBinding('main'))?.resourceProxyPrefixes).toEqual([
      'https://static.kookapp.cn/static/',
      'https://img.kookapp.cn/assets/',
    ])

    expect(await store.deleteSiteBinding('main', 'gz')).toBe(true)
    expect(await store.getSiteBinding('main')).toBeNull()
    expect(await store.deleteSiteBinding('main', 'gz')).toBe(false)
  })

  it('ranks bindings by default environment without hiding an archived default', async () => {
    const store = new MemoryStore()
    const frozen = await createEnvironment(store, 'frozen')
    const archived = await createEnvironment(store, 'archived')
    const makeBinding = (id: string, environmentSlug: string): SiteBinding => ({
      id,
      name: id,
      hostname: `${id}.bifrost.vanillacake.cn`,
      targetId: 'webapp',
      environmentSlug,
      fallbackOrigin: 'https://www.kookapp.cn',
      upstreamOrigin: 'https://www.kookapp.cn',
      officialOrigin: 'https://www.kookapp.cn',
      enabled: true,
      remoteTargetIds: [],
      resourceProxyPrefixes: [],
    })
    await store.saveSiteBinding(makeBinding('shared-site', 'shared'), 'gz')
    await store.saveSiteBinding(makeBinding('frozen-site', frozen.slug), 'gz')
    const archivedBinding = makeBinding('archived-site', archived.slug)
    await store.saveSiteBinding(archivedBinding, 'gz')
    await store.saveEnvironment({ ...frozen, status: 'FROZEN' }, 'gz')
    await store.saveEnvironment({ ...archived, status: 'ARCHIVED' }, 'gz')

    expect(
      (await store.listSiteBindingsByOfficialOrigin('https://www.kookapp.cn')).map(
        (binding) => binding.id
      )
    ).toEqual(['shared-site', 'frozen-site', 'archived-site'])
    await expect(
      store.saveSiteBinding({ ...archivedBinding, enabled: false }, 'gz')
    ).resolves.toMatchObject({ id: 'archived-site', enabled: false })
  })
})

describe('MemoryStore auth sessions', () => {
  const token = 'opaque-session-token'
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
  const createdAt = '2026-08-25T12:00:00.000Z'
  const expiresAt = '2026-08-25T13:00:00.000Z'

  it('stores only a token hash and returns isolated session values', async () => {
    const store = new MemoryStore(() => Date.parse(createdAt))
    const created = await store.createAuthSession({
      token,
      tenantKey: 'tenant-1',
      openId: 'open-1',
      unionId: '',
      name: '测试用户',
      avatarUrl: '',
      csrfToken: 'csrf-token',
      createdAt,
      expiresAt,
    })
    const internalSessions = (store as unknown as { authSessions: Map<string, typeof created> })
      .authSessions

    expect([...internalSessions.keys()]).toEqual([tokenHash])
    expect([...internalSessions.keys()]).not.toContain(token)
    expect(created).not.toHaveProperty('token')
    expect(created).not.toHaveProperty('tokenHash')

    const publicName = created.name
    created.name = 'mutated'
    const loaded = await store.getAuthSession(token)
    expect(loaded).toMatchObject({ name: publicName, tenantKey: 'tenant-1', openId: 'open-1' })
    loaded!.name = 'mutated again'
    expect((await store.getAuthSession(token))?.name).toBe(publicName)

    await expect(store.deleteAuthSession(token)).resolves.toBe(true)
    await expect(store.deleteAuthSession(token)).resolves.toBe(false)
    await expect(store.getAuthSession(token)).resolves.toBeNull()
  })

  it('treats an expired session as missing and removes it', async () => {
    let now = Date.parse(createdAt)
    const store = new MemoryStore(() => now)
    await store.createAuthSession({
      token,
      tenantKey: 'tenant-1',
      openId: 'open-1',
      unionId: 'union-1',
      name: '测试用户',
      avatarUrl: 'https://example.test/avatar.png',
      csrfToken: 'csrf-token',
      createdAt,
      expiresAt,
    })

    now = Date.parse(expiresAt)
    await expect(store.getAuthSession(token)).resolves.toBeNull()
    const internalSessions = (store as unknown as { authSessions: Map<string, unknown> })
      .authSessions
    expect(internalSessions.size).toBe(0)
  })
})
