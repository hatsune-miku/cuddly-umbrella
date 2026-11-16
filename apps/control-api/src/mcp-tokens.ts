import type { Express, Request } from 'express'
import { apiPermissionKey, createMcpPersonalTokenSchema } from '@cuddly/contracts'
import { McpTokenLimitError, type AuthSession, type CuddlyStore } from '@cuddly/db'

export function registerMcpTokenBoundary(app: Express, store: CuddlyStore): void {
  app.use('/api/v1', async (req, res, next) => {
    const match = /^Bearer\s+(bfpat_\S*)$/i.exec(req.get('authorization')?.trim() || '')
    if (!match) {
      next()
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    const session = await store.getMcpTokenSession(match[1]!)
    if (!session) {
      res
        .status(401)
        .json({
          code: 'MCP_TOKEN_INVALID',
          message: 'Token 无效或已撤销，请在主页的 MCP 接入中重新生成',
        })
      return
    }
    const pathname = new URL(req.originalUrl, 'http://bifrost.local').pathname
    if (
      pathname !== '/api/v1/mcp' &&
      !(pathname === '/api/v1/auth/session' && req.method === 'GET') &&
      !apiPermissionKey(req.method, pathname)
    ) {
      res.status(403).json({ code: 'MCP_TOKEN_SCOPE', message: '此操作需在浏览器登录后完成' })
      return
    }
    next()
  })
}

export function registerMcpTokens(
  app: Express,
  options: {
    store: CuddlyStore
    browserToken: (req: Request) => string
    validCsrf: (req: Request, session: AuthSession) => boolean
  }
): void {
  const root = '/api/v1/me/mcp-tokens'
  app.use(root, (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Cookie, Authorization',
    })
    next()
  })
  app.use(root, async (req, res, next) => {
    const cookie = options.browserToken(req)
    const session =
      cookie && !req.get('authorization') ? await options.store.getAuthSession(cookie) : null
    if (!session) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    if (session.kind !== 'browser' || !(await options.store.getUserAccount(session))) {
      res
        .status(403)
        .json({ code: 'INTERACTIVE_LOGIN_REQUIRED', message: '请在此浏览器使用飞书重新登录' })
      return
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !options.validCsrf(req, session)) {
      res.status(403).json({ code: 'CSRF_INVALID' })
      return
    }
    if (Object.keys(req.query).length) {
      res.status(400).json({ code: 'INVALID_REQUEST' })
      return
    }
    res.locals.mcpTokenOwner = session
    next()
  })
  app.get(root, async (_req, res) => {
    res.json({ items: await options.store.listMcpPersonalTokens(res.locals.mcpTokenOwner) })
  })
  app.post(root, async (req, res) => {
    const input = createMcpPersonalTokenSchema.safeParse(req.body)
    if (!input.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', message: '请输入 1 至 80 个字符的名称' })
      return
    }
    try {
      res
        .status(201)
        .json(await options.store.createMcpPersonalToken(res.locals.mcpTokenOwner, input.data.name))
    } catch (error) {
      if (!(error instanceof McpTokenLimitError)) throw error
      res.status(409).json({ code: 'MCP_TOKEN_LIMIT', message: error.message })
    }
  })
  app.delete(`${root}/:id`, async (req, res) => {
    const id = String(req.params.id)
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ code: 'INVALID_REQUEST' })
      return
    }
    if (!(await options.store.revokeMcpPersonalToken(res.locals.mcpTokenOwner, id))) {
      res.status(404).json({ code: 'TOKEN_NOT_FOUND' })
      return
    }
    res.status(204).end()
  })
}
