import { createHash } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

import type { SiteBinding } from '@cuddly/contracts'
import type { NextFunction, Request, Response } from 'express'

export const RESOURCE_PROXY_BASE_PATH = '/__cuddly/resource-proxy'
export const RESOURCE_PROXY_BOOTSTRAP_PATH = '/__cuddly/resource-proxy.js'
export const RESOURCE_PROXY_TRANSFORM_VERSION_PARAM = '__cuddly_rpv'

const RESOURCE_PROXY_RULE_ID_PATTERN = '[a-f0-9]{64}'
const MAX_PATH_DECODE_ROUNDS = 6
const RESOURCE_PROXY_TRANSFORM_PROTOCOL_VERSION = 3
const MAX_RESOURCE_PROXY_TEXT_BYTES = 4 * 1024 * 1024

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-event-id',
  'pragma',
  'range',
  'user-agent',
])

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'accept-ranges',
  'age',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'vary',
])

const IPV4_NON_PUBLIC_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const

const IPV6_NON_PUBLIC_CIDRS = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const

interface ResourceProxyRule {
  id: string
  sourcePrefix: URL
  proxyPrefix: string
}

interface ResourceProxyClientRule {
  sourcePrefix: string
  proxyPrefix: string
}

export interface ResolvedResourceRequest {
  rule: ResourceProxyRule
  target: URL
}

export type ResourceProxyDnsLookup = (hostname: string) => Promise<LookupAddress[]>

export interface PublicHostResolution {
  hostname: string
  addresses: LookupAddress[]
  lookup: LookupFunction
}

export type ResourceProxyHostResolver = (hostname: string) => Promise<PublicHostResolution>

class UnsafeResourceProxyTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeResourceProxyTargetError'
  }
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function normalizeNetworkHostname(value: string): string {
  return stripIpv6Brackets(value.trim().toLowerCase().replace(/\.$/, ''))
}

function ipv4ToNumber(address: string): number | null {
  if (isIP(address) !== 4) return null
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0)
}

function ipv4InCidr(address: number, baseAddress: string, prefixLength: number): boolean {
  const base = ipv4ToNumber(baseAddress)
  if (base === null) return false
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  return (address & mask) >>> 0 === (base & mask) >>> 0
}

function isPublicIpv4Number(address: number): boolean {
  return !IPV4_NON_PUBLIC_CIDRS.some(([base, prefix]) => ipv4InCidr(address, base, prefix))
}

function ipv6ToBigInt(rawAddress: string): bigint | null {
  let address = stripIpv6Brackets(rawAddress).toLowerCase()
  if (isIP(address) !== 6) return null

  if (address.includes('.')) {
    const separator = address.lastIndexOf(':')
    const ipv4 = ipv4ToNumber(address.slice(separator + 1))
    if (separator < 0 || ipv4 === null) return null
    address = `${address.slice(0, separator)}:${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`
  }

  const halves = address.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left
  if (groups.length !== 8) return null

  let value = 0n
  for (const group of groups) {
    if (!/^[a-f0-9]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(`0x${group}`)
  }
  return value
}

function ipv6InCidr(address: bigint, baseAddress: string, prefixLength: number): boolean {
  const base = ipv6ToBigInt(baseAddress)
  if (base === null) return false
  const shift = BigInt(128 - prefixLength)
  return address >> shift === base >> shift
}

export function isPublicResourceAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress)
  const family = isIP(address)
  if (family === 4) {
    const numeric = ipv4ToNumber(address)
    return numeric !== null && isPublicIpv4Number(numeric)
  }
  if (family !== 6) return false

  const numeric = ipv6ToBigInt(address)
  if (numeric === null) return false
  if (numeric >> 32n === 0xffffn) {
    return isPublicIpv4Number(Number(numeric & 0xffffffffn))
  }
  if (!ipv6InCidr(numeric, '2000::', 3)) return false
  return !IPV6_NON_PUBLIC_CIDRS.some(([base, prefix]) => ipv6InCidr(numeric, base, prefix))
}

function isPublicDnsHostname(hostname: string): boolean {
  if (
    !hostname.includes('.') ||
    hostname.length > 253 ||
    ['.internal', '.invalid', '.local', '.localhost', '.onion', '.test'].some((suffix) =>
      hostname.endsWith(suffix)
    ) ||
    hostname.endsWith('.home.arpa')
  ) {
    return false
  }
  return hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

export function createPinnedResourceLookup(
  rawHostname: string,
  sourceAddresses: LookupAddress[]
): LookupFunction {
  const hostname = normalizeNetworkHostname(rawHostname)
  const addresses = sourceAddresses.map((item) => ({ ...item }))
  if (
    addresses.length === 0 ||
    addresses.some(
      (item) => item.family !== isIP(item.address) || !isPublicResourceAddress(item.address)
    )
  ) {
    throw new UnsafeResourceProxyTargetError('Resource proxy address set is not public')
  }

  return (requestedHostname, options, callback) => {
    const requested = normalizeNetworkHostname(requestedHostname)
    if (requested !== hostname) {
      queueMicrotask(() =>
        callback(
          lookupError('Resource proxy lookup hostname changed after validation', 'EAI_NONAME'),
          '',
          0
        )
      )
      return
    }

    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0
    const candidates = requestedFamily
      ? addresses.filter((item) => item.family === requestedFamily)
      : addresses
    if (candidates.length === 0) {
      queueMicrotask(() =>
        callback(
          lookupError('No validated address matches the requested family', 'EAI_ADDRFAMILY'),
          ''
        )
      )
      return
    }

    queueMicrotask(() => {
      if (options.all)
        callback(
          null,
          candidates.map((item) => ({ ...item }))
        )
      else callback(null, candidates[0]!.address, candidates[0]!.family)
    })
  }
}

const systemDnsLookup: ResourceProxyDnsLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true })

export async function resolvePublicResourceHost(
  rawHostname: string,
  lookup: ResourceProxyDnsLookup = systemDnsLookup
): Promise<PublicHostResolution> {
  const hostname = normalizeNetworkHostname(rawHostname)
  const literalFamily = isIP(hostname)
  let addresses: LookupAddress[]
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }]
  } else {
    if (!isPublicDnsHostname(hostname)) {
      throw new UnsafeResourceProxyTargetError('Resource proxy hostname is not public')
    }
    addresses = await lookup(hostname)
  }

  const uniqueAddresses = [
    ...new Map(addresses.map((item) => [`${item.family}:${item.address}`, { ...item }])).values(),
  ]
  if (
    uniqueAddresses.length === 0 ||
    uniqueAddresses.some(
      (item) => item.family !== isIP(item.address) || !isPublicResourceAddress(item.address)
    )
  ) {
    throw new UnsafeResourceProxyTargetError(
      'Resource proxy hostname resolved to a non-public address'
    )
  }
  return {
    hostname,
    addresses: uniqueAddresses,
    lookup: createPinnedResourceLookup(hostname, uniqueAddresses),
  }
}

export function decodeStableResourcePath(value: string): string | null {
  let decoded = value
  for (let round = 0; round <= MAX_PATH_DECODE_ROUNDS; round += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return null
    }
    if (next !== decoded) {
      if (round === MAX_PATH_DECODE_ROUNDS) return null
      decoded = next
      continue
    }
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.includes('%') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      decoded.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      return null
    }
    return decoded
  }
  return null
}

export function resourceProxyRuleId(prefix: string | URL): string {
  const sourcePrefix = prefix instanceof URL ? prefix : new URL(prefix)
  return createHash('sha256').update(sourcePrefix.href).digest('hex')
}

function validPrefix(value: string): ResourceProxyRule | null {
  try {
    const sourcePrefix = new URL(value)
    const hostname = normalizeNetworkHostname(sourcePrefix.hostname)
    const literalFamily = isIP(hostname)
    if (
      !['http:', 'https:'].includes(sourcePrefix.protocol) ||
      sourcePrefix.username ||
      sourcePrefix.password ||
      /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value) ||
      sourcePrefix.search ||
      sourcePrefix.hash ||
      value.includes('?') ||
      value.includes('#') ||
      !sourcePrefix.pathname.endsWith('/') ||
      !decodeStableResourcePath(sourcePrefix.pathname) ||
      (literalFamily ? !isPublicResourceAddress(hostname) : !isPublicDnsHostname(hostname))
    ) {
      return null
    }
    const id = resourceProxyRuleId(sourcePrefix)
    return {
      id,
      sourcePrefix,
      proxyPrefix: `${RESOURCE_PROXY_BASE_PATH}/${id}/`,
    }
  } catch {
    return null
  }
}

function resourceProxyRules(binding: SiteBinding): ResourceProxyRule[] {
  const rules = new Map<string, ResourceProxyRule>()
  for (const value of binding.resourceProxyPrefixes || []) {
    const rule = validPrefix(value)
    if (rule && !rules.has(rule.id)) rules.set(rule.id, rule)
  }
  return [...rules.values()].sort(
    (left, right) =>
      right.sourcePrefix.href.length - left.sourcePrefix.href.length ||
      left.sourcePrefix.href.localeCompare(right.sourcePrefix.href)
  )
}

function resourceProxyClientRules(binding: SiteBinding): ResourceProxyClientRule[] {
  return resourceProxyRules(binding).map((rule) => ({
    sourcePrefix: rule.sourcePrefix.href,
    proxyPrefix: rule.proxyPrefix,
  }))
}

function rewriteResourceProxyUrlWithRules(
  value: unknown,
  baseUrl: string | URL,
  proxyOrigin: string | URL,
  rules: readonly ResourceProxyClientRule[]
): string | null {
  try {
    const source = new URL(String(value), baseUrl)
    const rule = rules.find((candidate) => source.href.startsWith(candidate.sourcePrefix))
    if (!rule) return null
    const origin = new URL(proxyOrigin).origin
    const rawSuffix = source.href.slice(rule.sourcePrefix.length)
    const suffix = rawSuffix.startsWith('/') ? rawSuffix.slice(1) : rawSuffix
    return `${origin}${rule.proxyPrefix}${suffix}`
  } catch {
    return null
  }
}

function rewriteResourceProxyLiteralTextWithRules(
  value: string,
  proxyOrigin: string | URL,
  rules: readonly ResourceProxyClientRule[]
): string {
  let origin: string
  try {
    origin = new URL(proxyOrigin).origin
  } catch {
    return value
  }
  let rewritten = value
  for (const rule of rules) {
    const target = `${origin}${rule.proxyPrefix}`
    const sources = [rule.sourcePrefix]
    try {
      const source = new URL(rule.sourcePrefix)
      sources.push(`//${source.host}${source.pathname}`)
    } catch {
      // Rules are validated before reaching the runtime; keep malformed injected data inert.
    }
    const pattern = new RegExp(
      `(?:${sources.map((source) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/?`,
      'g'
    )
    rewritten = rewritten.replace(pattern, target)
  }
  return rewritten
}

export function rewriteResourceProxyUrl(
  value: string,
  baseUrl: string | URL,
  proxyOrigin: string | URL,
  binding: SiteBinding
): string | null {
  return rewriteResourceProxyUrlWithRules(
    value,
    baseUrl,
    proxyOrigin,
    resourceProxyClientRules(binding)
  )
}

export function resourceProxyTransformVersion(binding: SiteBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        protocolVersion: RESOURCE_PROXY_TRANSFORM_PROTOCOL_VERSION,
        rules: resourceProxyClientRules(binding),
      })
    )
    .digest('hex')
}

function isWithinPrefix(target: URL, prefix: URL): boolean {
  if (target.origin !== prefix.origin) return false
  const targetPath = decodeStableResourcePath(target.pathname)
  const prefixPath = decodeStableResourcePath(prefix.pathname)
  return Boolean(targetPath && prefixPath && targetPath.startsWith(prefixPath))
}

export function resolveResourceRequest(
  originalUrl: string,
  binding: SiteBinding
): ResolvedResourceRequest | null {
  const queryIndex = originalUrl.indexOf('?')
  const rawPath = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl
  const rawSearch = queryIndex >= 0 ? originalUrl.slice(queryIndex) : ''
  const match = new RegExp(
    `^${RESOURCE_PROXY_BASE_PATH.replaceAll('/', '\\/')}\/(${RESOURCE_PROXY_RULE_ID_PATTERN})(\/.*)?$`
  ).exec(rawPath)
  if (!match?.[1]) return null
  const rule = resourceProxyRules(binding).find((candidate) => candidate.id === match[1])
  if (!rule) return null

  const suffixPath = decodeStableResourcePath(match[2] || '/')
  if (!suffixPath) return null
  const target = new URL(rule.sourcePrefix)
  target.pathname = `${rule.sourcePrefix.pathname}${suffixPath.slice(1)}`
  target.search = rawSearch
  return isWithinPrefix(target, rule.sourcePrefix) ? { rule, target } : null
}

export function resourceProxyRequestHeaders(
  req: Pick<Request, 'headers'>,
  target: URL
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const normalized = name.toLowerCase()
    if (value !== undefined && REQUEST_HEADER_ALLOWLIST.has(normalized)) {
      headers[normalized] = value
    }
  }
  headers.host = target.host
  headers.origin = target.origin
  headers.referer = `${target.origin}/`
  headers['accept-encoding'] = 'identity'
  return headers
}

export function resourceProxyResponseHeaders(
  headers: IncomingHttpHeaders,
  res: Pick<Response, 'setHeader'>
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      res.setHeader(name, value)
    }
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function proxyRedirect(location: string, request: ResolvedResourceRequest): string | null {
  let target: URL
  try {
    target = new URL(location, request.target)
  } catch {
    return null
  }
  if (!isWithinPrefix(target, request.rule.sourcePrefix)) return null
  const suffix = target.href.slice(request.rule.sourcePrefix.href.length)
  return `${request.rule.proxyPrefix}${suffix}`
}

function installResourceProxyRuntime(
  windowObject: Record<string, any>,
  config: {
    proxyBasePath: string
    rules: ResourceProxyClientRule[]
    transformVersion: string
    versionParam: string
  },
  rewriteWithRules: typeof rewriteResourceProxyUrlWithRules,
  rewriteLiteralTextWithRules: typeof rewriteResourceProxyLiteralTextWithRules
): void {
  if (!config.rules.length || windowObject.__CUDDLY_RESOURCE_PROXY_INSTALLED__) return

  const safely = (install: () => void) => {
    try {
      install()
    } catch {
      // A locked browser prototype must not prevent the remaining APIs from being patched.
    }
  }
  const pageBase = () => String(windowObject.document?.baseURI || windowObject.location?.href || '')
  const rewrite = (value: unknown, baseUrl = pageBase()) =>
    rewriteWithRules(
      value,
      baseUrl,
      String(windowObject.location?.origin || pageBase()),
      config.rules
    )
  const rewriteLiteralText = (value: string): string =>
    rewriteLiteralTextWithRules(
      value,
      String(windowObject.location?.origin || pageBase()),
      config.rules
    )
  const isSpace = (character: string) =>
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'

  const rewriteSrcset = (value: unknown, baseUrl: string): string => {
    const source = String(value)
    let output = ''
    let cursor = 0
    while (cursor < source.length) {
      let urlStart = cursor
      while (urlStart < source.length && (isSpace(source[urlStart]!) || source[urlStart] === ',')) {
        urlStart += 1
      }
      output += source.slice(cursor, urlStart)
      if (urlStart >= source.length) break

      let tokenEnd = urlStart
      while (tokenEnd < source.length && !isSpace(source[tokenEnd]!)) tokenEnd += 1
      let urlEnd = tokenEnd
      while (urlEnd > urlStart && source[urlEnd - 1] === ',') urlEnd -= 1
      const originalUrl = source.slice(urlStart, urlEnd)
      output += rewrite(originalUrl, baseUrl) || originalUrl
      output += source.slice(urlEnd, tokenEnd)
      cursor = tokenEnd

      if (urlEnd < tokenEnd) continue
      let descriptorEnd = cursor
      let parentheses = 0
      while (descriptorEnd < source.length) {
        const character = source[descriptorEnd]!
        if (character === '(') parentheses += 1
        else if (character === ')' && parentheses > 0) parentheses -= 1
        else if (character === ',' && parentheses === 0) break
        descriptorEnd += 1
      }
      output += source.slice(cursor, descriptorEnd)
      cursor = descriptorEnd
      if (source[cursor] === ',') {
        output += ','
        cursor += 1
      }
    }
    return output
  }

  const versionMappedStylesheet = (original: string, mapped: string, baseUrl: string): string => {
    try {
      const source = new URL(original, baseUrl)
      if (!source.pathname.toLowerCase().endsWith('.css')) return mapped
      const target = new URL(mapped)
      target.searchParams.set(config.versionParam, config.transformVersion)
      return target.href
    } catch {
      return mapped
    }
  }

  const rewriteCssText = (value: unknown, baseUrl: string): string => {
    const source = String(value)
    const lowerSource = source.toLowerCase()
    let output = ''
    let copiedUntil = 0
    let cursor = 0
    while (cursor < source.length) {
      if (source.startsWith('/*', cursor)) {
        const end = source.indexOf('*/', cursor + 2)
        cursor = end === -1 ? source.length : end + 2
        continue
      }
      const character = source[cursor]!
      if (character === '"' || character === "'") {
        const quote = character
        const valueStart = cursor + 1
        let valueEnd = valueStart
        while (valueEnd < source.length) {
          if (source[valueEnd] === '\\') valueEnd += 2
          else if (source[valueEnd] === quote) break
          else valueEnd += 1
        }
        if (source[valueEnd] === quote && /@import\s*$/i.test(source.slice(0, cursor))) {
          const mapped = rewrite(source.slice(valueStart, valueEnd), baseUrl)
          if (mapped) {
            output += source.slice(copiedUntil, valueStart)
            output += versionMappedStylesheet(source.slice(valueStart, valueEnd), mapped, baseUrl)
            copiedUntil = valueEnd
          }
        }
        cursor = source[valueEnd] === quote ? valueEnd + 1 : source.length
        continue
      }
      const previous = cursor > 0 ? source[cursor - 1]! : ''
      if (
        lowerSource.slice(cursor, cursor + 3) !== 'url' ||
        (previous && /[a-z\d_-]/i.test(previous))
      ) {
        cursor += 1
        continue
      }

      let opening = cursor + 3
      while (opening < source.length && isSpace(source[opening]!)) opening += 1
      if (source[opening] !== '(') {
        cursor += 3
        continue
      }
      let valueStart = opening + 1
      while (valueStart < source.length && isSpace(source[valueStart]!)) valueStart += 1
      let valueEnd = valueStart
      let closing = -1
      const quote =
        source[valueStart] === '"' || source[valueStart] === "'" ? source[valueStart] : ''
      if (quote) {
        valueStart += 1
        valueEnd = valueStart
        while (valueEnd < source.length) {
          if (source[valueEnd] === '\\') valueEnd += 2
          else if (source[valueEnd] === quote) break
          else valueEnd += 1
        }
        if (source[valueEnd] !== quote) {
          cursor = opening + 1
          continue
        }
        closing = valueEnd + 1
        while (closing < source.length && isSpace(source[closing]!)) closing += 1
        if (source[closing] !== ')') {
          cursor = opening + 1
          continue
        }
      } else {
        closing = valueStart
        while (closing < source.length) {
          if (source[closing] === '\\') closing += 2
          else if (source[closing] === ')') break
          else closing += 1
        }
        if (source[closing] !== ')') {
          cursor = opening + 1
          continue
        }
        valueEnd = closing
        while (valueEnd > valueStart && isSpace(source[valueEnd - 1]!)) valueEnd -= 1
      }

      const originalUrl = source.slice(valueStart, valueEnd)
      const mapped = rewrite(originalUrl, baseUrl)
      if (mapped) {
        output += source.slice(copiedUntil, valueStart)
        output += /@import\s*$/i.test(source.slice(0, cursor))
          ? versionMappedStylesheet(originalUrl, mapped, baseUrl)
          : mapped
        copiedUntil = valueEnd
      }
      cursor = closing + 1
    }
    return output + source.slice(copiedUntil)
  }
  const rewriteCssSource = (value: unknown, baseUrl: string): string =>
    rewriteCssText(value, baseUrl)

  const versionStylesheet = (value: unknown, baseUrl: string): string | null => {
    try {
      const target = new URL(String(value), baseUrl)
      if (
        target.origin !== windowObject.location.origin ||
        !target.pathname.toLowerCase().endsWith('.css') ||
        target.pathname.startsWith(`${config.proxyBasePath}/`)
      ) {
        return null
      }
      target.searchParams.set(config.versionParam, config.transformVersion)
      return target.href
    } catch {
      return null
    }
  }

  const resourceAttributes: Record<string, readonly string[]> = {
    script: ['src', 'href'],
    img: ['src', 'srcset'],
    link: ['href', 'imagesrcset'],
    source: ['src', 'srcset'],
    video: ['src', 'poster'],
    audio: ['src'],
    iframe: ['src', 'srcdoc'],
    object: ['data'],
    embed: ['src'],
    input: ['src'],
    track: ['src'],
    body: ['background'],
    table: ['background'],
    thead: ['background'],
    tbody: ['background'],
    tfoot: ['background'],
    tr: ['background'],
    td: ['background'],
    th: ['background'],
    image: ['href'],
    use: ['href'],
    feimage: ['href'],
  }
  const elementTag = (element: Record<string, unknown>): string =>
    String(element.localName || element.tagName || '').toLowerCase()
  const elementBase = (element: Record<string, unknown>): string =>
    String(element.baseURI || pageBase())
  const rewriteElementAttribute = (
    element: Record<string, unknown>,
    rawName: unknown,
    value: unknown
  ): string => {
    const name = String(rawName).toLowerCase().split(':').pop() || ''
    const original = String(value)
    const baseUrl = elementBase(element)
    if (name === 'style') return rewriteCssSource(original, baseUrl)
    const tag = elementTag(element)
    if (!resourceAttributes[tag]?.includes(name)) return original
    if (tag === 'iframe' && name === 'srcdoc') return rewriteLiteralText(original)
    if (name === 'srcset' || name === 'imagesrcset') {
      return rewriteSrcset(original, baseUrl)
    }
    const mapped = rewrite(original, baseUrl)
    if (mapped) {
      return tag === 'link' && name === 'href'
        ? versionMappedStylesheet(original, mapped, baseUrl)
        : mapped
    }
    if (tag === 'link' && name === 'href') {
      return versionStylesheet(original, baseUrl) || original
    }
    return original
  }

  safely(() => {
    const originalFetch = windowObject.fetch
    if (typeof originalFetch !== 'function') return
    windowObject.fetch = function (input: unknown, init: Record<string, unknown> | undefined) {
      const RequestConstructor = windowObject.Request
      const request: any =
        typeof RequestConstructor === 'function' && input instanceof RequestConstructor
          ? input
          : null
      const method = String(init?.method || request?.method || 'GET').toUpperCase()
      const mapped =
        method === 'GET' || method === 'HEAD'
          ? rewrite(request ? request.url : input instanceof URL ? input.href : input)
          : null
      if (!mapped) return originalFetch.call(this, input, init)
      const nextInit = Object.assign({}, init || {}, { credentials: 'omit' })
      return request
        ? originalFetch.call(this, new RequestConstructor(mapped, request), nextInit)
        : originalFetch.call(this, mapped, nextInit)
    }
  })

  safely(() => {
    const XMLHttpRequestConstructor = windowObject.XMLHttpRequest
    if (typeof XMLHttpRequestConstructor !== 'function') return
    const originalOpen = XMLHttpRequestConstructor.prototype.open
    XMLHttpRequestConstructor.prototype.open = function (
      method: unknown,
      url: unknown,
      ...rest: unknown[]
    ) {
      const normalizedMethod = String(method || 'GET').toUpperCase()
      const mapped = normalizedMethod === 'GET' || normalizedMethod === 'HEAD' ? rewrite(url) : null
      return originalOpen.call(this, method, mapped || url, ...rest)
    }
  })

  safely(() => {
    const ElementConstructor = windowObject.Element
    if (typeof ElementConstructor !== 'function') return
    const prototype = ElementConstructor.prototype
    const originalSetAttribute = prototype.setAttribute
    if (typeof originalSetAttribute === 'function') {
      prototype.setAttribute = function (name: unknown, value: unknown) {
        return originalSetAttribute.call(this, name, rewriteElementAttribute(this, name, value))
      }
    }
    const originalSetAttributeNs = prototype.setAttributeNS
    if (typeof originalSetAttributeNs === 'function') {
      prototype.setAttributeNS = function (namespace: unknown, name: unknown, value: unknown) {
        return originalSetAttributeNs.call(
          this,
          namespace,
          name,
          rewriteElementAttribute(this, name, value)
        )
      }
    }
  })

  const findPropertyDescriptor = (prototype: object, property: string) => {
    let candidate: object | null = prototype
    while (candidate) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, property)
      if (descriptor) return descriptor
      candidate = Object.getPrototypeOf(candidate)
    }
    return null
  }
  const patchedProperties = new WeakMap<object, Set<string>>()
  const patchElementProperty = (constructorName: string, property: string) => {
    safely(() => {
      const Constructor = windowObject[constructorName]
      if (typeof Constructor !== 'function' || !Constructor.prototype) return
      const prototype = Constructor.prototype as object
      let properties = patchedProperties.get(prototype)
      if (!properties) {
        properties = new Set<string>()
        patchedProperties.set(prototype, properties)
      }
      if (properties.has(property)) return
      const descriptor = findPropertyDescriptor(prototype, property)
      const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, property)
      if (!descriptor?.set || (ownDescriptor && !ownDescriptor.configurable)) return
      Object.defineProperty(prototype, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get
          ? function (this: unknown) {
              return descriptor.get!.call(this)
            }
          : undefined,
        set: function (value: unknown) {
          descriptor.set!.call(this, rewriteElementAttribute(this, property, value))
        },
      })
      properties.add(property)
    })
  }
  const propertyTargets: Array<[string, readonly string[]]> = [
    ['HTMLScriptElement', ['src']],
    ['HTMLImageElement', ['src', 'srcset']],
    ['HTMLLinkElement', ['href', 'imagesrcset']],
    ['HTMLSourceElement', ['src', 'srcset']],
    ['HTMLVideoElement', ['src', 'poster']],
    ['HTMLAudioElement', ['src']],
    ['HTMLIFrameElement', ['src']],
    ['HTMLObjectElement', ['data']],
    ['HTMLEmbedElement', ['src']],
    ['HTMLInputElement', ['src']],
    ['HTMLTrackElement', ['src']],
    ['HTMLBodyElement', ['background']],
    ['HTMLTableElement', ['background']],
    ['HTMLTableSectionElement', ['background']],
    ['HTMLTableRowElement', ['background']],
    ['HTMLTableCellElement', ['background']],
    ['SVGImageElement', ['href']],
    ['SVGUseElement', ['href']],
    ['SVGFEImageElement', ['href']],
    ['SVGScriptElement', ['href']],
  ]
  for (const [constructorName, properties] of propertyTargets) {
    for (const property of properties) patchElementProperty(constructorName, property)
  }

  safely(() => {
    const CssStyleDeclaration = windowObject.CSSStyleDeclaration
    if (typeof CssStyleDeclaration !== 'function') return
    const prototype = CssStyleDeclaration.prototype
    const originalSetProperty = prototype.setProperty
    const originalGetPropertyValue = prototype.getPropertyValue
    const declarationBase = (declaration: Record<string, unknown>): string =>
      String(
        (
          (declaration.parentRule as Record<string, unknown> | undefined)?.parentStyleSheet as
            Record<string, unknown> | undefined
        )?.href || pageBase()
      )
    if (typeof originalSetProperty === 'function') {
      prototype.setProperty = function (property: unknown, value: unknown, priority: unknown) {
        return originalSetProperty.call(
          this,
          property,
          typeof value === 'string'
            ? rewriteCssText(value, declarationBase(this as Record<string, unknown>))
            : value,
          priority
        )
      }
    }
    const descriptor = findPropertyDescriptor(prototype, 'cssText')
    const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, 'cssText')
    if (descriptor?.set && (!ownDescriptor || ownDescriptor.configurable)) {
      Object.defineProperty(prototype, 'cssText', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get
          ? function (this: unknown) {
              return descriptor.get!.call(this)
            }
          : undefined,
        set: function (value: unknown) {
          descriptor.set!.call(
            this,
            typeof value === 'string'
              ? rewriteCssSource(value, declarationBase(this as Record<string, unknown>))
              : value
          )
        },
      })
    }

    if (
      typeof originalSetProperty !== 'function' ||
      typeof originalGetPropertyValue !== 'function'
    ) {
      return
    }
    const urlStyleProperties: Array<[string, string]> = [
      ['background', 'background'],
      ['backgroundImage', 'background-image'],
      ['borderImage', 'border-image'],
      ['borderImageSource', 'border-image-source'],
      ['listStyle', 'list-style'],
      ['listStyleImage', 'list-style-image'],
      ['mask', 'mask'],
      ['maskImage', 'mask-image'],
      ['maskBorder', 'mask-border'],
      ['maskBorderSource', 'mask-border-source'],
      ['cursor', 'cursor'],
      ['content', 'content'],
      ['filter', 'filter'],
      ['backdropFilter', 'backdrop-filter'],
      ['clipPath', 'clip-path'],
      ['shapeOutside', 'shape-outside'],
      ['offsetPath', 'offset-path'],
      ['fill', 'fill'],
      ['stroke', 'stroke'],
      ['marker', 'marker'],
      ['markerStart', 'marker-start'],
      ['markerMid', 'marker-mid'],
      ['markerEnd', 'marker-end'],
      ['src', 'src'],
      ['WebkitMask', '-webkit-mask'],
      ['WebkitMaskImage', '-webkit-mask-image'],
      ['WebkitMaskBoxImage', '-webkit-mask-box-image'],
      ['WebkitMaskBoxImageSource', '-webkit-mask-box-image-source'],
      ['webkitMask', '-webkit-mask'],
      ['webkitMaskImage', '-webkit-mask-image'],
      ['webkitMaskBoxImage', '-webkit-mask-box-image'],
      ['webkitMaskBoxImageSource', '-webkit-mask-box-image-source'],
    ]
    for (const [property, cssProperty] of urlStyleProperties) {
      safely(() => {
        const descriptor = findPropertyDescriptor(prototype, property)
        const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, property)
        if (ownDescriptor && !ownDescriptor.configurable) return
        Object.defineProperty(prototype, property, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: descriptor?.get
            ? function (this: unknown) {
                return descriptor.get!.call(this)
              }
            : function (this: unknown) {
                return originalGetPropertyValue.call(this, cssProperty)
              },
          set: function (value: unknown) {
            const rewritten =
              typeof value === 'string'
                ? rewriteCssText(value, declarationBase(this as Record<string, unknown>))
                : value
            if (descriptor?.set) return descriptor.set.call(this, rewritten)
            return originalSetProperty.call(this, cssProperty, rewritten, '')
          },
        })
      })
    }
  })

  const styleSheetBase = (sheet: Record<string, unknown>): string =>
    String(
      sheet.href ||
        (sheet.parentStyleSheet as Record<string, unknown> | undefined)?.href ||
        (
          (sheet.parentRule as Record<string, unknown> | undefined)?.parentStyleSheet as
            Record<string, unknown> | undefined
        )?.href ||
        (sheet.ownerNode as Record<string, unknown> | undefined)?.baseURI ||
        pageBase()
    )
  const patchCssRuleMethod = (constructorName: string, method: string, textArgument: number) => {
    safely(() => {
      const Constructor = windowObject[constructorName]
      const original = Constructor?.prototype?.[method]
      if (typeof original !== 'function') return
      Constructor.prototype[method] = function (...args: unknown[]) {
        if (typeof args[textArgument] === 'string') {
          args[textArgument] = rewriteCssSource(
            args[textArgument],
            styleSheetBase(this as Record<string, unknown>)
          )
        }
        return original.apply(this, args)
      }
    })
  }
  patchCssRuleMethod('CSSStyleSheet', 'insertRule', 0)
  patchCssRuleMethod('CSSStyleSheet', 'addRule', 1)
  patchCssRuleMethod('CSSStyleSheet', 'replace', 0)
  patchCssRuleMethod('CSSStyleSheet', 'replaceSync', 0)
  patchCssRuleMethod('CSSGroupingRule', 'insertRule', 0)
  patchCssRuleMethod('CSSKeyframesRule', 'appendRule', 0)
  patchCssRuleMethod('CSSKeyframesRule', 'insertRule', 0)

  const patchStringProperty = (
    constructorName: string,
    property: string,
    transform: (value: string, receiver: Record<string, unknown>) => string
  ) => {
    safely(() => {
      const Constructor = windowObject[constructorName]
      if (typeof Constructor !== 'function' || !Constructor.prototype) return
      const prototype = Constructor.prototype as object
      const descriptor = findPropertyDescriptor(prototype, property)
      const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, property)
      if (!descriptor?.set || (ownDescriptor && !ownDescriptor.configurable)) return
      Object.defineProperty(prototype, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get
          ? function (this: unknown) {
              return descriptor.get!.call(this)
            }
          : undefined,
        set: function (value: unknown) {
          descriptor.set!.call(
            this,
            typeof value === 'string' ? transform(value, this as Record<string, unknown>) : value
          )
        },
      })
    })
  }
  const rewriteMarkup = (value: string, _receiver?: Record<string, unknown>): string =>
    rewriteLiteralText(value)
  patchStringProperty('Element', 'innerHTML', rewriteMarkup)
  patchStringProperty('Element', 'outerHTML', rewriteMarkup)
  patchStringProperty('ShadowRoot', 'innerHTML', rewriteMarkup)
  patchStringProperty('HTMLIFrameElement', 'srcdoc', rewriteMarkup)
  patchStringProperty('HTMLStyleElement', 'innerHTML', (value, receiver) =>
    rewriteCssSource(value, elementBase(receiver))
  )
  patchStringProperty('HTMLStyleElement', 'textContent', (value, receiver) =>
    rewriteCssSource(value, elementBase(receiver))
  )
  patchStringProperty('HTMLStyleElement', 'innerText', (value, receiver) =>
    rewriteCssSource(value, elementBase(receiver))
  )

  const patchStringMethodArgument = (
    constructorName: string,
    method: string,
    argumentIndex: number,
    transform: (value: string, receiver: Record<string, unknown>) => string = rewriteMarkup
  ) => {
    safely(() => {
      const Constructor = windowObject[constructorName]
      const original = Constructor?.prototype?.[method]
      if (typeof original !== 'function') return
      Constructor.prototype[method] = function (...args: unknown[]) {
        if (typeof args[argumentIndex] === 'string') {
          args[argumentIndex] = transform(args[argumentIndex], this as Record<string, unknown>)
        }
        return original.apply(this, args)
      }
    })
  }
  patchStringMethodArgument('Element', 'insertAdjacentHTML', 1)
  patchStringMethodArgument('Range', 'createContextualFragment', 0)
  patchStringMethodArgument('DOMParser', 'parseFromString', 0)
  patchStringMethodArgument('Element', 'setHTMLUnsafe', 0)
  patchStringMethodArgument('ShadowRoot', 'setHTMLUnsafe', 0)

  for (const method of ['write', 'writeln']) {
    safely(() => {
      const DocumentConstructor = windowObject.Document
      const original = DocumentConstructor?.prototype?.[method]
      if (typeof original !== 'function') return
      DocumentConstructor.prototype[method] = function (...args: unknown[]) {
        return original.apply(
          this,
          args.map((value) => (typeof value === 'string' ? rewriteMarkup(value) : value))
        )
      }
    })
  }

  safely(() => {
    const Original = windowObject.FontFace
    if (typeof Original !== 'function') return
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      if (!new.target) throw new TypeError('FontFace constructor must be called with new')
      if (typeof args[1] === 'string') args[1] = rewriteCssSource(args[1], pageBase())
      return Reflect.construct(Original, args, new.target === Wrapped ? Original : new.target)
    }
    Object.setPrototypeOf(Wrapped, Original)
    Wrapped.prototype = Original.prototype
    windowObject.FontFace = Wrapped
  })

  for (const method of ['set', 'append']) {
    safely(() => {
      const StylePropertyMap = windowObject.StylePropertyMap
      const original = StylePropertyMap?.prototype?.[method]
      if (typeof original !== 'function') return
      StylePropertyMap.prototype[method] = function (...args: unknown[]) {
        for (let index = 1; index < args.length; index += 1) {
          if (typeof args[index] === 'string') {
            args[index] = rewriteCssText(args[index], pageBase())
          }
        }
        return original.apply(this, args)
      }
    })
  }

  const patchUrlMethod = (constructorName: string, method: string, argumentIndex = 0) => {
    safely(() => {
      const Constructor = windowObject[constructorName]
      const original = Constructor?.prototype?.[method]
      if (typeof original !== 'function') return
      Constructor.prototype[method] = function (...args: unknown[]) {
        if (typeof args[argumentIndex] === 'string' || args[argumentIndex] instanceof URL) {
          args[argumentIndex] = rewrite(args[argumentIndex]) || args[argumentIndex]
        }
        return original.apply(this, args)
      }
    })
  }
  patchUrlMethod('ServiceWorkerContainer', 'register')
  patchUrlMethod('Worklet', 'addModule')

  const keyframeUrlProperties = new Set([
    'background',
    'backgroundImage',
    'background-image',
    'borderImage',
    'border-image',
    'borderImageSource',
    'border-image-source',
    'listStyle',
    'list-style',
    'listStyleImage',
    'list-style-image',
    'mask',
    'maskImage',
    'mask-image',
    'maskBorder',
    'mask-border',
    'maskBorderSource',
    'mask-border-source',
    'cursor',
    'content',
    'filter',
    'backdropFilter',
    'backdrop-filter',
    'clipPath',
    'clip-path',
    'shapeOutside',
    'shape-outside',
    'offsetPath',
    'offset-path',
    'fill',
    'stroke',
    'marker',
    'markerStart',
    'marker-start',
    'markerMid',
    'marker-mid',
    'markerEnd',
    'marker-end',
    'WebkitMask',
    'WebkitMaskImage',
    'WebkitMaskBoxImage',
    'WebkitMaskBoxImageSource',
    'webkitMask',
    'webkitMaskImage',
    'webkitMaskBoxImage',
    'webkitMaskBoxImageSource',
  ])
  const rewriteKeyframes = (keyframes: unknown): unknown => {
    const rewriteFrame = (frame: unknown): unknown => {
      if (!frame || typeof frame !== 'object') return frame
      let rewritten: Record<string, unknown> | null = null
      for (const property of Object.keys(frame)) {
        if (!keyframeUrlProperties.has(property)) continue
        const current = (frame as Record<string, unknown>)[property]
        let next = current
        let changed = false
        if (Array.isArray(current)) {
          const mapped = current.map((value: unknown) =>
            typeof value === 'string' ? rewriteCssText(value, pageBase()) : value
          )
          next = mapped
          changed = mapped.some((value: unknown, index: number) => value !== current[index])
        } else if (typeof current === 'string') {
          next = rewriteCssText(current, pageBase())
          changed = next !== current
        }
        if (changed) {
          rewritten ||= { ...(frame as Record<string, unknown>) }
          rewritten[property] = next
        }
      }
      return rewritten || frame
    }
    return Array.isArray(keyframes) ? keyframes.map(rewriteFrame) : rewriteFrame(keyframes)
  }
  safely(() => {
    const ElementConstructor = windowObject.Element
    const originalAnimate = ElementConstructor?.prototype?.animate
    if (typeof originalAnimate !== 'function') return
    ElementConstructor.prototype.animate = function (keyframes: unknown, options: unknown) {
      return originalAnimate.call(this, rewriteKeyframes(keyframes), options)
    }
  })

  safely(() => {
    const Original = windowObject.KeyframeEffect
    if (typeof Original !== 'function') return
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      if (!new.target) throw new TypeError('KeyframeEffect constructor must be called with new')
      if (args.length > 1) args[1] = rewriteKeyframes(args[1])
      return Reflect.construct(Original, args, new.target === Wrapped ? Original : new.target)
    }
    Object.setPrototypeOf(Wrapped, Original)
    Wrapped.prototype = Original.prototype
    windowObject.KeyframeEffect = Wrapped
  })

  const patchUrlConstructor = (name: 'Worker' | 'SharedWorker' | 'EventSource' | 'Audio') => {
    safely(() => {
      const Original = windowObject[name]
      if (typeof Original !== 'function') return
      const Wrapped = function (this: unknown, ...args: unknown[]) {
        if (!new.target) throw new TypeError(`${name} constructor must be called with new`)
        const mapped = rewrite(args[0])
        if (mapped) args[0] = mapped
        return Reflect.construct(Original, args, new.target === Wrapped ? Original : new.target)
      }
      Object.setPrototypeOf(Wrapped, Original)
      Wrapped.prototype = Original.prototype
      windowObject[name] = Wrapped
    })
  }
  patchUrlConstructor('Worker')
  patchUrlConstructor('SharedWorker')
  patchUrlConstructor('EventSource')
  patchUrlConstructor('Audio')

  windowObject.__CUDDLY_RESOURCE_PROXY_INSTALLED__ = true
}

export function resourceProxyBootstrap(binding: SiteBinding): string {
  const payload = JSON.stringify({
    proxyBasePath: RESOURCE_PROXY_BASE_PATH,
    rules: resourceProxyClientRules(binding),
    transformVersion: resourceProxyTransformVersion(binding),
    versionParam: RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
  }).replaceAll('<', '\\u003c')
  return `(${installResourceProxyRuntime.toString()})(window,${payload},(${rewriteResourceProxyUrlWithRules.toString()}),(${rewriteResourceProxyLiteralTextWithRules.toString()}))`
}

type ResourceProxyTextKind = 'css' | 'manifest' | 'svg'

class ResourceProxyTransformError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ResourceProxyTransformError'
  }
}

function responseHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value || ''
}

function resourceProxyTextKind(
  target: URL,
  headers: IncomingHttpHeaders
): ResourceProxyTextKind | null {
  const contentType = responseHeaderValue(headers['content-type']).toLowerCase()
  const mime = contentType.split(';', 1)[0]!.trim()
  if (mime.includes('javascript') || mime === 'application/ecmascript') return null
  if (mime === 'text/css') return 'css'
  if (mime === 'image/svg+xml') return 'svg'
  if (mime === 'application/manifest+json') return 'manifest'
  if (
    target.pathname.toLowerCase().endsWith('.css') &&
    (!mime || mime === 'application/octet-stream')
  ) {
    return 'css'
  }
  if (
    target.pathname.toLowerCase().endsWith('.svg') &&
    (!mime || mime === 'application/octet-stream')
  ) {
    return 'svg'
  }
  if (
    target.pathname.toLowerCase().endsWith('.webmanifest') &&
    (!mime || mime === 'application/json' || mime === 'application/octet-stream')
  ) {
    return 'manifest'
  }
  return null
}

function likelyResourceProxyTextRequest(req: Request, target: URL): boolean {
  const path = target.pathname.toLowerCase()
  const accept = String(req.headers.accept || '').toLowerCase()
  return (
    path.endsWith('.css') ||
    path.endsWith('.svg') ||
    path.endsWith('.webmanifest') ||
    accept.includes('text/css') ||
    accept.includes('image/svg+xml') ||
    accept.includes('application/manifest+json')
  )
}

function resourceProxyRequestOrigin(req: Request): string {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '')
    .split(',', 1)[0]!
    .trim()
    .toLowerCase()
  const protocol = ['http', 'https'].includes(forwardedProtocol) ? forwardedProtocol : req.protocol
  return new URL(`${protocol}://${req.get('host') || req.hostname}`).origin
}

function readResourceProxyBody(response: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_RESOURCE_PROXY_TEXT_BYTES) {
        response.destroy(new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_TOO_LARGE'))
        return
      }
      chunks.push(buffer)
    })
    response.once('end', () => resolve(Buffer.concat(chunks, size)))
    response.once('error', reject)
    response.once('aborted', () =>
      reject(new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_UPSTREAM_ABORTED'))
    )
  })
}

function decodeResourceProxyBody(body: Buffer, headers: IncomingHttpHeaders): Buffer {
  const encoding = responseHeaderValue(headers['content-encoding']).trim().toLowerCase()
  if (encoding.includes(',')) {
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_ENCODING_UNSUPPORTED')
  }
  let decoded: Buffer
  const options = { maxOutputLength: MAX_RESOURCE_PROXY_TEXT_BYTES }
  try {
    if (!encoding || encoding === 'identity') decoded = body
    else if (encoding === 'gzip' || encoding === 'x-gzip') decoded = gunzipSync(body, options)
    else if (encoding === 'deflate') decoded = inflateSync(body, options)
    else if (encoding === 'br') decoded = brotliDecompressSync(body, options)
    else throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_ENCODING_UNSUPPORTED')
  } catch (error) {
    if (error instanceof ResourceProxyTransformError) throw error
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_DECODE_FAILED')
  }
  if (decoded.length > MAX_RESOURCE_PROXY_TEXT_BYTES) {
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_TOO_LARGE')
  }
  return decoded
}

function decodeResourceProxyText(body: Buffer, headers: IncomingHttpHeaders): string {
  const contentType = responseHeaderValue(headers['content-type'])
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]
  if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset.toLowerCase())) {
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_CHARSET_UNSUPPORTED')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_CHARSET_INVALID')
  }
}

function transformedVary(value: string | string[] | undefined): string | null {
  const entries = responseHeaderValue(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.toLowerCase() !== 'accept-encoding')
  return entries.length ? entries.join(', ') : null
}

function versionResourceProxyStylesheetUrl(
  value: string,
  baseUrl: string,
  proxyOrigin: string,
  transformVersion: string
): string {
  try {
    const target = new URL(value, baseUrl)
    if (
      target.origin !== new URL(proxyOrigin).origin ||
      !target.pathname.startsWith(`${RESOURCE_PROXY_BASE_PATH}/`) ||
      !target.pathname.toLowerCase().endsWith('.css')
    ) {
      return value
    }
    target.searchParams.set(RESOURCE_PROXY_TRANSFORM_VERSION_PARAM, transformVersion)
    return target.href
  } catch {
    return value
  }
}

function versionResourceProxyCssImports(
  css: string,
  baseUrl: string,
  proxyOrigin: string,
  transformVersion: string
): string {
  const directStrings = css.replace(
    /(@import\s+)(["'])([^"'\r\n]+)\2/gi,
    (_source, prefix: string, quote: string, url: string) =>
      `${prefix}${quote}${versionResourceProxyStylesheetUrl(
        url,
        baseUrl,
        proxyOrigin,
        transformVersion
      )}${quote}`
  )
  return directStrings.replace(
    /(@import\s+url\(\s*)(?:(["'])([^"'\r\n]+)\2|([^\s)]+))(\s*\))/gi,
    (
      _source,
      prefix: string,
      quote: string | undefined,
      quotedUrl: string | undefined,
      bareUrl: string | undefined,
      suffix: string
    ) => {
      const url = quotedUrl ?? bareUrl ?? ''
      const rewritten = versionResourceProxyStylesheetUrl(
        url,
        baseUrl,
        proxyOrigin,
        transformVersion
      )
      return `${prefix}${quote || ''}${rewritten}${quote || ''}${suffix}`
    }
  )
}

function resourceProxyTransformedResponseHeaders(
  headers: IncomingHttpHeaders,
  res: Response,
  body: Buffer
): void {
  const omitted = new Set([
    'accept-ranges',
    'cache-control',
    'content-encoding',
    'content-length',
    'content-range',
    'etag',
    'vary',
  ])
  for (const [name, value] of Object.entries(headers)) {
    if (
      value !== undefined &&
      RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase()) &&
      !omitted.has(name.toLowerCase())
    ) {
      res.setHeader(name, value)
    }
  }
  const vary = transformedVary(headers.vary)
  if (vary) res.setHeader('Vary', vary)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', body.length)
  res.setHeader('ETag', `"sha256:${createHash('sha256').update(body).digest('hex')}"`)
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

async function proxyTransformedResourceText(
  req: Request,
  res: Response,
  upstreamResponse: http.IncomingMessage,
  binding: SiteBinding,
  kind: ResourceProxyTextKind
): Promise<void> {
  if (upstreamResponse.statusCode === 206) {
    upstreamResponse.resume()
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_PARTIAL_RESPONSE')
  }
  const encoded = await readResourceProxyBody(upstreamResponse)
  const decoded = decodeResourceProxyBody(encoded, upstreamResponse.headers)
  const source = decodeResourceProxyText(decoded, upstreamResponse.headers)
  const proxyOrigin = resourceProxyRequestOrigin(req)
  let rewritten = rewriteResourceProxyLiteralTextWithRules(
    source,
    proxyOrigin,
    resourceProxyClientRules(binding)
  )
  if (kind === 'css') {
    rewritten = versionResourceProxyCssImports(
      rewritten,
      new URL(req.originalUrl, proxyOrigin).href,
      proxyOrigin,
      resourceProxyTransformVersion(binding)
    )
  }
  const body = Buffer.from(rewritten, 'utf8')
  if (body.length > MAX_RESOURCE_PROXY_TEXT_BYTES) {
    throw new ResourceProxyTransformError('RESOURCE_PROXY_TEXT_TOO_LARGE')
  }
  res.status(upstreamResponse.statusCode || 200)
  resourceProxyTransformedResponseHeaders(upstreamResponse.headers, res, body)
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

async function proxyResolvedResourceRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  resolved: ResolvedResourceRequest,
  resolveHost: ResourceProxyHostResolver,
  binding: SiteBinding
): Promise<void> {
  const publicHost = await resolveHost(resolved.target.hostname)
  const transport = resolved.target.protocol === 'http:' ? http : https
  const likelyText = likelyResourceProxyTextRequest(req, resolved.target)
  const headers = resourceProxyRequestHeaders(req, resolved.target)
  if (likelyText) {
    for (const name of [
      'if-match',
      'if-modified-since',
      'if-none-match',
      'if-range',
      'if-unmodified-since',
      'range',
    ]) {
      delete headers[name]
    }
  }
  const upstreamRequest = transport.request(
    resolved.target,
    {
      method: req.method === 'HEAD' && likelyText ? 'GET' : req.method,
      headers,
      lookup: publicHost.lookup,
    },
    (upstreamResponse) => {
      const location = upstreamResponse.headers.location
      if (location) {
        const rewritten = proxyRedirect(location, resolved)
        if (!rewritten) {
          upstreamResponse.resume()
          res.status(502).json({ code: 'RESOURCE_PROXY_REDIRECT_OUTSIDE_PREFIX' })
          return
        }
        res.setHeader('Location', rewritten)
      }
      const textKind = resourceProxyTextKind(resolved.target, upstreamResponse.headers)
      if (req.method === 'HEAD' && !likelyText && textKind && upstreamResponse.statusCode === 200) {
        const sanitized = { ...upstreamResponse.headers }
        delete sanitized['accept-ranges']
        delete sanitized['cache-control']
        delete sanitized['content-encoding']
        delete sanitized['content-length']
        delete sanitized['content-range']
        delete sanitized.etag
        res.status(200)
        resourceProxyResponseHeaders(sanitized, res)
        res.setHeader('Cache-Control', 'no-store')
        upstreamResponse.resume()
        res.end()
        return
      }
      if (textKind && upstreamResponse.statusCode === 200) {
        void proxyTransformedResourceText(req, res, upstreamResponse, binding, textKind).catch(
          (error: unknown) => {
            if (error instanceof ResourceProxyTransformError && !res.headersSent) {
              res.status(502).json({ code: error.code })
              return
            }
            next(error)
          }
        )
        return
      }
      if (textKind && upstreamResponse.statusCode === 206) {
        upstreamResponse.resume()
        res.status(502).json({ code: 'RESOURCE_PROXY_TEXT_PARTIAL_RESPONSE' })
        return
      }
      if (req.method === 'HEAD' && likelyText) {
        res.status(upstreamResponse.statusCode || 502)
        const sanitized = { ...upstreamResponse.headers }
        if (textKind) {
          delete sanitized['accept-ranges']
          delete sanitized['content-encoding']
          delete sanitized['content-length']
          delete sanitized['content-range']
          delete sanitized.etag
        }
        resourceProxyResponseHeaders(sanitized, res)
        upstreamResponse.resume()
        res.end()
        return
      }
      res.status(upstreamResponse.statusCode || 502)
      resourceProxyResponseHeaders(upstreamResponse.headers, res)
      upstreamResponse.on('error', next)
      upstreamResponse.pipe(res)
    }
  )
  const acceptsEventStream = String(req.headers.accept || '')
    .toLowerCase()
    .includes('text/event-stream')
  if (!acceptsEventStream) {
    upstreamRequest.setTimeout(30_000, () => {
      upstreamRequest.destroy(new Error('Resource proxy upstream timed out'))
    })
  }
  upstreamRequest.on('error', next)
  req.on('aborted', () => upstreamRequest.destroy())
  upstreamRequest.end()
}

export function proxyResourceRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  binding: SiteBinding,
  resolveHost: ResourceProxyHostResolver = resolvePublicResourceHost
): void {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.status(405).setHeader('Allow', 'GET, HEAD').json({ code: 'METHOD_NOT_ALLOWED' })
    return
  }
  const resolved = resolveResourceRequest(req.originalUrl, binding)
  if (!resolved) {
    res.status(404).json({ code: 'RESOURCE_PROXY_ROUTE_NOT_FOUND' })
    return
  }

  void proxyResolvedResourceRequest(req, res, next, resolved, resolveHost, binding).catch(
    (error: unknown) => {
      if (error instanceof UnsafeResourceProxyTargetError && !res.headersSent) {
        res.status(502).json({ code: 'RESOURCE_PROXY_UPSTREAM_NOT_PUBLIC' })
        return
      }
      next(error)
    }
  )
}
