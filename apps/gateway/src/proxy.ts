import http, { type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'

import { rewriteLocationHeader, rewriteSetCookieHeaders, rewriteHosts } from '@cuddly/bifrost-rules'
import type { NextFunction, Request, Response } from 'express'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

export interface UpstreamProxyOptions {
  upstream: URL
  publicOrigin: URL
  cookieDomain: string
  maxRewriteBytes: number
  /**
   * An explicit forward proxy for this upstream request. Leaving this unset always means a
   * direct connection; proxy-related process environment variables are intentionally ignored.
   */
  forwardProxy?: URL
  responseHeaders?: http.OutgoingHttpHeaders
}

export interface BufferedJsonTransformContext {
  request: Request
  responseHeaders: IncomingHttpHeaders
  statusCode: number
}

export interface BufferedJsonTransformResult {
  body: unknown
  headers?: http.OutgoingHttpHeaders
}

export interface BufferedJsonUpstreamProxyOptions extends UpstreamProxyOptions {
  transform: (
    body: unknown,
    context: BufferedJsonTransformContext
  ) => BufferedJsonTransformResult | null | Promise<BufferedJsonTransformResult | null>
}

export interface BufferedTextTransformContext {
  request: Request
  responseHeaders: IncomingHttpHeaders
  statusCode: number
  contentType: string
}

export interface BufferedTextUpstreamProxyOptions extends UpstreamProxyOptions {
  contentTypes: readonly string[]
  transform: (
    body: string,
    context: BufferedTextTransformContext
  ) => BufferedTextTransformResult | null | Promise<BufferedTextTransformResult | null>
}

export interface BufferedTextTransformResult {
  body: string
  headers?: http.OutgoingHttpHeaders
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const REWRITTEN_BODY_HEADERS = new Set(['content-length', 'content-encoding', 'etag'])

const forwardProxyAgents = new Map<string, http.Agent>()

function forwardProxyAgent(upstream: URL, proxy: URL): http.Agent {
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new TypeError(`Unsupported forward proxy protocol: ${proxy.protocol}`)
  }
  const key = `${upstream.protocol}|${proxy.href}`
  const cached = forwardProxyAgents.get(key)
  if (cached) return cached

  const agent =
    upstream.protocol === 'http:'
      ? new HttpProxyAgent(proxy, { keepAlive: true })
      : new HttpsProxyAgent(proxy, { keepAlive: true })
  forwardProxyAgents.set(key, agent)
  return agent
}

function createUpstreamRequestHeaders(req: Request, options: UpstreamProxyOptions) {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase()
    if (
      normalized === 'host' ||
      normalized === 'origin' ||
      normalized === 'referer' ||
      normalized === 'accept-encoding' ||
      normalized.startsWith('x-cuddly-')
    ) {
      delete headers[name]
    }
  }
  headers.host = options.upstream.host
  headers.origin = options.upstream.origin
  headers.referer = `${options.upstream.origin}/`
  headers['accept-encoding'] = 'identity'
  return headers
}

function copyResponseHeaders(
  headers: IncomingHttpHeaders,
  res: Response,
  options: UpstreamProxyOptions,
  rewrittenBody: boolean
) {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
    if (rewrittenBody && REWRITTEN_BODY_HEADERS.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'set-cookie') {
      const cookies = rewriteSetCookieHeaders(value, options.cookieDomain)
      if (cookies) res.setHeader(name, cookies)
      continue
    }
    if (name.toLowerCase() === 'location') {
      const location = rewriteLocationHeader(String(value), [
        { upstreamHost: options.upstream.host, proxyHost: options.publicOrigin.host },
      ])
      if (location) res.setHeader(name, location)
      continue
    }
    res.setHeader(name, value)
  }
  if (options.responseHeaders) copyTransformedResponseHeaders(options.responseHeaders, res)
}

function copyTransformedResponseHeaders(headers: http.OutgoingHttpHeaders, res: Response) {
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      REWRITTEN_BODY_HEADERS.has(normalized)
    ) {
      continue
    }
    res.setHeader(name, value)
  }
}

function isRewriteCandidate(headers: IncomingHttpHeaders, limit: number): boolean {
  const contentType = String(headers['content-type'] || '').toLowerCase()
  const textual =
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('javascript') ||
    contentType.includes('xml')
  const contentLength = Number(headers['content-length'] || 0)
  return textual && contentLength > 0 && contentLength <= limit
}

function isBufferedJsonCandidate(
  req: Request,
  statusCode: number,
  headers: IncomingHttpHeaders,
  limit: number
): boolean {
  if (req.method.toUpperCase() === 'HEAD' || statusCode < 200 || statusCode >= 300) return false

  const contentType = String(headers['content-type'] || '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (
    contentType !== 'application/json' &&
    contentType !== 'text/json' &&
    !contentType?.endsWith('+json')
  ) {
    return false
  }

  const contentEncoding = String(headers['content-encoding'] || '')
    .trim()
    .toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') return false

  const rawContentLength = headers['content-length']
  if (rawContentLength === undefined) return true
  const contentLength = Number(
    Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
  )
  return Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= limit
}

function bufferedTextContentType(
  req: Request,
  statusCode: number,
  headers: IncomingHttpHeaders,
  contentTypes: readonly string[],
  limit: number
): string | null {
  if (req.method.toUpperCase() === 'HEAD' || statusCode < 200 || statusCode >= 300) return null

  const contentType = String(headers['content-type'] || '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (!contentType || !contentTypes.includes(contentType)) return null

  const contentEncoding = String(headers['content-encoding'] || '')
    .trim()
    .toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') return null

  const rawContentLength = headers['content-length']
  if (rawContentLength === undefined) return contentType
  const contentLength = Number(
    Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
  )
  return Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= limit
    ? contentType
    : null
}

function streamOriginalResponse(
  upstreamResponse: http.IncomingMessage,
  res: Response,
  options: UpstreamProxyOptions
) {
  res.status(upstreamResponse.statusCode || 502)
  copyResponseHeaders(upstreamResponse.headers, res, options, false)
  upstreamResponse.pipe(res)
}

function sendOriginalBuffer(
  body: Buffer,
  upstreamResponse: http.IncomingMessage,
  res: Response,
  options: UpstreamProxyOptions
) {
  res.status(upstreamResponse.statusCode || 502)
  copyResponseHeaders(upstreamResponse.headers, res, options, false)
  res.end(body)
}

function proxyRequest(
  req: Request,
  options: UpstreamProxyOptions,
  onResponse: (response: http.IncomingMessage) => void
) {
  const transport = options.upstream.protocol === 'http:' ? http : https
  return transport.request(
    options.upstream,
    {
      method: req.method,
      headers: createUpstreamRequestHeaders(req, options),
      path: req.originalUrl,
      ...(options.forwardProxy
        ? { agent: forwardProxyAgent(options.upstream, options.forwardProxy) }
        : {}),
    },
    onResponse
  )
}

export function createUpstreamProxy(options: UpstreamProxyOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const upstreamRequest = proxyRequest(req, options, (upstreamResponse) => {
      const shouldRewrite = isRewriteCandidate(upstreamResponse.headers, options.maxRewriteBytes)
      if (!shouldRewrite) {
        streamOriginalResponse(upstreamResponse, res, options)
        return
      }

      const chunks: Buffer[] = []
      upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamResponse.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8')
        const body = rewriteHosts(source, [
          { upstreamHost: options.upstream.host, proxyHost: options.publicOrigin.host },
          { upstreamHost: options.upstream.origin, proxyHost: options.publicOrigin.origin },
        ])
        res.status(upstreamResponse.statusCode || 502)
        copyResponseHeaders(upstreamResponse.headers, res, options, true)
        res.send(body)
      })
      upstreamResponse.on('error', next)
    })

    upstreamRequest.on('error', next)
    req.on('aborted', () => upstreamRequest.destroy())
    req.pipe(upstreamRequest)
  }
}

/**
 * Buffers only small successful JSON responses. Every failure to parse or transform is fail-open:
 * the original status, proxy-adjusted headers, and exact upstream bytes are returned instead.
 */
export function createBufferedJsonUpstreamProxy(options: BufferedJsonUpstreamProxyOptions) {
  if (!Number.isSafeInteger(options.maxRewriteBytes) || options.maxRewriteBytes <= 0) {
    throw new RangeError('maxRewriteBytes must be a positive safe integer')
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const upstreamRequest = proxyRequest(req, options, (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode || 502
      if (
        !isBufferedJsonCandidate(req, statusCode, upstreamResponse.headers, options.maxRewriteBytes)
      ) {
        streamOriginalResponse(upstreamResponse, res, options)
        return
      }

      let bufferedBytes = 0
      let fellBackToStreaming = false
      const chunks: Buffer[] = []

      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (bufferedBytes + buffer.length <= options.maxRewriteBytes) {
          chunks.push(buffer)
          bufferedBytes += buffer.length
          return
        }

        fellBackToStreaming = true
        upstreamResponse.pause()
        upstreamResponse.removeListener('data', onData)
        res.status(statusCode)
        copyResponseHeaders(upstreamResponse.headers, res, options, false)
        for (const buffered of chunks) res.write(buffered)
        res.write(buffer)
        chunks.length = 0
        upstreamResponse.pipe(res)
      }

      upstreamResponse.on('data', onData)
      upstreamResponse.on('end', () => {
        if (fellBackToStreaming) return
        const originalBody = Buffer.concat(chunks, bufferedBytes)

        void (async () => {
          let transformed: BufferedJsonTransformResult | null
          try {
            const source = originalBody.toString('utf8')
            const parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source)
            transformed = await options.transform(parsed, {
              request: req,
              responseHeaders: upstreamResponse.headers,
              statusCode,
            })
          } catch {
            sendOriginalBuffer(originalBody, upstreamResponse, res, options)
            return
          }

          if (transformed === null) {
            sendOriginalBuffer(originalBody, upstreamResponse, res, options)
            return
          }

          let body: string | undefined
          try {
            body = JSON.stringify(transformed.body)
          } catch {
            sendOriginalBuffer(originalBody, upstreamResponse, res, options)
            return
          }
          if (body === undefined) {
            sendOriginalBuffer(originalBody, upstreamResponse, res, options)
            return
          }

          res.status(statusCode)
          copyResponseHeaders(upstreamResponse.headers, res, options, true)
          if (transformed.headers) copyTransformedResponseHeaders(transformed.headers, res)
          // Use a separate write so Node does not synthesize a Content-Length for the new body.
          res.write(body)
          res.end()
        })()
      })
      upstreamResponse.on('error', next)
    })

    upstreamRequest.on('error', next)
    req.on('aborted', () => upstreamRequest.destroy())
    req.pipe(upstreamRequest)
  }
}

/**
 * Buffers only selected small successful text responses. Upstream host rewriting remains the
 * baseline behavior; a declined or failed custom transform still gets that existing rewrite.
 */
export function createBufferedTextUpstreamProxy(options: BufferedTextUpstreamProxyOptions) {
  if (!Number.isSafeInteger(options.maxRewriteBytes) || options.maxRewriteBytes <= 0) {
    throw new RangeError('maxRewriteBytes must be a positive safe integer')
  }
  const contentTypes = options.contentTypes.map((value) => value.trim().toLowerCase())

  return (req: Request, res: Response, next: NextFunction) => {
    const upstreamRequest = proxyRequest(req, options, (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode || 502
      const contentType = bufferedTextContentType(
        req,
        statusCode,
        upstreamResponse.headers,
        contentTypes,
        options.maxRewriteBytes
      )
      if (!contentType) {
        streamOriginalResponse(upstreamResponse, res, options)
        return
      }

      let bufferedBytes = 0
      let fellBackToStreaming = false
      const chunks: Buffer[] = []

      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (bufferedBytes + buffer.length <= options.maxRewriteBytes) {
          chunks.push(buffer)
          bufferedBytes += buffer.length
          return
        }

        fellBackToStreaming = true
        upstreamResponse.pause()
        upstreamResponse.removeListener('data', onData)
        res.status(statusCode)
        copyResponseHeaders(upstreamResponse.headers, res, options, false)
        for (const buffered of chunks) res.write(buffered)
        res.write(buffer)
        chunks.length = 0
        upstreamResponse.pipe(res)
      }

      upstreamResponse.on('data', onData)
      upstreamResponse.on('end', () => {
        if (fellBackToStreaming) return
        const originalBody = Buffer.concat(chunks, bufferedBytes)
        const source = originalBody.toString('utf8')
        const hostRewritten = rewriteHosts(source, [
          { upstreamHost: options.upstream.host, proxyHost: options.publicOrigin.host },
          { upstreamHost: options.upstream.origin, proxyHost: options.publicOrigin.origin },
        ])

        void (async () => {
          let transformed: BufferedTextTransformResult | null = null
          try {
            transformed = await options.transform(hostRewritten, {
              request: req,
              responseHeaders: upstreamResponse.headers,
              statusCode,
              contentType,
            })
          } catch {
            transformed = null
          }

          const body = transformed?.body ?? hostRewritten
          if (!transformed && body === source) {
            sendOriginalBuffer(originalBody, upstreamResponse, res, options)
            return
          }
          res.status(statusCode)
          copyResponseHeaders(upstreamResponse.headers, res, options, true)
          if (transformed?.headers) copyTransformedResponseHeaders(transformed.headers, res)
          res.write(body)
          res.end()
        })()
      })
      upstreamResponse.on('error', next)
    })

    upstreamRequest.on('error', next)
    req.on('aborted', () => upstreamRequest.destroy())
    req.pipe(upstreamRequest)
  }
}
