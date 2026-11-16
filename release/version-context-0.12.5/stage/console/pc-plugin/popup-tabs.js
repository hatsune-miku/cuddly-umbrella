export const POPUP_TAB_IDS = ['projects', 'queue']

export function normalizePopupTab(value) {
  return POPUP_TAB_IDS.includes(value) ? value : 'projects'
}

export function popupTabForKey(current, key) {
  const normalized = normalizePopupTab(current)
  if (key === 'Home') return POPUP_TAB_IDS[0]
  if (key === 'End') return POPUP_TAB_IDS.at(-1)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return normalized
  const direction = key === 'ArrowRight' ? 1 : -1
  const currentIndex = POPUP_TAB_IDS.indexOf(normalized)
  return POPUP_TAB_IDS[(currentIndex + direction + POPUP_TAB_IDS.length) % POPUP_TAB_IDS.length]
}
