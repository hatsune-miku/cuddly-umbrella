export const PROJECT_VERSION_TAB_KEY = 'cuddly.projectVersionTab.v1'
export const PROJECT_VERSION_TAB_IDS = ['requirements', 'branches']

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/

export function normalizeProjectVersionTab(value) {
  return PROJECT_VERSION_TAB_IDS.includes(value) ? value : 'branches'
}

export function projectVersionTabForKey(current, key) {
  const normalized = normalizeProjectVersionTab(current)
  if (key === 'Home') return PROJECT_VERSION_TAB_IDS[0]
  if (key === 'End') return PROJECT_VERSION_TAB_IDS.at(-1)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return normalized
  const direction = key === 'ArrowRight' ? 1 : -1
  const currentIndex = PROJECT_VERSION_TAB_IDS.indexOf(normalized)
  return PROJECT_VERSION_TAB_IDS[
    (currentIndex + direction + PROJECT_VERSION_TAB_IDS.length) % PROJECT_VERSION_TAB_IDS.length
  ]
}

function normalizeGroupItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 40) return null
  const seen = new Set()
  const normalized = []
  for (const item of items) {
    const targetId = typeof item?.targetId === 'string' ? item.targetId.trim() : ''
    if (!targetId || targetId.length > 80 || seen.has(targetId)) return null
    seen.add(targetId)
    if (item.mode === 'official') {
      normalized.push({ targetId, mode: 'official' })
      continue
    }
    const branch = typeof item?.branch === 'string' ? item.branch.trim() : ''
    if (item.mode !== 'branch' || !branch || branch.length > 240) return null
    normalized.push({ targetId, mode: 'branch', branch })
  }
  return normalized
}

export function normalizeConfigurationGroup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  const previewSlug = typeof value.previewSlug === 'string' ? value.previewSlug.trim() : ''
  const previewHostnamePrefix =
    typeof value.previewHostnamePrefix === 'string' ? value.previewHostnamePrefix.trim() : ''
  const id = typeof value.id === 'string' ? value.id.trim() : token
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const environmentSlug =
    typeof value.environmentSlug === 'string' ? value.environmentSlug.trim() : ''
  const siteBindingId = typeof value.siteBindingId === 'string' ? value.siteBindingId.trim() : ''
  const revision = Number(value.revision)
  const items = normalizeGroupItems(value.items)
  if (
    !TOKEN_PATTERN.test(token) ||
    id !== token ||
    !name ||
    name.length > 80 ||
    !environmentSlug ||
    !siteBindingId ||
    value.schemaVersion !== 1 ||
    !items ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    return null
  }
  return {
    id: token,
    token,
    previewSlug: /^[a-f0-9]{32}$/.test(previewSlug) ? previewSlug : '',
    previewHostnamePrefix: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(previewHostnamePrefix)
      ? previewHostnamePrefix
      : /^[a-f0-9]{32}$/.test(previewSlug)
        ? `p-${previewSlug}`
        : '',
    name,
    environmentId: typeof value.environmentId === 'string' ? value.environmentId : '',
    environmentSlug,
    siteBindingId,
    schemaVersion: 1,
    items,
    createdBy: typeof value.createdBy === 'string' ? value.createdBy.trim() : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy.trim() : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    revision,
    sharePath:
      value.sharePath === `/s/${token}` && typeof value.sharePath === 'string'
        ? value.sharePath
        : `/s/${token}`,
    directPreviewUrl:
      typeof value.directPreviewUrl === 'string' ? value.directPreviewUrl.trim() : '',
  }
}

export function normalizeConfigurationGroups(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return []
  return body.items.flatMap((item) => {
    const group = normalizeConfigurationGroup(item)
    return group ? [group] : []
  })
}

export function configurationGroupBranchSummary(group, targetNames = {}) {
  const items = Array.isArray(group?.items) ? group.items : []
  const branches = items
    .filter((item) => item.mode === 'branch')
    .map((item) => `${targetNames[item.targetId] || item.targetId} · ${item.branch}`)
  const officialCount = items.length - branches.length
  if (!branches.length) return '全部跟随官网版本'
  return `${branches.join('；')}${officialCount ? `；${officialCount} 项跟随官网` : ''}`
}

export function configurationGroupUpdateInput(group, { name, snapshot = null } = {}) {
  const normalized = normalizeConfigurationGroup(group)
  if (!normalized) throw new Error('配置组数据无效，请刷新后重试')
  const nextName = typeof name === 'string' ? name.trim() : ''
  if (!nextName || nextName.length > 80) throw new Error('配置组名称不能为空且不能超过 80 个字符')
  const snapshotItems = normalizeGroupItems(snapshot?.items)
  const useSnapshot = Boolean(
    snapshot &&
    typeof snapshot.bindingId === 'string' &&
    snapshot.bindingId &&
    typeof snapshot.environmentSlug === 'string' &&
    snapshot.environmentSlug &&
    snapshotItems
  )
  const items = useSnapshot ? snapshotItems : normalized.items
  return {
    name: nextName,
    environmentSlug: useSnapshot ? snapshot.environmentSlug : normalized.environmentSlug,
    siteBindingId: useSnapshot ? snapshot.bindingId : normalized.siteBindingId,
    schemaVersion: 1,
    items,
    expectedRevision: normalized.revision,
  }
}

export function isConfigurationGroupRevisionConflict(error) {
  return error?.body?.code === 'CONFIG_GROUP_REVISION_CONFLICT'
}
