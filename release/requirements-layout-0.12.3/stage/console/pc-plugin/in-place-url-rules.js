export function normalizeInPlaceUrlRules(value) {
  if (!Array.isArray(value)) return []
  const seenPatterns = new Set()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const pattern = typeof candidate.pattern === 'string' ? candidate.pattern.trim() : ''
    const environmentSlug =
      typeof candidate.environmentSlug === 'string' ? candidate.environmentSlug.trim() : ''
    if (
      !pattern ||
      pattern.length > 2048 ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(environmentSlug) ||
      seenPatterns.has(pattern)
    ) {
      return []
    }
    seenPatterns.add(pattern)
    return [{ pattern, environmentSlug }]
  })
}

export function matchInPlaceUrlRule(url, rules) {
  if (typeof url !== 'string' || !url) return null
  return normalizeInPlaceUrlRules(rules).reduce((best, rule) => {
    if (!url.includes(rule.pattern)) return best
    if (!best || rule.pattern.length > best.pattern.length) return rule
    return best
  }, null)
}

export function inPlaceRuleEnvironment(rule, environments) {
  if (!rule || !Array.isArray(environments)) return null
  return (
    environments.find(
      (environment) =>
        environment?.slug === rule.environmentSlug && environment.status !== 'ARCHIVED'
    ) || null
  )
}
