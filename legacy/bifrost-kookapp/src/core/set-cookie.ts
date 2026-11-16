import type { RequestHandler, Response } from 'express'
import type { IncomingMessage } from 'http'

import { config } from '../config'

/**
 * Set-Cookie 的 Domain 改写。
 *
 * 目标是让登录态在整个 bifrost 域下通用：主站、移动端、商户后台各占一个二级域名，
 * 但共享同一份登录态，所以统一把 Domain 改写到配置的父域上。
 *
 * 这里绕了一道弯：http-proxy-middleware 的 responseInterceptor 在拷贝上游响应头时，
 * 会自作主张地用惰性正则 /Domain=[^;]+?/i 去剥 Domain —— 惰性匹配只吃掉 `Domain=` 加一个字符，
 * 把 `Domain=kookapp.cn` 剩成非法的 `; ookapp.cn`。等中间件拿到值时原属性已经不存在了。
 *
 * 所以在 hpm 动手之前先把上游原始 Cookie 暂存下来，改写时直接丢弃 hpm 的产物、以原始值为准。
 */

const ORIGINAL_SET_COOKIE = Symbol('bifrost.originalSetCookie')

/** 在 hpm 拷贝响应头之前调用，暂存上游原始 Set-Cookie */
export function stashOriginalCookies(proxyRes: IncomingMessage, res: Response) {
  const cookies = proxyRes.headers['set-cookie']
  if (cookies) {
    res[ORIGINAL_SET_COOKIE] = cookies
  }
}

function applyDomain(cookie: string, domain: string): string {
  const stripped = cookie.replace(/;\s*Domain=[^;]*/i, '')
  return domain ? `${stripped}; Domain=${domain}` : stripped
}

export function rewriteSetCookieDomain(): RequestHandler {
  return function (req, res, next) {
    const originalSetHeader = res.setHeader.bind(res)

    res.setHeader = function (name: string, value: any) {
      if (name.toLowerCase() !== 'set-cookie') {
        return originalSetHeader(name, value)
      }
      // 以暂存的上游原始值为准；没暂存到（非代理响应）才用传入值
      const source = res[ORIGINAL_SET_COOKIE] ?? value
      const cookies = (Array.isArray(source) ? source : [source]).map((cookie: string) =>
        applyDomain(cookie, config.cookieDomain)
      )
      return originalSetHeader(name, cookies)
    } as typeof res.setHeader

    next()
  }
}
