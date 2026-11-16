import { discoverTabListOverride, discoverViewOverride } from './api/discover'
import { mallDecorationOverride } from './api/mall'
import { userSettingsOverride } from './api/user-settings'
import { ASSET_HOST_MAP } from './asset-map'
import { SITE_HOST_MAP } from './site-map'

import { config } from '../config'
import type { Rule } from '../core/interceptor'

const MIRROR_ENTRIES = Object.entries(ASSET_HOST_MAP)
const SITE_ENTRIES = Object.entries(SITE_HOST_MAP)

function replaceHosts(text: string, entries: [string, string][]): string {
  let result = text
  for (const [upstreamHost, replacement] of entries) {
    if (result.includes(upstreamHost)) {
      result = result.replaceAll(upstreamHost, replacement)
    }
  }
  return result
}

/**
 * 把一个 URL 里的上游域名换成本服务的对应地址，CDN 和各端一并处理。
 *
 * 除了响应体，3xx 的 Location 头也要过这一道 —— 上游一个跳转就能把浏览器
 * 送出私服，那时候登录态和响应覆盖全都没了。
 */
export function rewriteUpstreamHosts(url: string): string {
  return replaceHosts(replaceHosts(url, SITE_ENTRIES), MIRROR_ENTRIES)
}

/**
 * 把响应体里出现的上游 CDN 域名替换成本服务的镜像路径。
 *
 * 对所有文本响应生效，包括接口返回的 JSON —— 商城、发现页等接口体内嵌了大量图片 URL，
 * 不替换的话浏览器会直接去请求官方 CDN。因此它必须排在各 json 规则之后：
 * 那时 json 规则的产物已经被序列化回文本，才能一并被替换到。
 */
export const assetUrlRewrite: Rule = {
  name: 'asset-url-rewrite',
  kind: 'text',
  match: () => true,
  apply(ctx) {
    ctx.text = replaceHosts(ctx.text, MIRROR_ENTRIES)
  },
}

/**
 * 把响应体里出现的其它端的域名替换成对应的代理域名，让跳转留在私服内部。
 *
 * 与 assetUrlRewrite 同理，必须排在 json 规则之后才能覆盖接口体里的绝对地址。
 */
export const siteUrlRewrite: Rule = {
  name: 'site-url-rewrite',
  kind: 'text',
  match: () => true,
  apply(ctx) {
    ctx.text = replaceHosts(ctx.text, SITE_ENTRIES)
  },
}

/**
 * 端无关的接口覆盖基线。这些接口在主站和移动端是同一套后端，
 * 覆盖也应当一致，否则同一个私服在不同端会呈现不同数据。
 *
 * 只放确实跨端通用的规则；某个端专有的覆盖放到该端自己的 rules/ 下。
 */
export const commonApiOverrides: Rule[] = [
  userSettingsOverride,
  discoverTabListOverride,
  discoverViewOverride,
  mallDecorationOverride,
]

/**
 * 给 Module Federation 的 remoteEntry.js 追加一段自举代码，把页面侧 Hook 拉起来。
 *
 * remote 是在 host 启动后动态加载的，此时 HTML 里注入的脚本可能已经跑完，
 * 所以每个 remoteEntry 都要保证 k-inject 存在。
 */
export const remoteEntryInject: Rule = {
  name: 'remote-entry-inject',
  kind: 'text',
  match: 'remoteEntry.js',
  apply(ctx) {
    if (ctx.text.includes('k-inject.js')) {
      return
    }
    ctx.text += `\n
      if (!window._kinjectscript) {
        const _payloadUrl = '${config.misOrigin}/k-inject.js'
        const _kinjectscript = document.createElement('script')
        _kinjectscript.src = _payloadUrl
        document.head.appendChild(_kinjectscript)
        window._kinjectscript = true

        fetch(_payloadUrl).then(res => res.text()).then(raw => {
          setTimeout(() => {
            console.log('k-inject.js eval')
            eval(raw)
          }, 1000)
        })
      }
    \n`
  },
}
