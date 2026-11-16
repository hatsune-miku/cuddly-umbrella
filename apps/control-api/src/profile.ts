import type { Express, Request } from 'express'
import { updateOwnProfileSchema } from '@cuddly/contracts'
import { publicIdentityData, type AuthSession, type CuddlyStore } from '@cuddly/db'

export function registerPublicIdentityBoundary(app: Express, store: CuddlyStore): void {
  app.use('/api/v1', (req, res, next) => {
    if (req.path.startsWith('/internal/') || req.path === '/me/private-profile') {
      next()
      return
    }
    const json = res.json.bind(res)
    res.json = (value) => {
      void publicIdentityData(store, value)
        .then((data) => {
          json(data)
        })
        .catch(next)
      return res
    }
    next()
  })
}

export function registerOwnProfile(
  app: Express,
  options: {
    store: CuddlyStore
    authenticate: (req: Request) => Promise<AuthSession | null>
    browserToken: (req: Request) => string
    validCsrf: (req: Request, session: AuthSession) => boolean
  }
): void {
  app.use('/api/v1/me', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Vary', 'Cookie, Authorization')
    next()
  })
  app.get('/api/v1/me', async (req, res) => {
    const session = await options.authenticate(req)
    const user = session ? await options.store.getUserAccount(session) : null
    if (!user) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    res.json(user)
  })
  app.patch('/api/v1/me', async (req, res) => {
    const session = await options.authenticate(req)
    const user = session ? await options.store.getUserAccount(session) : null
    if (!session || !user) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    if (!options.validCsrf(req, session)) {
      res.status(403).json({ code: 'CSRF_INVALID' })
      return
    }
    const input = updateOwnProfileSchema.safeParse(req.body)
    if (!input.success) {
      res.status(400).json({ code: 'INVALID_PROFILE', message: '名字需为 1 至 80 个字符' })
      return
    }
    res.json(await options.store.updateOwnProfile(session, input.data.displayName))
  })
  app.get('/api/v1/me/private-profile', async (req, res) => {
    // A private profile is not an administrative permission. Never accept a target user ID.
    if (Object.keys(req.query).length) {
      res.status(400).json({ code: 'INVALID_REQUEST' })
      return
    }
    const token = options.browserToken(req)
    const session =
      token && !req.get('authorization') ? await options.store.getAuthSession(token) : null
    if (!session) {
      res.status(401).json({ code: 'AUTH_REQUIRED' })
      return
    }
    if (session.kind !== 'browser') {
      res
        .status(403)
        .json({ code: 'INTERACTIVE_LOGIN_REQUIRED', message: '请在此浏览器重新使用飞书登录' })
      return
    }
    const profile = await options.store.getOwnPrivateProfile(session)
    if (!profile) {
      res.status(403).json({ code: 'PRIVATE_PROFILE_UNAVAILABLE' })
      return
    }
    res.json(profile)
  })
}
