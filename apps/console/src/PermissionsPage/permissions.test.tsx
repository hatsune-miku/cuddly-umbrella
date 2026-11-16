import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultAuthorizationPolicy } from '@cuddly/contracts'

import { PermissionsPage } from './index'
import { PolicyEditor } from './components/PolicyEditor'

describe('permission management levels', () => {
  it('opens only feature policy for level 4 and user management from level 6', () => {
    const policyOnly = renderToStaticMarkup(
      <PermissionsPage authorization={{ permissionLevel: 4, roles: [] }} />
    )
    expect(policyOnly).toContain('正在读取功能权限')
    expect(policyOnly).not.toContain('正在读取用户')
    const users = renderToStaticMarkup(
      <PermissionsPage authorization={{ permissionLevel: 6, roles: [] }} />
    )
    expect(users).toContain('正在读取用户')
    const denied = renderToStaticMarkup(
      <PermissionsPage authorization={{ permissionLevel: 3, roles: ['owner'] }} />
    )
    expect(denied).toContain('此页面需要 4 级权限')
  })
  it('keeps both management rules locked and bounds new-user defaults', () => {
    const html = renderToStaticMarkup(
      <PolicyEditor policy={defaultAuthorizationPolicy()} actorLevel={6} onSaved={() => {}} />
    )
    expect(html).toMatch(
      /<input(?=[^>]*aria-label="用户管理最低权限等级")(?=[^>]*disabled="")(?=[^>]*value="6")[^>]*>/
    )
    expect(html).toMatch(
      /<input(?=[^>]*aria-label="功能权限配置最低权限等级")(?=[^>]*disabled="")(?=[^>]*value="4")[^>]*>/
    )
    expect(html).toContain('max="6"')
  })
})
