export const TAB_ENVIRONMENT_PREFS_KEY = 'cuddly.environmentByTab.v1'

const MAX_TAB_ENVIRONMENT_PREFS = 100

export function environmentClassForUrl(value) {
  let hostname = ''
  try {
    hostname = new URL(String(value || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'test'
  if (hostname === 'dev.chuanyuapp.com' || hostname.endsWith('.dev.chuanyuapp.com')) return 'test'
  if (hostname === 'kookapp.cn' || hostname.endsWith('.kookapp.cn')) return 'online'
  return ''
}

export function environmentForUrl(environments, value) {
  const expectedClass = environmentClassForUrl(value)
  if (!expectedClass) return null
  return (
    (environments || []).find(
      (environment) => environmentClassForUrl(environment?.backendOrigin) === expectedClass
    ) || null
  )
}

function normalizedOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return new URL(value.trim()).origin
  } catch {
    return ''
  }
}

export function normalizeEnvironments(value) {
  const source = Array.isArray(value?.items) ? value.items : []
  const seen = new Set()
  return source.filter((environment) => {
    const valid =
      environment &&
      typeof environment.id === 'string' &&
      typeof environment.slug === 'string' &&
      environment.slug.length > 0 &&
      typeof environment.name === 'string' &&
      ['ACTIVE', 'FROZEN'].includes(environment.status) &&
      !seen.has(environment.slug)
    if (valid) seen.add(environment.slug)
    return valid
  })
}

export function chooseEnvironment({
  environments,
  tabEnvironmentSlug = '',
  activeEnvironmentSlug = '',
  rememberedEnvironmentSlug = '',
  tabUrl = '',
}) {
  if (!environments?.length) return null
  return (
    environmentForUrl(environments, tabUrl) ||
    environments.find((environment) => environment.slug === tabEnvironmentSlug) ||
    environments.find((environment) => environment.slug === activeEnvironmentSlug) ||
    environments.find((environment) => environment.slug === rememberedEnvironmentSlug) ||
    environments[0]
  )
}

export function environmentOptionLabel(environment) {
  const name = typeof environment?.name === 'string' ? environment.name.trim() : ''
  const slug = typeof environment?.slug === 'string' ? environment.slug.trim() : ''
  const status = environment?.status === 'FROZEN' ? ' · 冻结' : ''
  return `${name ? `${name} · ${slug}` : slug || '未命名环境'}${status}`
}

export function readTabEnvironmentPreference(store, { tabId, officialOrigin }) {
  if (!Number.isInteger(tabId) || tabId < 0) return ''
  const entry = store && typeof store === 'object' ? store[String(tabId)] : null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
  const expectedOrigin = normalizedOrigin(officialOrigin)
  const entryOrigin = normalizedOrigin(entry.officialOrigin)
  return expectedOrigin &&
    entryOrigin === expectedOrigin &&
    typeof entry.environmentSlug === 'string'
    ? entry.environmentSlug.trim()
    : ''
}

export function writeTabEnvironmentPreference(
  store,
  { tabId, officialOrigin, environmentSlug, updatedAt = Date.now() }
) {
  const origin = normalizedOrigin(officialOrigin)
  const slug = typeof environmentSlug === 'string' ? environmentSlug.trim() : ''
  const current = store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  if (!Number.isInteger(tabId) || tabId < 0 || !origin || !slug) return { ...current }
  return Object.fromEntries(
    Object.entries({
      ...current,
      [String(tabId)]: { officialOrigin: origin, environmentSlug: slug, updatedAt },
    })
      .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
      .slice(0, MAX_TAB_ENVIRONMENT_PREFS)
  )
}

export function removeTabEnvironmentPreference(store, tabId) {
  const next = {
    ...(store && typeof store === 'object' && !Array.isArray(store) ? store : {}),
  }
  if (Number.isInteger(tabId) && tabId >= 0) delete next[String(tabId)]
  return next
}

export function retainTabEnvironmentPreferences(store, tabIds) {
  const activeTabIds = new Set(
    Array.from(tabIds || []).filter((tabId) => Number.isInteger(tabId) && tabId >= 0)
  )
  return Object.fromEntries(
    Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {}).filter(
      ([tabId]) => activeTabIds.has(Number(tabId))
    )
  )
}
