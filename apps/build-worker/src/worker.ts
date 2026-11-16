import { randomUUID } from 'node:crypto'

import {
  runnerArtifactDeleteSchema,
  runnerArtifactInventorySchema,
  runnerEventSchema,
  type Artifact,
  type BuildJob,
  type RunnerArtifactInventoryItem,
  type RunnerEvent,
  type RunnerStage,
} from '@cuddly/contracts'
import type { CuddlyStore } from '@cuddly/db'

class BuildFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly logPath: string | null = null
  ) {
    super(message)
    this.name = 'BuildFailure'
  }
}

export interface BuildWorkerOptions {
  store: CuddlyStore
  runnerUrl: string
  runnerToken: string
  workerId: string
  requestTimeoutMs: number
  maxConcurrency: number
  artifactCleanupIntervalMs?: number
  artifactCleanupBatchSize?: number
  artifactOrphanGraceMs?: number
  fetchImpl?: typeof fetch
  resolveRuntimeSettings?: () => Promise<{
    maxConcurrency: number
    requestTimeoutMs: number
    artifactBaseUrl: string
  }>
}

export type BuildJobProcessor = (
  job: BuildJob,
  options: BuildWorkerOptions,
  cancellationSignal: AbortSignal
) => Promise<boolean>

type RunnerResult = Extract<RunnerEvent, { type: 'result' }>

const DEFAULT_ARTIFACT_CLEANUP_BATCH_SIZE = 50
const DEFAULT_ARTIFACT_ORPHAN_GRACE_MS = 10 * 60_000

interface ArtifactCleanupBatchResult {
  attempted: number
  completed: number
}

const runnerStagePredecessors: Record<RunnerStage, BuildJob['status']> = {
  CHECKOUT: 'LEASED',
  INSTALLING: 'CHECKOUT',
  BUILDING: 'INSTALLING',
  VALIDATING: 'BUILDING',
  UPLOADING: 'VALIDATING',
}

const runningBuildStatuses: readonly BuildJob['status'][] = [
  'LEASED',
  'CHECKOUT',
  'INSTALLING',
  'BUILDING',
  'VALIDATING',
  'UPLOADING',
]

function cleanupBatchSize(options: BuildWorkerOptions): number {
  const configured = options.artifactCleanupBatchSize ?? DEFAULT_ARTIFACT_CLEANUP_BATCH_SIZE
  return Number.isFinite(configured) ? Math.max(0, Math.min(200, Math.floor(configured))) : 0
}

async function deleteRunnerArtifact(
  options: BuildWorkerOptions,
  artifact: { artifactId: string; storageKey: string }
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const body = runnerArtifactDeleteSchema.parse(artifact)
  const response = await fetchImpl(
    `${options.runnerUrl.replace(/\/$/, '')}/internal/artifacts/delete`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(options.requestTimeoutMs, 30_000)),
    }
  )
  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`Runner returned HTTP ${response.status}: ${responseBody.slice(0, 500)}`)
  }
}

async function cleanupSupersededArtifactBatch(
  options: BuildWorkerOptions,
  limit: number
): Promise<ArtifactCleanupBatchResult> {
  const candidates = await options.store.claimArtifactCleanupCandidates(limit)
  let completed = 0
  for (const candidate of candidates) {
    try {
      await deleteRunnerArtifact(options, {
        artifactId: candidate.id,
        storageKey: candidate.storageKey,
      })
      await options.store.completeArtifactDeletion(candidate.id)
      completed += 1
    } catch (error) {
      console.error(`[build-worker] Artifact cleanup failed for ${candidate.id}`, error)
    }
  }
  return { attempted: candidates.length, completed }
}

export async function cleanupSupersededArtifacts(options: BuildWorkerOptions): Promise<number> {
  return (await cleanupSupersededArtifactBatch(options, cleanupBatchSize(options))).completed
}

async function readRunnerArtifactInventory(
  options: BuildWorkerOptions
): Promise<RunnerArtifactInventoryItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(
    `${options.runnerUrl.replace(/\/$/, '')}/internal/artifacts/inventory`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${options.runnerToken}` },
      signal: AbortSignal.timeout(Math.min(options.requestTimeoutMs, 30_000)),
    }
  )
  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`Runner returned HTTP ${response.status}: ${responseBody.slice(0, 500)}`)
  }
  return runnerArtifactInventorySchema.parse(await response.json()).artifacts
}

export async function reconcileOrphanArtifacts(
  options: BuildWorkerOptions,
  limit = cleanupBatchSize(options)
): Promise<number> {
  const boundedLimit = Math.max(0, Math.floor(limit))
  if (boundedLimit === 0) return 0
  const inventory = await readRunnerArtifactInventory(options)
  if (inventory.length === 0) return 0

  const artifacts = await options.store.getArtifactsByIds([
    ...new Set(inventory.map((item) => item.artifactId)),
  ])
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const configuredGrace = options.artifactOrphanGraceMs ?? DEFAULT_ARTIFACT_ORPHAN_GRACE_MS
  const graceMs = Number.isFinite(configuredGrace)
    ? Math.max(0, configuredGrace)
    : DEFAULT_ARTIFACT_ORPHAN_GRACE_MS
  const readyBefore = Date.now() - graceMs
  const eligible = inventory
    .filter((item) => {
      const artifact = artifactsById.get(item.artifactId)
      if (item.state === 'DELETING') return !artifact || artifact.status === 'DELETED'
      return !artifact && Date.parse(item.modifiedAt) <= readyBefore
    })
    .sort(
      (a, b) =>
        Number(a.state !== 'DELETING') - Number(b.state !== 'DELETING') ||
        a.modifiedAt.localeCompare(b.modifiedAt) ||
        a.storageKey.localeCompare(b.storageKey)
    )
    .slice(0, boundedLimit)

  let completed = 0
  for (const item of eligible) {
    try {
      await deleteRunnerArtifact(options, {
        artifactId: item.artifactId,
        storageKey: item.storageKey,
      })
      completed += 1
    } catch (error) {
      console.error(`[build-worker] orphan Artifact cleanup failed for ${item.storageKey}`, error)
    }
  }
  return completed
}

export async function maintainArtifacts(options: BuildWorkerOptions): Promise<number> {
  const limit = cleanupBatchSize(options)
  if (limit === 0) return 0
  const regular = await cleanupSupersededArtifactBatch(options, limit)
  const remaining = Math.max(0, limit - regular.attempted)
  const orphaned = remaining > 0 ? await reconcileOrphanArtifacts(options, remaining) : 0
  return regular.completed + orphaned
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

async function cancellationRetryDelay(stopSignal: AbortSignal): Promise<void> {
  if (stopSignal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      stopSignal.removeEventListener('abort', aborted)
      resolve()
    }
    const timeout = setTimeout(finish, 500)
    timeout.unref()
    const aborted = () => {
      clearTimeout(timeout)
      finish()
    }
    stopSignal.addEventListener('abort', aborted, { once: true })
  })
}

async function forwardRunnerCancellation(
  jobId: string,
  options: BuildWorkerOptions,
  cancellationSignal: AbortSignal,
  stopSignal: AbortSignal
): Promise<void> {
  await Promise.race([waitForSignal(cancellationSignal), waitForSignal(stopSignal)])
  if (stopSignal.aborted || !cancellationSignal.aborted) return

  const fetchImpl = options.fetchImpl ?? fetch
  let lastWarning = ''
  while (!stopSignal.aborted) {
    try {
      const response = await fetchImpl(
        `${options.runnerUrl.replace(/\/$/, '')}/internal/runs/${encodeURIComponent(jobId)}/cancel`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${options.runnerToken}` },
          signal: AbortSignal.timeout(Math.min(options.requestTimeoutMs, 5_000)),
        }
      )
      if (response.ok) return
      const body = await response.text()
      const warning = `Runner cancellation returned HTTP ${response.status}: ${body.slice(0, 500)}`
      if (warning !== lastWarning) {
        console.warn(`[build-worker] ${warning}`)
        lastWarning = warning
      }
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error)
      if (warning !== lastWarning) {
        console.warn(`[build-worker] Runner cancellation request failed: ${warning}`)
        lastWarning = warning
      }
    }
    await cancellationRetryDelay(stopSignal)
  }
}

async function readRunnerEvents(
  response: Response,
  onStage: (stage: RunnerStage) => Promise<void>
): Promise<RunnerResult> {
  if (!response.body)
    throw new BuildFailure('RUNNER_EMPTY_RESPONSE', 'Runner returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let result: RunnerResult | null = null

  const consumeLine = async (line: string) => {
    if (!line.trim()) return
    const parsed = runnerEventSchema.safeParse(JSON.parse(line))
    if (!parsed.success) {
      throw new BuildFailure('RUNNER_PROTOCOL_ERROR', 'Runner returned an invalid event')
    }
    const event = parsed.data
    if (event.type === 'stage') await onStage(event.stage)
    if (event.type === 'result') result = event
    if (event.type === 'error') throw new BuildFailure(event.code, event.message, event.logPath)
  }

  while (true) {
    const { value, done } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    const lines = buffered.split('\n')
    buffered = lines.pop() || ''
    for (const line of lines) await consumeLine(line)
    if (done) break
  }
  await consumeLine(buffered)
  if (!result)
    throw new BuildFailure('RUNNER_NO_RESULT', 'Runner finished without an Artifact result')
  return result
}

async function invokeRunner(
  job: BuildJob,
  artifactId: string,
  options: BuildWorkerOptions,
  cancellationSignal: AbortSignal
) {
  if (!job.targetSnapshot) {
    throw new BuildFailure(
      'TARGET_SNAPSHOT_MISSING',
      'Build job has no project configuration snapshot'
    )
  }
  if (
    job.targetSnapshot.environment.id !== job.environmentId ||
    job.targetSnapshot.environment.slug !== job.environmentSlug
  ) {
    throw new BuildFailure(
      'TARGET_SNAPSHOT_ENVIRONMENT_MISMATCH',
      'Build job environment does not match its project configuration snapshot'
    )
  }
  const runtime = options.resolveRuntimeSettings
    ? await options.resolveRuntimeSettings()
    : {
        maxConcurrency: options.maxConcurrency,
        requestTimeoutMs: options.requestTimeoutMs,
        artifactBaseUrl: 'http://localhost:9872',
      }
  if (cancellationSignal.aborted) {
    throw new BuildFailure('BUILD_CANCELED', 'Build cancellation was requested')
  }

  console.log(
    `[build-worker] starting ${job.id} for ${job.targetId} in ${job.environmentSlug} (${job.targetSnapshot.environment.backendOrigin})`
  )

  const fetchImpl = options.fetchImpl ?? fetch
  const cancellationForwardingStop = new AbortController()
  const cancellationTask = forwardRunnerCancellation(
    job.id,
    options,
    cancellationSignal,
    cancellationForwardingStop.signal
  )
  try {
    const response = await fetchImpl(`${options.runnerUrl.replace(/\/$/, '')}/internal/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.runnerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jobId: job.id,
        artifactId,
        targetId: job.targetId,
        environmentId: job.environmentId,
        environmentSlug: job.environmentSlug,
        branch: job.branch,
        requestedBy: job.requestedBy,
        artifactBaseUrl: runtime.artifactBaseUrl,
        project: job.targetSnapshot,
      }),
      signal: AbortSignal.timeout(runtime.requestTimeoutMs),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new BuildFailure(
        'RUNNER_HTTP_ERROR',
        `Runner returned HTTP ${response.status}: ${body.slice(0, 500)}`
      )
    }
    return await readRunnerEvents(response, async (stage) => {
      const transitioned = await options.store.transitionBuildJob(
        job.id,
        [runnerStagePredecessors[stage]],
        { status: stage }
      )
      if (transitioned) return
      const current = await options.store.getBuildJob(job.id)
      if (current?.status === stage || current?.status === 'CANCELING') return
      throw new BuildFailure(
        'JOB_STATE_CONFLICT',
        `Build job cannot enter ${stage} from ${current?.status || 'missing'}`
      )
    })
  } finally {
    cancellationForwardingStop.abort()
    await cancellationTask
  }
}

export async function processBuildJob(
  job: BuildJob,
  options: BuildWorkerOptions,
  cancellationSignal: AbortSignal = new AbortController().signal
): Promise<boolean> {
  const artifactId = randomUUID()
  let succeeded = false
  try {
    const result = await invokeRunner(job, artifactId, options, cancellationSignal)
    const artifact: Artifact = {
      id: result.artifactId,
      buildJobId: job.id,
      targetId: job.targetId,
      environmentId: job.environmentId,
      environmentSlug: job.environmentSlug,
      branch: job.branch,
      status: 'READY',
      storageKey: result.storageKey,
      manifest: result.manifest,
      builtAt: result.builtAt,
      createdBy: job.requestedBy,
    }
    const completed = await options.store.completeBuildJob(job.id, {
      artifact,
      finishedAt: new Date().toISOString(),
      logPath: result.logPath,
    })
    if (!completed) {
      try {
        await deleteRunnerArtifact(options, {
          artifactId: result.artifactId,
          storageKey: result.storageKey,
        })
      } catch (error) {
        console.error(
          `[build-worker] canceled Artifact cleanup failed for ${result.artifactId}`,
          error
        )
      }
      const current = await options.store.getBuildJob(job.id)
      if (current?.status === 'CANCELING') {
        await options.store.transitionBuildJob(job.id, ['CANCELING'], {
          status: 'CANCELED',
          finishedAt: new Date().toISOString(),
          failureCode: 'BUILD_CANCELED',
          failureMessage: '构建已被提前中断',
          logPath: result.logPath,
        })
        return false
      }
      throw new BuildFailure(
        'JOB_STATE_CONFLICT',
        `Build result cannot be committed from ${current?.status || 'missing'}`,
        result.logPath
      )
    }
    succeeded = true
  } catch (error) {
    const failure =
      error instanceof BuildFailure
        ? error
        : new BuildFailure('WORKER_FAILED', error instanceof Error ? error.message : String(error))
    const current = await options.store.getBuildJob(job.id)
    if (current?.status === 'CANCELING') {
      await options.store.transitionBuildJob(job.id, ['CANCELING'], {
        status: 'CANCELED',
        finishedAt: new Date().toISOString(),
        failureCode: 'BUILD_CANCELED',
        failureMessage: '构建已被提前中断',
        logPath: failure.logPath,
      })
    } else if (current && runningBuildStatuses.includes(current.status)) {
      await options.store.transitionBuildJob(job.id, [current.status], {
        status: 'FAILED',
        finishedAt: new Date().toISOString(),
        failureCode: failure.code,
        failureMessage: failure.message.slice(0, 1000),
        logPath: failure.logPath,
      })
    }
  }
  return succeeded
}

export class BuildWorker {
  private stopping = false
  private readonly activeJobs = new Map<
    string,
    { task: Promise<void>; cancellation: AbortController }
  >()
  private activeCleanup: Promise<void> | null = null
  private artifactCleanupRequested = false
  private nextArtifactCleanupAt = 0
  constructor(
    private readonly options: BuildWorkerOptions,
    private readonly processJob: BuildJobProcessor = processBuildJob
  ) {}

  stop(): void {
    this.stopping = true
  }

  private start(job: BuildJob): void {
    let succeeded = false
    const cancellation = new AbortController()
    let task: Promise<void>
    task = Promise.resolve()
      .then(() => this.processJob(job, this.options, cancellation.signal))
      .then((result) => {
        succeeded = result
      })
      .catch((error) => {
        console.error(`[build-worker] job ${job.id} stopped unexpectedly`, error)
      })
      .finally(() => {
        const active = this.activeJobs.get(job.id)
        if (active?.task === task) this.activeJobs.delete(job.id)
        if (succeeded) this.requestArtifactCleanup()
      })
    this.activeJobs.set(job.id, { task, cancellation })
  }

  private async forwardCancellationRequests(): Promise<void> {
    await Promise.all(
      [...this.activeJobs.entries()].map(async ([jobId, active]) => {
        if (active.cancellation.signal.aborted) return
        const job = await this.options.store.getBuildJob(jobId)
        if (job?.status === 'CANCELING') active.cancellation.abort()
      })
    )
  }

  private requestArtifactCleanup(): void {
    if (this.stopping) return
    this.artifactCleanupRequested = true
    this.startArtifactCleanupIfDue()
  }

  private startArtifactCleanupIfDue(): void {
    if (this.stopping || this.activeCleanup) return
    if (!this.artifactCleanupRequested && Date.now() < this.nextArtifactCleanupAt) return
    this.artifactCleanupRequested = false
    this.nextArtifactCleanupAt = Date.now() + (this.options.artifactCleanupIntervalMs ?? 60_000)
    let task: Promise<void>
    task = maintainArtifacts(this.options)
      .then(() => undefined)
      .catch((error) => {
        console.error('[build-worker] scheduled Artifact cleanup failed', error)
      })
      .finally(() => {
        if (this.activeCleanup === task) this.activeCleanup = null
        if (this.artifactCleanupRequested) this.startArtifactCleanupIfDue()
      })
    this.activeCleanup = task
  }

  async run(pollIntervalMs: number): Promise<void> {
    while (!this.stopping) {
      await this.forwardCancellationRequests()
      const runtime = this.options.resolveRuntimeSettings
        ? await this.options.resolveRuntimeSettings()
        : { maxConcurrency: this.options.maxConcurrency }
      const maxConcurrency = Number.isFinite(runtime.maxConcurrency)
        ? Math.max(1, Math.floor(runtime.maxConcurrency))
        : 1
      while (!this.stopping && this.activeJobs.size < maxConcurrency) {
        const job = await this.options.store.claimNextBuildJob(this.options.workerId)
        if (!job) break
        this.start(job)
      }

      if (!this.stopping) this.startArtifactCleanupIfDue()

      if (this.stopping) break
      const poll = new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
      await Promise.race([
        poll,
        ...[...this.activeJobs.values()].map((active) => active.task),
        ...(this.activeCleanup ? [this.activeCleanup] : []),
      ])
    }

    await Promise.allSettled([
      ...[...this.activeJobs.values()].map((active) => active.task),
      ...(this.activeCleanup ? [this.activeCleanup] : []),
    ])
  }
}
