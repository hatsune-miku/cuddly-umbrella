import { config } from '../../../config'
import type { Rule } from '../../../core/interceptor'

function injectIntoHead(html: string, tags: string[]): string {
  return html.replace('<head>', ['<head>', ...tags].join('\n'))
}

/**
 * 官网首页：去掉客户端下载按钮，把「快速开始」改成进入私服。
 *
 * 命中判断依赖首页文案，上游改版会静默失效 —— 这类页面特征匹配是已知的脆弱点，
 * 只能用于这种失效了也不影响主流程的场景。
 */
export const homePageInject: Rule = {
  name: 'home-page-inject',
  kind: 'text',
  match: () => true,
  apply(ctx) {
    if (!ctx.text.includes('index-page') || !ctx.text.includes('不散场的轰趴')) {
      return
    }
    ctx.text = injectIntoHead(ctx.text, [`<script src="${config.misOrigin}/k-inject-home.js"></script>`])
  },
}

/**
 * webapp 外壳：注入页面侧 Hook。
 *
 * 服务端改不到的地方（img 元素、WebSocket 帧、IM 消息体、iframe 跳转）都靠这段脚本
 * 在页面上下文里补，pako 用于解开压缩过的 WebSocket 帧。
 */
export const webappInject: Rule = {
  name: 'webapp-inject',
  kind: 'text',
  match: () => true,
  apply(ctx) {
    // 只有 webapp 外壳带这个 favicon 标签，用它把 SPA 的 HTML 与其它文本响应区分开
    if (!/<link rel="icon shortcut" id="favicon"/.test(ctx.text)) {
      return
    }
    ctx.text = injectIntoHead(ctx.text, [
      '<script src="https://cdn.bootcdn.net/ajax/libs/pako/2.1.0/pako.es5.min.js"></script>',
      `<script src="${config.misOrigin}/k-inject.js"></script>`,
    ])
  },
}
