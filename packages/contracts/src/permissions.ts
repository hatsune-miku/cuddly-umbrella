import { z } from 'zod'

export const permissionLevelSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const rolesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
  )
  .max(64)
  .transform((roles) => [...new Set(roles)])
export const permissionRequirementSchema = z
  .object({ permissionLevel: permissionLevelSchema, roles: rolesSchema })
  .strict()
export type PermissionRequirement = z.infer<typeof permissionRequirementSchema>
export type PermissionPrincipal = PermissionRequirement

export const permissionDefinitions = [
  { key: 'runtime.read', name: '公开运行信息', permissionLevel: 0 },
  { key: 'catalog.read', name: '项目与环境查询', permissionLevel: 1 },
  { key: 'build.read', name: '构建记录与产物查询', permissionLevel: 1 },
  { key: 'build.create', name: '发起与重试构建', permissionLevel: 2 },
  { key: 'build.cancel', name: '取消构建', permissionLevel: 2 },
  { key: 'share.read', name: '需求分享查询', permissionLevel: 1 },
  { key: 'share.manage', name: '创建与管理需求分享', permissionLevel: 2 },
  { key: 'preview.read', name: '预览会话查询', permissionLevel: 1 },
  { key: 'preview.manage', name: '创建与撤销预览', permissionLevel: 2 },
  { key: 'system.read', name: '系统配置查询', permissionLevel: 4 },
  { key: 'system.manage', name: '修改系统配置', permissionLevel: 4 },
  { key: 'permissions.manage', name: '功能权限配置', permissionLevel: 4 },
  { key: 'users.manage', name: '用户管理', permissionLevel: 6 },
] as const
export type PermissionKey = (typeof permissionDefinitions)[number]['key']
export const permissionKeys = permissionDefinitions.map((definition) => definition.key)
export const permissionKeySchema = z.enum(permissionKeys as [PermissionKey, ...PermissionKey[]])
export const permissionRequirementsSchema = z
  .record(permissionKeySchema, permissionRequirementSchema)
  .superRefine((value, ctx) => {
    for (const [key, level] of [
      ['permissions.manage', 4],
      ['users.manage', 6],
    ] as const) {
      const management = value[key]
      if (management.permissionLevel !== level || management.roles.length !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key === 'users.manage' ? '用户管理' : '功能权限配置'}固定需要 ${level} 级权限，角色要求为空`,
        })
      }
    }
  })

export const authorizationPolicySchema = z.object({
  revision: z.number().int().min(1),
  defaultUserPermissionLevel: permissionLevelSchema,
  requirements: permissionRequirementsSchema,
})
export type AuthorizationPolicy = z.infer<typeof authorizationPolicySchema>
export type PermissionContext = PermissionPrincipal & {
  requirements?: AuthorizationPolicy['requirements']
}
export const saveAuthorizationPolicySchema = authorizationPolicySchema
  .omit({ revision: true })
  .extend({
    expectedRevision: z.number().int().min(1),
  })
  .strict()
export type SaveAuthorizationPolicy = z.infer<typeof saveAuthorizationPolicySchema>
export const updateUserPermissionsSchema = permissionRequirementSchema
  .extend({
    expectedRevision: z.number().int().min(1),
  })
  .strict()
export type UpdateUserPermissions = z.infer<typeof updateUserPermissionsSchema>

export interface UserAccount extends PermissionPrincipal {
  id: string
  tenantKey: string
  openId: string
  username: string
  name: string
  displayName: string
  avatarUrl: string
  revision: number
  createdAt: string
  updatedAt: string
}

export const updateOwnProfileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict()

// Only the owner's interactive account-details page may receive this type.
// Extend this explicit schema when adding private fields; never serialize provider payloads.
export const privateProfileSchema = z.object({
  feishu: z.object({ realName: z.string(), username: z.string().optional() }),
})
export type PrivateProfile = z.infer<typeof privateProfileSchema>

export function defaultAuthorizationPolicy(): AuthorizationPolicy {
  return {
    revision: 1,
    defaultUserPermissionLevel: 2,
    requirements: permissionRequirementsSchema.parse(
      Object.fromEntries(
        permissionDefinitions.map((definition) => [
          definition.key,
          { permissionLevel: definition.permissionLevel, roles: [] },
        ])
      )
    ),
  }
}

export const GUEST_PERMISSIONS: Readonly<PermissionPrincipal> = Object.freeze({
  permissionLevel: 0,
  roles: [],
})
export const PERMISSION_MANAGEMENT: Readonly<PermissionRequirement> = Object.freeze({
  permissionLevel: 4,
  roles: [],
})
export const USER_MANAGEMENT: Readonly<PermissionRequirement> = Object.freeze({
  permissionLevel: 6,
  roles: [],
})

export function permissionDenial(
  principal: PermissionPrincipal,
  requirement: PermissionRequirement
): 'roles' | 'permissionLevel' | null {
  const validPrincipal = permissionRequirementSchema.safeParse({
    permissionLevel: principal?.permissionLevel,
    roles: principal?.roles,
  })
  const validRequirement = permissionRequirementSchema.safeParse({
    permissionLevel: requirement?.permissionLevel,
    roles: requirement?.roles,
  })
  if (!validPrincipal.success || !validRequirement.success) return 'permissionLevel'
  const privilegedRole =
    principal.roles.includes('owner') || principal.roles.includes('administrator')
  if (!privilegedRole && !requirement.roles.every((role) => principal.roles.includes(role)))
    return 'roles'
  return principal.permissionLevel >= requirement.permissionLevel ? null : 'permissionLevel'
}

export function hasPermission(
  principal: PermissionPrincipal,
  requirement: PermissionRequirement
): boolean {
  return permissionDenial(principal, requirement) === null
}

/** Shared routing policy for the HTTP API and delegated MCP calls. Unknown endpoints fail closed. */
export function apiPermissionKey(method: string, pathname: string): PermissionKey | null {
  let path: string
  try {
    path = decodeURIComponent(pathname).replace(/\/+$/, '').toLowerCase()
  } catch {
    return null
  }
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const read = verb === 'GET'
  if (/^\/api\/v1\/admin\/permissions$/.test(path)) return 'permissions.manage'
  if (/^\/api\/v1\/admin\/users(?:\/[^/]+)?$/.test(path)) return 'users.manage'
  if (read && path === '/api/v1/runtime') return 'runtime.read'
  if (
    read &&
    /^\/api\/v1\/(?:environments(?:\/[^/]+\/matrix)?|build-targets(?:\/[^/]+\/branches)?|site-bindings\/(?:candidates|resolve)|admin\/environments|admin\/site-bindings(?:\/[^/]+)?)$/.test(
      path
    )
  )
    return 'catalog.read'
  if (
    read &&
    /^\/api\/v1\/(?:build-queue|build-jobs(?:\/[^/]+(?:\/(?:detail|log))?)?|artifacts(?:\/[^/]+)?)$/.test(
      path
    )
  )
    return 'build.read'
  if (verb === 'POST' && path === '/api/v1/build-jobs') return 'build.create'
  if (verb === 'POST' && /^\/api\/v1\/build-jobs\/[^/]+\/cancel$/.test(path)) return 'build.cancel'
  if (verb === 'POST' && /^\/api\/v1\/config-groups\/[^/]+\/previews$/.test(path))
    return 'preview.manage'
  if (/^\/api\/v1\/config-groups(?:\/[^/]+)?$/.test(path)) {
    if (read) return 'share.read'
    if (['POST', 'PUT', 'DELETE'].includes(verb)) return 'share.manage'
  }
  if (/^\/api\/v1\/previews(?:\/[^/]+)?$/.test(path)) {
    if (read) return 'preview.read'
    if (['POST', 'DELETE'].includes(verb)) return 'preview.manage'
  }
  if (
    /^\/api\/v1\/admin\/(?:setup-status|setup|unlock|proxy-settings(?:\/(?:reset|refresh))?|build-targets(?:\/[^/]+(?:\/reset)?)?|environments\/[^/]+(?:\/projects)?|site-bindings(?:\/[^/]+)?|system-settings)$/.test(
      path
    )
  )
    return read ? 'system.read' : 'system.manage'
  if (verb === 'POST' && /^\/api\/v1\/environments\/[^/]+\/revisions$/.test(path))
    return 'system.manage'
  return null
}
