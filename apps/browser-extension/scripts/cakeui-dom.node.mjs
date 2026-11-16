import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { setUiClass } from '../cakeui-dom.js'
import { cakePrimitives } from '../cakeui-primitives.js'

function element(tag, type = '') {
  return {
    tagName: tag.toUpperCase(),
    type,
    className: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value
    },
  }
}

test('CakeUI decorates a button without changing form semantics, state or callbacks', () => {
  const button = element('button', 'submit')
  button.disabled = true
  button.value = 'draft'
  button.onclick = () => 'original'
  setUiClass(button, 'primary-button share-submit')
  assert.equal(button.className, 'cake-button primary-button share-submit')
  assert.equal(button.attributes['data-variant'], 'primary')
  assert.equal(button.attributes['data-size'], 'small')
  assert.equal(button.type, 'submit')
  assert.equal(button.disabled, true)
  assert.equal(button.value, 'draft')
  assert.equal(button.onclick(), 'original')
})

test('redecorating dynamic controls preserves selectors without accumulating classes', () => {
  const button = element('button')
  setUiClass(button, 'queue-job-open')
  setUiClass(button, button.className)
  assert.equal(button.className, 'cake-button queue-job-open')
  assert.equal(button.attributes['data-variant'], 'ghost')
  setUiClass(button, 'cancel-build-button')
  assert.equal(button.attributes['data-variant'], 'danger')
})

test('native fields retain their type and original values', () => {
  for (const [tag, type, expected] of [
    ['input', 'search', 'cake-textbox'],
    ['input', 'url', 'cake-textbox'],
    ['input', 'number', 'cake-numberbox'],
    ['textarea', '', 'cake-textarea'],
    ['select', '', 'cake-combobox'],
  ]) {
    const input = element(tag, type)
    input.value = 'feature/中文'
    setUiClass(input, 'business-field')
    assert.equal(input.className, `${expected} business-field`)
    assert.equal(input.value, 'feature/中文')
    assert.equal(input.type, type)
  }
})

test('checkboxes are not accidentally turned into text boxes', () => {
  const checkbox = element('input', 'checkbox')
  checkbox.checked = true
  setUiClass(checkbox, 'overwrite-confirm')
  assert.equal(checkbox.className, 'overwrite-confirm')
  assert.equal(checkbox.checked, true)
})

test('status badges retain distinct success, failure, running and idle tones', () => {
  const badge = element('span')
  for (const [status, tone] of Object.entries({
    success: 'success',
    failed: 'danger',
    working: 'warning',
    canceling: 'warning',
    queued: 'accent',
    canceled: 'neutral',
    idle: 'neutral',
  })) {
    setUiClass(badge, `queue-status ${status}`)
    assert.equal(badge.attributes['data-tone'], tone)
    assert.match(badge.className, /cake-badge/)
  }
})

test('generated primitive contract pins the compact blue CakeUI theme', () => {
  assert.equal(cakePrimitives.provider.attributes['data-theme'], 'blue')
  assert.equal(cakePrimitives.provider.attributes['data-density'], 'compact')
  assert.equal(cakePrimitives.spinner.tag, 'span')
})

test('popup ships CakeUI locally and retains the native branch dropdown', async () => {
  const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8')
  assert.match(html, /href="cakeui\.css"/)
  assert.match(html, /href="cake-layout\.css"/)
  assert.doesNotMatch(html, /<link[^>]+href="https?:/)
  const adapter = await readFile(new URL('../cakeui-dom.js', import.meta.url), 'utf8')
  assert.doesNotMatch(adapter, /MutationObserver|setInterval|fetch\(/)
})
