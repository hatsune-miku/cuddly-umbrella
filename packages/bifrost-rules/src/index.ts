export interface HostRewrite {
  upstreamHost: string
  proxyHost: string
}

const HOSTNAME_TOKEN_CHARACTER = /[a-z0-9._-]/i

function rewriteHostToken(value: string, upstreamHost: string, proxyHost: string): string {
  if (!upstreamHost || upstreamHost === proxyHost) return value

  let cursor = 0
  let rewritten = ''
  while (cursor < value.length) {
    const match = value.indexOf(upstreamHost, cursor)
    if (match === -1) return `${rewritten}${value.slice(cursor)}`

    const before = match > 0 ? value[match - 1] : ''
    const afterIndex = match + upstreamHost.length
    const after = afterIndex < value.length ? value[afterIndex] : ''
    if (
      (!before || !HOSTNAME_TOKEN_CHARACTER.test(before)) &&
      (!after || !HOSTNAME_TOKEN_CHARACTER.test(after))
    ) {
      rewritten += `${value.slice(cursor, match)}${proxyHost}`
      cursor = afterIndex
      continue
    }

    rewritten += value.slice(cursor, afterIndex)
    cursor = afterIndex
  }
  return rewritten
}

export function rewriteCookieDomain(cookie: string, domain: string): string {
  const stripped = cookie.replace(/;\s*Domain=[^;]*/i, '')
  return domain ? `${stripped}; Domain=${domain}` : stripped
}

export function rewriteSetCookieHeaders(
  header: string | string[] | undefined,
  domain: string
): string[] | undefined {
  if (!header) return undefined
  const cookies = Array.isArray(header) ? header : [header]
  return cookies.map((cookie) => rewriteCookieDomain(cookie, domain))
}

export function rewriteHosts(value: string, rewrites: HostRewrite[]): string {
  let result = value
  for (const rewrite of rewrites) {
    result = rewriteHostToken(result, rewrite.upstreamHost, rewrite.proxyHost)
  }
  return result
}

export function rewriteLocationHeader(
  location: string | undefined,
  rewrites: HostRewrite[]
): string | undefined {
  return location ? rewriteHosts(location, rewrites) : undefined
}
