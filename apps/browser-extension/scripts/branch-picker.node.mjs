import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRANCH_PICKER_RENDER_LIMIT,
  branchDropdownPlacement,
  describeBranchBuild,
  endedQueueTargetIds,
  filterBranchPickerItems,
  flattenBuildQueue,
  formatBranchArtifactTime,
  prepareTargetBranchItems,
  sortBranchPickerItems,
} from '../branch-picker.js'

test('positions the branch dropdown below its trigger when space is available', () => {
  assert.deepEqual(
    branchDropdownPlacement(
      { left: 120, top: 80, bottom: 114, width: 260 },
      { viewportWidth: 560, viewportHeight: 600 }
    ),
    { left: 120, top: 118, width: 380, maxHeight: 316, opensAbove: false }
  )
})

test('flips the branch dropdown above low triggers and clamps it to the viewport', () => {
  assert.deepEqual(
    branchDropdownPlacement(
      { left: 500, top: 540, bottom: 574, width: 80 },
      { viewportWidth: 560, viewportHeight: 600 }
    ),
    { left: 172, top: 220, width: 380, maxHeight: 316, opensAbove: true }
  )
})

function branch(name, overrides = {}) {
  return {
    branch: name,
    buildStatus: 'IDLE',
    latestArtifact: null,
    latestJob: null,
    ...overrides,
  }
}

test('positions the 1.2x popup dropdown in unscaled layout coordinates', () => {
  const below = branchDropdownPlacement(
    { left: 144, top: 96, bottom: 136.8, width: 312 },
    { viewportWidth: 672, viewportHeight: 600, scale: 1.2 }
  )
  assert.equal(below.left, 120)
  assert.ok(Math.abs(below.top - 118) < 0.001)
  assert.equal(below.width, 380)
  assert.equal(below.opensAbove, false)
  const above = branchDropdownPlacement(
    { left: 600, top: 540, bottom: 574, width: 72 },
    { viewportWidth: 672, viewportHeight: 600, scale: 1.2 }
  )
  assert.equal(above.opensAbove, true)
  assert.ok((above.left + above.width) * 1.2 <= 672)
  assert.ok((above.top + above.maxHeight) * 1.2 <= 540)
})

test('filters locally without changing the order supplied by the service', () => {
  const result = filterBranchPickerItems(
    [branch('feature/latest'), branch('release/Stable'), branch('feature/older')],
    'FEATURE/'
  )
  assert.deepEqual(
    result.items.map((item) => item.branch),
    ['feature/latest', 'feature/older']
  )
  assert.equal(result.total, 2)
  assert.equal(result.truncated, false)
})

test('finds a synthetic source by its visible label', () => {
  const result = filterBranchPickerItems(
    [{ branch: '__source_tttt__', label: '走tttt', detail: '测试环境热更' }],
    'tttt'
  )
  assert.equal(result.total, 1)
  assert.equal(result.items[0].branch, '__source_tttt__')
})

test('sorts by newest build activity and includes live queue activity', () => {
  const items = [
    branch('never'),
    branch('artifact', {
      latestArtifact: { builtAt: '2026-08-24T09:00:00.000Z' },
    }),
    branch('failed-latest', {
      latestJob: {
        status: 'FAILED',
        createdAt: '2026-08-25T09:00:00.000Z',
        finishedAt: '2026-08-25T09:05:00.000Z',
      },
    }),
    branch('active'),
  ]
  const ordered = sortBranchPickerItems(
    items,
    [
      {
        targetId: 'webapp',
        branch: 'active',
        status: 'CANCELING',
        createdAt: '2026-08-25T10:00:00.000Z',
      },
    ],
    'webapp'
  )
  assert.deepEqual(
    ordered.map((item) => item.branch),
    ['active', 'failed-latest', 'artifact', 'never']
  )
})

test('keeps a pinned synthetic route ahead of recently built branches', () => {
  const ordered = sortBranchPickerItems([
    branch('feature/new', {
      latestArtifact: { builtAt: '2026-08-28T09:00:00.000Z' },
    }),
    { ...branch('__route_tttt__'), pinned: true, synthetic: true },
  ])

  assert.deepEqual(
    ordered.map((item) => item.branch),
    ['__route_tttt__', 'feature/new']
  )
})

test('limits rendered branches while retaining the complete match count', () => {
  const items = Array.from({ length: BRANCH_PICKER_RENDER_LIMIT + 37 }, (_, index) =>
    branch(`feature/${String(index).padStart(3, '0')}`)
  )
  const result = filterBranchPickerItems(items, '')
  assert.equal(result.items.length, BRANCH_PICKER_RENDER_LIMIT)
  assert.equal(result.total, items.length)
  assert.equal(result.truncated, true)
  assert.equal(result.items.at(-1).branch, 'feature/099')
})

test('flattens the running and queued sections in their service order', () => {
  assert.deepEqual(
    flattenBuildQueue({
      running: [{ id: 'running' }],
      queued: [{ id: 'queued-1' }, { id: 'queued-2' }],
    }).map((item) => item.id),
    ['running', 'queued-1', 'queued-2']
  )
})

test('only invents a buildable default branch in an active configured environment', () => {
  const target = {
    id: 'webapp',
    defaultBranch: 'master',
    enabled: true,
    configured: true,
  }
  const catalog = { items: [] }
  assert.deepEqual(
    prepareTargetBranchItems({ target, catalog, environmentStatus: 'ACTIVE' }).map(
      (item) => item.branch
    ),
    ['master']
  )
  assert.deepEqual(
    prepareTargetBranchItems({
      target,
      catalog,
      selectedBranch: 'feature/ghost',
      environmentStatus: 'FROZEN',
    }),
    []
  )
  assert.deepEqual(prepareTargetBranchItems({ target, catalog, environmentStatus: 'ARCHIVED' }), [])
})

test('identifies only visible targets whose queue jobs have ended', () => {
  const previous = {
    running: [
      { id: 'finished-web', targetId: 'webapp' },
      { id: 'still-running', targetId: 'base' },
    ],
    queued: [
      { id: 'finished-web-2', targetId: 'webapp' },
      { id: 'unrelated', targetId: 'biz' },
    ],
  }
  const next = { running: [{ id: 'still-running', targetId: 'base' }], queued: [] }
  assert.deepEqual(endedQueueTargetIds(previous, next, ['webapp', 'base']), ['webapp'])
})

test('uses the live queue stage and queue position ahead of stale catalog state', () => {
  const item = branch('feature/chat', {
    buildStatus: 'FAILED',
    latestJob: { status: 'FAILED' },
  })
  assert.deepEqual(
    describeBranchBuild({
      item,
      targetId: 'webapp',
      queueItems: [
        {
          targetId: 'webapp',
          branch: 'feature/chat',
          status: 'QUEUED',
          queuePosition: 4,
        },
      ],
    }),
    {
      label: '队列序号 4',
      tone: 'queued',
      active: true,
      status: 'QUEUED',
      queuePosition: 4,
      jobId: null,
    }
  )

  const installing = describeBranchBuild({
    item,
    targetId: 'webapp',
    queueItems: [
      {
        targetId: 'webapp',
        branch: 'feature/chat',
        status: 'INSTALLING',
        queuePosition: null,
      },
    ],
  })
  assert.equal(installing.label, '正在安装依赖')
  assert.equal(installing.tone, 'working')

  const canceling = describeBranchBuild({
    item,
    targetId: 'webapp',
    queueItems: [
      {
        targetId: 'webapp',
        branch: 'feature/chat',
        status: 'CANCELING',
        queuePosition: null,
      },
    ],
  })
  assert.equal(canceling.label, '正在中断')
  assert.equal(canceling.tone, 'working')
})

test('prefers a running job when the same branch also has a queued request', () => {
  const result = describeBranchBuild({
    item: branch('feature/duplicate'),
    targetId: 'webapp',
    queueItems: [
      {
        targetId: 'webapp',
        branch: 'feature/duplicate',
        status: 'QUEUED',
        queuePosition: 7,
      },
      {
        targetId: 'webapp',
        branch: 'feature/duplicate',
        status: 'VALIDATING',
        queuePosition: null,
      },
    ],
  })
  assert.equal(result.label, '正在校验产物')
  assert.equal(result.status, 'VALIDATING')
})

test('does not overlay queue activity from another environment', () => {
  const item = branch('feature/shared-name', {
    latestArtifact: { id: 'artifact', builtAt: '2026-08-25T08:00:00.000Z' },
  })
  const queueItems = [
    {
      targetId: 'webapp',
      environmentSlug: 'qa-b',
      branch: 'feature/shared-name',
      status: 'BUILDING',
      createdAt: '2026-08-25T10:00:00.000Z',
    },
  ]
  const result = describeBranchBuild({
    item,
    targetId: 'webapp',
    environmentSlug: 'qa-a',
    queueItems,
  })
  assert.equal(result.label, '已有可用包')
  assert.equal(result.active, false)

  assert.deepEqual(
    endedQueueTargetIds(
      { running: queueItems, queued: [] },
      { running: [], queued: [] },
      ['webapp'],
      'qa-a'
    ),
    []
  )

  const sorted = sortBranchPickerItems(
    [
      branch('artifact', { latestArtifact: { builtAt: '2026-08-25T09:00:00.000Z' } }),
      branch('feature/shared-name'),
    ],
    queueItems,
    'webapp',
    'qa-a'
  )
  assert.deepEqual(
    sorted.map((candidate) => candidate.branch),
    ['artifact', 'feature/shared-name']
  )
})

test('does not mislabel a catalog active marker with a newer terminal attempt', () => {
  const result = describeBranchBuild({
    item: branch('feature/retry', {
      buildStatus: 'BUILDING',
      latestJob: { status: 'CANCELED' },
    }),
    targetId: 'webapp',
    queueItems: [],
  })
  assert.equal(result.label, '正在构建')
  assert.equal(result.active, true)
  assert.equal(result.status, null)
})

test('distinguishes failure, cancellation, ready artifacts, and untouched branches', () => {
  const describe = (item) => describeBranchBuild({ item, targetId: 'base', queueItems: [] })
  assert.equal(
    describe(branch('failed', { latestJob: { status: 'FAILED' } })).label,
    '上次打包失败'
  )
  assert.equal(
    describe(branch('canceled', { latestJob: { status: 'CANCELED' } })).label,
    '最近打包取消'
  )
  assert.equal(
    describe(branch('ready', { latestArtifact: { id: 'artifact', builtAt: '2026-08-25' } })).label,
    '已有可用包'
  )
  assert.equal(describe(branch('new')).label, '尚未打包')
})

test('uses an explicit fallback for missing or invalid artifact timestamps', () => {
  assert.equal(formatBranchArtifactTime(null), '暂无可用产物')
  assert.equal(formatBranchArtifactTime('not-a-date'), '暂无可用产物')
  assert.match(formatBranchArtifactTime('2026-08-25T08:30:00.000Z'), /^上次打包 /)
})
