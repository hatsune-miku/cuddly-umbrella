import express, { type Express, type Request } from 'express'

import type { AuthSession, CuddlyStore } from '@cuddly/db'
import { mcpPersonalTokenPattern } from '@cuddly/contracts'
import { BifrostClient } from '@cuddly/mcp-server/client'
import { createMcpServer } from '@cuddly/mcp-server/server'
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js'
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js'
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js'
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { safeStringEqual } from './auth'
import { resolveAuthorization } from './authorization'
import {
  MCP_CONSENT_PATH,
  MCP_OAUTH_PATH,
  MCP_PATH,
  MCP_SCOPES,
  McpOAuthProvider,
} from './mcp-provider'

export function isMcpHttpReturnPath(value: string): boolean {
  try {
    const url = new URL(value, 'https://bifrost.invalid')
    return (
      url.origin === 'https://bifrost.invalid' &&
      url.pathname === MCP_CONSENT_PATH &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('request') || '') &&
      !url.hash
    )
  } catch {
    return false
  }
}

function html(value: string): string {
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

export function registerMcpHttp(
  app: Express,
  options: {
    store: CuddlyStore
    publicOrigin: string
    apiOrigin: string
    statePath?: string
    authenticate: (req: Request) => Promise<AuthSession | null>
    isGuest: (session: AuthSession) => boolean
  }
): McpOAuthProvider {
  const resource = `${options.publicOrigin}${MCP_PATH}`
  const provider = new McpOAuthProvider({
    store: options.store,
    resource,
    statePath: options.statePath,
  })
  const rateLimit = {}
  app.use(
    mcpAuthMetadataRouter({
      resourceServerUrl: new URL(resource),
      resourceName: 'Bifrost MCP',
      scopesSupported: MCP_SCOPES,
      oauthMetadata: {
        issuer: options.publicOrigin,
        authorization_endpoint: `${options.publicOrigin}${MCP_OAUTH_PATH}/authorize`,
        token_endpoint: `${options.publicOrigin}${MCP_OAUTH_PATH}/token`,
        registration_endpoint: `${options.publicOrigin}${MCP_OAUTH_PATH}/register`,
        revocation_endpoint: `${options.publicOrigin}${MCP_OAUTH_PATH}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: MCP_SCOPES,
      },
    })
  )
  app.use(`${MCP_OAUTH_PATH}/authorize`, authorizationHandler({ provider, rateLimit }))
  app.use(`${MCP_OAUTH_PATH}/token`, tokenHandler({ provider, rateLimit }))
  app.use(
    `${MCP_OAUTH_PATH}/register`,
    clientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit })
  )
  app.use(`${MCP_OAUTH_PATH}/revoke`, revocationHandler({ provider, rateLimit }))
  app.use(MCP_CONSENT_PATH, (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    next()
  })
  app.get(MCP_CONSENT_PATH, async (req, res) => {
    const id = typeof req.query.request === 'string' ? req.query.request : ''
    const pending = provider.getPending(id)
    if (!pending) {
      res.status(400).send('授权请求已过期，请从客户端重新连接。')
      return
    }
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'self'; form-action 'self' ${new URL(pending.params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`
    )
    const session = await options.authenticate(req)
    if (!session) {
      res.redirect(
        `/api/v1/auth/feishu/start?return_to=${encodeURIComponent(`${MCP_CONSENT_PATH}?request=${id}`)}`
      )
      return
    }
    if (options.isGuest(session)) {
      res.status(403).send('MCP 需要飞书身份，不能使用访客会话。')
      return
    }
    const client = await provider.clientsStore.getClient(pending.clientId)
    const authorization = await resolveAuthorization(options.store, session)
    const maximumLevel = Math.min(pending.permissionLevel, authorization.permissionLevel)
    res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Bifrost MCP 授权</title>
<link rel="stylesheet" href="/ui/cakeui.css"><link rel="stylesheet" href="/ui/auth.css">
<link rel="stylesheet" href="/api/v1/auth/mcp/style.css"></head><body class="mcp-auth-page"><main class="auth-completion mcp-auth">
<h1>连接 Bifrost MCP</h1><p>以 ${html(session.name)} 的身份连接客户端 ${html(client?.client_name || '未命名客户端')}。</p>
<p>回调地址：${html(pending.params.redirectUri)}</p>
<p>客户端名称由对方自行声明。仅当你刚刚主动连接此客户端时授权。连接最长有效 7 天；访问令牌 1 小时，客户端可自动续期。权限范围由服务端强制执行。</p>
<p>当前账号为 ${authorization.permissionLevel} 级权限。连接的权限上限不得超过账号权限；角色校验跟随账号当前角色。</p>
<form method="post" action="${MCP_CONSENT_PATH}">
<input type="hidden" name="request" value="${html(id)}"><input type="hidden" name="csrf" value="${html(session.csrfToken)}">
<label class="mcp-auth-fields">授权权限等级上限 <input class="mcp-auth-select" type="number" name="permissionLevel" min="0" max="${maximumLevel}" step="1" value="${Math.min(maximumLevel, 2)}" required></label><div class="mcp-auth-actions">
<button class="mcp-auth-button" name="decision" value="approve">授权连接</button>
<button class="mcp-auth-button mcp-auth-secondary" name="decision" value="deny">取消</button>
</div></form></main></body></html>`)
  })
  app.post(
    MCP_CONSENT_PATH,
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req, res) => {
      const session = await options.authenticate(req)
      if (!session || options.isGuest(session)) {
        res.status(401).json({ error: 'login_required' })
        return
      }
      if (
        typeof req.body?.csrf !== 'string' ||
        !safeStringEqual(req.body.csrf, session.csrfToken)
      ) {
        res.status(403).json({ error: 'invalid_csrf' })
        return
      }
      if (!['approve', 'deny'].includes(req.body.decision)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      try {
        const authorization = await resolveAuthorization(options.store, session)
        const permissionLevel = req.body.decision === 'deny' ? 0 : Number(req.body.permissionLevel)
        if (
          req.body.decision === 'approve' &&
          (typeof req.body.permissionLevel !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(req.body.permissionLevel) ||
            permissionLevel > authorization.permissionLevel)
        ) {
          res.status(400).json({ error: 'invalid_permission_level' })
          return
        }
        res.redirect(
          303,
          provider.complete(
            req.body.request,
            session,
            req.body.decision === 'approve',
            permissionLevel
          )
        )
      } catch {
        res.status(400).json({ error: 'invalid_request' })
      }
    }
  )

  let active = 0
  app.all(MCP_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const origin = req.get('origin')
    if (origin && origin !== options.publicOrigin && !provider.acceptsOrigin(origin)) {
      res.status(403).json({ error: 'origin_not_allowed' })
      return
    }
    if (origin) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
      })
      res.removeHeader('Access-Control-Allow-Credentials')
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    const token =
      /^Bearer ((?:bmcp_|bfpat_)[A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') || '')?.[1] ||
      ''
    const personal = mcpPersonalTokenPattern.test(token)
    let connection
    try {
      if (personal) {
        if (!(await options.store.getMcpTokenSession(token))) throw new Error('Invalid token')
        connection = { apiToken: token }
      } else connection = await provider.resolve(token)
    } catch {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${options.publicOrigin}/.well-known/oauth-protected-resource${MCP_PATH}", scope="bifrost:level:2"`
      )
      res.status(401).json({ error: 'invalid_token' })
      return
    }
    // Stateless transport: no GET event stream or session deletion is required.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      res.status(405).end()
      return
    }
    const session = personal
      ? await options.store.getMcpTokenSession(token)
      : await options.store.getAuthSession(connection.apiToken)
    if (!session) {
      res.status(401).json({ error: 'invalid_token' })
      return
    }
    const context = await resolveAuthorization(options.store, session)
    if (active >= 64) {
      res.setHeader('Retry-After', '5')
      res.status(429).json({ error: 'server_busy' })
      return
    }
    active++
    const client = new BifrostClient({
      origin: options.apiOrigin,
      displayOrigin: options.publicOrigin,
      token: async () => {
        // Re-check revocation for every tool/API call, not only the HTTP handshake.
        if (personal) {
          if (!(await options.store.getMcpTokenSession(token))) throw new Error('Token 已撤销')
        } else await provider.resolve(token)
        return connection.apiToken
      },
    })
    const server = createMcpServer(client, context)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    let closed = false
    res.once('close', () => {
      if (closed) return
      closed = true
      active--
      void server.close().catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' })
      else res.end()
    }
  })
  return provider
}
