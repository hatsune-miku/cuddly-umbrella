export const ACTIVE_BUILD_STATUSES = new Set([
  'QUEUED',
  'LEASED',
  'CHECKOUT',
  'INSTALLING',
  'BUILDING',
  'VALIDATING',
  'UPLOADING',
  'CANCELING',
])

export const TERMINAL_BUILD_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED'])

const BUILD_PRESENTATIONS = {
  QUEUED: { label: '连接打包嘟嘟', tone: 'queued', progress: 4, step: '排队中' },
  LEASED: { label: '任务已领取', tone: 'working', progress: 12, step: '1 / 6' },
  CHECKOUT: { label: '正在拉取代码', tone: 'working', progress: 28, step: '2 / 6' },
  INSTALLING: { label: '正在安装依赖', tone: 'working', progress: 46, step: '3 / 6' },
  BUILDING: { label: '正在打包', tone: 'working', progress: 68, step: '4 / 6' },
  VALIDATING: { label: '正在校验产物', tone: 'working', progress: 84, step: '5 / 6' },
  UPLOADING: { label: '正在保存产物', tone: 'working', progress: 96, step: '6 / 6' },
  CANCELING: { label: '正在中断', tone: 'canceling', progress: 100, step: '中断中' },
  SUCCEEDED: { label: '打包完成', tone: 'success', progress: 100, step: '已完成' },
  FAILED: { label: '打包失败', tone: 'failed', progress: 100, step: '已结束' },
  CANCELED: { label: '已取消', tone: 'canceled', progress: 100, step: '已结束' },
}

export function buildJobPresentation(jobOrStatus) {
  const job = typeof jobOrStatus === 'string' ? { status: jobOrStatus } : jobOrStatus || {}
  const presentation = BUILD_PRESENTATIONS[job.status] || {
    label: job.status || '未知状态',
    tone: 'idle',
    progress: 0,
    step: '等待状态',
  }
  const queuedWithPosition =
    job.status === 'QUEUED' && Number.isInteger(job.queuePosition)
      ? `队列序号 ${job.queuePosition}`
      : null
  return {
    ...presentation,
    label: queuedWithPosition || presentation.label,
    progressLabel: queuedWithPosition || presentation.step,
    cancelable: ACTIVE_BUILD_STATUSES.has(job.status) && job.status !== 'CANCELING',
    retryable: job.status === 'FAILED',
  }
}

export function orderedBuildQueue(queue) {
  return [...(queue?.running || []), ...(queue?.queued || [])]
}

export function buildQueueSummary(queue) {
  const running = queue?.running?.length || 0
  const queued = queue?.queued?.length || 0
  if (!running && !queued) return '当前空闲'
  return `运行 ${running} · 排队 ${queued}`
}

export function isBuildSubmissionLocked(submittedBranches, targetId, branch) {
  return Boolean(branch && submittedBranches?.[targetId] === branch)
}

export function replaceBuildQueueJob(queue, replacement) {
  if (!replacement?.id) return queue || { running: [], queued: [] }
  let found = false
  const replace = (job) => {
    if (job.id !== replacement.id) return job
    found = true
    return { ...job, ...replacement }
  }
  const running = (queue?.running || []).map(replace)
  const queued = (queue?.queued || []).map(replace)
  if (!found) running.unshift(replacement)
  return { ...queue, running, queued }
}

export function shouldPollBuildJob(detail) {
  return !detail?.job || !TERMINAL_BUILD_STATUSES.has(detail.job.status)
}
