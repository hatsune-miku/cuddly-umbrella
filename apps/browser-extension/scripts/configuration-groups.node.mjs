import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configurationGroupBranchSummary,
  configurationGroupUpdateInput,
  isConfigurationGroupRevisionConflict,
  normalizeConfigurationGroups,
  normalizeProjectVersionTab,
  projectVersionTabForKey,
} from '../configuration-groups.js'

const token = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const group = {
  id: token,
  token,
  name: '频道权限重构',
  environmentId: 'environment-id',
  environmentSlug: 'shared',
  siteBindingId: 'main',
  schemaVersion: 1,
  items: [
    { targetId: 'webapp', mode: 'official' },
    { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
  ],
  createdBy: 'QA Alice',
  createdAt: '2026-08-25T12:34:56.000Z',
  updatedBy: 'QA Alice',
  updatedAt: '2026-08-25T12:34:56.000Z',
  revision: 3,
  sharePath: `/s/${token}`,
  previewSlug: '0123456789abcdef0123456789abcdef',
  previewHostnamePrefix: 'party-week',
}

test('project version tabs default to branches and support keyboard navigation', () => {
  assert.equal(normalizeProjectVersionTab('unknown'), 'branches')
  assert.equal(projectVersionTabForKey('branches', 'ArrowRight'), 'requirements')
  assert.equal(projectVersionTabForKey('requirements', 'ArrowLeft'), 'branches')
  assert.equal(projectVersionTabForKey('branches', 'Home'), 'requirements')
  assert.equal(projectVersionTabForKey('requirements', 'End'), 'branches')
})

test('configuration group catalogs preserve server order and reject malformed records', () => {
  const second = {
    ...group,
    id: '0123456789abcdefghijklmnopqrstuv',
    token: '0123456789abcdefghijklmnopqrstuv',
  }
  assert.deepEqual(
    normalizeConfigurationGroups({ items: [group, second] }).map((item) => item.token),
    [token, second.token]
  )
  assert.deepEqual(normalizeConfigurationGroups({ items: [{ ...group, revision: 0 }] }), [])
  assert.deepEqual(normalizeConfigurationGroups(null), [])
  assert.equal(
    normalizeConfigurationGroups({ items: [group] })[0].previewHostnamePrefix,
    'party-week'
  )
})

test('configuration group summaries expose selected branches and official counts', () => {
  assert.equal(
    configurationGroupBranchSummary(group, { base: '基础模块' }),
    '基础模块 · feature/permissions；1 项跟随官网'
  )
  assert.equal(
    configurationGroupBranchSummary({ items: [{ targetId: 'base', mode: 'official' }] }),
    '全部跟随官网版本'
  )
})

test('configuration group updates retain content or explicitly replace it with the current snapshot', () => {
  assert.deepEqual(configurationGroupUpdateInput(group, { name: ' 新名字 ' }), {
    name: '新名字',
    environmentSlug: 'shared',
    siteBindingId: 'main',
    schemaVersion: 1,
    items: group.items,
    expectedRevision: 3,
  })
  assert.deepEqual(
    configurationGroupUpdateInput(group, {
      name: '测试环境需求',
      snapshot: {
        bindingId: 'main-test',
        environmentSlug: 'tttt',
        items: [{ targetId: 'base', mode: 'branch', branch: 'feature/test' }],
      },
    }),
    {
      name: '测试环境需求',
      environmentSlug: 'tttt',
      siteBindingId: 'main-test',
      schemaVersion: 1,
      items: [{ targetId: 'base', mode: 'branch', branch: 'feature/test' }],
      expectedRevision: 3,
    }
  )
})

test('only revision conflicts use the concurrent-edit recovery path', () => {
  assert.equal(
    isConfigurationGroupRevisionConflict({
      status: 409,
      body: { code: 'CONFIG_GROUP_REVISION_CONFLICT' },
    }),
    true
  )
  assert.equal(
    isConfigurationGroupRevisionConflict({
      status: 409,
      body: { code: 'CONFIG_GROUP_CONTEXT_CHANGED' },
    }),
    false
  )
  assert.equal(isConfigurationGroupRevisionConflict(new Error('network')), false)
})
