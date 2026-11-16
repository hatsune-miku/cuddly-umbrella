// 响应改写引擎。
//
// 一条 Rule 描述「命中哪些请求、以什么形态改写响应体」，站点把自己需要的 Rule 列成数组，
// 引擎按数组顺序依次执行。顺序是契约的一部分：json 规则先跑，产出的 JSON 会被后面的
// text 规则当作普通文本继续处理（CDN 域名替换正是靠这一点同时作用于 HTML 和接口响应）。

/** 规则拿到的响应体。json 规则读写 data，text 规则读写 text */
export interface RuleContext<T = any> {
  /** 响应体文本 */
  text: string
  /** 解析后的响应体；仅 json 规则可用，解析失败时该规则被跳过 */
  data: T
  /** 原始请求，用于取 query / header */
  req: any
}

/** 字符串按 url 子串包含匹配，正则按 url 匹配，函数自定义 */
export type RuleMatcher = string | RegExp | ((url: string, req: any) => boolean)

export interface Rule<T = any> {
  /** 排错用的名字，出现在解析失败等日志里 */
  name: string
  /**
   * json：先 JSON.parse，规则改完 data 后再 stringify 回响应体；
   *       规则也可以直接改 ctx.text 整体接管输出。
   * text：不做解析，规则直接操作原始文本。
   */
  kind: 'json' | 'text'
  match: RuleMatcher
  apply(ctx: RuleContext<T>): void | Promise<void>
}

// 二进制与富媒体响应不进改写链路，避免把它们 toString 成乱码。
const BINARY_EXTENSIONS = [
  'png',
  'webp',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'ico',
  'bmp',
  'tiff',
  'tif',
  'avif',
  'heic',
  'heif',
  'mp4',
  'mp3',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'wmv',
  'flv',
  'mkv',
  'm4v',
  'm4a',
  'm4b',
  'm4r',
  'm4p',
  'aac',
  'pag',
  'pdf',
  'epub',
  'mobi',
  'azw3',
  'azw',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ttf',
  'woff',
  'woff2',
  'ttc',
  'otf',
  'eot',
  'wasm',
]

const BINARY_PATTERN = new RegExp(`\\.(${BINARY_EXTENSIONS.join('|')})(\\?.*)?`, 'i')

function matches(matcher: RuleMatcher, url: string, req: any): boolean {
  if (typeof matcher === 'string') {
    return url.includes(matcher)
  }
  if (matcher instanceof RegExp) {
    return matcher.test(url)
  }
  return matcher(url, req)
}

/**
 * 把一组规则编译成 http-proxy-middleware 的 responseInterceptor 回调。
 * 返回 Buffer 表示原样放行（二进制），返回 string 表示替换响应体。
 */
export function createResponseHandler(rules: Rule[]) {
  return async function intercept(buffer: Buffer, _proxyRes: any, req: any): Promise<Buffer | string> {
    const url: string = req.url || ''
    if (BINARY_PATTERN.test(url)) {
      return buffer
    }
    if (rules.length === 0) {
      return buffer
    }

    let text = buffer.toString('utf-8')

    for (const rule of rules) {
      if (!matches(rule.match, url, req)) {
        continue
      }

      const ctx: RuleContext = { text, data: null, req }

      if (rule.kind === 'json') {
        try {
          ctx.data = JSON.parse(text)
        } catch {
          console.warn('xx', 'failed to parse json', rule.name, url)
          continue
        }
      }

      await rule.apply(ctx)

      // json 规则默认把改后的 data 写回；但若它直接动了 ctx.text，则以 text 为准。
      const tookOverText = ctx.text !== text
      text = rule.kind === 'json' && !tookOverText ? JSON.stringify(ctx.data) : ctx.text
    }

    return text
  }
}
