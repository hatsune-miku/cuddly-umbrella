import type { RequestHandler } from 'express'

import type { Rule } from './interceptor'

/**
 * 一个被代理的上游端。webapp、在线 H5、商户后台、各 CDN 镜像都是站点，
 * 差别只在上游地址、识别方式和生效的改写规则。新增一个端 = 往注册表加一条。
 */
export interface SiteDefinition {
  /** 站点标识，出现在启动日志里 */
  id: string

  /** 上游源站，形如 https://www.kookapp.cn */
  upstream: string

  /**
   * 本服务上用于识别该站点的 Host 列表。
   * 独立二级域名是首选方案：SPA 的绝对路径、Cookie 作用域和 WebSocket 都不需要额外适配。
   */
  hostnames?: string[]

  /**
   * 路径前缀挂载点，形如 /assets。转发给上游前会被 Express 剥掉。
   * 只适合本身不含绝对路径的资源类上游，主站类站点应当用 hostnames。
   */
  mount?: string

  /** 兜底站点：所有未被 hostname 和 mount 命中的请求都归它。整个注册表最多一个 */
  fallback?: boolean

  /** 伪装成浏览器直接访问。CDN 源站会按请求头挑请求，走 mount 的镜像需要打开 */
  spoofBrowserHeaders?: boolean

  /** 伪装请求头里的 Referer，留空则用站点自己的 upstream */
  referer?: string

  /** 把上游 Set-Cookie 的 Domain 改写到本服务域名下，登录态才能在代理域工作 */
  rewriteCookieDomain?: boolean

  /** 转发前重写请求路径。用于处理该站点的历史路径约定 */
  rewritePath?: (url: string) => string

  /**
   * 改写 3xx 响应的 Location 头。
   *
   * 响应体里的域名由 rules 处理，但重定向走的是响应头 —— 上游一个 302 指回官方域名，
   * 浏览器就直接跳出私服了，登录态和响应覆盖全部失效。
   */
  rewriteLocation?: (location: string) => string

  /** 该站点生效的响应改写规则，按数组顺序执行 */
  rules?: Rule[]
}

/** 站点定义 + 编译好的中间件 */
export interface MountedSite {
  site: SiteDefinition
  handler: RequestHandler
}
