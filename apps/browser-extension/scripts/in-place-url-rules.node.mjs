import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inPlaceRuleEnvironment,
  matchInPlaceUrlRule,
  normalizeInPlaceUrlRules,
} from '../in-place-url-rules.js'

test('normalizes literal URL rules and rejects malformed or duplicate entries', () => {
  assert.deepEqual(
    normalizeInPlaceUrlRules([
      { pattern: '  www.kookapp.cn  ', environmentSlug: ' shared ' },
      { pattern: 'www.kookapp.cn', environmentSlug: 'tttt' },
      { pattern: '', environmentSlug: 'shared' },
      { pattern: 'tttt-www.dev.chuanyuapp.com', environmentSlug: 'TTTT' },
      null,
    ]),
    [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }]
  )
})

test('matches the full URL as a case-sensitive literal and prefers the longest pattern', () => {
  const rules = [
    { pattern: 'kookapp.cn', environmentSlug: 'shared' },
    { pattern: 'www.kookapp.cn/channels', environmentSlug: 'channel_test' },
  ]
  assert.deepEqual(
    matchInPlaceUrlRule('https://www.kookapp.cn/channels/42?view=compact', rules),
    rules[1]
  )
  assert.equal(matchInPlaceUrlRule('https://WWW.kookapp.cn/channels/42', [rules[1]]), null)
  assert.equal(matchInPlaceUrlRule('https://example.test/', rules), null)
})

test('resolves only a non-archived environment selected by the rule', () => {
  const rule = { pattern: 'example.test', environmentSlug: 'qa' }
  const active = { slug: 'qa', status: 'ACTIVE' }
  assert.equal(inPlaceRuleEnvironment(rule, [active]), active)
  assert.equal(inPlaceRuleEnvironment(rule, [{ ...active, status: 'ARCHIVED' }]), null)
  assert.equal(inPlaceRuleEnvironment(rule, [{ slug: 'other', status: 'ACTIVE' }]), null)
})
