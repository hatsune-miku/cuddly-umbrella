import cors from 'cors'
import express from 'express'

import { config } from './config'
import { mountSites } from './core/proxy'
import { createDiagnosticsRouter } from './routes/diagnostics'
import { createFeishuSsoRouter } from './routes/feishu-sso'
import { createMisOperationRouter } from './routes/mis-operation'
import { createSites } from './sites'

const app = express()

// 站点路由按 Host 分发，服务跑在反代后面，需要认 X-Forwarded-* 才能拿到真实域名
app.set('trust proxy', true)

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['*'],
    credentials: true,
  })
)

const sites = createSites()

// 控制面路由要先于站点注册：站点里的兜底站点会接管剩下的一切
app.use(createFeishuSsoRouter())
app.use(createMisOperationRouter())
app.use(createDiagnosticsRouter(sites))

mountSites(app, sites)

app.listen(config.port, () => {
  console.log(`[bifrost] listening on ${config.port}`)
  for (const site of sites) {
    const via = site.hostnames?.length ? site.hostnames.join(', ') : site.mount || '(fallback)'
    console.log(`[bifrost]   ${site.id.padEnd(16)} ${via}  →  ${site.upstream}`)
  }
})
