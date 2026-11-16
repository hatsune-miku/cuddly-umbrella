import path from 'path'

// .env 由 Bun 在启动时自动加载，不需要 dotenv

function env(key: string, fallback?: string): string {
  const value = process.env[key]
  if (value === undefined || value === '') {
    if (fallback === undefined) {
      return ''
    }
    return fallback
  }
  return value
}

function envInt(key: string, fallback: number): number {
  const parsed = Number.parseInt(env(key), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 全服务唯一的配置出口。所有对外域名、上游地址和凭据都只在这里出现一次，
 * 其余模块一律从这里取，不再各自硬编码。
 */
export const config = {
  port: envInt('PORT', 9872),

  /** 打开后每个请求都会打一行「收到的 Host → 命中的站点」，排查域名分发用 */
  logRouting: env('LOG_ROUTING') === '1',

  /** 本服务对外的 Cookie 作用域。上游 Set-Cookie 的 Domain 会被改写到它上面 */
  cookieDomain: env('DOMAIN'),

  /** 本服务对外基址，CDN 镜像 URL 由它拼出 */
  publicOrigin: env('PUBLIC_ORIGIN', 'https://bifrost-api.vanillacake.cn'),

  /** 管理端（bifrost-mis）基址，页面侧注入脚本从这里加载 */
  misOrigin: env('MIS_ORIGIN', 'https://bifrost-api-mis.vanillacake.cn'),

  /** 各上游源站。新增端时在这里登记地址 */
  upstream: {
    webapp: env('UPSTREAM_WEBAPP', 'https://www.kookapp.cn'),
    mobile: env('UPSTREAM_MOBILE', 'https://m.kookapp.cn'),
    biz: env('UPSTREAM_BIZ', 'https://biz.kookapp.cn'),
  },

  /**
   * 各端在本服务上使用的 Host。留空表示该端不启用。
   *
   * webapp 同时是兜底站点，不靠 Host 匹配也能工作，但仍要登记：
   * 站点间的链接改写需要知道每个上游端对应哪个代理域名。
   */
  hostname: {
    webapp: env('HOSTNAME_WEBAPP', 'bifrost-api.vanillacake.cn'),
    mobile: env('HOSTNAME_MOBILE', 'bifrost-api-mobile.vanillacake.cn'),
    biz: env('HOSTNAME_BIZ', 'bifrost-api-biz.vanillacake.cn'),
  },

  feishu: {
    appId: env('FEISHU_APP_ID'),
    appSecret: env('FEISHU_APP_SECRET'),
    redirectUri: env('FEISHU_REDIRECT_URI', 'https://bifrost-api.vanillacake.cn/feishu-sso-callback'),
  },

  /**
   * misData 落盘位置：项目根下的 mis-data.json。
   *
   * 从本文件所在的 src/ 往上一级定位，不依赖启动时的工作目录。
   * （注意别写成两级 —— 那是 tsc 时代 dist/src 布局留下的深度，会跑到项目外面。）
   */
  misDataFile: env('MIS_DATA_FILE') || path.resolve(import.meta.dir, '../mis-data.json'),
}

/** publicOrigin 去掉协议头的部分，用于在 HTML/JS 文本里做域名替换 */
export const publicHost = config.publicOrigin.replace(/^https?:\/\//, '')
