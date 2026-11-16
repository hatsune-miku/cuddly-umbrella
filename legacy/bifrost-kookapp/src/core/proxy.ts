import type { Express, RequestHandler } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'

import { createResponseHandler } from './interceptor'
import { rewriteSetCookieDomain, stashOriginalCookies } from './set-cookie'
import type { MountedSite, SiteDefinition } from './site'

import { config } from '../config'

/**
 * 伪装成 Chrome 直接访问的请求头。CDN 源站对缺头的请求会返回异常内容，
 * 所以镜像类站点需要补上一整套，而不是转发客户端原始头。
 */
function browserHeaders(referer: string): Map<string, string> {
  return new Map(
    Object.entries({
      'cache-control': 'no-cache',
      'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'upgrade-insecure-requests': '1',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
      referer,
    })
  )
}

/** 把站点定义编译成一条完整的中间件链：路径重写 → Cookie 改写 → 代理 → 响应改写 */
export function createSiteHandler(site: SiteDefinition): RequestHandler {
  const upstreamHost = new URL(site.upstream).host
  const referer = site.referer || site.upstream
  const headers = site.spoofBrowserHeaders ? browserHeaders(referer) : null

  const interceptResponse = responseInterceptor(createResponseHandler(site.rules || []))

  const proxy = createProxyMiddleware({
    target: site.upstream,
    changeOrigin: true,
    selfHandleResponse: true,
    on: {
      proxyReq: (proxyReq, req: any) => {
        req.startTime = Date.now()
        if (headers) {
          proxyReq.setHeaders(headers)
        }
      },
      proxyRes: async (proxyRes, req, res: any) => {
        // 这两步都必须在 interceptResponse 之前：它随后会把响应头整体拷给客户端
        stashOriginalCookies(proxyRes, res)
        if (site.rewriteLocation && proxyRes.headers.location) {
          proxyRes.headers.location = site.rewriteLocation(proxyRes.headers.location)
        }
        await interceptResponse(proxyRes, req, res)
      },
    },
  })

  const chain: RequestHandler[] = [
    (req, _res, next) => {
      if (site.rewritePath) {
        req.url = site.rewritePath(req.url)
      }
      // 让上游把请求当成来自它自己的站内请求
      req.headers.host = upstreamHost
      req.headers.referer = referer
      next()
    },
  ]

  if (site.rewriteCookieDomain) {
    chain.push(rewriteSetCookieDomain())
  }

  chain.push(proxy)

  return (req, res, next) => {
    let index = 0
    const run = (err?: any) => {
      if (err) {
        return next(err)
      }
      const handler = chain[index++]
      return handler ? handler(req, res, run) : next()
    }
    run()
  }
}

/**
 * 把站点注册表挂到 app 上。匹配优先级：Host > 路径前缀 > 兜底站点。
 *
 * Host 优先意味着给某个端配了独立二级域名后，它会完整接管该域名下的所有请求，
 * 不会被兜底站点的规则误伤。
 */
export function mountSites(app: Express, sites: SiteDefinition[]): MountedSite[] {
  const mounted: MountedSite[] = sites.map((site) => ({ site, handler: createSiteHandler(site) }))

  const byHostname = new Map<string, MountedSite>()
  for (const entry of mounted) {
    for (const hostname of entry.site.hostnames || []) {
      byHostname.set(hostname.toLowerCase(), entry)
    }
  }

  if (byHostname.size > 0) {
    app.use((req, res, next) => {
      const matched = byHostname.get((req.hostname || '').toLowerCase())
      if (config.logRouting) {
        console.log(
          `[bifrost] host=${req.hostname} xfh=${req.headers['x-forwarded-host'] || '-'} → ${matched?.site.id || '(未命中，交给路径前缀/兜底)'}`
        )
      }
      return matched ? matched.handler(req, res, next) : next()
    })
  }

  for (const { site, handler } of mounted) {
    if (site.mount) {
      app.use(site.mount, handler)
    }
  }

  const fallback = mounted.find(({ site }) => site.fallback)
  if (fallback) {
    app.use('/', fallback.handler)
  }

  return mounted
}
