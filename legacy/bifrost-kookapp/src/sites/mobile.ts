import { assetUrlRewrite, commonApiOverrides, rewriteUpstreamHosts, siteUrlRewrite } from './shared-rules'

import { config } from '../config'
import type { SiteDefinition } from '../core/site'

/**
 * 移动端在线 H5（m.kookapp.cn），对外为 bifrost-api-mobile.vanillacake.cn。
 *
 * 注意与主仓库里的 apps/h5 区分：那是随客户端分发的离线 H5，这里代理的是独立仓库
 * html_h5 的在线版本，两者不是同一个东西。
 *
 * 目前跑的是通用基线：端无关的接口覆盖、CDN 镜像、端间链接改写。
 * H5 专有的覆盖规则后续放到 sites/mobile/rules/ 下，再加进 rules 数组。
 */
export function createMobileSite(): SiteDefinition | null {
  if (!config.hostname.mobile) {
    return null
  }
  return {
    id: 'mobile',
    upstream: config.upstream.mobile,
    hostnames: [config.hostname.mobile],
    // 与主站共享登录态：Domain 统一改写到配置的父域上
    rewriteCookieDomain: true,
    rewriteLocation: rewriteUpstreamHosts,
    rules: [...commonApiOverrides, assetUrlRewrite, siteUrlRewrite],
  }
}
