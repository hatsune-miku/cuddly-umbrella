export function configurationGroupItems(targets, selectedBranches) {
  return (Array.isArray(targets) ? targets : []).map((target) => {
    const targetId = typeof target?.id === 'string' ? target.id : ''
    const branch =
      selectedBranches && typeof selectedBranches[targetId] === 'string'
        ? selectedBranches[targetId].trim()
        : ''
    return branch ? { targetId, mode: 'branch', branch } : { targetId, mode: 'official' }
  })
}

export function configurationGroupFingerprint({ bindingId, environmentSlug, items }) {
  return JSON.stringify({
    bindingId: typeof bindingId === 'string' ? bindingId : '',
    environmentSlug: typeof environmentSlug === 'string' ? environmentSlug : '',
    items: Array.isArray(items) ? items : [],
  })
}

const configurationGroupUrlPrefixPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const configurationGroupChineseUrlPrefixPattern =
  /^[\p{Script=Han}0-9](?:[\p{Script=Han}0-9-]{0,61}[\p{Script=Han}0-9])?$/u
const reservedConfigurationGroupUrlPrefixes = new Set([
  'acme',
  'admin',
  'api',
  'assets',
  'biz',
  'certbot',
  'control',
  'gateway',
  'kfc',
  'm',
  'main',
  'mihomo',
  'oss',
  'static',
  'www',
])

export function normalizedConfigurationGroupUrlPrefix(value) {
  return typeof value === 'string' ? value.trim().normalize('NFC').toLowerCase() : ''
}

function isConfigurationGroupUrlPrefixInput(prefix) {
  return (
    configurationGroupUrlPrefixPattern.test(prefix) ||
    configurationGroupChineseUrlPrefixPattern.test(prefix)
  )
}

export function canonicalConfigurationGroupUrlPrefix(value) {
  const prefix = normalizedConfigurationGroupUrlPrefix(value)
  if (!prefix || !isConfigurationGroupUrlPrefixInput(prefix)) return ''
  try {
    const suffix = '.preview.invalid'
    const hostname = new URL(`https://${prefix}${suffix}`).hostname
    if (!hostname.endsWith(suffix)) return ''
    const canonical = hostname.slice(0, -suffix.length)
    return configurationGroupUrlPrefixPattern.test(canonical) ? canonical : ''
  } catch {
    return ''
  }
}

export function configurationGroupUrlPrefixError(value) {
  const prefix = normalizedConfigurationGroupUrlPrefix(value)
  if (!prefix) return ''
  if (!isConfigurationGroupUrlPrefixInput(prefix)) {
    return '支持英文、数字和连字符，或中文搭配数字、连字符；不能中英文混排或以连字符开头、结尾'
  }
  const canonical = canonicalConfigurationGroupUrlPrefix(prefix)
  if (!canonical) return '中文前缀转换后的域名超过长度限制，请缩短'
  if (canonical.startsWith('p-')) return 'p- 开头的地址由系统自动链接保留'
  if (reservedConfigurationGroupUrlPrefixes.has(canonical)) {
    return `${canonical} 是系统或预览站点保留地址`
  }
  return ''
}

export function configurationGroupShareUrl(controlOrigin, group) {
  const origin = new URL(controlOrigin).origin
  const token = typeof group?.token === 'string' ? group.token : ''
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('配置组令牌无效')
  const previewSlug = typeof group?.previewSlug === 'string' ? group.previewSlug : ''
  const previewHostnamePrefix =
    typeof group?.previewHostnamePrefix === 'string' &&
    configurationGroupUrlPrefixPattern.test(group.previewHostnamePrefix)
      ? group.previewHostnamePrefix
      : /^[a-f0-9]{32}$/.test(previewSlug)
        ? `p-${previewSlug}`
        : ''
  if (previewHostnamePrefix && typeof group?.directPreviewUrl === 'string') {
    const direct = new URL(group.directPreviewUrl)
    const control = new URL(origin)
    if (
      direct.protocol === 'https:' &&
      direct.hostname === `${previewHostnamePrefix}.${control.hostname}` &&
      direct.pathname === '/'
    ) {
      direct.search = ''
      direct.hash = ''
      return direct.href
    }
  }
  const expectedPath = `/s/${token}`
  const path = group?.sharePath === expectedPath ? group.sharePath : expectedPath
  const url = new URL(path, `${origin}/`)
  if (url.origin !== origin || url.pathname !== expectedPath) {
    throw new Error('配置组链接无效')
  }
  url.search = ''
  url.hash = ''
  return url.href
}

function punycodeDigit(codePoint) {
  if (codePoint >= 48 && codePoint <= 57) return codePoint - 22
  if (codePoint >= 65 && codePoint <= 90) return codePoint - 65
  if (codePoint >= 97 && codePoint <= 122) return codePoint - 97
  return 36
}

function adaptPunycodeBias(delta, pointCount, firstPoint) {
  let remainder = firstPoint ? Math.floor(delta / 700) : Math.floor(delta / 2)
  remainder += Math.floor(remainder / pointCount)
  let adjustment = 0
  while (remainder > 455) {
    remainder = Math.floor(remainder / 35)
    adjustment += 36
  }
  return adjustment + Math.floor((36 * remainder) / (remainder + 38))
}

function decodePunycodeLabel(label) {
  if (!label.startsWith('xn--')) return label
  const input = label.slice(4).toLowerCase()
  const output = []
  const delimiter = input.lastIndexOf('-')
  if (delimiter >= 0) {
    for (const character of input.slice(0, delimiter)) {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined || codePoint >= 128) return label
      output.push(codePoint)
    }
  }
  let cursor = delimiter >= 0 ? delimiter + 1 : 0
  let codePoint = 128
  let bias = 72
  let index = 0
  while (cursor < input.length) {
    const previousIndex = index
    let weight = 1
    for (let thresholdIndex = 36; ; thresholdIndex += 36) {
      if (cursor >= input.length) return label
      const digit = punycodeDigit(input.codePointAt(cursor))
      cursor += 1
      if (digit >= 36 || digit > Math.floor((Number.MAX_SAFE_INTEGER - index) / weight)) {
        return label
      }
      index += digit * weight
      const threshold =
        thresholdIndex <= bias ? 1 : thresholdIndex >= bias + 26 ? 26 : thresholdIndex - bias
      if (digit < threshold) break
      const multiplier = 36 - threshold
      if (weight > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)) return label
      weight *= multiplier
    }
    const pointCount = output.length + 1
    bias = adaptPunycodeBias(index - previousIndex, pointCount, previousIndex === 0)
    const increment = Math.floor(index / pointCount)
    if (increment > 0x10ffff - codePoint) return label
    codePoint += increment
    index %= pointCount
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return label
    output.splice(index, 0, codePoint)
    index += 1
  }
  try {
    return String.fromCodePoint(...output).normalize('NFC')
  } catch {
    return label
  }
}

export function configurationGroupShareDisplayUrl(controlOrigin, group, preferredPrefix = '') {
  const canonicalUrl = configurationGroupShareUrl(controlOrigin, group)
  const canonical = new URL(canonicalUrl)
  const control = new URL(controlOrigin)
  const canonicalPrefix =
    typeof group?.previewHostnamePrefix === 'string' ? group.previewHostnamePrefix : ''
  if (
    !canonicalPrefix ||
    canonical.hostname !== `${canonicalPrefix}.${control.hostname}` ||
    canonical.pathname !== '/'
  ) {
    return canonicalUrl
  }
  const normalizedPreferred = normalizedConfigurationGroupUrlPrefix(preferredPrefix)
  const displayPrefix =
    normalizedPreferred &&
    canonicalConfigurationGroupUrlPrefix(normalizedPreferred) === canonicalPrefix
      ? normalizedPreferred
      : decodePunycodeLabel(canonicalPrefix)
  return `${canonical.protocol}//${displayPrefix}.${control.hostname}/`
}
