export function normalizeBindingCandidates(value) {
  const source = Array.isArray(value?.items) ? value.items : value?.id ? [value] : []
  const seen = new Set()
  return source.filter((binding) => {
    if (
      !binding ||
      typeof binding.id !== 'string' ||
      typeof binding.hostname !== 'string' ||
      seen.has(binding.id)
    ) {
      return false
    }
    seen.add(binding.id)
    return true
  })
}

export function chooseBindingCandidate({ candidates, activeSiteBindingId, environmentSlug = '' }) {
  if (!candidates?.length) return null
  const eligible = environmentSlug
    ? candidates.filter((binding) => binding.environmentSlug === environmentSlug)
    : candidates
  if (!eligible.length) return null
  return eligible.find((binding) => binding.id === activeSiteBindingId) || eligible[0]
}
