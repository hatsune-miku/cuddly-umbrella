import { config } from '../config'

/**
 * 端映射表：每个上游端对应本服务上的哪个域名。
 *
 * 各端之间是互相跳转的 —— webapp 里用 iframe 打开在线 H5、H5 里链回主站、
 * 页面和接口体里都散着对方的绝对地址。不改写的话点一下就跳出私服回到线上，
 * 登录态和响应覆盖全部失效。
 *
 * 只登记有独立代理域名的端；没配 hostname 的端不参与改写。
 */
const SITE_ENDS = [
  { id: 'webapp', upstream: config.upstream.webapp, hostname: config.hostname.webapp },
  { id: 'mobile', upstream: config.upstream.mobile, hostname: config.hostname.mobile },
  { id: 'biz', upstream: config.upstream.biz, hostname: config.hostname.biz },
]

/** 上游端域名 → 本服务代理域名 */
export const SITE_HOST_MAP: Record<string, string> = Object.fromEntries(
  SITE_ENDS.filter((end) => end.hostname).map((end) => [new URL(end.upstream).host, end.hostname])
)
