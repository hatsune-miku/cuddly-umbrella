import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePopupTab, popupTabForKey } from '../popup-tabs.js'

test('defaults unknown popup tabs to the project workspace', () => {
  assert.equal(normalizePopupTab('projects'), 'projects')
  assert.equal(normalizePopupTab('queue'), 'queue')
  assert.equal(normalizePopupTab('unknown'), 'projects')
})

test('supports wrapping arrow navigation and Home/End keys', () => {
  assert.equal(popupTabForKey('projects', 'ArrowRight'), 'queue')
  assert.equal(popupTabForKey('queue', 'ArrowRight'), 'projects')
  assert.equal(popupTabForKey('projects', 'ArrowLeft'), 'queue')
  assert.equal(popupTabForKey('queue', 'Home'), 'projects')
  assert.equal(popupTabForKey('projects', 'End'), 'queue')
  assert.equal(popupTabForKey('queue', 'Enter'), 'queue')
})
