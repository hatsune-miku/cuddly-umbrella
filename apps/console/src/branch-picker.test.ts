import { describe, expect, it } from 'vitest'
import type { BranchCatalogItem, BuildQueueItem } from '@cuddly/contracts'

import {
  branchOptionStatus,
  buildStatusText,
  createBranchPickerOptions,
  filterBranchPickerOptions,
} from './branch-picker'

function catalog(branch: string, values: Partial<BranchCatalogItem> = {}): BranchCatalogItem {
  return {
    branch,
    buildStatus: 'IDLE',
    latestArtifact: null,
    latestJob: null,
    ...values,
  }
}

function queue(values: Partial<BuildQueueItem> = {}): BuildQueueItem {
  return {
    id: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    environmentSlug: 'shared',
    targetId: 'webapp',
    branch: 'feature/active',
    status: 'BUILDING',
    requestedBy: 'gz',
    createdAt: '2026-08-25T09:00:00.000Z',
    startedAt: '2026-08-25T09:01:00.000Z',
    queuePosition: null,
    isMine: true,
    ...values,
  }
}

describe('branch picker model', () => {
  it('describes queued work as connecting to 打包嘟嘟', () => {
    expect(buildStatusText.QUEUED).toBe('连接打包嘟嘟')

    const option = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: 'feature/active',
      fallbackBranch: 'master',
      items: [catalog('feature/active')],
      queueItems: [queue({ status: 'QUEUED', queuePosition: null })],
    }).find((item) => item.branch === 'feature/active')!

    expect(branchOptionStatus(option)).toEqual({ text: '连接打包嘟嘟', tone: 'waiting' })
  })

  it('sorts by newest build activity and leaves never-built branches at the bottom', () => {
    const options = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: '',
      fallbackBranch: 'master',
      queueItems: [],
      items: [
        catalog('never'),
        catalog('older', {
          latestArtifact: {
            id: crypto.randomUUID(),
            branch: 'older',
            builtAt: '2026-08-24T09:00:00.000Z',
          },
        }),
        catalog('new-failure', {
          latestJob: {
            id: crypto.randomUUID(),
            status: 'FAILED',
            createdAt: '2026-08-25T09:00:00.000Z',
            finishedAt: '2026-08-25T09:05:00.000Z',
            failureMessage: 'failed',
          },
        }),
      ],
    })

    expect(options.map((item) => item.branch)).toEqual(['new-failure', 'older', 'master', 'never'])
  })

  it('uses a running job before queued jobs and reports the queued remainder', () => {
    const option = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: 'feature/active',
      fallbackBranch: 'master',
      items: [catalog('feature/active')],
      queueItems: [
        queue({ status: 'QUEUED', queuePosition: 4 }),
        queue({ id: crypto.randomUUID(), status: 'INSTALLING', queuePosition: null }),
      ],
    }).find((item) => item.branch === 'feature/active')!

    expect(option.activeJob?.status).toBe('INSTALLING')
    expect(option.queuedCount).toBe(1)
    expect(branchOptionStatus(option)).toEqual({
      text: '正在安装依赖 · 另有 1 个排队',
      tone: 'working',
    })

    const canceling = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: 'feature/active',
      fallbackBranch: 'master',
      items: [catalog('feature/active')],
      queueItems: [queue({ status: 'CANCELING' })],
    }).find((item) => item.branch === 'feature/active')!
    expect(branchOptionStatus(canceling)).toEqual({ text: '正在中断', tone: 'working' })
  })

  it('searches without changing order and limits rendered options', () => {
    const options = Array.from(
      { length: 120 },
      (_value, index) =>
        createBranchPickerOptions({
          targetId: 'webapp',
          selectedBranch: '',
          fallbackBranch: '',
          items: [catalog(`feature/${String(index).padStart(3, '0')}`)],
          queueItems: [],
        })[0]!
    )
    const all = filterBranchPickerOptions(options, '')
    expect(all.items).toHaveLength(100)
    expect(all.total).toBe(120)
    expect(all.truncated).toBe(true)

    const searched = filterBranchPickerOptions(options, 'FEATURE/11')
    expect(searched.items.map((item) => item.branch)).toEqual(
      options.filter((item) => item.branch.includes('/11')).map((item) => item.branch)
    )
  })

  it('uses stable last-build wording for terminal branch states', () => {
    const failed = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: 'failed',
      fallbackBranch: 'master',
      items: [catalog('failed', { latestJob: { status: 'FAILED' } as never })],
      queueItems: [],
    })[0]!
    const ready = createBranchPickerOptions({
      targetId: 'webapp',
      selectedBranch: 'ready',
      fallbackBranch: 'master',
      items: [
        catalog('ready', {
          latestArtifact: {
            id: crypto.randomUUID(),
            branch: 'ready',
            builtAt: '2026-08-25T09:00:00.000Z',
          },
        }),
      ],
      queueItems: [],
    })[0]!

    expect(branchOptionStatus(failed).text).toBe('上次打包失败')
    expect(branchOptionStatus(ready).text).toBe('已有可用包')
  })
})
