import type { AddressInfo } from 'node:net'

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  Artifact,
  BranchCatalogItem,
  BuildJob,
  BuildQueueSnapshot,
  PreviewSessionView,
} from '@cuddly/contracts'
import { MemoryStore } from '@cuddly/db'
import { describe, expect, it } from 'vitest'

import { createControlApp, mergeBranches } from './app'

const SHARED_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'

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

describe('control API build queue', () => {
  it('orders branches by their newest build activity before untouched Git branches', () => {
    const catalog: BranchCatalogItem[] = [
      {
        branch: 'feature/older-artifact',
        buildStatus: 'IDLE',
        latestArtifact: {
          id: randomUUID(),
          branch: 'feature/older-artifact',
          builtAt: '2026-08-24T09:00:00.000Z',
        },
        latestJob: null,
      },
      {
        branch: 'feature/new-failure',
        buildStatus: 'FAILED',
        latestArtifact: null,
        latestJob: {
          id: randomUUID(),
          status: 'FAILED',
          createdAt: '2026-08-25T09:00:00.000Z',
          finishedAt: '2026-08-25T09:05:00.000Z',
          failureMessage: 'failed',
        },
      },
    ]

    const merged = mergeBranches(catalog, ['zeta/untouched', 'alpha/untouched'], '')
    expect(merged.map((item) => item.branch)).toEqual([
      'feature/new-failure',
      'feature/older-artifact',
      'alpha/untouched',
      'zeta/untouched',
    ])
    expect(mergeBranches(catalog, [], 'NEW-FAIL').map((item) => item.branch)).toEqual([
      'feature/new-failure',
    ])
  })

  it('keeps legacy admin-password endpoints as no-password compatibility shims', async () => {
    const store = new MemoryStore()
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const status = await fetch(`${origin}/api/v1/admin/setup-status`)
      expect(await status.json()).toEqual({ setupRequired: false, passwordRequired: false })

      const setup = await fetch(`${origin}/api/v1/admin/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({ password: 'first-admin-password' }),
      })
      expect(setup.status).toBe(200)
      expect(setup.headers.get('set-cookie')).toBeNull()
      expect(await setup.json()).toEqual({ unlocked: true, passwordRequired: false })

      const repeated = await fetch(`${origin}/api/v1/admin/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'another-admin-password' }),
      })
      expect(repeated.status).toBe(200)

      const unlock = await fetch(`${origin}/api/v1/admin/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'first-admin-password' }),
      })
      expect(unlock.status).toBe(200)
      expect(await unlock.json()).toEqual({ unlocked: true, passwordRequired: false })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('protects internal APIs with a Bearer token regardless of URL casing', async () => {
    const store = new MemoryStore()
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const configUrl = `${origin}/api/v1/internal/auto-ssl-config`

      const missing = await fetch(configUrl)
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="cuddly-internal"')

      const incorrect = await fetch(configUrl, {
        headers: { authorization: 'Bearer incorrect-token' },
      })
      expect(incorrect.status).toBe(401)

      const mixedCase = await fetch(`${origin}/api/v1/INTERNAL/auto-ssl-config`)
      expect(mixedCase.status).toBe(401)

      const authorized = await fetch(configUrl, {
        headers: { authorization: 'Bearer internal-test-token' },
      })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toEqual({
        autoSslEnabled: false,
        autoSslEmail: '',
        hostnames: [],
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('keeps QA and management settings open while protecting internal APIs separately', async () => {
    const store = new MemoryStore()
    const first = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000001',
      targetId: 'online-h5',
      branch: 'feature/running',
      profile: 'qa-web',
      requestedBy: 'qa-one',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const second = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000002',
      targetId: 'online-h5',
      branch: 'feature/mine',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const third = await createSharedBuildJob(store, {
      id: '00000000-0000-4000-8000-000000000003',
      targetId: 'online-h5',
      branch: 'feature/other',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    expect((await store.claimNextBuildJob('worker-1'))?.id).toBe(first.id)

    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const response = await fetch(`${origin}/api/v1/build-queue`, {
        headers: { 'x-cuddly-actor': 'gz' },
      })
      expect(response.status).toBe(200)
      const queue = (await response.json()) as BuildQueueSnapshot

      expect(queue.running.map((item) => item.id)).toEqual([first.id])
      expect(queue.queued.map((item) => item.id)).toEqual([second.id, third.id])
      expect(queue.queued.map((item) => item.queuePosition)).toEqual([1, 2])
      expect(queue.queued.map((item) => item.isMine)).toEqual([true, false])

      const projects = await fetch(`${origin}/api/v1/admin/build-targets`, {
        headers: { 'x-cuddly-actor': 'gz' },
      })
      expect(projects.status).toBe(200)
      const projectBody = (await projects.json()) as { items: Array<{ id: string }> }
      expect(projectBody.items.map((item) => item.id)).toContain('online-h5')

      const saveProject = await fetch(`${origin}/api/v1/admin/build-targets/webapp`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({
          id: 'ignored-by-path',
          name: '网页端',
          kind: 'webapp',
          repositoryUrl: 'https://git.example.test/webapp.git',
          defaultBranch: 'develop',
          installCommand: 'corepack pnpm install --frozen-lockfile',
          buildCommand: 'corepack pnpm run build',
          outputDirectory: 'dist',
          siteAdapter: 'generic-static-v1',
          enabled: true,
          required: false,
          gitAuthorizationHeader: 'Authorization: Basic hidden',
        }),
      })
      expect(saveProject.status).toBe(200)
      expect((await store.getBuildTarget('webapp'))?.configurationSource).toBe('database')
      expect((await saveProject.json()) as Record<string, unknown>).not.toHaveProperty(
        'gitAuthorizationHeader'
      )

      const saveEnvironmentProject = await fetch(
        `${origin}/api/v1/admin/environments/shared/projects`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-cuddly-actor': 'gz',
          },
          body: JSON.stringify({
            items: [
              {
                targetId: 'webapp',
                enabled: true,
                required: false,
                installCommand: 'corepack pnpm install --frozen-lockfile',
                buildCommand: 'corepack pnpm run build',
                outputDirectory: 'dist',
              },
            ],
          }),
        }
      )
      expect(saveEnvironmentProject.status).toBe(200)

      const publicProjects = await fetch(`${origin}/api/v1/build-targets`)
      const publicBody = (await publicProjects.json()) as { items: Array<Record<string, unknown>> }
      expect(publicBody.items.find((item) => item.id === 'webapp')).not.toHaveProperty(
        'repositoryUrl'
      )
      expect(publicBody.items.find((item) => item.id === 'webapp')).not.toHaveProperty(
        'buildCommand'
      )

      const build = await fetch(`${origin}/api/v1/build-jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'anonymous-build-test',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({ targetId: 'webapp', branch: 'develop', profile: 'qa-web' }),
      })
      expect(build.status).toBe(202)
      const buildBody = (await build.json()) as BuildJob
      expect(buildBody).toMatchObject({ requestedBy: 'gz' })
      expect(buildBody.targetSnapshot).toMatchObject({
        kind: 'webapp',
        useChinaRegistry: true,
      })
      expect(buildBody.targetSnapshot).not.toHaveProperty('gitAuthorization')

      const systemSettings = await fetch(`${origin}/api/v1/admin/system-settings`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({
          buildMaxConcurrency: 4,
          useChinaRegistry: false,
        }),
      })
      expect(systemSettings.status).toBe(200)
      expect(await systemSettings.json()).toMatchObject({
        buildMaxConcurrency: 4,
        useChinaRegistry: false,
      })

      const buildWithoutChinaRegistry = await fetch(`${origin}/api/v1/build-jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'default-registry-build-test',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({ targetId: 'webapp', branch: 'master', profile: 'qa-web' }),
      })
      expect(buildWithoutChinaRegistry.status).toBe(202)
      expect(((await buildWithoutChinaRegistry.json()) as BuildJob).targetSnapshot).toMatchObject({
        useChinaRegistry: false,
      })

      expect((await fetch(`${origin}/api/v1/session`)).status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('cancels queued and running builds through an open idempotent endpoint', async () => {
    const store = new MemoryStore()
    const running = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/running-cancel',
      profile: 'qa-web',
      requestedBy: 'qa-one',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.claimNextBuildJob('worker-1')
    const queued = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'webapp',
      branch: 'feature/queued-cancel',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const finished = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'biz',
      branch: 'feature/already-finished',
      profile: 'qa-web',
      requestedBy: 'qa-three',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.updateBuildJob(finished.id, {
      status: 'FAILED',
      finishedAt: new Date().toISOString(),
    })

    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const queuedResponse = await fetch(`${origin}/api/v1/build-jobs/${queued.id}/cancel`, {
        method: 'POST',
        headers: { 'x-cuddly-actor': 'gz' },
      })
      expect(queuedResponse.status).toBe(200)
      expect(await queuedResponse.json()).toMatchObject({ status: 'CANCELED' })

      const runningResponse = await fetch(`${origin}/api/v1/build-jobs/${running.id}/cancel`, {
        method: 'POST',
        headers: { 'x-cuddly-actor': 'gz' },
      })
      expect(runningResponse.status).toBe(202)
      expect(await runningResponse.json()).toMatchObject({ status: 'CANCELING' })
      const repeated = await fetch(`${origin}/api/v1/build-jobs/${running.id}/cancel`, {
        method: 'POST',
      })
      expect(repeated.status).toBe(202)

      const queue = (await fetch(`${origin}/api/v1/build-queue`).then((response) =>
        response.json()
      )) as BuildQueueSnapshot
      expect(queue.running).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: running.id, status: 'CANCELING' })])
      )

      const terminal = await fetch(`${origin}/api/v1/build-jobs/${finished.id}/cancel`, {
        method: 'POST',
      })
      expect(terminal.status).toBe(409)
      expect(await terminal.json()).toMatchObject({ code: 'JOB_NOT_CANCELABLE' })
      expect(
        (
          await fetch(`${origin}/api/v1/build-jobs/00000000-0000-4000-8000-000000000099/cancel`, {
            method: 'POST',
          })
        ).status
      ).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('serves build history, command snapshots, events, artifacts, and sanitized logs', async () => {
    const store = new MemoryStore()
    const job = await createSharedBuildJob(store, {
      id: randomUUID(),
      targetId: 'online-h5',
      branch: 'feature/ci-view',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: {
        id: 'online-h5',
        environment: {
          id: SHARED_ENVIRONMENT_ID,
          slug: 'shared',
          name: '公共调试环境',
          backendOrigin: 'https://www.kookapp.cn',
        },
        repositoryUrl: 'https://user:password@git.example.test/html-h5.git',
        installCommand: 'AUTHORIZATION=Bearer-secret pnpm install',
        buildCommand: 'BUILD_TOKEN=hidden pnpm build',
        outputDirectory: 'build',
        siteAdapter: 'kook-online-h5-v1',
        useChinaRegistry: true,
      },
    })
    await store.claimNextBuildJob('worker-1')
    await store.updateBuildJob(job.id, { status: 'BUILDING' })
    const artifactId = randomUUID()
    const builtAt = new Date().toISOString()
    await store.createArtifact({
      id: artifactId,
      buildJobId: job.id,
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: job.targetId,
      branch: job.branch,
      status: 'READY',
      storageKey: `ready/online-h5/${artifactId}`,
      builtAt,
      createdBy: 'gz',
      manifest: {
        schemaVersion: 1,
        artifactId,
        target: job.targetId,
        branch: job.branch,
        builtAt,
        serve: {
          siteAdapter: 'kook-online-h5-v1',
          entrypoints: ['index.html'],
          publicBase: `/__cuddly/artifacts/${artifactId}/`,
        },
        files: [
          {
            path: 'index.html',
            size: 1,
            contentType: 'text/html; charset=utf-8',
            digest: 'sha256:test',
            cacheClass: 'html',
          },
        ],
      },
    })
    await store.updateBuildJob(job.id, {
      status: 'SUCCEEDED',
      finishedAt: new Date().toISOString(),
      logPath: `/srv/cuddly/logs/${job.id}.log`,
    })

    const logDirectory = await mkdtemp(path.join(tmpdir(), 'cuddly-logs-'))
    await writeFile(
      path.join(logDirectory, `${job.id}.log`),
      [
        '$ AUTHORIZATION=Bearer-secret pnpm install',
        'BUILD_TOKEN=hidden pnpm build',
        'https://user:password@git.example.test/repository.git',
      ].join('\n')
    )
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
      logDirectory,
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const history = await fetch(
        `${origin}/api/v1/build-jobs?status=SUCCEEDED&query=feature%2Fci-view`
      ).then((response) => response.json())
      expect(history.items).toHaveLength(1)
      expect(history.items[0].logPath).toBe(`/api/v1/build-jobs/${job.id}/log`)
      expect(history.items[0].targetSnapshot).not.toHaveProperty('gitAuthorization')
      expect(history.items[0].targetSnapshot).toMatchObject({
        repositoryUrl: '<repository>',
        installCommand: 'AUTHORIZATION=<redacted> pnpm install',
        buildCommand: 'BUILD_TOKEN=<redacted> pnpm build',
      })
      expect(JSON.stringify(history)).not.toContain('user:password')
      expect(JSON.stringify(history)).not.toContain('Bearer-secret')

      const detail = await fetch(`${origin}/api/v1/build-jobs/${job.id}/detail`).then((response) =>
        response.json()
      )
      expect(detail.commands.map((step: { command: string }) => step.command)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('feature/ci-view'),
          expect.stringContaining('AUTHORIZATION=<redacted>'),
          expect.stringContaining('BUILD_TOKEN=<redacted>'),
        ])
      )
      expect(
        detail.commands.filter((step: { command: string }) =>
          step.command.includes('registry.npmmirror.com')
        )
      ).toHaveLength(2)
      expect(
        detail.commands.find((step: { stage: string }) => step.stage === 'INSTALLING').command
      ).toContain('pnpm_config_dangerously_allow_all_builds=true')
      expect(detail.events.map((event: { status: string }) => event.status)).toEqual([
        'QUEUED',
        'LEASED',
        'BUILDING',
        'SUCCEEDED',
      ])
      expect(detail.artifact).toMatchObject({ id: artifactId, fileCount: 1 })

      const log = await fetch(`${origin}/api/v1/build-jobs/${job.id}/log`).then((response) =>
        response.json()
      )
      expect(log.complete).toBe(true)
      expect(log.content).toContain('AUTHORIZATION=<redacted>')
      expect(log.content).toContain('BUILD_TOKEN=<redacted>')
      expect(log.content).toContain('https://<redacted>@git.example.test')
      expect(log.content).not.toContain('Bearer-secret')
      expect(log.content).not.toContain('password')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await rm(logDirectory, { recursive: true, force: true })
    }
  })

  it('serves complete build history with validated page-number pagination', async () => {
    const store = new MemoryStore()
    const records = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        branch: 'feature/old-success',
        status: 'SUCCEEDED' as const,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        branch: 'feature/failed-history',
        status: 'FAILED' as const,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        branch: 'feature/canceled-history',
        status: 'CANCELED' as const,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        branch: 'feature/new-success',
        status: 'SUCCEEDED' as const,
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        branch: 'feature/newest-failure',
        status: 'FAILED' as const,
      },
    ]
    for (const record of records) {
      const job = await createSharedBuildJob(store, {
        id: record.id,
        targetId: 'online-h5',
        branch: record.branch,
        profile: 'qa-web',
        requestedBy: 'gz',
        idempotencyKey: null,
        targetSnapshot: null,
      })
      await store.updateBuildJob(job.id, {
        status: record.status,
        finishedAt: new Date().toISOString(),
        failureCode: record.status === 'FAILED' ? 'BUILD_FAILED' : null,
        failureMessage: record.status === 'FAILED' ? 'failed' : null,
      })
    }
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const firstPage = (await fetch(`${origin}/api/v1/build-jobs?page=1&pageSize=2`).then(
        (response) => response.json()
      )) as {
        items: BuildJob[]
        page: number
        pageSize: number
        total: number
        totalPages: number
      }
      expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 })
      expect(firstPage.items.map((job) => job.id)).toEqual([records[4]!.id, records[3]!.id])

      const allStatuses = (await fetch(`${origin}/api/v1/build-jobs?pageSize=10`).then((response) =>
        response.json()
      )) as { items: BuildJob[]; page: number }
      expect(allStatuses.page).toBe(1)
      expect(new Set(allStatuses.items.map((job) => job.status))).toEqual(
        new Set(['SUCCEEDED', 'FAILED', 'CANCELED'])
      )

      const failures = (await fetch(
        `${origin}/api/v1/build-jobs?page=1&pageSize=10&status=FAILED&query=failed-history`
      ).then((response) => response.json())) as { items: BuildJob[]; total: number }
      expect(failures).toMatchObject({
        items: [{ id: records[1]!.id, status: 'FAILED' }],
        total: 1,
      })

      const legacy = (await fetch(`${origin}/api/v1/build-jobs?limit=2`).then((response) =>
        response.json()
      )) as { items: BuildJob[]; nextCursor: string | null; page?: number }
      expect(legacy.items).toHaveLength(2)
      expect(legacy.nextCursor).toBeTruthy()
      expect(legacy.page).toBeUndefined()

      for (const invalidQuery of [
        'page=0&pageSize=20',
        'page=1.5&pageSize=20',
        'page=1&pageSize=101',
        'page=1&pageSize=0',
        'page=1&status=NOT_A_STATUS',
        'page=1&status=FAILED&status=SUCCEEDED',
      ]) {
        const response = await fetch(`${origin}/api/v1/build-jobs?${invalidQuery}`)
        expect(response.status, invalidQuery).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' })
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('requires Remote previews to be bound to a site', async () => {
    const store = new MemoryStore()
    await store.saveBuildTarget(
      {
        id: 'base',
        name: 'Base',
        kind: 'remote',
        repositoryUrl: 'https://git.example.test/kook.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm --filter base build',
        outputDirectory: 'apps/base/dist',
        siteAdapter: 'kook-remote-v1',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )
    const artifactId = randomUUID()
    const builtAt = new Date().toISOString()
    const artifact: Artifact = {
      id: artifactId,
      buildJobId: randomUUID(),
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: 'base',
      branch: 'feature/preview',
      status: 'READY',
      storageKey: `ready/base/${artifactId}`,
      builtAt,
      createdBy: 'gz',
      manifest: {
        schemaVersion: 1,
        artifactId,
        target: 'base',
        branch: 'feature/preview',
        builtAt,
        serve: {
          siteAdapter: 'kook-remote-v1',
          entrypoints: ['remoteEntry.js'],
          publicBase: `https://preview.example.test/__cuddly/preview-artifacts/${artifactId}/cuddly_base_test/`,
          remote: {
            moduleKey: 'base',
            providerName: 'cuddly_base_test',
            entryPath: 'remoteEntry.js',
          },
        },
        files: [
          {
            path: 'remoteEntry.js',
            size: 1,
            contentType: 'text/javascript; charset=utf-8',
            digest: 'sha256:test',
            cacheClass: 'asset',
          },
        ],
      },
    }
    await store.createArtifact(artifact)

    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const response = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({ selections: [{ targetId: 'base', artifactId }] }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' })

      const invalid = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selections: [{ targetId: 'online-h5', artifactId }] }),
      })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('manages site bindings, resolves official sites, and creates site-aware previews', async () => {
    const store = new MemoryStore()
    await store.saveBuildTarget(
      {
        id: 'webapp',
        name: '网页端',
        kind: 'webapp',
        repositoryUrl: 'https://git.example.test/webapp.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm build',
        outputDirectory: 'build',
        siteAdapter: 'generic-static-v1',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )
    await enableSharedTarget(store, 'webapp')
    await store.saveBuildTarget(
      {
        id: 'legacy-site',
        name: '旧站点项目',
        kind: 'webapp',
        repositoryUrl: 'https://git.example.test/legacy-site.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm build',
        outputDirectory: 'dist',
        siteAdapter: 'legacy-static-v0',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )
    await enableSharedTarget(store, 'base')
    await store.saveBuildTarget(
      {
        id: 'base',
        name: 'Base',
        kind: 'remote',
        repositoryUrl: 'https://git.example.test/kook.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm --filter base build',
        outputDirectory: 'apps/base/dist',
        siteAdapter: 'kook-remote-v1',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )

    await store.saveBuildTarget(
      {
        id: 'legacy-remote',
        name: '旧 Remote',
        kind: 'remote',
        repositoryUrl: 'https://git.example.test/legacy-remote.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm build',
        outputDirectory: 'dist',
        siteAdapter: 'legacy-remote-v0',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )

    const siteArtifactId = randomUUID()
    const mismatchedSiteArtifactId = randomUUID()
    const remoteArtifactId = randomUUID()
    const builtAt = new Date().toISOString()
    await store.createArtifact({
      id: siteArtifactId,
      buildJobId: randomUUID(),
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: 'webapp',
      branch: 'feature/site-preview',
      status: 'READY',
      storageKey: `ready/webapp/${siteArtifactId}`,
      builtAt,
      createdBy: 'gz',
      manifest: {
        schemaVersion: 1,
        artifactId: siteArtifactId,
        target: 'webapp',
        branch: 'feature/site-preview',
        builtAt,
        serve: {
          siteAdapter: 'generic-static-v1',
          entrypoints: ['index.html'],
          publicBase: `/__cuddly/artifacts/${siteArtifactId}/`,
        },
        files: [
          {
            path: 'index.html',
            size: 1,
            contentType: 'text/html; charset=utf-8',
            digest: 'sha256:site',
            cacheClass: 'html',
          },
        ],
      },
    })
    await store.createArtifact({
      id: mismatchedSiteArtifactId,
      buildJobId: randomUUID(),
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: 'webapp',
      branch: 'feature/wrong-adapter',
      status: 'READY',
      storageKey: `ready/webapp/${mismatchedSiteArtifactId}`,
      builtAt,
      createdBy: 'gz',
      manifest: {
        schemaVersion: 1,
        artifactId: mismatchedSiteArtifactId,
        target: 'webapp',
        branch: 'feature/wrong-adapter',
        builtAt,
        serve: {
          siteAdapter: 'kook-online-h5-v1',
          entrypoints: ['index.html'],
          publicBase: `/__cuddly/artifacts/${mismatchedSiteArtifactId}/`,
        },
        files: [
          {
            path: 'index.html',
            size: 1,
            contentType: 'text/html; charset=utf-8',
            digest: 'sha256:wrong-adapter',
            cacheClass: 'html',
          },
        ],
      },
    })
    await store.createArtifact({
      id: remoteArtifactId,
      buildJobId: randomUUID(),
      environmentId: SHARED_ENVIRONMENT_ID,
      environmentSlug: 'shared',
      targetId: 'base',
      branch: 'feature/remote-preview',
      status: 'READY',
      storageKey: `ready/base/${remoteArtifactId}`,
      builtAt,
      createdBy: 'gz',
      manifest: {
        schemaVersion: 1,
        artifactId: remoteArtifactId,
        target: 'base',
        branch: 'feature/remote-preview',
        builtAt,
        serve: {
          siteAdapter: 'kook-remote-v1',
          entrypoints: ['remoteEntry.js'],
          publicBase: `/__cuddly/artifacts/${remoteArtifactId}/`,
          remote: {
            moduleKey: 'base',
            providerName: 'cuddly_base_site_preview',
            entryPath: 'remoteEntry.js',
          },
        },
        files: [
          {
            path: 'remoteEntry.js',
            size: 1,
            contentType: 'text/javascript; charset=utf-8',
            digest: 'sha256:remote',
            cacheClass: 'asset',
          },
        ],
      },
    })

    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
      previewBaseDomain: 'Preview.Example.Test.',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const runtime = await fetch(`${origin}/api/v1/runtime`)
      expect(runtime.status).toBe(200)
      expect(runtime.headers.get('cache-control')).toBe('no-store')
      expect(await runtime.json()).toMatchObject({
        previewBaseDomain: 'preview.example.test',
        inPlaceUrlRules: [],
      })
      const inPlaceUrlRules = [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }]
      const savedRules = await fetch(`${origin}/api/v1/admin/system-settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({ inPlaceUrlRules }),
      })
      expect(savedRules.status).toBe(200)
      expect(await savedRules.json()).toMatchObject({ inPlaceUrlRules })
      expect(
        await fetch(`${origin}/api/v1/runtime`).then((response) => response.json())
      ).toMatchObject({
        inPlaceUrlRules,
      })
      const invalidRules = await fetch(`${origin}/api/v1/admin/system-settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          inPlaceUrlRules: [{ pattern: 'missing.example.test', environmentSlug: 'missing' }],
        }),
      })
      expect(invalidRules.status).toBe(400)
      expect(await invalidRules.json()).toMatchObject({
        code: 'IN_PLACE_RULE_ENVIRONMENT_INVALID',
        index: 0,
        environmentSlug: 'missing',
      })
      const saved = await fetch(`${origin}/api/v1/admin/site-bindings/main`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({
          name: 'KOOK 网页端',
          hostname: 'Main.Preview.Example.Test.',
          targetId: 'webapp',
          environmentSlug: 'shared',
          upstreamOrigin: 'https://www.kookapp.cn/',
          officialOrigin: 'https://www.kookapp.cn/',
          enabled: true,
          remoteTargetIds: ['base'],
          resourceProxyPrefixes: [
            ' HTTPS://STATIC.KOOKAPP.CN:443/assets/../static/ ',
            'https://img.kookapp.cn/assets/',
          ],
        }),
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({
        id: 'main',
        hostname: 'main.preview.example.test',
        officialOrigin: 'https://www.kookapp.cn',
        resourceProxyPrefixes: [
          'https://static.kookapp.cn/static/',
          'https://img.kookapp.cn/assets/',
        ],
      })

      const invalidResourceProxy = await fetch(
        `${origin}/api/v1/admin/site-bindings/invalid-resource-proxy`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '非法资源代理',
            hostname: 'invalid-resource-proxy.preview.example.test',
            targetId: 'webapp',
            environmentSlug: 'shared',
            upstreamOrigin: 'https://invalid-resource-proxy.kookapp.cn',
            officialOrigin: 'https://invalid-resource-proxy.kookapp.cn',
            enabled: false,
            remoteTargetIds: [],
            resourceProxyPrefixes: ['https://static.kookapp.cn/static'],
          }),
        }
      )
      expect(invalidResourceProxy.status).toBe(400)
      expect(await invalidResourceProxy.json()).toMatchObject({ code: 'INVALID_SITE_BINDING' })

      const outsidePreviewDomain = await fetch(
        `${origin}/api/v1/admin/site-bindings/outside-domain`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '越界站点',
            hostname: 'outside.bifrost.vanillacake.cn',
            targetId: 'webapp',
            environmentSlug: 'shared',
            upstreamOrigin: 'https://outside.kookapp.cn',
            officialOrigin: 'https://outside.kookapp.cn',
            enabled: false,
            remoteTargetIds: [],
            resourceProxyPrefixes: [],
          }),
        }
      )
      expect(outsidePreviewDomain.status).toBe(400)
      expect(await outsidePreviewDomain.json()).toEqual({
        code: 'SITE_BINDING_HOSTNAME_OUTSIDE_PREVIEW_DOMAIN',
        message:
          '预览域名必须是 preview.example.test 的直接一级子域名，例如 main.preview.example.test',
      })

      const nestedPreviewDomain = await fetch(
        `${origin}/api/v1/admin/site-bindings/nested-domain`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '多级站点',
            hostname: 'nested.main.preview.example.test',
            targetId: 'webapp',
            environmentSlug: 'shared',
            upstreamOrigin: 'https://nested.kookapp.cn',
            officialOrigin: 'https://nested.kookapp.cn',
            enabled: false,
            remoteTargetIds: [],
            resourceProxyPrefixes: [],
          }),
        }
      )
      expect(nestedPreviewDomain.status).toBe(400)
      expect(await nestedPreviewDomain.json()).toMatchObject({
        code: 'SITE_BINDING_HOSTNAME_OUTSIDE_PREVIEW_DOMAIN',
      })

      const invalidId = await fetch(`${origin}/api/v1/admin/site-bindings/main_preview`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '非法标识站点',
          hostname: 'invalid.bifrost.vanillacake.cn',
          targetId: 'webapp',
          environmentSlug: 'shared',
          upstreamOrigin: 'https://www.kookapp.cn',
          officialOrigin: 'https://invalid.kookapp.cn',
          enabled: false,
          remoteTargetIds: [],
          resourceProxyPrefixes: [],
        }),
      })
      expect(invalidId.status).toBe(400)
      expect(await invalidId.json()).toMatchObject({ code: 'INVALID_SITE_BINDING' })

      const disabledProject = await fetch(`${origin}/api/v1/admin/site-bindings/disabled-site`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '停用站点',
          hostname: 'disabled.preview.example.test',
          targetId: 'biz',
          environmentSlug: 'shared',
          upstreamOrigin: 'https://biz.kookapp.cn',
          officialOrigin: 'https://biz.kookapp.cn',
          enabled: false,
          remoteTargetIds: [],
          resourceProxyPrefixes: [],
        }),
      })
      expect(disabledProject.status).toBe(400)
      expect(await disabledProject.json()).toMatchObject({
        code: 'SITE_BINDING_TARGET_INVALID',
      })

      const unsupportedAdapter = await fetch(`${origin}/api/v1/admin/site-bindings/legacy-site`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '旧适配器站点',
          hostname: 'legacy.preview.example.test',
          targetId: 'legacy-site',
          environmentSlug: 'shared',
          upstreamOrigin: 'https://legacy.kookapp.cn',
          officialOrigin: 'https://legacy.kookapp.cn',
          enabled: false,
          remoteTargetIds: [],
          resourceProxyPrefixes: [],
        }),
      })
      expect(unsupportedAdapter.status).toBe(400)
      expect(await unsupportedAdapter.json()).toMatchObject({
        code: 'SITE_BINDING_TARGET_INVALID',
      })

      const unsupportedRemoteAdapter = await fetch(
        `${origin}/api/v1/admin/site-bindings/legacy-remote`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '旧 Remote 站点',
            hostname: 'legacy-remote.preview.example.test',
            targetId: 'webapp',
            environmentSlug: 'shared',
            upstreamOrigin: 'https://legacy-remote.kookapp.cn',
            officialOrigin: 'https://legacy-remote.kookapp.cn',
            enabled: false,
            remoteTargetIds: ['legacy-remote'],
            resourceProxyPrefixes: [],
          }),
        }
      )
      expect(unsupportedRemoteAdapter.status).toBe(400)
      expect(await unsupportedRemoteAdapter.json()).toMatchObject({
        code: 'SITE_BINDING_REMOTE_TARGET_INVALID',
      })

      const byHostname = await fetch(
        `${origin}/api/v1/site-bindings/resolve?hostname=MAIN.PREVIEW.EXAMPLE.TEST%3A443`
      )
      expect(byHostname.status).toBe(200)
      expect(await byHostname.json()).toMatchObject({
        id: 'main',
        remoteTargetIds: ['base'],
        resourceProxyPrefixes: [
          'https://static.kookapp.cn/static/',
          'https://img.kookapp.cn/assets/',
        ],
      })

      const byOfficialOrigin = await fetch(
        `${origin}/api/v1/site-bindings/resolve?officialOrigin=${encodeURIComponent('https://www.kookapp.cn/')}`
      )
      expect(byOfficialOrigin.status).toBe(200)
      expect(await byOfficialOrigin.json()).toMatchObject({ id: 'main' })

      const sslSettings = await fetch(`${origin}/api/v1/admin/system-settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoSslEnabled: true }),
      })
      expect(sslSettings.status).toBe(200)
      expect(await sslSettings.json()).toMatchObject({
        autoSslEnabled: true,
        autoSslEmail: '',
      })

      const sslConfig = await fetch(`${origin}/api/v1/internal/auto-ssl-config`, {
        headers: { authorization: 'Bearer internal-test-token' },
      })
      expect(sslConfig.status).toBe(200)
      expect(await sslConfig.json()).toEqual({
        autoSslEnabled: true,
        autoSslEmail: '',
        hostnames: ['main.preview.example.test'],
      })

      const previewResponse = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          siteBindingId: 'main',
          siteArtifactId,
          selections: [{ targetId: 'base', artifactId: remoteArtifactId }],
        }),
      })
      expect(previewResponse.status).toBe(201)
      const preview = (await previewResponse.json()) as PreviewSessionView
      expect(preview).not.toHaveProperty('hotModuleUrl')
      expect(preview).toMatchObject({
        siteBindingId: 'main',
        siteArtifactId,
        siteSelection: {
          targetId: 'webapp',
          artifactId: siteArtifactId,
          branch: 'feature/site-preview',
          builtAt,
        },
        selections: [expect.objectContaining({ targetId: 'base', artifactId: remoteArtifactId })],
      })
      expect(await store.isArtifactReferencedByActivePreview(siteArtifactId)).toBe(true)

      const mismatchedAdapter = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          siteBindingId: 'main',
          siteArtifactId: mismatchedSiteArtifactId,
        }),
      })
      expect(mismatchedAdapter.status).toBe(400)
      expect(await mismatchedAdapter.json()).toMatchObject({
        code: 'PREVIEW_SITE_ARTIFACT_INVALID',
      })

      const storedPreviewResponse = await fetch(`${origin}/api/v1/previews/${preview.token}`)
      expect(storedPreviewResponse.status).toBe(200)
      expect(await storedPreviewResponse.json()).toMatchObject({
        token: preview.token,
        siteSelection: {
          targetId: 'webapp',
          artifactId: siteArtifactId,
          branch: 'feature/site-preview',
          builtAt,
        },
      })

      const revokePreviewResponse = await fetch(
        `${origin}/api/v1/previews/${encodeURIComponent(preview.token)}`,
        { method: 'DELETE' }
      )
      expect(revokePreviewResponse.status).toBe(204)
      expect(await store.isArtifactReferencedByActivePreview(siteArtifactId)).toBe(true)

      const repeatedRevokeResponse = await fetch(
        `${origin}/api/v1/previews/${encodeURIComponent(preview.token)}`,
        { method: 'DELETE' }
      )
      expect(repeatedRevokeResponse.status).toBe(204)
      expect(
        await fetch(`${origin}/api/v1/previews/${encodeURIComponent(preview.token)}`)
      ).toMatchObject({ status: 404 })

      const disallowed = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          siteBindingId: 'main',
          selections: [{ targetId: 'discover', artifactId: randomUUID() }],
        }),
      })
      expect(disallowed.status).toBe(400)
      expect(await disallowed.json()).toMatchObject({ code: 'PREVIEW_REMOTE_NOT_ALLOWED' })

      const incompleteGroup = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '漏选项目',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [{ targetId: 'webapp', mode: 'official' }],
        }),
      })
      expect(incompleteGroup.status).toBe(400)
      expect(await incompleteGroup.json()).toMatchObject({
        code: 'CONFIG_GROUP_PROJECTS_INCOMPLETE',
        expectedTargetIds: ['webapp', 'base'],
      })

      const groupResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          name: '语音频道提测',
          urlPrefix: 'voice-test',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'branch', branch: 'feature/site-preview' },
            { targetId: 'base', mode: 'branch', branch: 'feature/remote-preview' },
          ],
        }),
      })
      expect(groupResponse.status).toBe(201)
      const group = await groupResponse.json()
      expect(group).toMatchObject({
        id: group.token,
        name: '语音频道提测',
        schemaVersion: 1,
        revision: 1,
        environmentSlug: 'shared',
        siteBindingId: 'main',
        createdBy: 'gz',
        updatedBy: 'gz',
        previewHostnamePrefix: 'voice-test',
        sharePath: expect.stringMatching(/^\/s\/[A-Za-z0-9_-]{32}$/),
        directPreviewUrl: 'https://voice-test.preview.example.test',
        available: true,
        environment: { slug: 'shared', name: '公共调试环境', status: 'ACTIVE' },
        siteBinding: {
          id: 'main',
          hostname: 'main.preview.example.test',
          officialOrigin: 'https://www.kookapp.cn',
        },
        items: [
          expect.objectContaining({
            targetId: 'webapp',
            mode: 'branch',
            branch: 'feature/site-preview',
            readiness: 'READY',
            artifact: { id: siteArtifactId, branch: 'feature/site-preview', builtAt },
          }),
          expect.objectContaining({
            targetId: 'base',
            mode: 'branch',
            branch: 'feature/remote-preview',
            readiness: 'READY',
            artifact: { id: remoteArtifactId, branch: 'feature/remote-preview', builtAt },
          }),
        ],
      })

      const resolvedDirectGroupResponse = await fetch(
        `${origin}/api/v1/config-groups/resolve-preview?hostname=${encodeURIComponent('voice-test.preview.example.test')}`
      )
      expect(resolvedDirectGroupResponse.status).toBe(200)
      expect(await resolvedDirectGroupResponse.json()).toMatchObject({
        configurationGroup: { token: group.token, previewHostnamePrefix: 'voice-test' },
        siteBinding: { id: 'main', hostname: 'main.preview.example.test' },
        environment: { slug: 'shared' },
      })

      const duplicatePrefixResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '撞名需求',
          urlPrefix: 'voice-test',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(duplicatePrefixResponse.status).toBe(409)
      expect(await duplicatePrefixResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_URL_PREFIX_CONFLICT',
      })

      const chinesePrefixResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '中文地址需求',
          urlPrefix: '中文需求',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(chinesePrefixResponse.status).toBe(201)
      const chinesePrefixGroup = await chinesePrefixResponse.json()
      expect(chinesePrefixGroup).toMatchObject({
        previewHostnamePrefix: 'xn--fiq228cyxerz3c',
        directPreviewUrl: 'https://xn--fiq228cyxerz3c.preview.example.test',
      })

      const duplicatePunycodeResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Punycode 撞名需求',
          urlPrefix: 'xn--fiq228cyxerz3c',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(duplicatePunycodeResponse.status).toBe(409)
      expect(await duplicatePunycodeResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_URL_PREFIX_CONFLICT',
      })

      const oversizedChinesePrefixResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '过长中文地址',
          urlPrefix: '中'.repeat(60),
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(oversizedChinesePrefixResponse.status).toBe(400)
      expect(await oversizedChinesePrefixResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_URL_PREFIX_INVALID',
      })

      const reservedPrefixResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '保留地址需求',
          urlPrefix: 'main',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(reservedPrefixResponse.status).toBe(400)
      expect(await reservedPrefixResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_URL_PREFIX_RESERVED',
      })

      const nextRemoteArtifactId = randomUUID()
      const nextBuiltAt = new Date(Date.parse(builtAt) + 60_000).toISOString()
      const previousRemoteArtifact = (await store.getArtifact(remoteArtifactId))!
      await store.createArtifact({
        ...previousRemoteArtifact,
        id: nextRemoteArtifactId,
        buildJobId: randomUUID(),
        storageKey: `ready/base/${nextRemoteArtifactId}`,
        builtAt: nextBuiltAt,
        manifest: {
          ...previousRemoteArtifact.manifest,
          artifactId: nextRemoteArtifactId,
          builtAt: nextBuiltAt,
        },
      })

      const stalePreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${group.token}/previews`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 2 }),
        }
      )
      expect(stalePreviewResponse.status).toBe(409)
      expect(await stalePreviewResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_REVISION_CONFLICT',
        currentRevision: 1,
      })

      const currentPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${group.token}/previews`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 1 }),
        }
      )
      expect(currentPreviewResponse.status).toBe(201)

      // Legacy clients send no JSON body; keep that request shape compatible.
      const sharedPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${group.token}/previews`,
        { method: 'POST', headers: { 'x-cuddly-actor': 'qa-from-link' } }
      )
      expect(sharedPreviewResponse.status).toBe(201)
      const sharedPreview = await sharedPreviewResponse.json()
      expect(sharedPreview).toMatchObject({
        mode: 'preview',
        previewOrigin: 'http://main.preview.example.test',
        configurationGroup: { token: group.token },
        preview: {
          createdBy: 'qa-from-link',
          siteBindingId: 'main',
          siteArtifactId,
          selections: [expect.objectContaining({ artifactId: nextRemoteArtifactId })],
        },
      })
      expect(
        sharedPreview.configurationGroup.items.find(
          (item: { targetId: string }) => item.targetId === 'webapp'
        )
      ).toMatchObject({ artifact: { id: siteArtifactId } })
      expect(
        sharedPreview.configurationGroup.items.find(
          (item: { targetId: string }) => item.targetId === 'base'
        )
      ).toMatchObject({ artifact: { id: nextRemoteArtifactId } })

      const remoteOnlyPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${group.token}/previews`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 1, applicationMode: 'remote-only' }),
        }
      )
      expect(remoteOnlyPreviewResponse.status).toBe(201)
      const remoteOnlyPreview = await remoteOnlyPreviewResponse.json()
      expect(remoteOnlyPreview).toMatchObject({
        mode: 'preview',
        applicationMode: 'remote-only',
        preview: {
          siteBindingId: 'main',
          selections: [expect.objectContaining({ artifactId: nextRemoteArtifactId })],
        },
      })
      expect(remoteOnlyPreview.preview.siteArtifactId).toBeUndefined()

      const missingGroupResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '等待 Base 打包',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'branch', branch: 'feature/not-built' },
          ],
        }),
      })
      expect(missingGroupResponse.status).toBe(201)
      const missingGroup = await missingGroupResponse.json()
      expect(missingGroup.items).toEqual([
        expect.objectContaining({ targetId: 'webapp', readiness: 'OFFICIAL' }),
        expect.objectContaining({ targetId: 'base', readiness: 'MISSING' }),
      ])
      const missingPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${missingGroup.token}/previews`,
        { method: 'POST' }
      )
      expect(missingPreviewResponse.status).toBe(409)
      expect(await missingPreviewResponse.json()).toMatchObject({
        code: 'CONFIG_GROUP_ARTIFACTS_NOT_READY',
        missing: [{ targetId: 'base', targetName: 'Base', branch: 'feature/not-built' }],
      })

      const missingSiteGroupResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '本体等待打包但热更可用',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'branch', branch: 'feature/site-not-built' },
            { targetId: 'base', mode: 'branch', branch: 'feature/remote-preview' },
          ],
        }),
      })
      expect(missingSiteGroupResponse.status).toBe(201)
      const missingSiteGroup = await missingSiteGroupResponse.json()
      const missingSiteRemoteOnlyResponse = await fetch(
        `${origin}/api/v1/config-groups/${missingSiteGroup.token}/previews`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ applicationMode: 'remote-only' }),
        }
      )
      expect(missingSiteRemoteOnlyResponse.status).toBe(201)
      const missingSiteRemoteOnlyPreview = await missingSiteRemoteOnlyResponse.json()
      expect(missingSiteRemoteOnlyPreview.preview.siteArtifactId).toBeUndefined()
      expect(missingSiteRemoteOnlyPreview.preview.selections).toEqual([
        expect.objectContaining({ artifactId: nextRemoteArtifactId }),
      ])

      const officialGroupResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '完全跟随官网',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      const officialGroup = await officialGroupResponse.json()
      const officialPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${officialGroup.token}/previews`,
        { method: 'POST' }
      )
      expect(officialPreviewResponse.status).toBe(201)
      expect(await officialPreviewResponse.json()).toMatchObject({
        mode: 'preview',
        configurationGroup: { token: officialGroup.token },
        preview: {
          environmentSlug: 'shared',
          siteBindingId: 'main',
          selections: [],
        },
        previewOrigin: expect.stringContaining('main.preview.example.test'),
      })

      const managedGroupResponse = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'creator' },
        body: JSON.stringify({
          name: '可管理需求',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      const managedGroup = await managedGroupResponse.json()
      expect(managedGroupResponse.status).toBe(201)
      expect(managedGroup).toMatchObject({
        id: managedGroup.token,
        revision: 1,
        createdBy: 'creator',
        updatedBy: 'creator',
      })

      const originalManagedPreviewResponse = await fetch(
        `${origin}/api/v1/config-groups/${managedGroup.token}/previews`,
        { method: 'POST', headers: { 'x-cuddly-actor': 'first-qa' } }
      )
      const originalManagedPreview = await originalManagedPreviewResponse.json()
      expect(originalManagedPreviewResponse.status).toBe(201)
      expect(originalManagedPreview.preview.selections).toEqual([])

      const groupListResponse = await fetch(`${origin}/api/v1/config-groups`)
      expect(groupListResponse.status).toBe(200)
      expect(groupListResponse.headers.get('cache-control')).toBe('no-store')
      const groupList = await groupListResponse.json()
      expect(groupList.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: managedGroup.token,
            token: managedGroup.token,
            name: '可管理需求',
            sharePath: `/s/${managedGroup.token}`,
            items: [
              { targetId: 'webapp', mode: 'official' },
              { targetId: 'base', mode: 'official' },
            ],
          }),
        ])
      )
      expect(
        groupList.items.find((item: { token: string }) => item.token === managedGroup.token)
      ).not.toHaveProperty('available')

      const incompleteManagedUpdate = await fetch(
        `${origin}/api/v1/config-groups/${managedGroup.token}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            schemaVersion: 1,
            name: '漏掉热更项目',
            environmentSlug: 'shared',
            siteBindingId: 'main',
            items: [{ targetId: 'webapp', mode: 'official' }],
          }),
        }
      )
      expect(incompleteManagedUpdate.status).toBe(400)
      expect(await incompleteManagedUpdate.json()).toMatchObject({
        code: 'CONFIG_GROUP_PROJECTS_INCOMPLETE',
      })
      expect(await store.getConfigurationGroup(managedGroup.token)).toMatchObject({ revision: 1 })

      const updateManagedResponse = await fetch(
        `${origin}/api/v1/config-groups/${managedGroup.token}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'editor' },
          body: JSON.stringify({
            expectedRevision: 1,
            schemaVersion: 1,
            name: '编辑后的需求',
            environmentSlug: 'shared',
            siteBindingId: 'main',
            items: [
              { targetId: 'webapp', mode: 'branch', branch: 'feature/site-preview' },
              { targetId: 'base', mode: 'branch', branch: 'feature/remote-preview' },
            ],
          }),
        }
      )
      expect(updateManagedResponse.status).toBe(200)
      expect(await updateManagedResponse.json()).toMatchObject({
        id: managedGroup.token,
        token: managedGroup.token,
        name: '编辑后的需求',
        revision: 2,
        createdBy: 'creator',
        updatedBy: 'editor',
        items: [
          expect.objectContaining({ targetId: 'webapp', branch: 'feature/site-preview' }),
          expect.objectContaining({ targetId: 'base', branch: 'feature/remote-preview' }),
        ],
      })
      expect(await store.getPreviewSession(originalManagedPreview.preview.token)).toMatchObject({
        selections: [],
      })

      const conflictingUpdate = await fetch(
        `${origin}/api/v1/config-groups/${managedGroup.token}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            schemaVersion: 1,
            name: '覆盖他人更新',
            environmentSlug: 'shared',
            siteBindingId: 'main',
            items: [
              { targetId: 'webapp', mode: 'official' },
              { targetId: 'base', mode: 'official' },
            ],
          }),
        }
      )
      expect(conflictingUpdate.status).toBe(409)
      expect(await conflictingUpdate.json()).toMatchObject({
        code: 'CONFIG_GROUP_REVISION_CONFLICT',
        currentRevision: 2,
      })

      const deleteManagedResponse = await fetch(
        `${origin}/api/v1/config-groups/${managedGroup.token}`,
        { method: 'DELETE', headers: { 'x-cuddly-actor': 'deleter' } }
      )
      expect(deleteManagedResponse.status).toBe(204)
      expect(await fetch(`${origin}/api/v1/config-groups/${managedGroup.token}`)).toMatchObject({
        status: 404,
      })
      expect(
        await fetch(`${origin}/api/v1/config-groups/${managedGroup.token}`, {
          method: 'DELETE',
        })
      ).toMatchObject({ status: 404 })

      const missingUpdate = await fetch(`${origin}/api/v1/config-groups/${'z'.repeat(32)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          schemaVersion: 1,
          name: '不存在',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'official' },
          ],
        }),
      })
      expect(missingUpdate.status).toBe(404)
      expect(await missingUpdate.json()).toMatchObject({ code: 'CONFIG_GROUP_NOT_FOUND' })

      const baseConfig = (await store.getProjectEnvironmentConfig(SHARED_ENVIRONMENT_ID, 'base'))!
      await store.saveProjectEnvironmentConfig({ ...baseConfig, enabled: false }, 'gz')

      const disabledRemotePreview = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          siteBindingId: 'main',
          selections: [{ targetId: 'base', artifactId: nextRemoteArtifactId }],
        }),
      })
      expect(disabledRemotePreview.status).toBe(409)
      expect(await disabledRemotePreview.json()).toMatchObject({
        code: 'PREVIEW_PROJECT_UNAVAILABLE',
      })

      const disabledSharedGroup = await fetch(`${origin}/api/v1/config-groups/${group.token}`).then(
        (response) => response.json()
      )
      expect(disabledSharedGroup).toMatchObject({
        available: false,
        items: expect.arrayContaining([
          expect.objectContaining({ targetId: 'base', readiness: 'UNAVAILABLE' }),
        ]),
      })
      const disabledSharedPreview = await fetch(
        `${origin}/api/v1/config-groups/${group.token}/previews`,
        { method: 'POST' }
      )
      expect(disabledSharedPreview.status).toBe(409)
      expect(await disabledSharedPreview.json()).toMatchObject({ code: 'CONFIG_GROUP_UNAVAILABLE' })

      const disabledGroupCreate = await fetch(`${origin}/api/v1/config-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '停用项目不能固定旧包',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          items: [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'branch', branch: 'feature/remote-preview' },
          ],
        }),
      })
      expect(disabledGroupCreate.status).toBe(409)
      expect(await disabledGroupCreate.json()).toMatchObject({
        code: 'CONFIG_GROUP_PROJECT_UNAVAILABLE',
      })

      const webappConfig = (await store.getProjectEnvironmentConfig(
        SHARED_ENVIRONMENT_ID,
        'webapp'
      ))!
      await store.saveProjectEnvironmentConfig({ ...webappConfig, enabled: false }, 'gz')
      const disabledSitePreview = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteBindingId: 'main', siteArtifactId }),
      })
      expect(disabledSitePreview.status).toBe(409)
      expect(await disabledSitePreview.json()).toMatchObject({
        code: 'PREVIEW_PROJECT_UNAVAILABLE',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('persists environment order consistently across public and admin directories', async () => {
    const store = new MemoryStore()
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const save = (slug: string, sortOrder?: unknown) =>
        fetch(`${origin}/api/v1/admin/environments/${slug}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: slug,
            backendOrigin: 'https://www.kookapp.cn',
            ...(sortOrder === undefined ? {} : { sortOrder }),
          }),
        })
      expect((await save('qa', 20)).status).toBe(200)
      expect((await save('online', -20)).status).toBe(200)
      expect((await save('tttt', -10)).status).toBe(200)
      const legacy = await save('online')
      expect(await legacy.json()).toMatchObject({ sortOrder: -20 })
      for (const path of ['environments', 'admin/environments']) {
        const response = await fetch(`${origin}/api/v1/${path}`)
        const body = await response.json()
        expect(body.items.map((e: { slug: string }) => e.slug)).toEqual([
          'online',
          'tttt',
          'shared',
          'qa',
        ])
      }
      for (const value of [1.5, 'first', null, 1000001])
        expect((await save('online', value)).status).toBe(400)
      expect((await store.getEnvironment('online'))!.sortOrder).toBe(-20)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('manages isolated runtime environments and snapshots effective environment commands', async () => {
    const store = new MemoryStore()
    const webapp = (await store.getBuildTarget('webapp'))!
    await store.saveBuildTarget(
      {
        ...webapp,
        repositoryUrl: 'file:///definitely-missing/webapp.git',
        enabled: true,
        configurationSource: 'database',
      },
      'gz'
    )
    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)

    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const created = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          name: '测试环境',
          backendOrigin: 'https://staging-api.example.test',
          status: 'ACTIVE',
        }),
      })
      expect(created.status).toBe(200)
      const environment = (await created.json()) as {
        id: string
        slug: string
        backendOrigin: string
        useInternalProxy: boolean
        resourceProxyPrefixes: string[]
      }
      expect(environment).toMatchObject({
        slug: 'staging',
        backendOrigin: 'https://staging-api.example.test',
        useInternalProxy: false,
        resourceProxyPrefixes: [],
      })
      const proxied = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          name: '测试环境',
          backendOrigin: 'https://staging-api.example.test',
          useInternalProxy: true,
          status: 'ACTIVE',
        }),
      })
      expect(proxied.status).toBe(200)
      expect(await proxied.json()).toMatchObject({ useInternalProxy: true })

      const resourceProxyConfigured = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          name: '测试环境',
          backendOrigin: 'https://staging-api.example.test',
          useInternalProxy: true,
          resourceProxyPrefixes: [' HTTPS://IMG.CHUANYUAPP.COM:443/ '],
          status: 'ACTIVE',
        }),
      })
      expect(resourceProxyConfigured.status).toBe(200)
      expect(await resourceProxyConfigured.json()).toMatchObject({
        resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
      })

      const legacyUpdate = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          name: '测试环境（兼容旧控制台）',
          backendOrigin: 'https://staging-api.example.test',
          status: 'ACTIVE',
        }),
      })
      expect(legacyUpdate.status).toBe(200)
      expect(await legacyUpdate.json()).toMatchObject({
        name: '测试环境（兼容旧控制台）',
        useInternalProxy: true,
        resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
      })

      const drafts = await fetch(`${origin}/api/v1/admin/environments/staging/projects`).then(
        (response) => response.json()
      )
      expect(
        drafts.items.find((item: { targetId: string }) => item.targetId === 'webapp')
      ).toMatchObject({
        enabled: false,
        required: false,
      })
      expect(await store.listProjectEnvironmentConfigs(environment.id)).toEqual([])

      const configured = await fetch(`${origin}/api/v1/admin/environments/staging/projects`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-cuddly-actor': 'gz' },
        body: JSON.stringify({
          items: [
            {
              targetId: 'webapp',
              enabled: true,
              required: true,
              installCommand: 'pnpm install --staging',
              buildCommand: 'pnpm build --staging',
              outputDirectory: 'staging-dist',
            },
          ],
        }),
      })
      expect(configured.status).toBe(200)

      const publicTargets = await fetch(`${origin}/api/v1/build-targets?environment=staging`).then(
        (response) => response.json()
      )
      expect(publicTargets.items).toEqual([
        expect.objectContaining({ id: 'webapp', enabled: true, required: true }),
      ])

      const build = await fetch(`${origin}/api/v1/build-jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'staging-build',
          'x-cuddly-actor': 'gz',
        },
        body: JSON.stringify({
          environmentSlug: 'staging',
          targetId: 'webapp',
          branch: 'feature/staging',
        }),
      })
      expect(build.status).toBe(202)
      const createdBuild = (await build.json()) as BuildJob
      expect(createdBuild).toMatchObject({
        environmentId: environment.id,
        environmentSlug: 'staging',
        targetSnapshot: {
          environment: {
            id: environment.id,
            slug: 'staging',
            backendOrigin: 'https://staging-api.example.test',
          },
          installCommand: 'pnpm install --staging',
          buildCommand: 'pnpm build --staging',
          outputDirectory: 'staging-dist',
        },
      })
      const stagingHistory = await fetch(`${origin}/api/v1/build-jobs?environment=staging`).then(
        (response) => response.json()
      )
      const sharedHistory = await fetch(`${origin}/api/v1/build-jobs`).then((response) =>
        response.json()
      )
      expect(stagingHistory.items).toHaveLength(1)
      expect(sharedHistory.items).toHaveLength(0)

      const frozen = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '测试环境',
          backendOrigin: 'https://staging-api.example.test',
          useInternalProxy: true,
          status: 'FROZEN',
        }),
      })
      expect(frozen.status).toBe(200)
      expect(await frozen.json()).toMatchObject({ useInternalProxy: true })
      const artifactId = randomUUID()
      const builtAt = new Date().toISOString()
      await store.createArtifact({
        id: artifactId,
        buildJobId: createdBuild.id,
        environmentId: environment.id,
        environmentSlug: environment.slug,
        targetId: 'webapp',
        branch: 'feature/artifact-ready',
        status: 'READY',
        storageKey: `ready/webapp/${artifactId}`,
        builtAt,
        createdBy: 'gz',
        manifest: {
          schemaVersion: 1,
          artifactId,
          target: 'webapp',
          branch: 'feature/artifact-ready',
          builtAt,
          serve: {
            siteAdapter: 'generic-static-v1',
            entrypoints: ['index.html'],
            publicBase: `/__cuddly/artifacts/${artifactId}/`,
          },
          files: [],
        },
      })
      const frozenBranchesResponse = await fetch(
        `${origin}/api/v1/build-targets/webapp/branches?environment=staging`
      )
      expect(frozenBranchesResponse.status).toBe(200)
      expect(await frozenBranchesResponse.json()).toMatchObject({
        remoteAvailable: false,
        items: [
          {
            branch: 'feature/artifact-ready',
            latestArtifact: { id: artifactId },
          },
        ],
      })
      await store.saveSiteBinding(
        {
          id: 'main',
          name: '网页端',
          hostname: 'main.preview.example.test',
          targetId: 'webapp',
          environmentSlug: 'shared',
          fallbackOrigin: 'https://www.kookapp.cn',
          upstreamOrigin: 'https://www.kookapp.cn',
          officialOrigin: 'https://www.kookapp.cn',
          enabled: true,
          remoteTargetIds: [],
          resourceProxyPrefixes: [],
        },
        'gz'
      )
      const isolatedPreview = await fetch(`${origin}/api/v1/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          environmentSlug: 'staging',
          siteBindingId: 'main',
          siteArtifactId: artifactId,
        }),
      })
      expect(isolatedPreview.status).toBe(201)
      expect(await isolatedPreview.json()).toMatchObject({
        environmentId: environment.id,
        environmentSlug: 'staging',
        siteBindingId: 'main',
        siteSelection: { artifactId },
      })
      const publicRevision = await fetch(`${origin}/api/v1/environments/staging/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevisionId: null, selections: [] }),
      })
      expect(publicRevision.status).toBe(410)
      expect(await publicRevision.json()).toMatchObject({ code: 'PUBLIC_REVISION_DISABLED' })
      const rejectedBuild = await fetch(`${origin}/api/v1/build-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          environmentSlug: 'staging',
          targetId: 'webapp',
          branch: 'feature/frozen',
        }),
      })
      expect(rejectedBuild.status).toBe(409)
      expect(await rejectedBuild.json()).toMatchObject({ code: 'ENVIRONMENT_NOT_ACTIVE' })

      const archived = await fetch(`${origin}/api/v1/admin/environments/staging`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '测试环境',
          backendOrigin: 'https://staging-api.example.test',
          useInternalProxy: true,
          status: 'ARCHIVED',
        }),
      })
      expect(archived.status).toBe(200)
      const publicEnvironments = await fetch(`${origin}/api/v1/environments`).then((response) =>
        response.json()
      )
      const adminEnvironments = await fetch(`${origin}/api/v1/admin/environments`).then(
        (response) => response.json()
      )
      expect(publicEnvironments.items.map((item: { slug: string }) => item.slug)).not.toContain(
        'staging'
      )
      expect(adminEnvironments.items.map((item: { slug: string }) => item.slug)).toContain(
        'staging'
      )
      expect(await fetch(`${origin}/api/v1/environments/staging/matrix`)).toMatchObject({
        status: 410,
      })
      expect(await fetch(`${origin}/api/v1/admin/environments/staging/projects`)).toMatchObject({
        status: 200,
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('returns deterministic named site candidates and keeps archived bindings manageable', async () => {
    const store = new MemoryStore()
    const frozen = await store.saveEnvironment(
      {
        id: randomUUID(),
        slug: 'frozen',
        name: '冻结环境',
        status: 'ACTIVE',
        backendOrigin: 'https://frozen-api.example.test',
        useInternalProxy: false,
        resourceProxyPrefixes: [],
        currentRevisionId: null,
      },
      'gz'
    )
    const archived = await store.saveEnvironment(
      {
        id: randomUUID(),
        slug: 'archived',
        name: '归档环境',
        status: 'ACTIVE',
        backendOrigin: 'https://archived-api.example.test',
        useInternalProxy: false,
        resourceProxyPrefixes: [],
        currentRevisionId: null,
      },
      'gz'
    )
    const binding = (id: string, environmentSlug: string) => ({
      id,
      name: `${environmentSlug} binding`,
      hostname: `${environmentSlug}.preview.example.test`,
      targetId: 'webapp',
      environmentSlug,
      fallbackOrigin: 'https://www.kookapp.cn',
      upstreamOrigin: 'https://www.kookapp.cn',
      officialOrigin: 'https://www.kookapp.cn',
      enabled: true,
      remoteTargetIds: [],
      resourceProxyPrefixes: [],
    })
    await store.saveSiteBinding(binding('shared-site', 'shared'), 'gz')
    await store.saveSiteBinding(binding('frozen-site', frozen.slug), 'gz')
    await store.saveSiteBinding(binding('archived-site', archived.slug), 'gz')
    await store.saveEnvironment({ ...frozen, status: 'FROZEN' }, 'gz')
    await store.saveEnvironment({ ...archived, status: 'ARCHIVED' }, 'gz')

    const server = createControlApp({
      store,
      internalApiToken: 'internal-test-token',
      settingsSecret: 'test-secret',
    }).listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      const sslConfig = await fetch(`${origin}/api/v1/internal/auto-ssl-config`, {
        headers: { authorization: 'Bearer internal-test-token' },
      }).then((response) => response.json())
      expect(sslConfig.hostnames).toEqual([
        'archived.preview.example.test',
        'frozen.preview.example.test',
        'shared.preview.example.test',
      ])
      const candidates = await fetch(
        `${origin}/api/v1/site-bindings/candidates?officialOrigin=https%3A%2F%2Fwww.kookapp.cn`
      ).then((response) => response.json())
      expect(candidates.items).toEqual([
        expect.objectContaining({
          id: 'shared-site',
          environmentName: '公共调试环境',
          environmentStatus: 'ACTIVE',
        }),
        expect.objectContaining({
          id: 'frozen-site',
          environmentName: '冻结环境',
          environmentStatus: 'FROZEN',
        }),
        expect.objectContaining({
          id: 'archived-site',
          environmentName: '归档环境',
          environmentStatus: 'ARCHIVED',
        }),
      ])
      expect(
        await fetch(
          `${origin}/api/v1/site-bindings/resolve?officialOrigin=https%3A%2F%2Fwww.kookapp.cn`
        ).then((response) => response.json())
      ).toMatchObject({ id: 'shared-site' })
      expect(
        await fetch(`${origin}/api/v1/site-bindings/resolve?hostname=archived.preview.example.test`)
      ).toMatchObject({ status: 200 })
      expect(await fetch(`${origin}/api/v1/admin/site-bindings/archived-site`)).toMatchObject({
        status: 200,
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
