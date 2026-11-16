export const SITE_BINDING_REQUIRED = '当前页面尚未配置站点绑定，请先在管理后台配置站点'
export const ENVIRONMENT_REQUIRED = '请选择运行环境'
export const IN_PLACE_RULE_ENVIRONMENT_MISMATCH = '当前地址命中的原地应用规则与所选环境不一致'
export const IN_PLACE_RULE_SITE_FORBIDDEN = '当前地址只允许原地热更，页面项目必须使用官网页面'
export const IN_PLACE_RULE_ORIGIN_MISMATCH = '当前地址只允许原地热更，但它不是站点绑定的官方页面'

function normalizedOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

export function pageEnvironmentClass(value) {
  let hostname = ''
  try {
    hostname = new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'test'
  if (hostname === 'dev.chuanyuapp.com' || hostname.endsWith('.dev.chuanyuapp.com')) return 'test'
  if (hostname === 'kookapp.cn' || hostname.endsWith('.kookapp.cn')) return 'online'
  return ''
}

export function originsShareEnvironment(left, right) {
  const leftOrigin = normalizedOrigin(left)
  const rightOrigin = normalizedOrigin(right)
  if (!leftOrigin || !rightOrigin) return false
  if (leftOrigin === rightOrigin) return true
  const leftClass = pageEnvironmentClass(leftOrigin)
  return Boolean(leftClass && leftClass === pageEnvironmentClass(rightOrigin))
}

export function previewDestinationUrl(origin, currentUrl) {
  const destination = new URL(origin)
  try {
    const current = new URL(currentUrl)
    destination.pathname = current.pathname
    destination.search = current.search
    destination.hash = current.hash
  } catch {
    // Keep the origin root when the current tab URL cannot be parsed.
  }
  return destination.href
}

export function createPreviewRequest({
  binding,
  environmentSlug,
  siteArtifactId,
  selections,
  ttlMinutes = 480,
}) {
  if (!binding) throw new Error(SITE_BINDING_REQUIRED)
  if (!environmentSlug) throw new Error(ENVIRONMENT_REQUIRED)
  return {
    ttlMinutes,
    siteBindingId: binding.id,
    environmentSlug,
    ...(siteArtifactId ? { siteArtifactId } : {}),
    selections: selections || [],
  }
}

export function mergeSelectedBranches({ sameBinding, previous, defaults }) {
  return Object.fromEntries(
    Object.entries(defaults).map(([targetId, branch]) => [
      targetId,
      sameBinding && Object.hasOwn(previous, targetId) ? previous[targetId] : branch,
    ])
  )
}

export function resolveSelectedArtifacts({
  targets = [],
  selectedBranches = {},
  branchCatalogs = {},
  siteTargetId = null,
  siteOverrideEnabled = false,
}) {
  let siteArtifactId = null
  const selections = []
  const missing = []
  for (const target of targets) {
    const branch = selectedBranches[target.id] || ''
    if (!branch) continue
    if (target.id === siteTargetId && !siteOverrideEnabled) continue
    const artifact =
      branchCatalogs[target.id]?.items?.find((item) => item.branch === branch)?.latestArtifact ||
      null
    if (!artifact) {
      missing.push({ targetId: target.id, targetName: target.name || target.id, branch })
      continue
    }
    if (target.id === siteTargetId) {
      siteArtifactId = artifact.id
    } else {
      selections.push({
        targetId: target.id,
        artifactId: artifact.id,
        branch,
        builtAt: artifact.builtAt,
      })
    }
  }
  return { siteArtifactId, selections, missing }
}

export function planPreviewApplication({
  binding,
  environmentSlug,
  previewOrigin,
  currentUrl = '',
  siteArtifactId = null,
  selections = [],
  inPlaceRule = null,
}) {
  if (!binding) {
    return {
      canApply: false,
      mode: null,
      requestedOrigin: null,
      reason: SITE_BINDING_REQUIRED,
    }
  }
  if (!environmentSlug) {
    return {
      canApply: false,
      mode: 'site',
      requestedOrigin: null,
      reason: ENVIRONMENT_REQUIRED,
    }
  }
  const requestedOrigin = normalizedOrigin(previewOrigin)
  const selectedPageOrigin = normalizedOrigin(binding.officialOrigin)
  const currentOrigin = normalizedOrigin(currentUrl)
  const currentPageMatchesEnvironment = originsShareEnvironment(currentOrigin, selectedPageOrigin)
  if (inPlaceRule) {
    if (
      inPlaceRule.environmentSlug !== environmentSlug ||
      typeof inPlaceRule.pattern !== 'string' ||
      !currentUrl.includes(inPlaceRule.pattern)
    ) {
      return {
        canApply: false,
        mode: 'remote',
        requestedOrigin,
        reason: IN_PLACE_RULE_ENVIRONMENT_MISMATCH,
      }
    }
    if (siteArtifactId) {
      return {
        canApply: false,
        mode: 'remote',
        requestedOrigin,
        reason: IN_PLACE_RULE_SITE_FORBIDDEN,
      }
    }
    if (!requestedOrigin || !selectedPageOrigin || !currentPageMatchesEnvironment) {
      return {
        canApply: false,
        mode: 'remote',
        requestedOrigin,
        reason: IN_PLACE_RULE_ORIGIN_MISMATCH,
      }
    }
    return {
      canApply: true,
      mode: selections.length ? 'remote' : 'official',
      requestedOrigin: selections.length ? requestedOrigin : selectedPageOrigin,
      pageOrigin: currentOrigin,
      reason: null,
      inPlaceRule,
    }
  }
  if (
    !siteArtifactId &&
    selections.length > 0 &&
    requestedOrigin &&
    selectedPageOrigin &&
    currentPageMatchesEnvironment &&
    binding.environmentSlug === environmentSlug
  ) {
    return {
      canApply: true,
      mode: 'remote',
      requestedOrigin,
      pageOrigin: currentOrigin,
      reason: null,
    }
  }
  if (
    !siteArtifactId &&
    selections.length === 0 &&
    currentPageMatchesEnvironment &&
    binding.environmentSlug === environmentSlug
  ) {
    return {
      canApply: true,
      mode: 'official',
      requestedOrigin: currentOrigin,
      pageOrigin: currentOrigin,
      reason: null,
    }
  }
  return {
    canApply: true,
    mode: 'site',
    requestedOrigin,
    reason: null,
  }
}
