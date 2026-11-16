import { assetUrlRewrite, commonApiOverrides, rewriteUpstreamHosts, siteUrlRewrite } from './shared-rules'

import { config } from '../config'
import type { SiteDefinition } from '../core/site'

/**
 * 商户后台（biz.kookapp.cn），对外为 bifrost-api-biz.vanillacake.cn。
 *
 * 与移动端一样先跑通用基线。biz 的接口面与 C 端不同，commonApiOverrides 里
 * 匹配不到的规则不会生效，等真正要覆盖 biz 自己的接口时再在 sites/biz/rules/ 下补。
 */
export function createBizSite(): SiteDefinition | null {
  if (!config.hostname.biz) {
    return null
  }
  return {
    id: 'biz',
    upstream: config.upstream.biz,
    hostnames: [config.hostname.biz],
    rewriteCookieDomain: true,
    rewriteLocation: rewriteUpstreamHosts,
    rules: [...commonApiOverrides, assetUrlRewrite, siteUrlRewrite],
  }
}
