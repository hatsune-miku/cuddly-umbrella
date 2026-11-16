import type { Express, Request, Response, NextFunction } from 'express'

import {
  apiPermissionKey,
  GUEST_PERMISSIONS,
  permissionDenial,
  permissionDefinitions,
  saveAuthorizationPolicySchema,
  updateUserPermissionsSchema,
  type AuthorizationPolicy,
  type PermissionPrincipal,
  USER_MANAGEMENT,
} from '@cuddly/contracts'
import { AuthorizationUpdateError, type AuthSession, type CuddlyStore } from '@cuddly/db'

export interface AuthorizationView extends PermissionPrincipal {
  userId?: string
  username?: string
  requirements: AuthorizationPolicy['requirements']
}

export async function resolveAuthorization(
  store: CuddlyStore,
  session: AuthSession | null
): Promise<AuthorizationView> {
  const policy = await store.getAuthorizationPolicy()
  if (!session) return { ...GUEST_PERMISSIONS, roles: [], requirements: policy.requirements }
  const user = await store.getUserAccount(session)
  const principal = user || GUEST_PERMISSIONS
  return {
    permissionLevel: Math.min(
      principal.permissionLevel,
      session.permissionCeiling ?? Number.MAX_SAFE_INTEGER
    ),
    roles: [...principal.roles],
    ...(user ? { userId: user.id, username: user.username } : {}),
    requirements: policy.requirements,
  }
}

export function registerAuthorizationGuard(
  app: Express,
  options: {
    store: CuddlyStore
    session: (req: Request) => AuthSession | null
    testFixture: boolean
  }
): void {
  app.use('/api/v1', async (req, res, next) => {
    if (/^\/internal(?:\/|$)/i.test(req.path)) {
      next()
      return
    }
    const key = apiPermissionKey(
      req.method,
      new URL(req.originalUrl, 'http://bifrost.local').pathname
    )
    if (!key) {
      res.status(404).json({ code: 'NOT_FOUND' })
      return
    }
    const session = options.session(req)
    const authorization = options.testFixture
      ? {
          permissionLevel: 8,
          roles: ['owner'],
          requirements: (await options.store.getAuthorizationPolicy()).requirements,
        }
      : await resolveAuthorization(options.store, session)
    const requirement = authorization.requirements[key]
    const denied = permissionDenial(authorization, requirement)
    if (denied) {
      res.setHeader('Cache-Control', 'no-store')
      if (!session) res.setHeader('WWW-Authenticate', 'Session realm="cuddly"')
      res.status(session ? 403 : 401).json({
        code: session ? 'PERMISSION_DENIED' : 'AUTH_REQUIRED',
        message:
          denied === 'roles'
            ? '当前用户不具备此功能所需的角色'
            : `此功能需要 ${requirement.permissionLevel} 级权限`,
        reason: denied,
        permissionKey: key,
        required: requirement,
      })
      return
    }
    next()
  })
}

export function registerPermissionManagement(
  app: Express,
  options: {
    store: CuddlyStore
    session: (req: Request) => AuthSession | null
    testFixture: boolean
  }
): void {
  function actor(req: Request): string {
    const session = options.session(req)
    return session?.userId ? `user:${session.userId}` : 'test-fixture'
  }
  function actorSession(req: Request): AuthSession | undefined {
    if (options.testFixture) return undefined
    const session = options.session(req)
    if (!session) throw new AuthorizationUpdateError('PERMISSION_DENIED')
    return session
  }
  app.get('/api/v1/admin/permissions', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      ...(await options.store.getAuthorizationPolicy()),
      definitions: permissionDefinitions,
    })
  })
  app.put('/api/v1/admin/permissions', async (req, res) => {
    const input = saveAuthorizationPolicySchema.safeParse(req.body)
    if (!input.success) {
      res.status(400).json({ code: 'INVALID_REQUEST', issues: input.error.issues })
      return
    }
    res.json(await options.store.saveAuthorizationPolicy(input.data, actor(req), actorSession(req)))
  })
  app.get('/api/v1/admin/users', async (req, res) => {
    const page = Number(req.query.page ?? 1)
    const pageSize = Number(req.query.pageSize ?? 20)
    const query = req.query.query ?? ''
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1_000_000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      typeof query !== 'string' ||
      query.length > 120
    ) {
      res.status(400).json({ code: 'INVALID_REQUEST' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(await options.store.listUserAccounts(query.trim(), page, pageSize))
  })
  app.patch('/api/v1/admin/users/:userId', async (req, res) => {
    const input = updateUserPermissionsSchema.safeParse(req.body)
    if (
      !input.success ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(req.params.userId))
    ) {
      res.status(400).json({ code: 'INVALID_REQUEST' })
      return
    }
    res.json(
      await options.store.updateUserPermissions(
        String(req.params.userId),
        input.data,
        actor(req),
        actorSession(req)
      )
    )
  })
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(error instanceof AuthorizationUpdateError)) {
      next(error)
      return
    }
    const messages = {
      REVISION_CONFLICT: '配置已被修改，请刷新后重试',
      USER_NOT_FOUND: '用户不存在',
      LAST_PERMISSION_MANAGER: `至少需要保留一位拥有 ${USER_MANAGEMENT.permissionLevel} 级及以上权限的用户`,
      PERMISSION_DENIED: '当前权限不足，请刷新后重试',
      PERMISSION_LEVEL_EXCEEDED: '设置的权限等级不能高于你当前的权限等级',
    }
    res
      .status(
        error.code === 'USER_NOT_FOUND'
          ? 404
          : ['PERMISSION_DENIED', 'PERMISSION_LEVEL_EXCEEDED'].includes(error.code)
            ? 403
            : 409
      )
      .json({ code: error.code, message: messages[error.code] })
  })
}
