import { createServer, type RequestListener, type Server } from 'node:http'

import express from 'express'
import { describe, expect, it, vi } from 'vitest'

import { createBufferedJsonUpstreamProxy, type BufferedJsonUpstreamProxyOptions } from './proxy'

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP address'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function withBufferedProxy(
  upstreamHandler: RequestListener,
  proxyOptions: Pick<BufferedJsonUpstreamProxyOptions, 'maxRewriteBytes' | 'transform'>,
  run: (gatewayOrigin: string, upstreamOrigin: string) => Promise<void>
) {
  const upstream = createServer(upstreamHandler)
  const upstreamOrigin = await listen(upstream)
  const gatewayApp = express()
  gatewayApp.use(
    createBufferedJsonUpstreamProxy({
      upstream: new URL(upstreamOrigin),
      publicOrigin: new URL('https://main.bifrost.example.com'),
      cookieDomain: 'bifrost.example.com',
      ...proxyOptions,
    })
  )
  const gateway = createServer(gatewayApp)
  const gatewayOrigin = await listen(gateway)

  try {
    await run(gatewayOrigin, upstreamOrigin)
  } finally {
    await close(gateway)
    await close(upstream)
  }
}

describe('bounded buffered JSON upstream proxy', () => {
  it('preserves the request and rewrites a successful JSON response with explicit headers', async () => {
    const requests: Array<{
      body: string
      headers: Record<string, string | string[] | undefined>
      method?: string
      url?: string
    }> = []
    const source = '{ "data": { "official": true } }'
    const transform = vi.fn((body: unknown) => ({
      body: { ...(body as object), overlaid: true },
      headers: {
        'Cache-Control': 'no-store',
        'Content-Encoding': 'gzip',
        'Content-Length': '9999',
        ETag: '"replacement"',
        'X-Cuddly-Overlay': 'active',
      },
    }))

    await withBufferedProxy(
      (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          requests.push({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: req.headers,
            method: req.method,
            url: req.url,
          })
          res.writeHead(200, {
            'Cache-Control': 'private, max-age=60',
            'Content-Encoding': 'identity',
            'Content-Length': Buffer.byteLength(source),
            'Content-Type': 'application/json; charset=utf-8',
            ETag: '"official"',
          })
          res.end(source)
        })
      },
      { maxRewriteBytes: 1024, transform },
      async (gatewayOrigin, upstreamOrigin) => {
        const response = await fetch(
          `${gatewayOrigin}/api/v3/version/hot-module?platform=web&cursor=42`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer qa-session',
              'Content-Type': 'application/json',
              Cookie: 'session=upstream-cookie',
              Origin: 'https://client.example.com',
              Referer: 'https://client.example.com/channels/1',
              'X-Business-Header': 'preserved',
              'X-Cuddly-Preview-Token': 'must-not-leak',
            },
            body: '{"request":"latest"}',
          }
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ data: { official: true }, overlaid: true })
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-length')).toBeNull()
        expect(response.headers.get('content-encoding')).toBeNull()
        expect(response.headers.get('etag')).toBeNull()
        expect(response.headers.get('x-cuddly-overlay')).toBe('active')

        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          body: '{"request":"latest"}',
          method: 'POST',
          url: '/api/v3/version/hot-module?platform=web&cursor=42',
        })
        expect(requests[0]?.headers).toMatchObject({
          'accept-encoding': 'identity',
          authorization: 'Bearer qa-session',
          cookie: 'session=upstream-cookie',
          host: new URL(upstreamOrigin).host,
          origin: upstreamOrigin,
          referer: `${upstreamOrigin}/`,
          'x-business-header': 'preserved',
        })
        expect(requests[0]?.headers['x-cuddly-preview-token']).toBeUndefined()
        expect(transform).toHaveBeenCalledOnce()
      }
    )
  })

  it('buffers and transforms a chunked JSON response', async () => {
    const transform = vi.fn(async (body: unknown) => ({
      body: { ...(body as object), selected: 'feature/chat' },
    }))

    await withBufferedProxy(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/problem+json' })
        res.write('{"modules":')
        res.write('["base"]}')
        res.end()
      },
      { maxRewriteBytes: 128, transform },
      async (gatewayOrigin) => {
        const response = await fetch(`${gatewayOrigin}/v3/version/hot-module`)
        expect(await response.json()).toEqual({
          modules: ['base'],
          selected: 'feature/chat',
        })
        expect(transform).toHaveBeenCalledOnce()
      }
    )
  })

  it('fails open with the exact original body when transform declines or throws', async () => {
    const sources = {
      '/decline': '{ "source": "declined", "spacing": true }',
      '/throw': '{ "source": "exception", "spacing": true }',
    } as const
    const transform = vi.fn((_body: unknown, context: { request: { path: string } }) => {
      if (context.request.path === '/decline') return null
      throw new Error('overlay unavailable')
    })

    await withBufferedProxy(
      (req, res) => {
        const source = sources[req.url as keyof typeof sources]
        if (!source) return void res.writeHead(404).end()
        res.writeHead(203, {
          'Content-Length': Buffer.byteLength(source),
          'Content-Type': 'application/json',
          ETag: `"${req.url?.slice(1)}"`,
          'X-Upstream-Response': 'preserved',
        })
        res.end(source)
      },
      { maxRewriteBytes: 128, transform },
      async (gatewayOrigin) => {
        for (const [path, source] of Object.entries(sources)) {
          const response = await fetch(`${gatewayOrigin}${path}`)
          expect(response.status).toBe(203)
          expect(await response.text()).toBe(source)
          expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(source)))
          expect(response.headers.get('etag')).toBe(`"${path.slice(1)}"`)
          expect(response.headers.get('x-upstream-response')).toBe('preserved')
        }
        expect(transform).toHaveBeenCalledTimes(2)
      }
    )
  })

  it('streams declared and chunked over-limit bodies without losing buffered bytes', async () => {
    const declared = '{"payload":"declared body is too large"}'
    const chunked = '{"payload":"chunked body is too large"}'
    const transform = vi.fn(() => ({ body: { unexpected: true } }))

    await withBufferedProxy(
      (req, res) => {
        const isDeclared = req.url === '/declared'
        const source = isDeclared ? declared : chunked
        res.writeHead(200, {
          ...(isDeclared ? { 'Content-Length': Buffer.byteLength(source) } : {}),
          'Content-Type': 'application/json',
          ETag: `"${isDeclared ? 'declared' : 'chunked'}"`,
        })
        if (isDeclared) {
          res.end(source)
          return
        }
        res.write(source.slice(0, 8))
        res.write(source.slice(8, 18))
        res.end(source.slice(18))
      },
      { maxRewriteBytes: 16, transform },
      async (gatewayOrigin) => {
        const declaredResponse = await fetch(`${gatewayOrigin}/declared`)
        expect(await declaredResponse.text()).toBe(declared)
        expect(declaredResponse.headers.get('content-length')).toBe(
          String(Buffer.byteLength(declared))
        )
        expect(declaredResponse.headers.get('etag')).toBe('"declared"')

        const chunkedResponse = await fetch(`${gatewayOrigin}/chunked`)
        expect(await chunkedResponse.text()).toBe(chunked)
        expect(chunkedResponse.headers.get('etag')).toBe('"chunked"')
        expect(transform).not.toHaveBeenCalled()
      }
    )
  })

  it('passes through unauthorized, non-JSON, and HEAD responses without transforming', async () => {
    const transform = vi.fn(() => ({ body: { unexpected: true } }))

    await withBufferedProxy(
      (req, res) => {
        if (req.url === '/unauthorized') {
          const source = '{"code":"UNAUTHORIZED"}'
          res.writeHead(401, {
            'Content-Length': Buffer.byteLength(source),
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="kook"',
          })
          res.end(source)
          return
        }
        if (req.url === '/plain') {
          res.writeHead(200, { 'Content-Type': 'text/plain', ETag: '"plain"' })
          res.end('{"looks":"json"}')
          return
        }
        res.writeHead(200, {
          'Content-Length': '24',
          'Content-Type': 'application/json',
          ETag: '"head"',
        })
        res.end()
      },
      { maxRewriteBytes: 128, transform },
      async (gatewayOrigin) => {
        const unauthorized = await fetch(`${gatewayOrigin}/unauthorized`)
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.text()).toBe('{"code":"UNAUTHORIZED"}')
        expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer realm="kook"')

        const plain = await fetch(`${gatewayOrigin}/plain`)
        expect(await plain.text()).toBe('{"looks":"json"}')
        expect(plain.headers.get('etag')).toBe('"plain"')

        const head = await fetch(`${gatewayOrigin}/head`, { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe('')
        expect(head.headers.get('content-length')).toBe('24')
        expect(head.headers.get('etag')).toBe('"head"')
        expect(transform).not.toHaveBeenCalled()
      }
    )
  })
})
