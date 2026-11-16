import express, { type Express, type Request, type Response } from 'express'

import type { AuthSession, CuddlyStore } from '@cuddly/db'
import { PRODUCT_NAME } from '@cuddly/product'

import { oauthRandomToken, pkceChallenge, safeStringEqual } from './auth'

export const MCP_AUTHORIZE_PATH = '/api/v1/auth/mcp/authorize'
const CODE_TTL_MS = 60_000
const MAX_PENDING_CODES = 256
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const opaquePattern = /^[A-Za-z0-9_-]{43}$/

interface AuthorizationRequest {
  redirect_uri: string
  state: string
  code_challenge: string
}

interface McpAuthOptions {
  store: CuddlyStore
  authenticate: (req: Request) => Promise<AuthSession | null>
  isGuest: (session: AuthSession) => boolean
  now?: () => number
}

function parseAuthorization(value: Record<string, unknown>): AuthorizationRequest | null {
  const { redirect_uri, state, code_challenge } = value
  if (
    typeof redirect_uri !== 'string' ||
    typeof state !== 'string' ||
    typeof code_challenge !== 'string' ||
    !opaquePattern.test(state) ||
    !opaquePattern.test(code_challenge)
  )
    return null
  try {
    const url = new URL(redirect_uri)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      Number(url.port) < 1024 ||
      url.pathname !== '/callback' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null
    return { redirect_uri: url.href, state, code_challenge }
  } catch {
    return null
  }
}

export function isMcpAuthorizationReturnPath(value: string): boolean {
  try {
    const url = new URL(value, 'https://bifrost.invalid')
    return (
      url.origin === 'https://bifrost.invalid' &&
      url.pathname === MCP_AUTHORIZE_PATH &&
      parseAuthorization(Object.fromEntries(url.searchParams)) !== null
    )
  } catch {
    return false
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!
  )
}

function privateResponse(res: Response, callbackOrigin = ''): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'self'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`
  )
}

export function registerMcpAuthorization(app: Express, options: McpAuthOptions): void {
  const now = options.now || Date.now
  const codes = new Map<
    string,
    {
      request: AuthorizationRequest
      session: AuthSession
      expiresAt: number
    }
  >()

  function prune(): void {
    for (const [code, grant] of codes) {
      if (grant.expiresAt <= now()) codes.delete(code)
    }
  }

  app.get(MCP_AUTHORIZE_PATH, async (req, res) => {
    privateResponse(res)
    const input = parseAuthorization(req.query)
    if (!input) {
      res
        .status(400)
        .json({ code: 'MCP_INVALID_AUTHORIZATION', message: '请从 MCP 登录命令重新开始' })
      return
    }
    privateResponse(res, new URL(input.redirect_uri).origin)
    const session = await options.authenticate(req)
    if (!session) {
      const returnTo = `${MCP_AUTHORIZE_PATH}?${new URLSearchParams({ ...input })}`
      res.redirect(`/api/v1/auth/feishu/start?return_to=${encodeURIComponent(returnTo)}`)
      return
    }
    if (options.isGuest(session)) {
      res
        .status(403)
        .json({ code: 'MCP_FEISHU_REQUIRED', message: 'MCP 需要飞书身份，不能使用访客会话' })
      return
    }
    const hidden = Object.entries({ ...input, csrf: session.csrfToken })
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join('\n')
    res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(PRODUCT_NAME)} MCP 授权</title>
<link rel="stylesheet" href="/ui/cakeui.css"><link rel="stylesheet" href="/ui/auth.css">
<link rel="stylesheet" href="/api/v1/auth/mcp/style.css"></head>
<body><main class="auth-completion mcp-auth">
<h1>连接 ${escapeHtml(PRODUCT_NAME)} MCP</h1>
<p>以 ${escapeHtml(session.name)} 的身份授权本机 AI 客户端操作系统。</p>
<p>连接使用账号当前的权限等级和角色，最长有效 7 天。只在你刚刚主动运行 MCP 登录命令时继续。</p>
<form class="mcp-auth-actions" method="post" action="${MCP_AUTHORIZE_PATH}">
${hidden}<button class="mcp-auth-button" name="decision" value="approve" type="submit">授权本机 MCP</button>
<button class="mcp-auth-button mcp-auth-secondary" name="decision" value="deny" type="submit">取消</button>
</form></main></body></html>`)
  })

  app.get('/api/v1/auth/mcp/style.css', (_req, res) => {
    res.type('css').send(`
.mcp-auth-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.mcp-auth-page { box-sizing: border-box; }
.mcp-auth { min-width: 0; overflow-wrap: anywhere; font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; }
.mcp-auth-fields { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.mcp-auth-select { box-sizing: border-box; min-width: 0; width: 100%; padding: 10px; font: inherit;
  background: var(--cake-surface); color: var(--cake-text); border: 1px solid var(--cake-line); border-radius: 8px; }
.mcp-auth-button { padding: 10px 16px; border: 1px solid var(--cake-line); border-radius: var(--cake-radius-small, 10px);
  background: var(--cake-text); color: var(--cake-surface); cursor: pointer; font: inherit; }
.mcp-auth-secondary { background: var(--cake-surface); color: var(--cake-text); }
.mcp-auth-button:focus-visible { outline: 2px solid var(--cake-text); outline-offset: 3px; }
`)
  })

  app.post(
    MCP_AUTHORIZE_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req, res) => {
      privateResponse(res)
      const input = parseAuthorization(req.body || {})
      const session = await options.authenticate(req)
      if (!session) {
        res.status(401).json({ code: 'AUTH_REQUIRED' })
        return
      }
      if (options.isGuest(session)) {
        res.status(403).json({ code: 'MCP_FEISHU_REQUIRED' })
        return
      }
      if (
        typeof req.body?.csrf !== 'string' ||
        !safeStringEqual(req.body.csrf, session.csrfToken)
      ) {
        res.status(403).json({ code: 'CSRF_INVALID' })
        return
      }
      if (!input || !['approve', 'deny'].includes(req.body.decision)) {
        res.status(400).json({ code: 'MCP_INVALID_AUTHORIZATION' })
        return
      }
      const callback = new URL(input.redirect_uri)
      callback.searchParams.set('state', input.state)
      if (req.body.decision === 'deny') {
        callback.searchParams.set('error', 'access_denied')
      } else {
        prune()
        if (codes.size >= MAX_PENDING_CODES) {
          res.status(429).json({ code: 'MCP_AUTH_BUSY', message: '请稍后重新登录' })
          return
        }
        const code = oauthRandomToken()
        codes.set(code, { request: input, session, expiresAt: now() + CODE_TTL_MS })
        callback.searchParams.set('code', code)
      }
      res.redirect(303, callback.href)
    }
  )

  app.post('/api/v1/auth/mcp/token', async (req, res) => {
    privateResponse(res)
    prune()
    const { code, code_verifier, redirect_uri } = req.body || {}
    const grant = typeof code === 'string' ? codes.get(code) : undefined
    if (
      !grant ||
      typeof code_verifier !== 'string' ||
      !opaquePattern.test(code_verifier) ||
      redirect_uri !== grant.request.redirect_uri ||
      !safeStringEqual(pkceChallenge(code_verifier), grant.request.code_challenge)
    ) {
      res.status(400).json({ code: 'MCP_INVALID_GRANT', message: '授权已失效，请重新登录' })
      return
    }
    codes.delete(code)
    const expiresAt = Math.min(now() + TOKEN_MAX_AGE_MS, Date.parse(grant.session.expiresAt))
    if (expiresAt <= now()) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    const token = oauthRandomToken()
    const csrfToken = oauthRandomToken()
    await options.store.createAuthSession({
      kind: 'mcp',
      token,
      tenantKey: grant.session.tenantKey,
      openId: grant.session.openId,
      unionId: grant.session.unionId,
      name: grant.session.name,
      avatarUrl: grant.session.avatarUrl,
      ...(grant.session.permissionCeiling === undefined
        ? {}
        : { permissionCeiling: grant.session.permissionCeiling }),
      csrfToken,
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    })
    res.json({
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      identity: { name: grant.session.name },
    })
  })
}
