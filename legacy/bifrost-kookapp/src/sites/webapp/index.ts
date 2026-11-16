import { hotModuleOverride } from './rules/hot-module'
import { homePageInject, webappInject } from './rules/inject'
import { welcomeNoticeInject } from './rules/mail-list'

import { config } from '../../config'
import type { SiteDefinition } from '../../core/site'
import { assetUrlRewrite, commonApiOverrides, remoteEntryInject } from '../shared-rules'

/**
 * PC / Web 主站。当前唯一的兜底站点：没有被独立域名或路径前缀认领的请求都到这里。
 *
 * 这里刻意没有启用 siteUrlRewrite。webapp 里指向在线 H5 的 iframe 目前由页面侧
 * k-inject.js 改写到 dev 域名；一旦服务端先把 m.kookapp.cn 换成移动端代理域名，
 * k-inject 的前缀匹配就不再命中，那条 dev 跳转会静默失效。
 * 要让主站的 H5 iframe 走 bifrost 移动端，把 siteUrlRewrite 加进下面的文本规则段，
 * 同时移除 k-inject.js 里的 filterIframeSrc。
 */
export function createWebappSite(): SiteDefinition {
  return {
    id: 'webapp',
    upstream: config.upstream.webapp,
    fallback: true,
    rewriteCookieDomain: true,
    // 历史路径约定，客户端某些版本会带 /kookapp 前缀
    rewritePath: (url) => url.replace('/kookapp', ''),
    rules: [
      // ── 接口覆盖。必须排在文本规则之前，产物才能被后面的域名替换扫到 ──
      ...commonApiOverrides,
      hotModuleOverride,
      welcomeNoticeInject,

      // ── 文本改写。assetUrlRewrite 要在 webappInject 之前：
      //    后者的命中判断作用在替换后的 HTML 上 ──
      assetUrlRewrite,
      homePageInject,
      webappInject,
      remoteEntryInject,
    ],
  }
}
