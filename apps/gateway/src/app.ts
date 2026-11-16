import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { FileArtifactStore } from '@cuddly/artifact-store'
import { manifestFile } from '@cuddly/build-adapters'
import { configurationGroupHostnamePrefixFromHostname } from '@cuddly/contracts'
import type {
  Artifact,
  ArtifactManifestFile,
  ConfigurationGroup,
  EnvironmentRecord,
  PreviewSession,
  SiteBinding,
} from '@cuddly/contracts'
import type { CuddlyStore } from '@cuddly/db'
import { publicIdentityData } from '@cuddly/db'
import { PRODUCT_NAME } from '@cuddly/product'
import {
  isExpectedStaticPath,
  isHtmlNavigation,
  isBackendProxyRequest,
  isSupportedStaticSiteAdapter,
  resolveArtifactFile,
  resolveArtifactNavigationEntry,
} from '@cuddly/site-adapters'
import express, { type NextFunction, type Request, type Response } from 'express'

import {
  applyHotModuleOverlay,
  hotModuleOverrideFromArtifact,
  type HotModuleOverride,
} from './hot-module'
import {
  createBufferedJsonUpstreamProxy,
  createBufferedTextUpstreamProxy,
  createUpstreamProxy,
  type UpstreamProxyOptions,
} from './proxy'
import {
  proxyResourceRequest,
  RESOURCE_PROXY_BASE_PATH,
  RESOURCE_PROXY_BOOTSTRAP_PATH,
  RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
  rewriteResourceProxyUrl,
  resourceProxyBootstrap,
  resourceProxyTransformVersion,
  type ResourceProxyHostResolver,
} from './resource-proxy'

interface GatewayRuntimeOptions {
  allowedHosts: string[]
  proxy: UpstreamProxyOptions
}

export interface GatewayOptions {
  store: CuddlyStore
  artifactStore: FileArtifactStore
  environmentSlug: string
  targetId: string
  allowedHosts: string[]
  hookPath: string | null
  proxy: UpstreamProxyOptions
  internalProxyUrl?: URL | null
  resourceProxyHostResolver?: ResourceProxyHostResolver
  resolveRuntimeOptions?: () => Promise<GatewayRuntimeOptions>
  previewBaseDomain?: string
}

class InternalProxyNotConfiguredError extends Error {
  constructor(environmentSlug: string) {
    super(`Environment ${environmentSlug} requires the internal proxy, but it is not configured`)
    this.name = 'InternalProxyNotConfiguredError'
  }
}

export function resourceProxyBindingForEnvironment(
  binding: SiteBinding,
  environment: EnvironmentRecord
): SiteBinding {
  const resourceProxyPrefixes = [
    ...new Set([
      ...(binding.resourceProxyPrefixes || []),
      ...(environment.resourceProxyPrefixes || []),
    ]),
  ]
  if (
    resourceProxyPrefixes.length === binding.resourceProxyPrefixes.length &&
    resourceProxyPrefixes.every((prefix, index) => prefix === binding.resourceProxyPrefixes[index])
  ) {
    return binding
  }
  return { ...binding, resourceProxyPrefixes }
}

function parseRange(
  value: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return null
  let start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd))
  let end = rawEnd ? Number(rawEnd) : size - 1
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null
  }
  end = Math.min(end, size - 1)
  return { start, end }
}

function cacheControl(file: ArtifactManifestFile, environmentEntry: boolean): string {
  if (environmentEntry || file.cacheClass === 'html') return 'no-cache, must-revalidate'
  if (file.cacheClass === 'immutable') return 'public, max-age=31536000, immutable'
  return 'public, max-age=86400'
}

const RESOURCE_PROXY_INJECTION_ATTRIBUTE = 'data-cuddly-resource-proxy'
const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
])

interface HtmlTag {
  start: number
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
  source: string
}

interface HtmlInjectionPoints {
  headOpenEnd: number | null
  headCloseStart: number | null
  bodyOpenStart: number | null
  firstScriptStart: number | null
  hasResourceProxyScript: boolean
}

function htmlTagEnd(html: string, start: number): number | null {
  let quote: '"' | "'" | null = null
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index + 1
  }
  return null
}

function nextHtmlTag(html: string, from: number): HtmlTag | null {
  let cursor = from
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    if (start === -1) return null
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4)
      if (commentEnd === -1) return null
      cursor = commentEnd + 3
      continue
    }
    if (html.startsWith('<![CDATA[', start)) {
      const cdataEnd = html.indexOf(']]>', start + 9)
      if (cdataEnd === -1) return null
      cursor = cdataEnd + 3
      continue
    }

    const end = htmlTagEnd(html, start)
    if (end === null) return null
    const source = html.slice(start, end)
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/.exec(source)
    if (!match?.[2]) {
      cursor = end
      continue
    }
    return {
      start,
      end,
      name: match[2].toLowerCase(),
      closing: Boolean(match[1]),
      selfClosing: /\/\s*>$/.test(source),
      source,
    }
  }
  return null
}

function hasHtmlAttribute(tag: string, attribute: string): boolean {
  const escaped = escapeRegExp(attribute)
  return new RegExp(`\\s${escaped}(?:\\s|=|/?>)`, 'i').test(tag)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rawTextClosingStart(lowerHtml: string, tagName: string, from: number): number | null {
  const prefix = `</${tagName}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1) {
    const boundary = lowerHtml[candidate + prefix.length]
    if (boundary === undefined || boundary === '>' || boundary === '/' || /\s/.test(boundary)) {
      return candidate
    }
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return null
}

function htmlInjectionPoints(html: string): HtmlInjectionPoints {
  const lowerHtml = html.toLowerCase()
  let cursor = 0
  let templateDepth = 0
  const points: HtmlInjectionPoints = {
    headOpenEnd: null,
    headCloseStart: null,
    bodyOpenStart: null,
    firstScriptStart: null,
    hasResourceProxyScript: false,
  }

  while (cursor < html.length) {
    const tag = nextHtmlTag(html, cursor)
    if (!tag) break
    cursor = tag.end

    if (tag.name === 'template') {
      if (tag.closing) templateDepth = Math.max(0, templateDepth - 1)
      else if (!tag.selfClosing) templateDepth += 1
      continue
    }

    if (templateDepth === 0) {
      if (!tag.closing && tag.name === 'head' && points.headOpenEnd === null) {
        points.headOpenEnd = tag.end
      } else if (tag.closing && tag.name === 'head' && points.headCloseStart === null) {
        points.headCloseStart = tag.start
      } else if (!tag.closing && tag.name === 'body' && points.bodyOpenStart === null) {
        points.bodyOpenStart = tag.start
      }
      if (!tag.closing && tag.name === 'script') {
        if (points.firstScriptStart === null) points.firstScriptStart = tag.start
        if (hasHtmlAttribute(tag.source, RESOURCE_PROXY_INJECTION_ATTRIBUTE)) {
          points.hasResourceProxyScript = true
        }
      }
    }

    if (!tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const closingStart = rawTextClosingStart(lowerHtml, tag.name, cursor)
      if (closingStart === null) break
      cursor = closingStart
    }
  }

  return points
}

interface ResourceTextReplacement {
  pattern: RegExp
  sourceLength: number
  target: string
}

interface ResourceTextRewriteContext {
  replacements: ResourceTextReplacement[]
  transformVersion: string
}

function resourceTextRewriteContext(
  req: Request,
  binding: SiteBinding,
  relativePath: string
): ResourceTextRewriteContext {
  const proxyOrigin = requestPublicOrigin(req)
  const officialRoot = new URL('/', binding.officialOrigin)
  const baseUrl = new URL(relativePath.replace(/^\/+/, ''), officialRoot)
  const sourcesByTarget = new Map<string, Set<string>>()

  const addReplacement = (source: string, target: string) => {
    const sources = sourcesByTarget.get(target) || new Set<string>()
    sources.add(source)
    sourcesByTarget.set(target, sources)
  }

  for (const configuredPrefix of binding.resourceProxyPrefixes || []) {
    const trimmed = configuredPrefix.trim()
    if (!trimmed) continue
    let normalized: string
    try {
      normalized = new URL(trimmed).href
    } catch {
      continue
    }
    const target = rewriteResourceProxyUrl(normalized, baseUrl, proxyOrigin, binding)
    if (!target) continue
    addReplacement(trimmed, target)
    addReplacement(normalized, target)
    try {
      const source = new URL(normalized)
      addReplacement(`//${source.host}${source.pathname}`, target)
    } catch {
      // The normalized URL was already parsed above; keep the rewrite loop defensive.
    }
  }

  return {
    replacements: [...sourcesByTarget.entries()]
      .map(([target, sourceSet]) => {
        const sources = [...sourceSet].sort((left, right) => right.length - left.length)
        return {
          pattern: new RegExp(`(?:${sources.map(escapeRegExp).join('|')})/?`, 'g'),
          sourceLength: sources[0]?.length || 0,
          target,
        }
      })
      .sort((left, right) => right.sourceLength - left.sourceLength),
    transformVersion: resourceProxyTransformVersion(binding),
  }
}

function rewriteResourceProxyText(text: string, context: ResourceTextRewriteContext): string {
  let rewritten = text
  for (const replacement of context.replacements) {
    replacement.pattern.lastIndex = 0
    rewritten = rewritten.replace(replacement.pattern, replacement.target)
  }
  return rewritten
}

function versionedLocalCssHref(
  value: string,
  requestOrigin: URL,
  transformVersion: string
): string | null {
  const href = value.trim()
  if (!href) return null
  let resolved: URL
  try {
    resolved = new URL(decodeHtmlAttributeValue(href), requestOrigin)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(resolved.protocol) ||
    resolved.origin !== requestOrigin.origin ||
    !resolved.pathname.toLowerCase().endsWith('.css') ||
    resolved.pathname === RESOURCE_PROXY_BASE_PATH ||
    resolved.pathname.startsWith(`${RESOURCE_PROXY_BASE_PATH}/`)
  ) {
    return null
  }

  const encodedVersion = encodeURIComponent(transformVersion)
  const parameterPattern = new RegExp(
    `([?&]|&(?:amp|#0*38|#x0*26);)${escapeRegExp(RESOURCE_PROXY_TRANSFORM_VERSION_PARAM)}=[^&#]*`,
    'i'
  )
  if (parameterPattern.test(href)) {
    return href.replace(
      parameterPattern,
      `$1${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${encodedVersion}`
    )
  }
  const hashIndex = htmlAttributeFragmentIndex(href)
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  const entitySeparators = beforeHash.match(/&(?:amp|#0*38|#x0*26);/gi)
  const separator = decodeHtmlAttributeValue(beforeHash).includes('?')
    ? entitySeparators?.at(-1) || '&'
    : '?'
  return `${beforeHash}${separator}${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${encodedVersion}${hash}`
}

function htmlAttributeFragmentIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '&') {
      const reference = /^&(?:#[a-f\d]+|#x[a-f\d]+|[a-z][a-z\d]+);/i.exec(value.slice(index))
      if (reference) {
        if (decodeHtmlAttributeValue(reference[0]) === '#') return index
        index += reference[0].length - 1
        continue
      }
    }
    if (value[index] === '#') return index
  }
  return -1
}

function decodeHtmlAttributeValue(value: string): string {
  const namedReferences: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  }
  return value
    .replace(/&#(?:x([a-f\d]+)|(\d+));/gi, (source, hex?: string, decimal?: string) => {
      const codePoint = Number.parseInt(hex || decimal || '', hex ? 16 : 10)
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return source
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return source
      }
    })
    .replace(/&(amp|apos|gt|lt|quot);/gi, (source, name: string) => {
      return namedReferences[name.toLowerCase()] || source
    })
}

function htmlAttributeValue(tag: string, attribute: string): string | null {
  const pattern = new RegExp(
    `\\s${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\t\\n\\f\\r "'\`=<>]+))`,
    'i'
  )
  const match = pattern.exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

function linkLoadsCss(tag: string): boolean {
  const rel = htmlAttributeValue(tag, 'rel')
  if (rel === null) return false
  const tokens = decodeHtmlAttributeValue(rel).toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.includes('stylesheet') || tokens.includes('preload')
}

function rewriteHtmlLocalCssHrefs(
  html: string,
  requestOrigin: URL,
  transformVersion: string
): string {
  let cursor = 0
  let output = ''
  let writtenUntil = 0
  const lowerHtml = html.toLowerCase()

  while (cursor < html.length) {
    const tag = nextHtmlTag(html, cursor)
    if (!tag) break
    cursor = tag.end

    if (!tag.closing && tag.name === 'link' && linkLoadsCss(tag.source)) {
      const rewrittenTag = tag.source.replace(
        /(\shref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'`=<>]+))/i,
        (source, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
          const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
          const rewritten = versionedLocalCssHref(value, requestOrigin, transformVersion)
          if (!rewritten) return source
          if (doubleQuoted !== undefined) return `${prefix}"${rewritten}"`
          if (singleQuoted !== undefined) return `${prefix}'${rewritten}'`
          return `${prefix}${rewritten}`
        }
      )
      if (rewrittenTag !== tag.source) {
        output += html.slice(writtenUntil, tag.start)
        output += rewrittenTag.replace(
          /[\t\n\f\r ]+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'`=<>]+)/i,
          ''
        )
        writtenUntil = tag.end
      }
    }

    if (!tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const closingStart = rawTextClosingStart(lowerHtml, tag.name, cursor)
      if (closingStart === null) break
      cursor = closingStart
    }
  }

  return writtenUntil ? `${output}${html.slice(writtenUntil)}` : html
}

function isCssArtifactFile(metadata: ArtifactManifestFile, relativePath: string): boolean {
  return (
    path.extname(relativePath).toLowerCase() === '.css' ||
    metadata.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/css'
  )
}

function injectHtml(html: string, artifact: Artifact): string {
  const points = htmlInjectionPoints(html)
  const resourceProxyScript = points.hasResourceProxyScript
    ? ''
    : `<script ${RESOURCE_PROXY_INJECTION_ATTRIBUTE} src="${RESOURCE_PROXY_BOOTSTRAP_PATH}"></script>`
  const scripts = `<script src="/__cuddly/bootstrap.js?artifact=${encodeURIComponent(artifact.id)}"></script>`

  const headOpenEnd = points.headOpenEnd
  if (headOpenEnd !== null) {
    const lateCandidates = [points.headCloseStart, points.bodyOpenStart].filter(
      (point): point is number => point !== null && point >= headOpenEnd
    )
    const lateInsertion = lateCandidates.length ? Math.min(...lateCandidates) : headOpenEnd
    return `${html.slice(0, headOpenEnd)}${resourceProxyScript}${html.slice(
      headOpenEnd,
      lateInsertion
    )}${scripts}${html.slice(lateInsertion)}`
  }

  const insertionCandidates = [
    points.headCloseStart,
    points.bodyOpenStart,
    points.firstScriptStart,
  ].filter((point): point is number => point !== null)
  const insertion = insertionCandidates.length ? Math.min(...insertionCandidates) : 0
  return `${html.slice(0, insertion)}${resourceProxyScript}${scripts}${html.slice(insertion)}`
}

function injectResourceProxyBootstrap(html: string): string {
  const points = htmlInjectionPoints(html)
  if (points.hasResourceProxyScript) return html
  const script = `<script ${RESOURCE_PROXY_INJECTION_ATTRIBUTE} src="${RESOURCE_PROXY_BOOTSTRAP_PATH}"></script>`
  if (points.headOpenEnd !== null) {
    return `${html.slice(0, points.headOpenEnd)}${script}${html.slice(points.headOpenEnd)}`
  }
  const insertionCandidates = [
    points.headCloseStart,
    points.bodyOpenStart,
    points.firstScriptStart,
  ].filter((point): point is number => point !== null)
  const insertion = insertionCandidates.length ? Math.min(...insertionCandidates) : 0
  return `${html.slice(0, insertion)}${script}${html.slice(insertion)}`
}

const ARTIFACT_TEXT_ETAG_VERSION = 'cuddly-artifact-text-v2'

function transformedArtifactTextEtag(body: string, transformVersion: string): string {
  const digest = createHash('sha256')
    .update(ARTIFACT_TEXT_ETAG_VERSION)
    .update('\0')
    .update(transformVersion)
    .update('\0')
    .update(body)
    .digest('hex')
  return `"sha256:${digest}"`
}

async function sendArtifactFile(input: {
  req: Request
  res: Response
  artifactStore: FileArtifactStore
  artifact: Artifact
  relativePath: string
  binding?: SiteBinding
  environmentEntry?: boolean
}) {
  const metadata = manifestFile(input.artifact.manifest, input.relativePath)
  if (!metadata) {
    input.res.status(404).json({ code: 'ARTIFACT_FILE_NOT_FOUND' })
    return
  }

  const rewriteContext = input.binding
    ? resourceTextRewriteContext(input.req, input.binding, input.relativePath)
    : null
  const transformCss = Boolean(
    rewriteContext?.replacements.length && isCssArtifactFile(metadata, input.relativePath)
  )

  if (metadata.cacheClass === 'html' || transformCss) {
    const source = await input.artifactStore.readText(input.artifact.storageKey, input.relativePath)
    if (source === null) {
      input.res.status(502).json({ code: 'ARTIFACT_STORAGE_MISSING' })
      return
    }
    const requestUrl = new URL(input.req.path, requestPublicOrigin(input.req))
    let body = rewriteContext ? rewriteResourceProxyText(source, rewriteContext) : source
    if (metadata.cacheClass === 'html') {
      if (rewriteContext?.replacements.length) {
        body = rewriteHtmlLocalCssHrefs(body, requestUrl, rewriteContext.transformVersion)
      }
      body = injectHtml(body, input.artifact)
      if (rewriteContext) {
        body = rewriteResourceProxyText(body, rewriteContext)
        if (rewriteContext.replacements.length) {
          body = rewriteHtmlLocalCssHrefs(body, requestUrl, rewriteContext.transformVersion)
        }
      }
    }
    const etag = transformedArtifactTextEtag(
      body,
      rewriteContext?.transformVersion || 'no-resource-proxy-rules'
    )
    const previewScopedPath =
      Boolean(sitePreviewToken(input.req)) &&
      !input.req.path.startsWith('/__cuddly/artifacts/') &&
      !input.req.path.startsWith('/__cuddly/preview-artifacts/')
    const responseCacheControl = previewScopedPath
      ? 'private, no-store'
      : cacheControl(metadata, Boolean(input.environmentEntry))
    if (input.req.headers['if-none-match'] === etag) {
      input.res.setHeader('Cache-Control', responseCacheControl)
      input.res.setHeader('ETag', etag)
      input.res.setHeader('Accept-Ranges', 'none')
      input.res.status(304).end()
      return
    }
    input.res.status(200)
    input.res.setHeader('Content-Type', metadata.contentType)
    input.res.setHeader('Cache-Control', responseCacheControl)
    input.res.setHeader('ETag', etag)
    input.res.setHeader('Accept-Ranges', 'none')
    input.res.setHeader('Content-Length', String(Buffer.byteLength(body)))
    if (input.req.method === 'HEAD') input.res.end()
    else input.res.send(body)
    return
  }

  const etag = `"${metadata.digest}"`
  if (input.req.headers['if-none-match'] === etag) {
    input.res.status(304).end()
    return
  }

  const file = await input.artifactStore.openFile(input.artifact.storageKey, input.relativePath)
  if (!file) {
    input.res.status(502).json({ code: 'ARTIFACT_STORAGE_MISSING' })
    return
  }
  input.res.setHeader('Content-Type', metadata.contentType)
  const previewScopedPath =
    Boolean(sitePreviewToken(input.req)) &&
    !input.req.path.startsWith('/__cuddly/artifacts/') &&
    !input.req.path.startsWith('/__cuddly/preview-artifacts/')
  input.res.setHeader(
    'Cache-Control',
    previewScopedPath
      ? 'private, no-store'
      : cacheControl(metadata, Boolean(input.environmentEntry))
  )
  input.res.setHeader('ETag', etag)
  input.res.setHeader('Accept-Ranges', 'bytes')

  const rangeHeader =
    typeof input.req.headers.range === 'string' ? input.req.headers.range : undefined
  const range = parseRange(rangeHeader, file.size)
  if (rangeHeader && !range) {
    await file.close()
    input.res.status(416).setHeader('Content-Range', `bytes */${file.size}`)
    input.res.end()
    return
  }
  if (range) {
    input.res.status(206)
    input.res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
    input.res.setHeader('Content-Length', String(range.end - range.start + 1))
  } else {
    input.res.status(200)
    input.res.setHeader('Content-Length', String(file.size))
  }
  if (input.req.method === 'HEAD') {
    await file.close()
    input.res.end()
    return
  }
  const stream = file.createStream(range || undefined)
  stream.once('error', (error) => {
    if (input.res.headersSent) input.res.destroy(error as Error)
    else input.res.status(502).json({ code: 'ARTIFACT_STORAGE_READ_FAILED' })
  })
  stream.pipe(input.res)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function artifactPath(req: Request): { artifactId: string; relativePath: string } | null {
  const match = /^\/__cuddly\/artifacts\/([^/]+)\/(.+)$/.exec(req.path)
  if (!match?.[1] || !match[2] || !UUID_PATTERN.test(match[1])) return null
  return { artifactId: match[1], relativePath: match[2] }
}

function previewArtifactPath(req: Request): { artifactId: string; relativePath: string } | null {
  const match = /^\/__cuddly\/preview-artifacts\/([^/]+)\/(.+)$/.exec(req.path)
  if (!match?.[1] || !match[2] || !UUID_PATTERN.test(match[1])) return null
  return { artifactId: match[1], relativePath: match[2] }
}

function previewToken(req: Request): string | null {
  const match = /^\/__cuddly\/previews\/([^/]+)\/(?:api\/)?v3\/version\/hot-module$/.exec(req.path)
  return match?.[1] || null
}

function previewCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Max-Age', '600')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}

function privateNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store')
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function sitePreviewToken(req: Request): string | null {
  const token = req.get('x-cuddly-preview-token')?.trim()
  return token || null
}

function isSiteHotModulePath(requestPath: string): boolean {
  return requestPath === '/api/v3/version/hot-module' || requestPath === '/v3/version/hot-module'
}

const HOT_MODULE_MAX_REWRITE_BYTES = 256 * 1024
const PREVIEW_LOOKUP_CACHE_MAX_ENTRIES = 1024
const PREVIEW_LOOKUP_CACHE_TTL_MS = 30_000
const PREVIEW_LOOKUP_NEGATIVE_TTL_MS = 5_000
const ENVIRONMENT_LOOKUP_CACHE_MAX_ENTRIES = 128
// Environment edits may take at most five seconds to reach an already-warm hostname. This keeps
// the request path off the database without materially delaying an archive or backend switch.
const ENVIRONMENT_LOOKUP_CACHE_TTL_MS = 5_000
const ENVIRONMENT_LOOKUP_NEGATIVE_TTL_MS = 1_000
const SITE_BINDING_LOOKUP_CACHE_MAX_ENTRIES = 256
// Binding and runtime-setting edits are control-plane operations. A short bounded cache keeps
// ordinary page assets off PostgreSQL while still making edits visible without a Gateway restart.
const SITE_BINDING_LOOKUP_CACHE_TTL_MS = 5_000
const SITE_BINDING_LOOKUP_NEGATIVE_TTL_MS = 1_000
const RUNTIME_OPTIONS_CACHE_TTL_MS = 5_000
const DIRECT_PREVIEW_CACHE_TTL_MS = 30_000
const DIRECT_PREVIEW_CACHE_MAX_ENTRIES = 1024

function requestPublicOrigin(req: Request): URL {
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const protocol =
    forwardedProtocol === 'http' || forwardedProtocol === 'https' ? forwardedProtocol : req.protocol
  return new URL(`${protocol}://${req.get('host') || req.hostname}`)
}

function isReadySiteArtifact(
  artifact: Artifact | null,
  binding: SiteBinding,
  environment: EnvironmentRecord
): artifact is Artifact {
  return Boolean(
    artifact &&
    artifact.status === 'READY' &&
    artifact.targetId === binding.targetId &&
    artifact.environmentId === environment.id &&
    artifact.environmentSlug === environment.slug &&
    isSupportedStaticSiteAdapter(artifact.manifest.serve.siteAdapter)
  )
}

function legacyUpstreamOrigin(binding: SiteBinding): string | undefined {
  return (binding as SiteBinding & { upstreamOrigin?: string }).upstreamOrigin
}

function siteFallbackOrigin(binding: SiteBinding, defaultOrigin: string): URL {
  return new URL(binding.fallbackOrigin || legacyUpstreamOrigin(binding) || defaultOrigin)
}

function environmentBackendOrigin(
  environment: EnvironmentRecord,
  binding: SiteBinding,
  defaultOrigin: string
): URL {
  return new URL(environment.backendOrigin || legacyUpstreamOrigin(binding) || defaultOrigin)
}

function environmentForwardProxy(
  environment: EnvironmentRecord,
  internalProxyUrl: URL | null | undefined
): URL | undefined {
  if (!environment.useInternalProxy) return undefined
  if (!internalProxyUrl) throw new InternalProxyNotConfiguredError(environment.slug)
  return internalProxyUrl
}

export function createGatewayApp(options: GatewayOptions) {
  const app = express()
  const requestBindings = new WeakMap<Request, SiteBinding>()
  const requestEnvironments = new WeakMap<Request, EnvironmentRecord>()
  const requestPreviews = new WeakMap<Request, PreviewSession>()
  const previewBaseDomain = options.previewBaseDomain ?? 'bifrost.vanillacake.cn'
  type DirectPreviewResolution = {
    binding: SiteBinding
    environment: EnvironmentRecord
    preview: PreviewSession
  }
  const directPreviewCache = new Map<
    string,
    { resolution: DirectPreviewResolution | null; validUntil: number }
  >()
  const directPreviewLookups = new Map<string, Promise<DirectPreviewResolution | null>>()
  const previewLookupCache = new Map<
    string,
    { preview: PreviewSession | null; validUntil: number }
  >()
  const previewLookups = new Map<string, Promise<PreviewSession | null>>()
  const environmentLookupCache = new Map<
    string,
    { environment: EnvironmentRecord | null; validUntil: number }
  >()
  const environmentLookups = new Map<string, Promise<EnvironmentRecord | null>>()
  const siteBindingLookupCache = new Map<
    string,
    { binding: SiteBinding | null; validUntil: number }
  >()
  const siteBindingLookups = new Map<string, Promise<SiteBinding | null>>()
  let runtimeOptionsCache: { runtime: GatewayRuntimeOptions; validUntil: number } | null = null
  let runtimeOptionsLookup: Promise<GatewayRuntimeOptions> | null = null

  const buildDirectPreview = async (
    group: ConfigurationGroup
  ): Promise<DirectPreviewResolution | null> => {
    const [environment, binding] = await Promise.all([
      options.store.getEnvironment(group.environmentId),
      options.store.getSiteBinding(group.siteBindingId),
    ])
    if (
      !environment ||
      environment.slug !== group.environmentSlug ||
      environment.status === 'ARCHIVED' ||
      !binding?.enabled
    ) {
      return null
    }
    const expectedTargets = new Set([binding.targetId, ...binding.remoteTargetIds])
    if (
      group.items.length !== expectedTargets.size ||
      group.items.some((item) => !expectedTargets.has(item.targetId))
    ) {
      return null
    }

    let siteArtifactId: string | undefined
    const selections: PreviewSession['selections'] = []
    for (const item of group.items) {
      if (item.mode === 'official') continue
      const artifact = (
        await options.store.listArtifacts(item.targetId, item.branch, environment.id)
      )[0]
      if (
        !artifact ||
        artifact.environmentSlug !== environment.slug ||
        artifact.status !== 'READY'
      ) {
        return null
      }
      if (item.targetId === binding.targetId) {
        if (!isReadySiteArtifact(artifact, binding, environment)) return null
        siteArtifactId = artifact.id
        continue
      }
      const remote = artifact.manifest.serve.remote
      if (!binding.remoteTargetIds.includes(item.targetId) || !remote) return null
      selections.push({
        moduleKey: remote.moduleKey,
        targetId: artifact.targetId,
        artifactId: artifact.id,
        branch: artifact.branch,
        builtAt: artifact.builtAt,
        providerName: remote.providerName,
        version: remote.providerName || artifact.branch,
        entryPath: remote.entryPath,
      })
    }
    return {
      binding,
      environment,
      preview: {
        token: `direct-${group.previewSlug}`,
        environmentId: environment.id,
        environmentSlug: environment.slug,
        createdBy: group.createdBy,
        createdAt: group.createdAt,
        expiresAt: '9999-12-31T23:59:59.999Z',
        siteBindingId: binding.id,
        siteArtifactId,
        selections,
      },
    }
  }

  const resolveDirectPreview = async (
    previewHostnamePrefix: string
  ): Promise<DirectPreviewResolution | null> => {
    const now = Date.now()
    const cached = directPreviewCache.get(previewHostnamePrefix)
    if (cached && cached.validUntil > now) return cached.resolution
    if (cached) directPreviewCache.delete(previewHostnamePrefix)
    const inFlight = directPreviewLookups.get(previewHostnamePrefix)
    if (inFlight) return inFlight
    const lookup = options.store
      .getConfigurationGroupByPreviewHostnamePrefix(previewHostnamePrefix)
      .then((group) => (group ? buildDirectPreview(group) : null))
      .then((resolution) => {
        directPreviewCache.set(previewHostnamePrefix, {
          resolution,
          validUntil: Date.now() + DIRECT_PREVIEW_CACHE_TTL_MS,
        })
        while (directPreviewCache.size > DIRECT_PREVIEW_CACHE_MAX_ENTRIES) {
          const oldest = directPreviewCache.keys().next().value
          if (typeof oldest !== 'string') break
          directPreviewCache.delete(oldest)
        }
        return resolution
      })
      .finally(() => directPreviewLookups.delete(previewHostnamePrefix))
    directPreviewLookups.set(previewHostnamePrefix, lookup)
    return lookup
  }

  const cacheRuntimeOptions = (
    runtime: GatewayRuntimeOptions,
    now = Date.now()
  ): GatewayRuntimeOptions => {
    runtimeOptionsCache = { runtime, validUntil: now + RUNTIME_OPTIONS_CACHE_TTL_MS }
    return runtime
  }

  const resolveRuntime = async (): Promise<GatewayRuntimeOptions> => {
    const now = Date.now()
    if (runtimeOptionsCache && runtimeOptionsCache.validUntil > now) {
      return runtimeOptionsCache.runtime
    }
    runtimeOptionsCache = null

    if (runtimeOptionsLookup) return runtimeOptionsLookup
    const lookup = Promise.resolve()
      .then(() =>
        options.resolveRuntimeOptions
          ? options.resolveRuntimeOptions()
          : { allowedHosts: options.allowedHosts, proxy: options.proxy }
      )
      .then((runtime) => cacheRuntimeOptions(runtime))
      .finally(() => {
        if (runtimeOptionsLookup === lookup) runtimeOptionsLookup = null
      })
    runtimeOptionsLookup = lookup
    return lookup
  }

  const cachePreviewLookup = (
    token: string,
    preview: PreviewSession | null,
    now = Date.now()
  ): PreviewSession | null => {
    const expiresAt = preview ? Date.parse(preview.expiresAt) : Number.POSITIVE_INFINITY
    const ttl = preview ? PREVIEW_LOOKUP_CACHE_TTL_MS : PREVIEW_LOOKUP_NEGATIVE_TTL_MS
    const validUntil = Math.min(now + ttl, expiresAt)
    previewLookupCache.delete(token)
    if (validUntil > now) previewLookupCache.set(token, { preview, validUntil })
    while (previewLookupCache.size > PREVIEW_LOOKUP_CACHE_MAX_ENTRIES) {
      const oldest = previewLookupCache.keys().next().value
      if (typeof oldest !== 'string') break
      previewLookupCache.delete(oldest)
    }
    return preview
  }

  const resolvePreviewSession = async (token: string): Promise<PreviewSession | null> => {
    const now = Date.now()
    const cached = previewLookupCache.get(token)
    if (cached && cached.validUntil > now) {
      previewLookupCache.delete(token)
      previewLookupCache.set(token, cached)
      return cached.preview
    }
    if (cached) previewLookupCache.delete(token)

    const inFlight = previewLookups.get(token)
    if (inFlight) return inFlight

    const lookup = options.store
      .getPreviewSession(token)
      .then((preview) => cachePreviewLookup(token, preview))
      .finally(() => {
        if (previewLookups.get(token) === lookup) previewLookups.delete(token)
      })
    previewLookups.set(token, lookup)
    return lookup
  }

  const cacheEnvironmentLookup = (
    slug: string,
    environment: EnvironmentRecord | null,
    now = Date.now()
  ): EnvironmentRecord | null => {
    const ttl = environment ? ENVIRONMENT_LOOKUP_CACHE_TTL_MS : ENVIRONMENT_LOOKUP_NEGATIVE_TTL_MS
    environmentLookupCache.delete(slug)
    environmentLookupCache.set(slug, { environment, validUntil: now + ttl })
    while (environmentLookupCache.size > ENVIRONMENT_LOOKUP_CACHE_MAX_ENTRIES) {
      const oldest = environmentLookupCache.keys().next().value
      if (typeof oldest !== 'string') break
      environmentLookupCache.delete(oldest)
    }
    return environment
  }

  const resolveEnvironment = async (slug: string): Promise<EnvironmentRecord | null> => {
    const now = Date.now()
    const cached = environmentLookupCache.get(slug)
    if (cached && cached.validUntil > now) {
      environmentLookupCache.delete(slug)
      environmentLookupCache.set(slug, cached)
      return cached.environment
    }
    if (cached) environmentLookupCache.delete(slug)

    const inFlight = environmentLookups.get(slug)
    if (inFlight) return inFlight
    const lookup = options.store
      .getEnvironment(slug)
      .then((environment) => cacheEnvironmentLookup(slug, environment))
      .finally(() => {
        if (environmentLookups.get(slug) === lookup) environmentLookups.delete(slug)
      })
    environmentLookups.set(slug, lookup)
    return lookup
  }

  const cacheSiteBindingLookup = (
    hostname: string,
    binding: SiteBinding | null,
    now = Date.now()
  ): SiteBinding | null => {
    const ttl = binding ? SITE_BINDING_LOOKUP_CACHE_TTL_MS : SITE_BINDING_LOOKUP_NEGATIVE_TTL_MS
    siteBindingLookupCache.delete(hostname)
    siteBindingLookupCache.set(hostname, { binding, validUntil: now + ttl })
    while (siteBindingLookupCache.size > SITE_BINDING_LOOKUP_CACHE_MAX_ENTRIES) {
      const oldest = siteBindingLookupCache.keys().next().value
      if (typeof oldest !== 'string') break
      siteBindingLookupCache.delete(oldest)
    }
    return binding
  }

  const resolveSiteBinding = async (hostname: string): Promise<SiteBinding | null> => {
    const now = Date.now()
    const cached = siteBindingLookupCache.get(hostname)
    if (cached && cached.validUntil > now) {
      siteBindingLookupCache.delete(hostname)
      siteBindingLookupCache.set(hostname, cached)
      return cached.binding
    }
    if (cached) siteBindingLookupCache.delete(hostname)

    const inFlight = siteBindingLookups.get(hostname)
    if (inFlight) return inFlight
    const lookup = options.store
      .getSiteBindingByHostname(hostname, true)
      .then((binding) => cacheSiteBindingLookup(hostname, binding))
      .finally(() => {
        if (siteBindingLookups.get(hostname) === lookup) siteBindingLookups.delete(hostname)
      })
    siteBindingLookups.set(hostname, lookup)
    return lookup
  }

  const proxyBackend = async (
    req: Request,
    res: Response,
    next: NextFunction,
    binding: SiteBinding,
    environment: EnvironmentRecord
  ) => {
    try {
      const runtime = await resolveRuntime()
      createUpstreamProxy({
        ...runtime.proxy,
        upstream: environmentBackendOrigin(environment, binding, runtime.proxy.upstream.origin),
        forwardProxy: environmentForwardProxy(environment, options.internalProxyUrl),
        publicOrigin: requestPublicOrigin(req),
        ...(sitePreviewToken(req)
          ? { responseHeaders: { 'Cache-Control': 'private, no-store' } }
          : {}),
      })(req, res, next)
    } catch (error) {
      next(error)
    }
  }

  const proxyFrontendFallback = async (
    req: Request,
    res: Response,
    next: NextFunction,
    binding: SiteBinding,
    environment: EnvironmentRecord
  ) => {
    try {
      const runtime = await resolveRuntime()
      const rewriteContext = resourceTextRewriteContext(req, binding, req.path)
      createBufferedTextUpstreamProxy({
        ...runtime.proxy,
        // An environment marked as internal must use the same fail-closed proxy path for its
        // official frontend shell as it does for backend and hot-module traffic. Otherwise an
        // extension-free Preview can leak past the company route before any overlay is loaded.
        forwardProxy: environmentForwardProxy(environment, options.internalProxyUrl),
        upstream: siteFallbackOrigin(binding, runtime.proxy.upstream.origin),
        publicOrigin: requestPublicOrigin(req),
        responseHeaders: { 'Cache-Control': 'private, no-store' },
        contentTypes: ['text/html', 'application/xhtml+xml', 'text/css'],
        transform(body, context) {
          if (
            (context.contentType === 'text/html' ||
              context.contentType === 'application/xhtml+xml') &&
            rewriteContext.replacements.length
          ) {
            const requestUrl = new URL(req.originalUrl, requestPublicOrigin(req))
            let rewritten = rewriteResourceProxyText(body, rewriteContext)
            rewritten = rewriteHtmlLocalCssHrefs(
              rewritten,
              requestUrl,
              rewriteContext.transformVersion
            )
            rewritten = injectResourceProxyBootstrap(rewritten)
            return {
              body: rewritten,
              headers: { 'Cache-Control': 'private, no-store' },
            }
          }

          const requestedTransformVersion =
            typeof req.query[RESOURCE_PROXY_TRANSFORM_VERSION_PARAM] === 'string'
              ? req.query[RESOURCE_PROXY_TRANSFORM_VERSION_PARAM]
              : null
          if (
            context.contentType === 'text/css' &&
            rewriteContext.replacements.length &&
            requestedTransformVersion === rewriteContext.transformVersion
          ) {
            return { body: rewriteResourceProxyText(body, rewriteContext) }
          }
          return null
        },
      })(req, res, next)
    } catch (error) {
      next(error)
    }
  }

  const matchingSitePreview = async (
    req: Request,
    binding: SiteBinding,
    environment: EnvironmentRecord
  ): Promise<PreviewSession | null> => {
    const token = sitePreviewToken(req)
    if (!token) return null
    const cached = requestPreviews.get(req)
    if (cached) {
      return cached.siteBindingId === binding.id &&
        cached.environmentId === environment.id &&
        cached.environmentSlug === environment.slug
        ? cached
        : null
    }
    const preview = await resolvePreviewSession(token)
    return preview?.siteBindingId === binding.id &&
      preview.environmentId === environment.id &&
      preview.environmentSlug === environment.slug
      ? preview
      : null
  }

  const resolveSiteArtifact = async (
    req: Request,
    binding: SiteBinding,
    environment: EnvironmentRecord
  ): Promise<{
    artifact: Artifact | null
    previewSelected: boolean
    officialSelected: boolean
  }> => {
    const preview = await matchingSitePreview(req, binding, environment)
    if (preview) {
      return {
        artifact: preview.siteArtifactId
          ? await options.store.getArtifact(preview.siteArtifactId)
          : null,
        previewSelected: true,
        officialSelected: !preview.siteArtifactId,
      }
    }
    return {
      artifact: null,
      previewSelected: false,
      officialSelected: true,
    }
  }

  const authorizedSiteArtifact = async (
    req: Request,
    binding: SiteBinding,
    environment: EnvironmentRecord,
    artifactId: string
  ): Promise<Artifact | null> => {
    const artifact = await options.store.getArtifact(artifactId)
    if (!isReadySiteArtifact(artifact, binding, environment)) return null
    const preview = await matchingSitePreview(req, binding, environment)
    if (preview?.siteArtifactId === artifactId) return artifact
    return null
  }

  const previewHotModuleOverrides = async (
    preview: PreviewSession,
    environment: EnvironmentRecord,
    publicOrigin: URL,
    allowedTargetIds?: ReadonlySet<string>
  ): Promise<{
    overrides: HotModuleOverride[]
    failure: { code: string; message: string } | null
  }> => {
    const disallowed = allowedTargetIds
      ? preview.selections.find((selection) => !allowedTargetIds.has(selection.targetId))
      : null
    if (disallowed) {
      return {
        overrides: [],
        failure: {
          code: 'PREVIEW_REMOTE_NOT_ALLOWED',
          message: `${disallowed.moduleKey} 已不再属于当前站点，请重新创建预览`,
        },
      }
    }
    const selections = preview.selections
    const artifacts = await Promise.all(
      selections.map((selection) => options.store.getArtifact(selection.artifactId))
    )
    const overrides: HotModuleOverride[] = []
    for (const [index, selection] of selections.entries()) {
      const artifact = artifacts[index]
      const override = artifact ? hotModuleOverrideFromArtifact(artifact, publicOrigin) : null
      if (
        !artifact ||
        artifact.environmentId !== environment.id ||
        artifact.environmentSlug !== environment.slug ||
        artifact.targetId !== selection.targetId ||
        !override ||
        override.moduleKey !== selection.moduleKey
      ) {
        return {
          overrides: [],
          failure: {
            code: 'PREVIEW_ARTIFACT_UNAVAILABLE',
            message: `${selection.moduleKey} 的预览产物已经不可用`,
          },
        }
      }
      overrides.push(override)
    }
    return { overrides, failure: null }
  }

  app.disable('x-powered-by')

  app.get('/health/live', (_req, res) => res.json({ ok: true }))
  app.get('/health/ready', async (_req, res) => {
    try {
      const environments = await options.store.listEnvironments()
      const ready = environments.some((environment) => environment.status !== 'ARCHIVED')
      res.status(ready ? 200 : 503).json({ ok: ready })
    } catch {
      res.status(503).json({ ok: false })
    }
  })

  app.options('/__cuddly/previews/*path', (_req, res) => {
    previewCors(res)
    res.status(204).end()
  })
  app.options('/__cuddly/preview-artifacts/*path', (_req, res) => {
    previewCors(res)
    res.status(204).end()
  })

  app.use((req, res, next) => {
    const token = previewToken(req)
    if (!token) {
      next()
      return
    }
    previewCors(res)
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.status(405).json({ code: 'METHOD_NOT_ALLOWED' })
      return
    }
    privateNoStore(res)
    res.status(410).json({
      code: 'SITE_BOUND_PREVIEW_REQUIRED',
      message: '旧版热更预览接口已停用，请更新浏览器扩展并通过站点预览使用热更',
    })
  })

  app.use(async (req, res, next) => {
    const hostname = req.hostname.toLowerCase().replace(/\.$/, '')
    const directPreviewHostnamePrefix = configurationGroupHostnamePrefixFromHostname(
      hostname,
      previewBaseDomain
    )
    let binding: SiteBinding | null = null
    if (directPreviewHostnamePrefix) {
      const direct = await resolveDirectPreview(directPreviewHostnamePrefix)
      if (direct) {
        binding = direct.binding
        requestBindings.set(req, direct.binding)
        requestEnvironments.set(req, direct.environment)
        requestPreviews.set(req, direct.preview)
        req.headers['x-cuddly-preview-token'] = direct.preview.token
      } else {
        // Ordinary site bindings use the same wildcard base domain. Only treat an unknown label as
        // a missing share after giving a configured site such as main or m a chance to resolve.
        binding = await resolveSiteBinding(hostname)
      }
    } else {
      binding = await resolveSiteBinding(hostname)
    }
    if (!binding) {
      const runtime = await resolveRuntime()
      if (
        runtime.allowedHosts.some(
          (allowedHost) => allowedHost.toLowerCase().replace(/\.$/, '') === hostname
        )
      ) {
        binding = {
          id: `legacy-${options.targetId}`,
          name: options.targetId,
          hostname,
          targetId: options.targetId,
          environmentSlug: options.environmentSlug,
          fallbackOrigin: runtime.proxy.upstream.origin,
          upstreamOrigin: runtime.proxy.upstream.origin,
          officialOrigin: runtime.proxy.upstream.origin,
          enabled: true,
          remoteTargetIds: [],
          resourceProxyPrefixes: [],
        }
      }
    }
    if (!binding || !binding.enabled) {
      res.status(404).json({ code: 'HOST_NOT_CONFIGURED' })
      return
    }
    requestBindings.set(req, binding)
    next()
  })

  app.use(async (req, res, next) => {
    const token = sitePreviewToken(req)
    const binding = requestBindings.get(req)!
    if (token) {
      const preview = requestPreviews.get(req) ?? (await resolvePreviewSession(token))
      const environment = preview ? await resolveEnvironment(preview.environmentSlug) : null
      if (
        !preview ||
        preview.siteBindingId !== binding.id ||
        !environment ||
        environment.status === 'ARCHIVED' ||
        environment.id !== preview.environmentId ||
        environment.slug !== preview.environmentSlug
      ) {
        privateNoStore(res)
        res.status(404).json({
          code: 'PREVIEW_NOT_FOUND',
          message: '预览不存在、已过期或不属于当前站点',
        })
        return
      }
      privateNoStore(res)
      requestPreviews.set(req, preview)
      requestEnvironments.set(req, environment)
      requestBindings.set(req, resourceProxyBindingForEnvironment(binding, environment))
      next()
      return
    }

    const environment = await resolveEnvironment(binding.environmentSlug)
    if (!environment) {
      res.status(503).json({
        code: 'ENVIRONMENT_UNAVAILABLE',
        environmentSlug: binding.environmentSlug,
      })
      return
    }
    if (environment.status === 'ARCHIVED') {
      res.status(503).json({
        code: 'ENVIRONMENT_ARCHIVED',
        environmentSlug: environment.slug,
      })
      return
    }
    requestEnvironments.set(req, environment)
    requestBindings.set(req, resourceProxyBindingForEnvironment(binding, environment))
    next()
  })

  app.use(async (req, res, next) => {
    const requested = previewArtifactPath(req)
    if (!requested) {
      if (req.path.startsWith('/__cuddly/preview-artifacts/')) {
        previewCors(res)
        res.setHeader('Cache-Control', 'no-store')
        res.status(404).json({ code: 'ARTIFACT_NOT_FOUND' })
        return
      }
      next()
      return
    }
    previewCors(res)
    const environment = requestEnvironments.get(req)!
    const artifact = await options.store.getArtifact(requested.artifactId)
    if (
      !artifact ||
      artifact.environmentId !== environment.id ||
      artifact.environmentSlug !== environment.slug ||
      artifact.status !== 'READY' ||
      artifact.manifest.serve.siteAdapter !== 'kook-remote-v1' ||
      !artifact.manifest.serve.remote
    ) {
      res.setHeader('Cache-Control', 'no-store')
      res.status(404).json({ code: 'ARTIFACT_NOT_FOUND' })
      return
    }
    if (!(await options.store.isRemoteArtifactReferenced(requested.artifactId))) {
      const directPreview = requestPreviews.get(req)
      if (directPreview?.selections.some((item) => item.artifactId === requested.artifactId)) {
        await sendArtifactFile({
          req,
          res,
          artifactStore: options.artifactStore,
          artifact,
          relativePath: requested.relativePath.startsWith(
            `${artifact.manifest.serve.remote.providerName}/`
          )
            ? requested.relativePath.slice(`${artifact.manifest.serve.remote.providerName}/`.length)
            : requested.relativePath,
          binding: requestBindings.get(req)!,
        })
        return
      }
      res.setHeader('Cache-Control', 'no-store')
      res.status(404).json({ code: 'ARTIFACT_NOT_REFERENCED' })
      return
    }
    const prefix = `${artifact.manifest.serve.remote.providerName}/`
    const relativePath = requested.relativePath.startsWith(prefix)
      ? requested.relativePath.slice(prefix.length)
      : requested.relativePath
    await sendArtifactFile({
      req,
      res,
      artifactStore: options.artifactStore,
      artifact,
      relativePath,
      binding: requestBindings.get(req)!,
    })
  })

  app.get(RESOURCE_PROXY_BOOTSTRAP_PATH, (req, res) => {
    const binding = requestBindings.get(req)!
    res.setHeader('Cache-Control', 'no-store')
    res.type('text/javascript').send(resourceProxyBootstrap(binding))
  })

  app.use((req, res, next) => {
    if (!req.path.startsWith(`${RESOURCE_PROXY_BASE_PATH}/`)) {
      next()
      return
    }
    proxyResourceRequest(
      req,
      res,
      next,
      requestBindings.get(req)!,
      options.resourceProxyHostResolver
    )
  })

  app.use(async (req, res, next) => {
    if (!isSiteHotModulePath(req.path)) {
      next()
      return
    }
    const binding = requestBindings.get(req)!
    const environment = requestEnvironments.get(req)!
    if (req.method === 'OPTIONS') {
      previewCors(res)
      res.status(204).end()
      return
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      next()
      return
    }

    const publicOrigin = requestPublicOrigin(req)
    let overrides: HotModuleOverride[]
    const token = sitePreviewToken(req)
    if (token) {
      previewCors(res)
      const preview = requestPreviews.get(req)!
      const resolved = await previewHotModuleOverrides(
        preview,
        environment,
        publicOrigin,
        new Set(binding.remoteTargetIds)
      )
      if (resolved.failure) {
        privateNoStore(res)
        res.status(410).json(resolved.failure)
        return
      }
      overrides = resolved.overrides
    } else {
      overrides = []
    }

    if (overrides.length === 0) {
      next()
      return
    }

    try {
      const runtime = await resolveRuntime()
      createBufferedJsonUpstreamProxy({
        ...runtime.proxy,
        upstream: environmentBackendOrigin(environment, binding, runtime.proxy.upstream.origin),
        forwardProxy: environmentForwardProxy(environment, options.internalProxyUrl),
        publicOrigin: requestPublicOrigin(req),
        responseHeaders: { 'Cache-Control': 'private, no-store' },
        maxRewriteBytes: Math.min(runtime.proxy.maxRewriteBytes, HOT_MODULE_MAX_REWRITE_BYTES),
        transform(body) {
          if (!applyHotModuleOverlay(body, overrides)) return null
          return {
            body,
            headers: { 'Cache-Control': 'private, no-store' },
          }
        },
      })(req, res, next)
    } catch (error) {
      next(error)
    }
  })

  app.get('/__cuddly/runtime', async (req, res) => {
    const environment = requestEnvironments.get(req)!
    const matrix = await options.store.getEnvironmentMatrix(environment.id)
    if (!matrix || matrix.environment.id !== environment.id) {
      res.status(503).json({ code: 'ENVIRONMENT_UNAVAILABLE' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(await publicIdentityData(options.store, matrix))
  })

  app.get('/__cuddly/bootstrap.js', async (req, res) => {
    const binding = requestBindings.get(req)!
    const environment = requestEnvironments.get(req)!
    const matrix = await options.store.getEnvironmentMatrix(environment.id)
    if (!matrix || matrix.environment.id !== environment.id) {
      if (sitePreviewToken(req)) privateNoStore(res)
      res
        .status(503)
        .type('text/javascript')
        .send(`throw new Error(${JSON.stringify(`${PRODUCT_NAME} environment unavailable`)})`)
      return
    }
    const requestedArtifactId = typeof req.query.artifact === 'string' ? req.query.artifact : null
    let { artifact } = await resolveSiteArtifact(req, binding, environment)
    if (requestedArtifactId && requestedArtifactId !== artifact?.id) {
      artifact = await authorizedSiteArtifact(req, binding, environment, requestedArtifactId)
    }
    if (!isReadySiteArtifact(artifact, binding, environment)) {
      if (sitePreviewToken(req)) privateNoStore(res)
      res
        .status(404)
        .type('text/javascript')
        .send(`throw new Error(${JSON.stringify(`${PRODUCT_NAME} Artifact unavailable`)})`)
      return
    }
    const payload = {
      environment: matrix.environment,
      revision: matrix.revision
        ? { id: matrix.revision.id, revisionNo: matrix.revision.revisionNo }
        : null,
      site: binding.id,
      artifact: {
        id: artifact.id,
        branch: artifact.branch,
        builtAt: artifact.builtAt,
        environmentId: artifact.environmentId,
        environmentSlug: artifact.environmentSlug,
      },
    }
    res.setHeader('Cache-Control', 'no-store')
    res.type('text/javascript').send(`window.__CUDDLY__=${safeJson(payload)};`)
  })

  app.get('/__cuddly/hooks/k-inject.js', async (_req, res) => {
    if (!options.hookPath) {
      res.status(204).end()
      return
    }
    try {
      const source = await readFile(options.hookPath, 'utf8')
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.type('text/javascript').send(source)
    } catch {
      res.status(404).end()
    }
  })

  app.use(async (req, res, next) => {
    const requested = artifactPath(req)
    if (!requested) {
      if (req.path.startsWith('/__cuddly/artifacts/')) {
        if (sitePreviewToken(req)) privateNoStore(res)
        res.status(404).json({ code: 'ARTIFACT_NOT_FOUND' })
        return
      }
      next()
      return
    }
    const binding = requestBindings.get(req)!
    const environment = requestEnvironments.get(req)!
    const artifact = await authorizedSiteArtifact(req, binding, environment, requested.artifactId)
    if (!artifact) {
      if (sitePreviewToken(req)) privateNoStore(res)
      res.status(404).json({ code: 'ARTIFACT_NOT_REFERENCED' })
      return
    }
    const relativePath = resolveArtifactFile(requested.relativePath, artifact.manifest)
    if (!relativePath) {
      res.status(404).json({ code: 'ARTIFACT_FILE_NOT_FOUND' })
      return
    }
    await sendArtifactFile({
      req,
      res,
      artifactStore: options.artifactStore,
      artifact,
      relativePath,
      binding,
    })
  })

  app.use(async (req, res, next) => {
    const binding = requestBindings.get(req)!
    const environment = requestEnvironments.get(req)!
    if (isBackendProxyRequest(req)) {
      await proxyBackend(req, res, next, binding, environment)
      return
    }

    const { artifact, previewSelected, officialSelected } = await resolveSiteArtifact(
      req,
      binding,
      environment
    )
    if (officialSelected) {
      await proxyFrontendFallback(req, res, next, binding, environment)
      return
    }
    if (isReadySiteArtifact(artifact, binding, environment)) {
      const exact = resolveArtifactFile(req.path, artifact.manifest)
      if (exact) {
        await sendArtifactFile({
          req,
          res,
          artifactStore: options.artifactStore,
          artifact,
          relativePath: exact,
          binding,
          environmentEntry: exact.endsWith('.htm') || exact.endsWith('.html'),
        })
        return
      }
      if (isExpectedStaticPath(req.path)) {
        res.status(404).json({ code: 'FRONTEND_ASSET_NOT_FOUND', path: req.path })
        return
      }
    }
    if (!isReadySiteArtifact(artifact, binding, environment)) {
      if (previewSelected) privateNoStore(res)
      res.status(previewSelected ? 410 : 503).json({
        code: previewSelected ? 'PREVIEW_ARTIFACT_UNAVAILABLE' : 'ENVIRONMENT_HAS_NO_ARTIFACT',
      })
      return
    }
    if (isHtmlNavigation(req)) {
      const entry = resolveArtifactNavigationEntry(req.path, artifact.manifest)
      if (!entry) {
        res.status(502).json({ code: 'ARTIFACT_ENTRY_NOT_FOUND' })
        return
      }
      await sendArtifactFile({
        req,
        res,
        artifactStore: options.artifactStore,
        artifact,
        relativePath: entry,
        binding,
        environmentEntry: true,
      })
      return
    }
    await proxyFrontendFallback(req, res, next, binding, environment)
  })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[gateway] request failed', error)
    if (!res.headersSent) {
      if (error instanceof InternalProxyNotConfiguredError) {
        res.status(503).json({ code: 'INTERNAL_PROXY_NOT_CONFIGURED' })
      } else {
        res.status(502).json({ code: 'GATEWAY_ERROR' })
      }
    } else res.end()
  })

  return app
}

export function defaultHookPath(): string {
  return path.resolve('legacy/bifrost-mis/public/k-inject.js')
}
