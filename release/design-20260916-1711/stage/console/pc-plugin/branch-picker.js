import { createUiElement, setUiClass } from './cakeui-dom.js'
import { ACTIVE_BUILD_STATUSES, buildJobPresentation } from './build-queue.js'

export const BRANCH_PICKER_RENDER_LIMIT = 100

export function flattenBuildQueue(queue) {
  return [...(queue?.running || []), ...(queue?.queued || [])]
}

export function prepareTargetBranchItems({
  target,
  catalog,
  selectedBranch = '',
  environmentStatus = '',
}) {
  const canOfferDefaultBranch =
    environmentStatus === 'ACTIVE' && target?.enabled && target?.configured
  const items = catalog?.items?.length
    ? [...catalog.items]
    : canOfferDefaultBranch
      ? [
          {
            branch: target.defaultBranch,
            buildStatus: 'IDLE',
            latestArtifact: null,
            latestJob: null,
          },
        ]
      : []
  if (
    selectedBranch &&
    canOfferDefaultBranch &&
    !items.some((item) => item.branch === selectedBranch)
  ) {
    items.unshift({
      branch: selectedBranch,
      buildStatus: 'IDLE',
      latestArtifact: null,
      latestJob: null,
    })
  }
  return items
}

function belongsToEnvironment(job, environmentSlug) {
  return !environmentSlug || job?.environmentSlug === environmentSlug
}

export function endedQueueTargetIds(
  previousQueue,
  nextQueue,
  allowedTargetIds,
  environmentSlug = ''
) {
  const nextIds = new Set(
    flattenBuildQueue(nextQueue)
      .filter((job) => belongsToEnvironment(job, environmentSlug))
      .map((job) => job.id)
  )
  const allowed = allowedTargetIds ? new Set(allowedTargetIds) : null
  return [
    ...new Set(
      flattenBuildQueue(previousQueue)
        .filter((job) => belongsToEnvironment(job, environmentSlug))
        .filter((job) => !nextIds.has(job.id))
        .map((job) => job.targetId)
        .filter((targetId) => !allowed || allowed.has(targetId))
    ),
  ]
}

export function filterBranchPickerItems(items, query, limit = BRANCH_PICKER_RENDER_LIMIT) {
  const normalized = String(query || '')
    .trim()
    .toLowerCase()
  const matches = (items || []).filter(
    (item) =>
      !normalized ||
      [item.branch, item.label, item.detail].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(normalized)
      )
  )
  const boundedLimit = Math.max(1, Math.floor(limit) || BRANCH_PICKER_RENDER_LIMIT)
  return {
    items: matches.slice(0, boundedLimit),
    total: matches.length,
    truncated: matches.length > boundedLimit,
  }
}

function timeValue(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortBranchPickerItems(items, queueItems = [], targetId = '', environmentSlug = '') {
  const jobsByBranch = new Map()
  if (targetId) {
    for (const job of queueItems || []) {
      if (
        job.targetId !== targetId ||
        !belongsToEnvironment(job, environmentSlug) ||
        !ACTIVE_BUILD_STATUSES.has(job.status)
      ) {
        continue
      }
      const jobs = jobsByBranch.get(job.branch) || []
      jobs.push(job)
      jobsByBranch.set(job.branch, jobs)
    }
  }
  return (items || [])
    .map((item) => {
      const jobs = jobsByBranch.get(item.branch) || []
      return {
        item,
        activityAt: Math.max(
          timeValue(item.latestArtifact?.builtAt),
          timeValue(item.latestJob?.finishedAt),
          timeValue(item.latestJob?.createdAt),
          ...jobs.map((job) => timeValue(job.startedAt || job.createdAt))
        ),
      }
    })
    .sort(
      (left, right) =>
        Number(Boolean(right.item.pinned)) - Number(Boolean(left.item.pinned)) ||
        right.activityAt - left.activityAt ||
        String(left.item.branch).localeCompare(String(right.item.branch))
    )
    .map(({ item }) => item)
}

function matchingQueueJobs(queueItems, targetId, branch, environmentSlug) {
  return (queueItems || []).filter(
    (job) =>
      job.targetId === targetId &&
      job.branch === branch &&
      belongsToEnvironment(job, environmentSlug) &&
      ACTIVE_BUILD_STATUSES.has(job.status)
  )
}

export function describeBranchBuild({ item, queueItems, targetId, environmentSlug = '' }) {
  const activeJobs = matchingQueueJobs(queueItems, targetId, item?.branch, environmentSlug)
  const running = activeJobs.find((job) => job.status !== 'QUEUED')
  const queued = activeJobs
    .filter((job) => job.status === 'QUEUED')
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER)
    )[0]
  const active = running || queued

  if (active) {
    const queueLabel =
      active.status === 'QUEUED' && Number.isInteger(active.queuePosition)
        ? `队列序号 ${active.queuePosition}`
        : buildJobPresentation(active).label
    return {
      label: queueLabel,
      tone: active.status === 'QUEUED' ? 'queued' : 'working',
      active: true,
      status: active.status,
      queuePosition: active.queuePosition ?? null,
      jobId: active.id || null,
    }
  }

  const latestStatus = item?.latestJob?.status
  const catalogActiveStatus = ACTIVE_BUILD_STATUSES.has(latestStatus) ? latestStatus : null
  if (catalogActiveStatus || item?.buildStatus === 'BUILDING') {
    return {
      label: catalogActiveStatus ? buildJobPresentation(catalogActiveStatus).label : '正在构建',
      tone: catalogActiveStatus === 'QUEUED' ? 'queued' : 'working',
      active: true,
      status: catalogActiveStatus,
      queuePosition: null,
      jobId: item?.latestJob?.id || null,
    }
  }
  if (latestStatus === 'FAILED' || item?.buildStatus === 'FAILED') {
    return {
      label: '上次打包失败',
      tone: 'failed',
      active: false,
      status: 'FAILED',
      queuePosition: null,
      jobId: item?.latestJob?.id || null,
    }
  }
  if (latestStatus === 'CANCELED') {
    return {
      label: '最近打包取消',
      tone: 'canceled',
      active: false,
      status: 'CANCELED',
      queuePosition: null,
      jobId: item?.latestJob?.id || null,
    }
  }
  if (item?.latestArtifact) {
    return {
      label: '已有可用包',
      tone: 'ready',
      active: false,
      status: latestStatus || null,
      queuePosition: null,
      jobId: item?.latestJob?.id || null,
    }
  }
  if (latestStatus === 'SUCCEEDED') {
    return {
      label: buildJobPresentation('SUCCEEDED').label,
      tone: 'ready',
      active: false,
      status: latestStatus,
      queuePosition: null,
      jobId: item?.latestJob?.id || null,
    }
  }
  return {
    label: '尚未打包',
    tone: 'idle',
    active: false,
    status: latestStatus || null,
    queuePosition: null,
    jobId: item?.latestJob?.id || null,
  }
}

export function formatBranchArtifactTime(value) {
  if (!value) return '暂无可用产物'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无可用产物'
  return `上次打包 ${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)}`
}

export function branchDropdownPlacement(
  triggerRect,
  {
    viewportWidth,
    viewportHeight,
    margin = 8,
    gap = 4,
    preferredWidth = 380,
    preferredHeight = 316,
    minHeight = 150,
  }
) {
  const widthLimit = Math.max(0, Number(viewportWidth) - margin * 2)
  const width = Math.min(
    widthLimit,
    Math.max(Number(triggerRect?.width) || 0, Math.min(preferredWidth, widthLimit))
  )
  const below = Math.max(0, Number(viewportHeight) - margin - Number(triggerRect?.bottom) - gap)
  const above = Math.max(0, Number(triggerRect?.top) - margin - gap)
  const opensAbove = below < minHeight && above > below
  const availableHeight = opensAbove ? above : below
  const maxHeight = Math.min(preferredHeight, availableHeight)
  const left = Math.max(
    margin,
    Math.min(Number(triggerRect?.left) || 0, Number(viewportWidth) - margin - width)
  )
  const top = opensAbove
    ? Math.max(margin, Number(triggerRect?.top) - gap - maxHeight)
    : Number(triggerRect?.bottom) + gap

  return { left, top, width, maxHeight, opensAbove }
}

function optionButton({ value, name, detail, status, selected, official, onSelect, onKeyDown }) {
  const button = createUiElement('button')
  button.type = 'button'
  setUiClass(button, `branch-option${selected ? ' selected' : ''}${official ? ' official' : ''}`)
  button.setAttribute('role', 'option')
  button.setAttribute('aria-selected', String(selected))
  button.tabIndex = selected ? 0 : -1
  button.dataset.value = value
  button.title = name

  const copy = createUiElement('span')
  setUiClass(copy, 'branch-option-copy')
  const title = createUiElement('strong')
  title.textContent = name
  const meta = createUiElement('small')
  meta.textContent = detail
  copy.append(title, meta)

  const state = createUiElement('span')
  setUiClass(state, `branch-option-state ${status.tone}`)
  state.textContent = status.label
  button.append(copy, state)
  button.addEventListener('click', () => onSelect(value))
  button.addEventListener('keydown', onKeyDown)
  return button
}

export function createBranchPicker(dropdown) {
  const search = dropdown.querySelector('#branch-picker-search')
  const list = dropdown.querySelector('#branch-picker-list')
  const count = dropdown.querySelector('#branch-picker-count')
  let config = null
  let optionNodes = []
  let returnFocus = null

  function triggerFor(targetId) {
    if (!targetId) return null
    return document.querySelector(
      `.branch-picker-trigger[data-target-id="${CSS.escape(targetId)}"]`
    )
  }

  function position() {
    if (!config) return
    const trigger = config.trigger?.isConnected ? config.trigger : triggerFor(config.targetId)
    if (!trigger) {
      close({ restoreFocus: false })
      return
    }
    config.trigger = trigger
    returnFocus = trigger
    const rect = trigger.getBoundingClientRect()
    const initial = branchDropdownPlacement(rect, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
    dropdown.style.visibility = 'hidden'
    dropdown.style.left = `${initial.left}px`
    dropdown.style.top = `${initial.top}px`
    dropdown.style.width = `${initial.width}px`
    dropdown.style.maxHeight = `${initial.maxHeight}px`
    dropdown.style.setProperty(
      '--branch-list-max-height',
      `${Math.max(72, initial.maxHeight - 78)}px`
    )
    const actualHeight = Math.min(initial.maxHeight, dropdown.scrollHeight)
    const placement = branchDropdownPlacement(rect, {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredHeight: actualHeight,
    })
    dropdown.style.left = `${placement.left}px`
    dropdown.style.top = `${placement.top}px`
    dropdown.dataset.placement = placement.opensAbove ? 'above' : 'below'
    dropdown.style.visibility = ''
  }

  function focusOption(index, { preventScroll = false } = {}) {
    if (!optionNodes.length) return
    const target = optionNodes[Math.max(0, Math.min(index, optionNodes.length - 1))]
    for (const option of optionNodes) option.tabIndex = -1
    if (!target) return
    target.tabIndex = 0
    target.focus({ preventScroll })
  }

  function close({ restoreFocus = true } = {}) {
    const previousTargetId = config?.targetId
    config?.trigger?.setAttribute('aria-expanded', 'false')
    config = null
    dropdown.hidden = true
    dropdown.style.visibility = ''
    if (!restoreFocus) return
    const fallback = triggerFor(previousTargetId)
    const target = returnFocus?.isConnected ? returnFocus : fallback
    target?.focus()
  }

  function choose(value) {
    const onSelect = config?.onSelect
    const targetId = config?.targetId
    close({ restoreFocus: false })
    onSelect?.(value)
    window.requestAnimationFrame(() => triggerFor(targetId)?.focus())
  }

  function onOptionKeyDown(event) {
    const index = optionNodes.indexOf(event.currentTarget)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) search.focus()
      else focusOption(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(optionNodes.length - 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  function render() {
    if (!config) return
    const queueItems = flattenBuildQueue(config.queue)
    const filtered = filterBranchPickerItems(
      sortBranchPickerItems(
        config.items,
        queueItems,
        config.targetId,
        config.environmentSlug || ''
      ),
      search.value
    )
    const fragment = document.createDocumentFragment()
    const nodes = []
    const focusedOption = list.contains(document.activeElement) ? document.activeElement : null
    const focusedValue = focusedOption instanceof HTMLElement ? focusedOption.dataset.value : null
    const previousScrollTop = list.scrollTop

    if (config.official) {
      const officialNode = optionButton({
        value: '',
        name: config.official.label,
        detail: config.official.detail,
        status: config.official.status || { label: '官方', tone: 'official' },
        selected: !config.selectedBranch,
        official: true,
        onSelect: choose,
        onKeyDown: onOptionKeyDown,
      })
      nodes.push(officialNode)
      fragment.append(officialNode)
    }

    for (const item of filtered.items) {
      const node = optionButton({
        value: item.branch,
        name: item.label || item.branch,
        detail: item.detail || formatBranchArtifactTime(item.latestArtifact?.builtAt),
        status:
          item.status ||
          describeBranchBuild({
            item,
            queueItems,
            targetId: config.targetId,
            environmentSlug: config.environmentSlug || '',
          }),
        selected: item.branch === config.selectedBranch,
        official: false,
        onSelect: choose,
        onKeyDown: onOptionKeyDown,
      })
      nodes.push(node)
      fragment.append(node)
    }

    if (!filtered.items.length) {
      const empty = createUiElement('div')
      setUiClass(empty, 'branch-picker-empty')
      empty.textContent = search.value.trim() ? '没有匹配的分支' : '还没有可选分支'
      fragment.append(empty)
    }

    list.replaceChildren(fragment)
    optionNodes = nodes
    list.scrollTop = previousScrollTop
    if (focusedValue !== null) {
      const nextFocused = optionNodes.find((node) => node.dataset.value === focusedValue)
      if (nextFocused) focusOption(optionNodes.indexOf(nextFocused), { preventScroll: true })
      else search.focus({ preventScroll: true })
    }
    count.textContent = filtered.truncated
      ? `显示前 ${filtered.items.length} 个，共 ${filtered.total} 个匹配分支，请继续缩小范围`
      : search.value.trim()
        ? `找到 ${filtered.total} 个匹配分支`
        : `${filtered.total} 个分支 · 按最近打包排序`
  }

  function open(nextConfig) {
    config?.trigger?.setAttribute('aria-expanded', 'false')
    config = nextConfig
    returnFocus = nextConfig.trigger || document.activeElement
    search.value = ''
    search.placeholder = `搜索 ${nextConfig.targetName} 分支`
    render()
    nextConfig.trigger?.setAttribute('aria-expanded', 'true')
    dropdown.hidden = false
    position()
    window.requestAnimationFrame(() => search.focus())
  }

  function update(nextConfig) {
    if (!config || config.targetId !== nextConfig.targetId) return
    const trigger = triggerFor(config.targetId)
    config.trigger?.setAttribute('aria-expanded', 'false')
    config = { ...config, ...nextConfig, trigger: trigger || config.trigger }
    config.trigger?.setAttribute('aria-expanded', 'true')
    returnFocus = config.trigger || returnFocus
    render()
    position()
  }

  search.addEventListener('input', render)
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const selectedIndex = optionNodes.findIndex(
        (node) => node.getAttribute('aria-selected') === 'true'
      )
      focusOption(selectedIndex >= 0 ? selectedIndex : 0)
    } else if (event.key === 'Enter' && search.value.trim()) {
      const branchNodes = optionNodes.filter((node) => node.dataset.value)
      if (branchNodes.length === 1) {
        event.preventDefault()
        branchNodes[0].click()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!config || dropdown.hidden) return
      if (dropdown.contains(event.target) || config.trigger?.contains(event.target)) return
      close({ restoreFocus: false })
    },
    true
  )
  document.addEventListener(
    'scroll',
    (event) => {
      if (!config || dropdown.hidden || dropdown.contains(event.target)) return
      close({ restoreFocus: false })
    },
    true
  )
  window.addEventListener('resize', () => {
    if (config && !dropdown.hidden) position()
  })

  return {
    open,
    update,
    close,
    get targetId() {
      return config?.targetId || null
    },
  }
}
