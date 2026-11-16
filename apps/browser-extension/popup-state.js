export const POPUP_SCOPED_STATE_KEY = 'cuddly.popupStateByTabBindingEnvironment.v2'
export const READ_POPUP_SCOPED_STATE_COMMAND = 'read-popup-scoped-state'
export const WRITE_POPUP_SCOPED_STATE_COMMAND = 'write-popup-scoped-state'

const MAX_SCOPED_STATES = 100

function stringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => typeof key === 'string' && typeof entry === 'string'
    )
  )
}

export function popupStateScopeKey(tabId, bindingId, environmentSlug) {
  if (
    !Number.isInteger(tabId) ||
    tabId < 0 ||
    typeof bindingId !== 'string' ||
    !bindingId ||
    typeof environmentSlug !== 'string' ||
    !environmentSlug
  ) {
    return ''
  }
  return `${tabId}:${bindingId}:${environmentSlug}`
}

export function readScopedPopupState(store, { tabId, bindingId, environmentSlug }) {
  const key = popupStateScopeKey(tabId, bindingId, environmentSlug)
  const entry = key && store && typeof store === 'object' ? store[key] : null
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return {
    selectedBranches: stringRecord(entry.selectedBranches),
    submittedBuildBranches: stringRecord(entry.submittedBuildBranches),
    siteOverrideEnabled: entry.siteOverrideEnabled === true,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
  }
}

export function writeScopedPopupState(
  store,
  {
    tabId,
    bindingId,
    environmentSlug,
    selectedBranches,
    submittedBuildBranches,
    siteOverrideEnabled = false,
    updatedAt = Date.now(),
  }
) {
  const key = popupStateScopeKey(tabId, bindingId, environmentSlug)
  if (!key) return store && typeof store === 'object' ? { ...store } : {}
  const next = {
    ...(store && typeof store === 'object' && !Array.isArray(store) ? store : {}),
    [key]: {
      selectedBranches: stringRecord(selectedBranches),
      submittedBuildBranches: stringRecord(submittedBuildBranches),
      siteOverrideEnabled: siteOverrideEnabled === true,
      updatedAt,
    },
  }
  const entries = Object.entries(next)
    .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
    .slice(0, MAX_SCOPED_STATES)
  return Object.fromEntries(entries)
}

export function removeScopedPopupStatesForTab(store, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return store && typeof store === 'object' && !Array.isArray(store) ? { ...store } : {}
  }
  const prefix = `${tabId}:`
  return Object.fromEntries(
    Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {}).filter(
      ([key]) => !key.startsWith(prefix)
    )
  )
}

export function retainScopedPopupStatesForTabs(store, tabIds) {
  const activeTabIds = new Set(
    Array.from(tabIds || []).filter((tabId) => Number.isInteger(tabId) && tabId >= 0)
  )
  return Object.fromEntries(
    Object.entries(store && typeof store === 'object' && !Array.isArray(store) ? store : {}).filter(
      ([key]) => {
        const separator = key.indexOf(':')
        if (separator <= 0) return false
        const tabId = Number(key.slice(0, separator))
        return Number.isInteger(tabId) && activeTabIds.has(tabId)
      }
    )
  )
}

export function chooseRestoredPopupState(inMemoryState, persistedState) {
  return inMemoryState || persistedState || null
}

export function operationMatchesContext(operation, current, { requireBranch = false } = {}) {
  if (!operation || !current) return false
  const sameScope =
    operation.tabId === current.tabId &&
    operation.bindingId === current.bindingId &&
    operation.environmentSlug === current.environmentSlug &&
    (operation.contextVersion === undefined ||
      current.contextVersion === undefined ||
      operation.contextVersion === current.contextVersion)
  if (!sameScope) return false
  if (!requireBranch) return true
  return operation.targetId === current.targetId && operation.branch === (current.branch || '')
}
