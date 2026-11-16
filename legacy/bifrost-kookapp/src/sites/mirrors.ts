import { ASSET_MIRRORS } from './asset-map'
import { assetUrlRewrite, remoteEntryInject } from './shared-rules'

import { config } from '../config'
import type { SiteDefinition } from '../core/site'

/** 把 CDN 镜像表编译成站点定义 */
export function createMirrorSites(): SiteDefinition[] {
  return ASSET_MIRRORS.map((mirror) => ({
    id: mirror.id,
    upstream: `https://${mirror.host}`,
    mount: mirror.mount,
    // CDN 源站按请求头挑请求，且要求 Referer 指向主站
    spoofBrowserHeaders: true,
    referer: config.upstream.webapp,
    // 镜像回来的 JS/CSS 里仍会出现其它 CDN 域名，需要继续替换；
    // 官方 remoteEntry.js 也是从 img.kookapp.cn 过来的，注入规则挂在这里。
    rules: [assetUrlRewrite, remoteEntryInject],
  }))
}
