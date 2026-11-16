import { randomBytes } from 'node:crypto'

import type { AuthSession, CuddlyStore } from '@cuddly/db'
import express, { type Express, type Request, type Response } from 'express'

import { oauthRandomToken, pkceChallenge, safeStringEqual } from './auth'

export const PC_LOGIN_PATH = '/api/v1/auth/pc-login'
const AUTHORIZE_PATH = `${PC_LOGIN_PATH}/authorize`
const TTL_MS = 5 * 60_000
const MAX_PENDING = 256
const opaquePattern = /^[A-Za-z0-9_-]{43}$/

interface PcLoginOptions {
  store: CuddlyStore
  publicOrigin: string
  browserToken: (req: Request) => string
  isGuest: (session: AuthSession) => boolean
  now?: () => number
}

interface PendingLogin {
  challenge: string
  code: string
  expiresAt: number
  status: 'pending' | 'approved' | 'denied'
  browserToken?: string
}

export function isPcLoginReturnPath(value: string): boolean {
  return /^\/api\/v1\/auth\/pc-login\/authorize\?request=[A-Za-z0-9_-]{43}$/.test(value)
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
}

function privateResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  )
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Bifrost · ${title}</title>
<link rel="stylesheet" href="/ui/cakeui.css"><link rel="stylesheet" href="/ui/auth.css">
<link rel="stylesheet" href="/api/v1/auth/mcp/style.css"></head>
<body><main class="auth-completion mcp-auth"><h1>${title}</h1>${content}</main></body></html>`
}

// The PC iframe and the system browser share neither cookies nor window messaging.
// Only the initiating panel knows the verifier; the browser explicitly approves its request.
export function registerPcLogin(app: Express, options: PcLoginOptions): void {
  const now = options.now || Date.now
  const pending = new Map<string, PendingLogin>()
  const attempts = new Map<string, { count: number; expiresAt: number }>()

  function prune(): void {
    for (const [id, login] of pending) if (login.expiresAt <= now()) pending.delete(id)
    for (const [ip, attempt] of attempts) if (attempt.expiresAt <= now()) attempts.delete(ip)
  }

  function validOrigin(req: Request): boolean {
    return !req.get('origin') || req.get('origin') === options.publicOrigin
  }

  app.post(PC_LOGIN_PATH, (req, res) => {
    privateResponse(res)
    if (!validOrigin(req) || !req.is('application/json')) {
      res.status(403).json({ code: 'PC_LOGIN_INVALID_ORIGIN' })
      return
    }
    const challenge = req.body?.challenge
    if (typeof challenge !== 'string' || !opaquePattern.test(challenge)) {
      res.status(400).json({ code: 'PC_LOGIN_INVALID_REQUEST' })
      return
    }
    prune()
    const ip = req.ip || ''
    const attempt = attempts.get(ip) || { count: 0, expiresAt: now() + 60_000 }
    if (pending.size >= MAX_PENDING || attempts.size >= 1024 || attempt.count >= 30) {
      res.setHeader('Retry-After', '60')
      res.status(429).json({ code: 'PC_LOGIN_BUSY' })
      return
    }
    attempt.count += 1
    attempts.set(ip, attempt)
    const id = oauthRandomToken()
    const code = randomBytes(4)
      .toString('hex')
      .toUpperCase()
      .replace(/(.{4})/, '$1-')
    const expiresAt = now() + TTL_MS
    pending.set(id, { challenge, code, expiresAt, status: 'pending' })
    res.status(201).json({
      id,
      code,
      expiresAt,
      expiresInMs: TTL_MS,
      authorizationUrl: `${options.publicOrigin}${AUTHORIZE_PATH}?request=${id}`,
    })
  })

  app.get(AUTHORIZE_PATH, async (req, res) => {
    privateResponse(res)
    prune()
    const id = typeof req.query.request === 'string' ? req.query.request : ''
    const login = pending.get(id)
    if (!login || login.status !== 'pending') {
      res
        .status(410)
        .type('html')
        .send(page('登录请求已结束', '<p>请回到 KOOK PC 重新发起登录。</p>'))
      return
    }
    const token = options.browserToken(req)
    const session = token ? await options.store.getAuthSession(token) : null
    if (!session || options.isGuest(session)) {
      res.redirect(
        `/api/v1/auth/feishu/start?return_to=${encodeURIComponent(`${AUTHORIZE_PATH}?request=${id}`)}`
      )
      return
    }
    res.type('html').send(
      page(
        '登录 KOOK PC',
        `
<p>使用 ${escapeHtml(session.name)} 登录 Bifrost 插件。</p>
<p>请核对插件中的验证码：<strong>${login.code}</strong></p>
<form class="mcp-auth-actions" method="post" action="${AUTHORIZE_PATH}">
<input type="hidden" name="request" value="${id}">
<input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
<button class="mcp-auth-button" type="submit" name="decision" value="approve">确认登录</button>
<button class="mcp-auth-button mcp-auth-secondary" type="submit" name="decision" value="deny">取消</button>
</form>`
      )
    )
  })

  app.post(
    AUTHORIZE_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req, res) => {
      privateResponse(res)
      const token = options.browserToken(req)
      const session = token ? await options.store.getAuthSession(token) : null
      if (!session || options.isGuest(session)) {
        res.status(401).json({ code: 'AUTH_REQUIRED' })
        return
      }
      // no-referrer can make Chrome send Origin: null for this HTML form.
      // The synchronizer token is already bound to the authenticated browser session.
      if (
        typeof req.body?.csrf !== 'string' ||
        !safeStringEqual(req.body.csrf, session.csrfToken)
      ) {
        res.status(403).json({ code: 'CSRF_INVALID' })
        return
      }
      prune()
      const login = pending.get(req.body?.request)
      if (!login || login.status !== 'pending') {
        res
          .status(410)
          .type('html')
          .send(page('登录请求已结束', '<p>请回到 KOOK PC 重新发起登录。</p>'))
        return
      }
      if (!['approve', 'deny'].includes(req.body?.decision)) {
        res.status(400).json({ code: 'PC_LOGIN_INVALID_REQUEST' })
        return
      }
      login.status = req.body.decision === 'approve' ? 'approved' : 'denied'
      if (login.status === 'approved') login.browserToken = token
      res
        .type('html')
        .send(
          page(
            login.status === 'approved' ? '已确认登录' : '已取消登录',
            login.status === 'approved'
              ? '<p>KOOK PC 插件会自动更新登录状态。可以关闭此页面。</p>'
              : '<p>可以关闭此页面。</p>'
          )
        )
    }
  )

  app.post(`${PC_LOGIN_PATH}/:id/claim`, async (req, res) => {
    privateResponse(res)
    if (!validOrigin(req) || !req.is('application/json')) {
      res.status(403).json({ code: 'PC_LOGIN_INVALID_ORIGIN' })
      return
    }
    prune()
    const id = String(req.params.id)
    const login = pending.get(id)
    if (!login) {
      res.status(410).json({ code: 'PC_LOGIN_EXPIRED' })
      return
    }
    const verifier = req.body?.verifier
    if (
      typeof verifier !== 'string' ||
      !opaquePattern.test(verifier) ||
      !safeStringEqual(pkceChallenge(verifier), login.challenge)
    ) {
      res.status(403).json({ code: 'PC_LOGIN_INVALID_VERIFIER' })
      return
    }
    if (login.status === 'pending') {
      res.status(202).json({ status: 'pending' })
      return
    }
    // Consume before the first await: parallel polls must never mint multiple sessions.
    pending.delete(id)
    if (login.status === 'denied') {
      res.status(403).json({ code: 'PC_LOGIN_DENIED' })
      return
    }
    const session = login.browserToken
      ? await options.store.getAuthSession(login.browserToken)
      : null
    if (!session || options.isGuest(session) || Date.parse(session.expiresAt) <= now()) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    const token = oauthRandomToken()
    const expiresAt = new Date(
      Math.min(Date.parse(session.expiresAt), now() + 7 * 24 * 60 * 60_000)
    ).toISOString()
    await options.store.createAuthSession({
      ...session,
      kind: 'pc',
      token,
      csrfToken: oauthRandomToken(),
      createdAt: new Date(now()).toISOString(),
      expiresAt,
    })
    res.json({ token, expiresAt })
  })
}
