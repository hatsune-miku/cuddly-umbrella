import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseRestoredPopupState,
  operationMatchesContext,
  popupStateScopeKey,
  readScopedPopupState,
  removeScopedPopupStatesForTab,
  retainScopedPopupStatesForTabs,
  writeScopedPopupState,
} from '../popup-state.js'

test('keeps branch choices and submission locks isolated by tab, binding, and environment', () => {
  let store = writeScopedPopupState(null, {
    tabId: 7,
    bindingId: 'main',
    environmentSlug: 'online',
    selectedBranches: { webapp: 'feature/chat' },
    submittedBuildBranches: { webapp: 'feature/chat' },
    siteOverrideEnabled: true,
    updatedAt: 1,
  })
  store = writeScopedPopupState(store, {
    tabId: 7,
    bindingId: 'main',
    environmentSlug: 'test',
    selectedBranches: { webapp: 'develop' },
    submittedBuildBranches: {},
    siteOverrideEnabled: false,
    updatedAt: 2,
  })

  assert.equal(popupStateScopeKey(7, 'main', 'online'), '7:main:online')
  assert.deepEqual(
    readScopedPopupState(store, {
      tabId: 7,
      bindingId: 'main',
      environmentSlug: 'online',
    }),
    {
      selectedBranches: { webapp: 'feature/chat' },
      submittedBuildBranches: { webapp: 'feature/chat' },
      siteOverrideEnabled: true,
      updatedAt: 1,
    }
  )
  assert.deepEqual(
    readScopedPopupState(store, { tabId: 7, bindingId: 'main', environmentSlug: 'test' }),
    {
      selectedBranches: { webapp: 'develop' },
      submittedBuildBranches: {},
      siteOverrideEnabled: false,
      updatedAt: 2,
    }
  )
  assert.equal(
    readScopedPopupState(store, { tabId: 8, bindingId: 'main', environmentSlug: 'online' }),
    null
  )
})

test('sanitizes persisted popup state', () => {
  const stored = readScopedPopupState(
    {
      '3:binding:online': {
        selectedBranches: { webapp: 'main', invalid: 3 },
        submittedBuildBranches: ['not', 'a', 'record'],
        updatedAt: 'yesterday',
      },
    },
    { tabId: 3, bindingId: 'binding', environmentSlug: 'online' }
  )
  assert.deepEqual(stored, {
    selectedBranches: { webapp: 'main' },
    submittedBuildBranches: {},
    siteOverrideEnabled: false,
    updatedAt: 0,
  })
})

test('treats a legacy persisted page branch as a draft instead of an implicit page override', () => {
  const stored = readScopedPopupState(
    {
      '3:main:shared': {
        selectedBranches: { webapp: 'master', discover: 'feature/discover' },
        submittedBuildBranches: {},
        updatedAt: 8,
      },
    },
    { tabId: 3, bindingId: 'main', environmentSlug: 'shared' }
  )

  assert.equal(stored.siteOverrideEnabled, false)
  assert.equal(stored.selectedBranches.webapp, 'master')
})

test('removes closed tabs and rejects stale or malformed local fallback scopes', () => {
  const store = {
    '3:main:online': { selectedBranches: { base: 'feature/a' }, updatedAt: 3 },
    '3:main:test': { selectedBranches: { base: 'feature/b' }, updatedAt: 2 },
    '4:main:online': { selectedBranches: { base: 'feature/c' }, updatedAt: 1 },
    malformed: { selectedBranches: { base: 'stale' }, updatedAt: 4 },
  }

  assert.deepEqual(removeScopedPopupStatesForTab(store, 3), {
    '4:main:online': store['4:main:online'],
    malformed: store.malformed,
  })
  assert.deepEqual(retainScopedPopupStatesForTabs(store, [3]), {
    '3:main:online': store['3:main:online'],
    '3:main:test': store['3:main:test'],
  })
})

test('keeps the current popup selection ahead of a stale persisted snapshot during refresh', () => {
  const current = {
    selectedBranches: { base: 'feature/current' },
    submittedBuildBranches: {},
  }
  const stale = {
    selectedBranches: { base: 'master' },
    submittedBuildBranches: {},
  }

  assert.equal(chooseRestoredPopupState(current, stale), current)
  assert.equal(chooseRestoredPopupState(null, stale), stale)
  assert.equal(chooseRestoredPopupState(null, null), null)
})

test('rejects stale async operations after environment or branch changes', () => {
  const operation = {
    tabId: 5,
    bindingId: 'online-binding',
    environmentSlug: 'online',
    targetId: 'webapp',
    branch: 'feature/chat',
    contextVersion: 4,
  }
  assert.equal(operationMatchesContext(operation, operation, { requireBranch: true }), true)
  assert.equal(
    operationMatchesContext(operation, { ...operation, bindingId: 'test-binding' }),
    false
  )
  assert.equal(operationMatchesContext(operation, { ...operation, environmentSlug: 'test' }), false)
  assert.equal(operationMatchesContext(operation, { ...operation, contextVersion: 5 }), false)
  assert.equal(
    operationMatchesContext(
      operation,
      { ...operation, branch: 'feature/voice' },
      { requireBranch: true }
    ),
    false
  )
})
