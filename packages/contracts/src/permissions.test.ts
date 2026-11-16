import { describe, expect, it } from 'vitest'
import {
  apiPermissionKey,
  defaultAuthorizationPolicy,
  hasPermission,
  permissionDenial,
  permissionLevelSchema,
  rolesSchema,
  saveAuthorizationPolicySchema,
} from './permissions'

describe('permission levels and roles', () => {
  it.each([-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8', null])(
    'rejects non-natural permission level %s',
    (value) => {
      expect(permissionLevelSchema.safeParse(value).success).toBe(false)
    }
  )
  it.each([0, 1, 8, Number.MAX_SAFE_INTEGER])('accepts natural permission level %s', (value) => {
    expect(permissionLevelSchema.parse(value)).toBe(value)
  })
  it('permits visitors only when both the level and role conditions allow them', () => {
    expect(
      hasPermission({ permissionLevel: 0, roles: [] }, { permissionLevel: 0, roles: [] })
    ).toBe(true)
    expect(
      hasPermission({ permissionLevel: 0, roles: [] }, { permissionLevel: 0, roles: ['new-user'] })
    ).toBe(false)
    expect(
      hasPermission({ permissionLevel: 0, roles: [] }, { permissionLevel: 1, roles: [] })
    ).toBe(false)
  })
  it('requires every role, checks roles first, and ignores extra user fields', () => {
    expect(
      permissionDenial(
        { permissionLevel: 9, roles: ['a'] },
        { permissionLevel: 8, roles: ['a', 'b'] }
      )
    ).toBe('roles')
    expect(
      permissionDenial({ permissionLevel: 0, roles: [] }, { permissionLevel: 8, roles: ['a'] })
    ).toBe('roles')
    const user = { name: 'User', permissionLevel: 8, roles: ['a', 'b', 'c'] }
    expect(hasPermission(user, { permissionLevel: 8, roles: ['b', 'a'] })).toBe(true)
  })
  it.each(['owner', 'administrator'])(
    '%s bypasses roles but never bypasses the required level',
    (role) => {
      expect(
        hasPermission(
          { permissionLevel: 8, roles: [role] },
          { permissionLevel: 8, roles: ['new-user'] }
        )
      ).toBe(true)
      expect(
        hasPermission({ permissionLevel: 7, roles: [role] }, { permissionLevel: 8, roles: [] })
      ).toBe(false)
    }
  )
  it('normalizes sets without case-insensitive privilege aliases', () => {
    expect(rolesSchema.parse(['a', 'a', ' b '])).toEqual(['a', 'b'])
    expect(
      hasPermission(
        { permissionLevel: 8, roles: ['Owner'] },
        { permissionLevel: 8, roles: ['new-user'] }
      )
    ).toBe(false)
  })
  it('locks permission management and requires complete policy replacement', () => {
    const { revision, ...policy } = defaultAuthorizationPolicy()
    expect(
      saveAuthorizationPolicySchema.safeParse({ ...policy, expectedRevision: revision }).success
    ).toBe(true)
    policy.requirements['permissions.manage'].permissionLevel = 0
    expect(
      saveAuthorizationPolicySchema.safeParse({ ...policy, expectedRevision: revision }).success
    ).toBe(false)
    expect(
      saveAuthorizationPolicySchema.safeParse({
        defaultUserPermissionLevel: 2,
        expectedRevision: 1,
        requirements: {},
      }).success
    ).toBe(false)
  })
  it('normalizes routes while failing closed on unknown APIs', () => {
    expect(apiPermissionKey('HEAD', '/API/v1/admin/USERS/')).toBe('users.manage')
    expect(apiPermissionKey('PATCH', '/api/v1/admin/%75sers/id')).toBe('users.manage')
    expect(apiPermissionKey('POST', '/api/v1/build-jobs')).toBe('build.create')
    expect(apiPermissionKey('GET', '/api/v1/new-unclassified-route')).toBeNull()
    expect(apiPermissionKey('GET', '/api/v1/admin/users%')).toBeNull()
  })
})
