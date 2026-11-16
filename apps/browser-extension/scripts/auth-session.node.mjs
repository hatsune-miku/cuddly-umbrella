import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticatedRequestInit,
  feishuLoginUrl,
  normalizeAuthSession,
  requestNeedsCsrf,
} from '../auth-session.js'

test('normalizes the authenticated session identity without accepting unsafe avatars', () => {
  assert.deepEqual(
    normalizeAuthSession({
      authenticated: true,
      identity: { name: '  QA   Alice  ', avatarUrl: 'javascript:alert(1)' },
      csrfToken: ' csrf-token ',
    }),
    {
      authenticated: true,
      guest: false,
      identity: { name: 'QA Alice', avatarUrl: '' },
      csrfToken: 'csrf-token',
    }
  )
})

test('rejects incomplete or unauthenticated session responses', () => {
  assert.equal(normalizeAuthSession({ authenticated: false }), null)
  assert.equal(normalizeAuthSession({ authenticated: true, identity: { name: 'QA' } }), null)
})

test('includes credentials on reads and csrf on mutations', () => {
  assert.equal(requestNeedsCsrf({ method: 'GET' }), false)
  assert.equal(requestNeedsCsrf({ method: 'POST' }), true)
  assert.deepEqual(authenticatedRequestInit(), { credentials: 'include', headers: {} })
  assert.deepEqual(authenticatedRequestInit({ method: 'DELETE' }, 'csrf-token'), {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'x-cuddly-csrf': 'csrf-token' },
  })
  assert.throws(() => authenticatedRequestInit({ method: 'POST' }), /重新登录/)
})

test('builds the fixed Feishu login landing with an encoded relative return path', () => {
  assert.equal(
    feishuLoginUrl('https://bifrost.vanillacake.cn'),
    'https://bifrost.vanillacake.cn/api/v1/auth/feishu/start?return_to=%2F'
  )
})
