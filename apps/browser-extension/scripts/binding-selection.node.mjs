import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseBindingCandidate, normalizeBindingCandidates } from '../binding-selection.js'

const shared = {
  id: 'main',
  hostname: 'main.bifrost.example.test',
  environmentSlug: 'shared',
}
const qaA = {
  id: 'qa-a-main',
  hostname: 'qa-a-main.bifrost.example.test',
  environmentSlug: 'qa-a',
  environmentName: '需求 A',
  environmentStatus: 'FROZEN',
}

test('normalizes candidate envelopes and legacy single-binding responses', () => {
  assert.deepEqual(normalizeBindingCandidates({ items: [shared, shared, null] }), [shared])
  assert.deepEqual(normalizeBindingCandidates(qaA), [qaA])
  assert.deepEqual(
    normalizeBindingCandidates({ id: 'decoupled', hostname: 'main.preview.example.test' }),
    [{ id: 'decoupled', hostname: 'main.preview.example.test' }]
  )
  assert.deepEqual(normalizeBindingCandidates(null), [])
})

test('keeps an active tab binding ahead of the default site role binding', () => {
  assert.equal(
    chooseBindingCandidate({
      candidates: [shared, qaA],
      activeSiteBindingId: qaA.id,
    }),
    qaA
  )
  assert.equal(
    chooseBindingCandidate({ candidates: [shared, qaA], activeSiteBindingId: null }),
    shared
  )
})

test('a locked environment never falls back to a binding from another environment', () => {
  assert.equal(
    chooseBindingCandidate({
      candidates: [shared, qaA],
      activeSiteBindingId: shared.id,
      environmentSlug: 'qa-a',
    }),
    qaA
  )
  assert.equal(
    chooseBindingCandidate({
      candidates: [shared, qaA],
      activeSiteBindingId: shared.id,
      environmentSlug: 'missing',
    }),
    null
  )
})
