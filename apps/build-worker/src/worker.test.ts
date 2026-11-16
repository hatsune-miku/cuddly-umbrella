import { randomUUID } from 'node:crypto'

import type { Artifact, BuildJob, RunnerArtifactInventoryItem } from '@cuddly/contracts'
import { MemoryStore } from '@cuddly/db'
import { describe, expect, it, vi } from 'vitest'

import {
  BuildWorker,
  cleanupSupersededArtifacts,
  maintainArtifacts,
  processBuildJob,
  reconcileOrphanArtifacts,
} from './worker'

const TEST_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ENVIRONMENT_SLUG = 'shared'
const TEST_BACKEND_ORIGIN = 'https://api.kookapp.cn'

function artifact(input: { targetId: string; branch: string; builtAt: string }): Artifact {
  const id = randomUUID()
  return {
    id,
    buildJobId: randomUUID(),
    targetId: input.targetId,
    environmentId: TEST_ENVIRONMENT_ID,
    environmentSlug: TEST_ENVIRONMENT_SLUG,
    branch: input.branch,
    status: 'READY',
    storageKey: `ready/${input.targetId}/${id}`,
    builtAt: input.builtAt,
    createdBy: 'gz',
    manifest: {
      schemaVersion: 1,
      artifactId: id,
      target: input.targetId,
      branch: input.branch,
      builtAt: input.builtAt,
      serve: {
        siteAdapter: 'generic-static-v1',
        entrypoints: ['index.html'],
        publicBase: `/__cuddly/artifacts/${id}/`,
      },
      files: [
        {
          path: 'index.html',
          size: 1,
          contentType: 'text/html',
          digest: 'sha256:test',
          cacheClass: 'html',
        },
      ],
    },
  }
}

function inventoryResponse(artifacts: RunnerArtifactInventoryItem[]): Response {
  return new Response(JSON.stringify({ artifacts }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function buildJobSnapshot() {
  return {
    id: 'online-h5',
    kind: 'h5-site' as const,
    repositoryUrl: 'https://git.example.test/mobile.git',
    installCommand: 'pnpm install',
    buildCommand: 'pnpm build',
    outputDirectory: 'build',
    siteAdapter: 'kook-online-h5-v1',
    environment: {
      id: TEST_ENVIRONMENT_ID,
      slug: TEST_ENVIRONMENT_SLUG,
      name: '公共调试环境',
      backendOrigin: TEST_BACKEND_ORIGIN,
    },
  }
}

async function configuredStore(): Promise<MemoryStore> {
  const store = new MemoryStore()
  for (const targetId of ['online-h5', 'webapp']) {
    const target = await store.getBuildTarget(targetId)
    if (!target) throw new Error(`Missing test project: ${targetId}`)
    const saved = await store.saveBuildTarget(
      {
        ...target,
        repositoryUrl: `https://git.example.test/${targetId}.git`,
        enabled: true,
      },
      'gz'
    )
    await store.saveProjectEnvironmentConfig(
      {
        targetId,
        environmentId: TEST_ENVIRONMENT_ID,
        enabled: true,
        required: false,
        installCommand: saved.installCommand,
        buildCommand: saved.buildCommand,
        outputDirectory: saved.outputDirectory,
      },
      'gz'
    )
  }
  return store
}

function successfulRunnerResponse(init?: RequestInit): Response {
  const input = JSON.parse(String(init?.body)) as {
    jobId: string
    artifactId: string
    targetId: string
    environmentId: string
    environmentSlug: string
    branch: string
  }
  const builtAt = new Date().toISOString()
  const events = [
    { type: 'stage', stage: 'CHECKOUT', at: builtAt },
    { type: 'stage', stage: 'INSTALLING', at: builtAt },
    { type: 'stage', stage: 'BUILDING', at: builtAt },
    { type: 'stage', stage: 'VALIDATING', at: builtAt },
    { type: 'stage', stage: 'UPLOADING', at: builtAt },
    {
      type: 'result',
      artifactId: input.artifactId,
      storageKey: `ready/${input.targetId}/${input.artifactId}`,
      builtAt,
      logPath: `/logs/${input.jobId}.log`,
      manifest: {
        schemaVersion: 1,
        artifactId: input.artifactId,
        target: input.targetId,
        branch: input.branch,
        builtAt,
        serve: {
          siteAdapter: 'kook-online-h5-v1',
          entrypoints: ['index.htm'],
          publicBase: `/__cuddly/artifacts/${input.artifactId}/`,
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
    },
  ]
  return new Response(events.map((event) => JSON.stringify(event)).join('\n'))
}

describe('BuildWorker concurrency', () => {
  it('fills execution slots with jobs from different projects', async () => {
    const store = await configuredStore()
    await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/mobile',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.createBuildJob({
      id: randomUUID(),
      targetId: 'webapp',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/web',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })

    const started = new Set<string>()
    const releases = new Map<string, () => void>()
    let resolveBothStarted: () => void = () => undefined
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve
    })
    const processJob = async (job: BuildJob) => {
      started.add(job.targetId)
      if (started.size === 2) resolveBothStarted()
      await new Promise<void>((resolve) => releases.set(job.id, resolve))
      return true
    }
    const worker = new BuildWorker(
      {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'test-token',
        workerId: 'worker-1',
        requestTimeoutMs: 1000,
        maxConcurrency: 2,
        fetchImpl: async () => inventoryResponse([]),
      },
      processJob
    )

    const run = worker.run(5)
    await Promise.race([
      bothStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('worker did not start both projects')), 1000)
      ),
    ])

    expect([...started].sort()).toEqual(['online-h5', 'webapp'])
    worker.stop()
    releases.forEach((release) => release())
    await run
  })

  it('does not count a single-flight maintenance sweep against build execution slots', async () => {
    const store = await configuredStore()
    const first = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/first',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    const second = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'webapp',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/second',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    let announceInventoryStarted: () => void = () => undefined
    const inventoryStarted = new Promise<void>((resolve) => {
      announceInventoryStarted = resolve
    })
    let releaseInventory: () => void = () => undefined
    const inventoryReleased = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })
    let announceSecondStarted: () => void = () => undefined
    const secondStarted = new Promise<void>((resolve) => {
      announceSecondStarted = resolve
    })
    let releaseSecond: () => void = () => undefined
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const worker = new BuildWorker(
      {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 1000,
        maxConcurrency: 1,
        fetchImpl: async (_input, init) => {
          expect(init?.method).toBe('GET')
          announceInventoryStarted()
          await inventoryReleased
          return inventoryResponse([])
        },
      },
      async (job) => {
        if (job.id === first.id) {
          await inventoryStarted
          return true
        }
        expect(job.id).toBe(second.id)
        announceSecondStarted()
        await secondReleased
        return false
      }
    )

    const run = worker.run(5)
    await Promise.race([
      secondStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('maintenance occupied the only build slot')), 1000)
      ),
    ])
    worker.stop()
    releaseSecond()
    releaseInventory()
    await run
  })
})

describe('BuildWorker cancellation', () => {
  it('forwards cancellation to Runner and finalizes only after Runner acknowledges it', async () => {
    const store = await configuredStore()
    const job = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/cancel-active',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: buildJobSnapshot(),
    })
    const claimed = (await store.claimNextBuildJob('worker-1'))!
    const encoder = new TextEncoder()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let announceRunnerStarted: () => void = () => undefined
    const runnerStarted = new Promise<void>((resolve) => {
      announceRunnerStarted = resolve
    })
    const runnerResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'stage', stage: 'CHECKOUT', at: new Date().toISOString() })}\n`
            )
          )
          announceRunnerStarted()
        },
      })
    )
    const requests: string[] = []
    const cancellation = new AbortController()
    const processing = processBuildJob(
      claimed,
      {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 10_000,
        maxConcurrency: 1,
        fetchImpl: async (input) => {
          const url = String(input)
          requests.push(url)
          if (url.endsWith('/internal/run')) return runnerResponse
          if (url.endsWith(`/internal/runs/${job.id}/cancel`)) {
            expect((await store.getBuildJob(job.id))?.status).toBe('CANCELING')
            streamController.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: 'error', code: 'BUILD_CANCELED', message: 'Build cancellation was requested', logPath: `/logs/${job.id}.log` })}\n`
              )
            )
            streamController.close()
            return new Response(JSON.stringify({ status: 'CANCELING' }), { status: 202 })
          }
          throw new Error(`Unexpected request: ${url}`)
        },
      },
      cancellation.signal
    )

    await runnerStarted
    await store.requestBuildJobCancellation(job.id, 'qa-one')
    cancellation.abort()
    await expect(processing).resolves.toBe(false)

    expect(requests).toEqual([
      'http://runner.test/internal/run',
      `http://runner.test/internal/runs/${job.id}/cancel`,
    ])
    expect(await store.getBuildJob(job.id)).toMatchObject({
      status: 'CANCELED',
      failureCode: 'BUILD_CANCELED',
      logPath: `/logs/${job.id}.log`,
    })
    expect((await store.listBuildJobEvents(job.id)).map((event) => event.status)).toEqual([
      'QUEUED',
      'LEASED',
      'CANCELING',
      'CANCELED',
    ])
  })

  it('deletes a physical result when cancellation wins the atomic DB publication race', async () => {
    const store = await configuredStore()
    const job = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/cancel-at-publish',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: buildJobSnapshot(),
    })
    const claimed = (await store.claimNextBuildJob('worker-1'))!
    const complete = store.completeBuildJob.bind(store)
    vi.spyOn(store, 'completeBuildJob').mockImplementation(async (jobId, record) => {
      await store.requestBuildJobCancellation(jobId, 'qa-one')
      return complete(jobId, record)
    })
    const deletes: Array<{ artifactId: string; storageKey: string }> = []

    await expect(
      processBuildJob(claimed, {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 10_000,
        maxConcurrency: 1,
        fetchImpl: async (input, init) => {
          const url = String(input)
          if (url.endsWith('/internal/run')) return successfulRunnerResponse(init)
          if (url.endsWith('/internal/artifacts/delete')) {
            deletes.push(JSON.parse(String(init?.body)))
            return new Response(null, { status: 204 })
          }
          throw new Error(`Unexpected request: ${url}`)
        },
      })
    ).resolves.toBe(false)

    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.storageKey).toBe(`ready/online-h5/${deletes[0]?.artifactId}`)
    expect(await store.getArtifact(deletes[0]!.artifactId)).toBeNull()
    expect((await store.getBuildJob(job.id))?.status).toBe('CANCELED')
  })

  it('turns the active processor signal on while CANCELING still blocks the project', async () => {
    const store = await configuredStore()
    const running = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/cancel-monitor',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    let announceStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    let announceCanceled: () => void = () => undefined
    const canceled = new Promise<void>((resolve) => {
      announceCanceled = resolve
    })
    let releaseProcessor: () => void = () => undefined
    const processorReleased = new Promise<void>((resolve) => {
      releaseProcessor = resolve
    })
    const worker = new BuildWorker(
      {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 10_000,
        maxConcurrency: 1,
        fetchImpl: async () => inventoryResponse([]),
      },
      async (job, _options, signal) => {
        expect(job.id).toBe(running.id)
        announceStarted()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        )
        expect((await store.getBuildJob(job.id))?.status).toBe('CANCELING')
        expect(await store.claimNextBuildJob('other-worker')).toBeNull()
        await store.transitionBuildJob(job.id, ['CANCELING'], {
          status: 'CANCELED',
          finishedAt: new Date().toISOString(),
        })
        announceCanceled()
        await processorReleased
        return false
      }
    )

    const run = worker.run(5)
    await started
    const next = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/after-cancel',
      profile: 'qa-web',
      requestedBy: 'qa-two',
      idempotencyKey: null,
      targetSnapshot: null,
    })
    await store.requestBuildJobCancellation(running.id, 'qa-one')
    await canceled
    worker.stop()
    releaseProcessor()
    await run
    expect((await store.claimNextBuildJob('other-worker'))?.id).toBe(next.id)
  })
})

describe('BuildWorker environment snapshot', () => {
  it('forwards the resolved environment and publishes an environment-scoped Artifact', async () => {
    const store = await configuredStore()
    const job = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/environment-payload',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: buildJobSnapshot(),
    })
    const claimed = (await store.claimNextBuildJob('worker-1'))!
    let runnerPayload: Record<string, unknown> | null = null

    await expect(
      processBuildJob(claimed, {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 10_000,
        maxConcurrency: 1,
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe('http://runner.test/internal/run')
          runnerPayload = JSON.parse(String(init?.body))
          return successfulRunnerResponse(init)
        },
      })
    ).resolves.toBe(true)

    expect(runnerPayload).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      project: {
        environment: {
          id: TEST_ENVIRONMENT_ID,
          slug: TEST_ENVIRONMENT_SLUG,
          backendOrigin: TEST_BACKEND_ORIGIN,
        },
      },
    })
    expect(await store.getArtifactByBuildJobId(job.id)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      targetId: 'online-h5',
      branch: 'feature/environment-payload',
    })
  })

  it('fails closed before Runner when the immutable snapshot belongs to another environment', async () => {
    const store = await configuredStore()
    const snapshot = buildJobSnapshot()
    snapshot.environment = {
      ...snapshot.environment,
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'other',
    }
    const job = await store.createBuildJob({
      id: randomUUID(),
      targetId: 'online-h5',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      branch: 'feature/environment-mismatch',
      profile: 'qa-web',
      requestedBy: 'gz',
      idempotencyKey: null,
      targetSnapshot: snapshot,
    })
    const claimed = (await store.claimNextBuildJob('worker-1'))!
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(
      processBuildJob(claimed, {
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 10_000,
        maxConcurrency: 1,
        fetchImpl,
      })
    ).resolves.toBe(false)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await store.getBuildJob(job.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'TARGET_SNAPSHOT_ENVIRONMENT_MISMATCH',
    })
  })
})

describe('Artifact cleanup', () => {
  it('deletes the physical package before committing the DELETED tombstone', async () => {
    const store = new MemoryStore()
    const old = artifact({
      targetId: 'webapp',
      branch: 'master',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    const latest = artifact({
      targetId: 'webapp',
      branch: 'master',
      builtAt: '2026-08-25T02:00:00.000Z',
    })
    await store.createArtifact(old)
    await store.createArtifact(latest)
    const requests: Array<{ url: string; body: unknown }> = []

    const completed = await cleanupSupersededArtifacts({
      store,
      runnerUrl: 'http://runner.test/',
      runnerToken: 'runner-token',
      workerId: 'worker-1',
      requestTimeoutMs: 1000,
      maxConcurrency: 1,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        expect((await store.getArtifact(old.id))?.status).toBe('DELETING')
        return new Response(null, { status: 204 })
      },
    })

    expect(completed).toBe(1)
    expect(requests).toEqual([
      {
        url: 'http://runner.test/internal/artifacts/delete',
        body: { artifactId: old.id, storageKey: old.storageKey },
      },
    ])
    expect((await store.getArtifact(old.id))?.status).toBe('DELETED')
    expect((await store.getArtifact(latest.id))?.status).toBe('READY')
  })

  it('keeps DELETING when the delete result is uncertain so READY never points at partial files', async () => {
    const store = new MemoryStore()
    const old = artifact({
      targetId: 'online-h5',
      branch: 'master',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    const latest = artifact({
      targetId: 'online-h5',
      branch: 'master',
      builtAt: '2026-08-25T02:00:00.000Z',
    })
    await store.createArtifact(old)
    await store.createArtifact(latest)

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await cleanupSupersededArtifacts({
        store,
        runnerUrl: 'http://runner.test',
        runnerToken: 'runner-token',
        workerId: 'worker-1',
        requestTimeoutMs: 1000,
        maxConcurrency: 1,
        fetchImpl: async () => new Response('disk busy', { status: 500 }),
      })
    } finally {
      error.mockRestore()
    }

    expect((await store.getArtifact(old.id))?.status).toBe('DELETING')
  })

  it('runs a sweep when the worker starts even when there are no build jobs', async () => {
    const store = new MemoryStore()
    const old = artifact({
      targetId: 'webapp',
      branch: 'existing-branch',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    const latest = artifact({
      targetId: 'webapp',
      branch: 'existing-branch',
      builtAt: '2026-08-25T02:00:00.000Z',
    })
    await store.createArtifact(old)
    await store.createArtifact(latest)
    let announceDeleted: () => void = () => undefined
    const deleted = new Promise<void>((resolve) => {
      announceDeleted = resolve
    })
    const worker = new BuildWorker({
      store,
      runnerUrl: 'http://runner.test',
      runnerToken: 'runner-token',
      workerId: 'worker-1',
      requestTimeoutMs: 1000,
      maxConcurrency: 1,
      artifactCleanupIntervalMs: 60_000,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'GET') return inventoryResponse([])
        announceDeleted()
        return new Response(null, { status: 204 })
      },
    })

    const run = worker.run(5)
    await Promise.race([
      deleted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('startup Artifact sweep did not run')), 1000)
      ),
    ])
    worker.stop()
    await run

    expect((await store.getArtifact(old.id))?.status).toBe('DELETED')
  })

  it('reconciles only old untracked READY and safe DELETING directories with one DB batch', async () => {
    const store = new MemoryStore()
    const trackedReady = artifact({
      targetId: 'webapp',
      branch: 'tracked',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    const deleted = artifact({
      targetId: 'online-h5',
      branch: 'deleted',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    deleted.status = 'DELETED'
    await store.createArtifact(trackedReady)
    await store.createArtifact(deleted)
    const oldReadyId = randomUUID()
    const freshReadyId = randomUUID()
    const missingDeletingId = randomUUID()
    const trackedDeletingId = trackedReady.id
    const inventory: RunnerArtifactInventoryItem[] = [
      {
        artifactId: oldReadyId,
        targetId: 'webapp',
        storageKey: `ready/webapp/${oldReadyId}`,
        state: 'READY',
        modifiedAt: '2020-01-01T00:00:00.000Z',
      },
      {
        artifactId: freshReadyId,
        targetId: 'webapp',
        storageKey: `ready/webapp/${freshReadyId}`,
        state: 'READY',
        modifiedAt: new Date().toISOString(),
      },
      {
        artifactId: trackedReady.id,
        targetId: trackedReady.targetId,
        storageKey: trackedReady.storageKey,
        state: 'READY',
        modifiedAt: '2020-01-01T00:00:00.000Z',
      },
      {
        artifactId: missingDeletingId,
        targetId: 'base',
        storageKey: `deleting/base/${missingDeletingId}`,
        state: 'DELETING',
        modifiedAt: new Date().toISOString(),
      },
      {
        artifactId: deleted.id,
        targetId: deleted.targetId,
        storageKey: `deleting/${deleted.targetId}/${deleted.id}`,
        state: 'DELETING',
        modifiedAt: new Date().toISOString(),
      },
      {
        artifactId: trackedDeletingId,
        targetId: trackedReady.targetId,
        storageKey: `deleting/${trackedReady.targetId}/${trackedDeletingId}`,
        state: 'DELETING',
        modifiedAt: '2020-01-01T00:00:00.000Z',
      },
    ]
    const lookup = vi.spyOn(store, 'getArtifactsByIds')
    const deletedRequests: unknown[] = []

    const completed = await reconcileOrphanArtifacts({
      store,
      runnerUrl: 'http://runner.test',
      runnerToken: 'runner-token',
      workerId: 'worker-1',
      requestTimeoutMs: 1000,
      maxConcurrency: 1,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'GET') return inventoryResponse(inventory)
        deletedRequests.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      },
    })

    expect(completed).toBe(3)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(deletedRequests).toEqual(
      expect.arrayContaining([
        { artifactId: oldReadyId, storageKey: `ready/webapp/${oldReadyId}` },
        {
          artifactId: missingDeletingId,
          storageKey: `deleting/base/${missingDeletingId}`,
        },
        {
          artifactId: deleted.id,
          storageKey: `deleting/${deleted.targetId}/${deleted.id}`,
        },
      ])
    )
  })

  it('shares one maintenance batch between regular retention and orphan reconciliation', async () => {
    const store = new MemoryStore()
    const old = artifact({
      targetId: 'webapp',
      branch: 'master',
      builtAt: '2026-08-25T01:00:00.000Z',
    })
    const latest = artifact({
      targetId: 'webapp',
      branch: 'master',
      builtAt: '2026-08-25T02:00:00.000Z',
    })
    await store.createArtifact(old)
    await store.createArtifact(latest)
    const requests: Array<{ method: string | undefined; body: unknown }> = []

    const completed = await maintainArtifacts({
      store,
      runnerUrl: 'http://runner.test',
      runnerToken: 'runner-token',
      workerId: 'worker-1',
      requestTimeoutMs: 1000,
      maxConcurrency: 1,
      artifactCleanupBatchSize: 1,
      fetchImpl: async (_input, init) => {
        requests.push({
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return new Response(null, { status: 204 })
      },
    })

    expect(completed).toBe(1)
    expect(requests).toEqual([
      {
        method: 'POST',
        body: { artifactId: old.id, storageKey: old.storageKey },
      },
    ])
  })
})
