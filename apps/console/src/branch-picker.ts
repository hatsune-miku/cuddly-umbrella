import type { BranchCatalogItem, BuildJobStatus, BuildQueueItem } from '@cuddly/contracts'

export const buildStatusText: Record<BuildJobStatus, string> = {
  QUEUED: '连接打包嘟嘟',
  LEASED: '任务已领取',
  CHECKOUT: '正在拉取代码',
  INSTALLING: '正在安装依赖',
  BUILDING: '正在打包',
  VALIDATING: '正在校验产物',
  UPLOADING: '正在保存产物',
  CANCELING: '正在中断',
  SUCCEEDED: '打包完成',
  FAILED: '打包失败',
  CANCELED: '已取消',
}

export interface BranchPickerOption extends BranchCatalogItem {
  activityAt: string | null
  activeJob: BuildQueueItem | null
  queuedCount: number
}

function latestTime(...values: Array<string | null | undefined>): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null
  )
}

export function createBranchPickerOptions({
  items,
  queueItems,
  targetId,
  selectedBranch,
  fallbackBranch,
}: {
  items: BranchCatalogItem[]
  queueItems: BuildQueueItem[]
  targetId: string
  selectedBranch: string
  fallbackBranch: string
}): BranchPickerOption[] {
  const byBranch = new Map(items.map((item) => [item.branch, item]))
  const queueByBranch = new Map<string, BuildQueueItem[]>()
  for (const job of queueItems) {
    if (job.targetId !== targetId) continue
    const jobs = queueByBranch.get(job.branch) || []
    jobs.push(job)
    queueByBranch.set(job.branch, jobs)
  }
  for (const branch of [selectedBranch, fallbackBranch]) {
    if (branch && !byBranch.has(branch)) {
      byBranch.set(branch, {
        branch,
        buildStatus: 'IDLE',
        latestArtifact: null,
        latestJob: null,
      })
    }
  }

  return [...byBranch.values()]
    .map((item) => {
      const matchingJobs = queueByBranch.get(item.branch) || []
      const activeJob =
        matchingJobs.find((job) => job.status !== 'QUEUED') || matchingJobs[0] || null
      return {
        ...item,
        activeJob,
        queuedCount: matchingJobs.filter((job) => job.status === 'QUEUED').length,
        activityAt: latestTime(
          item.latestArtifact?.builtAt,
          item.latestJob?.finishedAt,
          item.latestJob?.createdAt,
          ...matchingJobs.map((job) => job.startedAt || job.createdAt)
        ),
      }
    })
    .sort(
      (left, right) =>
        Number(Boolean(right.activityAt)) - Number(Boolean(left.activityAt)) ||
        (right.activityAt || '').localeCompare(left.activityAt || '') ||
        left.branch.localeCompare(right.branch)
    )
}

export function filterBranchPickerOptions(
  options: BranchPickerOption[],
  query: string,
  limit = 100
): { items: BranchPickerOption[]; total: number; truncated: boolean } {
  const normalized = query.trim().toLocaleLowerCase()
  const matches = normalized
    ? options.filter((item) => item.branch.toLocaleLowerCase().includes(normalized))
    : options
  const boundedLimit = Math.max(1, Math.floor(limit))
  return {
    items: matches.slice(0, boundedLimit),
    total: matches.length,
    truncated: matches.length > boundedLimit,
  }
}

export function branchOptionStatus(option: BranchPickerOption): {
  text: string
  tone: 'idle' | 'waiting' | 'working' | 'success' | 'failed'
} {
  if (option.activeJob) {
    if (option.activeJob.status === 'QUEUED') {
      return {
        text: option.activeJob.queuePosition
          ? `排队第 ${option.activeJob.queuePosition} 位`
          : '连接打包嘟嘟',
        tone: 'waiting',
      }
    }
    const queuedSuffix = option.queuedCount ? ` · 另有 ${option.queuedCount} 个排队` : ''
    return {
      text: `${buildStatusText[option.activeJob.status] || option.activeJob.status}${queuedSuffix}`,
      tone: 'working',
    }
  }
  if (option.latestJob?.status === 'FAILED') return { text: '上次打包失败', tone: 'failed' }
  if (option.latestJob?.status === 'CANCELED') return { text: '上次打包已取消', tone: 'idle' }
  if (option.latestArtifact) return { text: '已有可用包', tone: 'success' }
  return { text: '尚未打包', tone: 'idle' }
}
