import { Router } from 'express'

import { config } from '../config'
import type { SiteDefinition } from '../core/site'

/**
 * 自诊断：让服务自己说出它究竟收到了什么 Host、按这个 Host 会分发到哪个站点。
 *
 * 域名分发出问题时，绝大多数情况不是分发逻辑错了，而是请求到达本服务时 Host 已经
 * 不是浏览器发出的那个了（反代没配 server 块、或者 proxy_set_header Host 写死了）。
 * 这个端点把判断依据直接摊开，省得靠猜。
 *
 *   curl -H 'Host: bifrost-api-mobile.vanillacake.cn' http://127.0.0.1:9872/__bifrost/whoami
 */
export function createDiagnosticsRouter(sites: SiteDefinition[]): Router {
  const router = Router()

  router.get('/__bifrost/whoami', (req, res) => {
    const hostname = (req.hostname || '').toLowerCase()
    const matched = sites.find((site) => (site.hostnames || []).some((h) => h.toLowerCase() === hostname))
    const fallback = sites.find((site) => site.fallback)

    res.json({
      收到的请求头: {
        host: req.headers.host || null,
        'x-forwarded-host': req.headers['x-forwarded-host'] || null,
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || null,
        'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      },
      express解析出的hostname: req.hostname,
      命中站点: matched ? { id: matched.id, upstream: matched.upstream } : null,
      实际会走: matched
        ? `${matched.id} → ${matched.upstream}`
        : `未命中任何域名，落到兜底站点 ${fallback?.id} → ${fallback?.upstream}`,
      已注册站点: sites.map((site) => ({
        id: site.id,
        upstream: site.upstream,
        hostnames: site.hostnames || [],
        mount: site.mount || null,
        fallback: !!site.fallback,
      })),
      cookie作用域: config.cookieDomain || '(未配置 DOMAIN，不改写)',
    })
  })

  return router
}
