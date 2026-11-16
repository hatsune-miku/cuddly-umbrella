import { publicHost } from '../config'

/**
 * CDN 镜像表。上游把静态资源和图片放在独立域名上，这些域名不接受代理域的 Cookie，
 * 也没有对应的 CORS 头，所以整体镜像到本服务的路径前缀下。
 *
 * 这张表是资源 URL 重写的唯一事实来源：镜像站点定义、响应体里的域名替换、
 * 以及页面侧 k-inject.js 需要的映射表，全部由它派生。
 */
export const ASSET_MIRRORS = [
  { id: 'kook-static', host: 'static.kookapp.cn', mount: '/static' },
  { id: 'kook-assets', host: 'img.kookapp.cn', mount: '/assets' },
  { id: 'kaiheila-static', host: 'static.kaiheila.cn', mount: '/kaiheila-static' },
  { id: 'kaiheila-assets', host: 'img.kaiheila.cn', mount: '/kaiheila-assets' },
] as const

/** 上游 CDN 域名 → 本服务镜像地址（不含协议，用于文本替换） */
export const ASSET_HOST_MAP: Record<string, string> = Object.fromEntries(
  ASSET_MIRRORS.map((mirror) => [mirror.host, `${publicHost}${mirror.mount}`])
)
