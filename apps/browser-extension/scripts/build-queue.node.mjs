import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildJobPresentation,
  buildQueueSummary,
  isBuildSubmissionLocked,
  orderedBuildQueue,
  replaceBuildQueueJob,
  shouldPollBuildJob,
} from '../build-queue.js'

test('presents queue position and build-stage progress without pretending it is elapsed time', () => {
  assert.equal(buildJobPresentation('QUEUED').label, '连接打包嘟嘟')
  assert.deepEqual(buildJobPresentation({ status: 'QUEUED', queuePosition: 3 }), {
    label: '队列序号 3',
    tone: 'queued',
    progress: 4,
    step: '排队中',
    progressLabel: '队列序号 3',
    cancelable: true,
    retryable: false,
  })
  assert.deepEqual(buildJobPresentation('VALIDATING'), {
    label: '正在校验产物',
    tone: 'working',
    progress: 84,
    step: '5 / 6',
    progressLabel: '5 / 6',
    cancelable: true,
    retryable: false,
  })
})

test('keeps the service running order before the queued order', () => {
  const queue = {
    running: [{ id: 'run-1' }, { id: 'run-2' }],
    queued: [{ id: 'queue-1' }, { id: 'queue-2' }],
  }
  assert.deepEqual(
    orderedBuildQueue(queue).map((job) => job.id),
    ['run-1', 'run-2', 'queue-1', 'queue-2']
  )
  assert.equal(buildQueueSummary(queue), '运行 2 · 排队 2')
  assert.equal(buildQueueSummary({ running: [], queued: [] }), '当前空闲')
})

test('locks only the branch that was submitted from this popup', () => {
  const submitted = { webapp: 'feature/chat' }
  assert.equal(isBuildSubmissionLocked(submitted, 'webapp', 'feature/chat'), true)
  assert.equal(isBuildSubmissionLocked(submitted, 'webapp', 'feature/voice'), false)
  assert.equal(isBuildSubmissionLocked(submitted, 'base', 'feature/chat'), false)
})

test('allows canceling active work but not a cancellation already in progress', () => {
  assert.equal(buildJobPresentation('BUILDING').cancelable, true)
  assert.equal(buildJobPresentation('CANCELING').cancelable, false)
  assert.equal(buildJobPresentation('SUCCEEDED').cancelable, false)
  assert.equal(buildJobPresentation('FAILED').retryable, true)
  assert.equal(buildJobPresentation('CANCELED').retryable, false)
})

test('keeps an optimistic cancellation visible when a follow-up refresh fails', () => {
  const queue = {
    running: [{ id: 'job-1', status: 'BUILDING', branch: 'main', startedAt: 'now' }],
    queued: [],
  }
  assert.deepEqual(replaceBuildQueueJob(queue, { id: 'job-1', status: 'CANCELING' }).running[0], {
    id: 'job-1',
    status: 'CANCELING',
    branch: 'main',
    startedAt: 'now',
  })
  assert.equal(shouldPollBuildJob({ job: { status: 'CANCELING' } }), true)
  assert.equal(shouldPollBuildJob({ job: { status: 'CANCELED' } }), false)
  assert.equal(shouldPollBuildJob({ job: { status: 'FAILED' } }), false)
})
