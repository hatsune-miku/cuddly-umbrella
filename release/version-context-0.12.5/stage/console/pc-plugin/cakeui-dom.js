import { cakePrimitives } from './cakeui-primitives.js'

// The popup owns its state in native DOM. Reuse CakeUI's build-time rendered native
// primitives without introducing a second React reconciler or observing the whole page.
function primitiveFor(element, className) {
  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return cakePrimitives.button
  if (tag === 'select') return cakePrimitives.select
  if (tag === 'textarea') return cakePrimitives.textarea
  if (tag === 'input' && !['checkbox', 'radio'].includes(element.type))
    return element.type === 'number' ? cakePrimitives.number : cakePrimitives.text
  if (tag === 'span' && className.includes('loading-spinner')) return cakePrimitives.spinner
  if (tag === 'span' && /(?:queue-status|module-kind|requirement-environment)/.test(className))
    return cakePrimitives.badge
  return null
}

export function setUiClass(element, className) {
  const business = String(className)
    .split(/\s+/)
    .filter((name) => !name.startsWith('cake-'))
    .join(' ')
  const primitive = primitiveFor(element, business)
  element.className = [primitive?.attributes.class, business].filter(Boolean).join(' ')
  if (primitive) {
    for (const name of ['data-size', 'data-tone']) {
      if (primitive.attributes[name]) element.setAttribute(name, primitive.attributes[name])
    }
    if (element.tagName === 'BUTTON') {
      const variant = /(?:danger|cancel-button|cancel-build|delete-button)/.test(business)
        ? 'danger'
        : /(?:primary-button|share-button)/.test(business)
          ? 'primary'
          : /(?:icon-button|text-button|identity-logout|requirement-action|requirement-use|queue-job-open|queue-job-link|branch-picker-option|branch-option)/.test(
                business
              )
            ? 'ghost'
            : 'default'
      element.setAttribute('data-variant', variant)
    }
    if (primitive === cakePrimitives.badge) {
      const tone = /\bfailed\b/.test(business)
        ? 'danger'
        : /\bsuccess\b/.test(business)
          ? 'success'
          : /\b(?:working|canceling)\b/.test(business)
            ? 'warning'
            : /\b(?:canceled|idle)\b/.test(business)
              ? 'neutral'
              : 'accent'
      element.setAttribute('data-tone', tone)
    }
  }
  return element
}

export function createUiElement(tagName) {
  return setUiClass(document.createElement(tagName), '')
}

export function initializeCakeUI(root = document) {
  for (const element of root.querySelectorAll(
    'button, input, select, textarea, .module-loading-spinner'
  )) {
    setUiClass(element, element.className)
  }
  for (const [name, value] of Object.entries(cakePrimitives.provider.attributes)) {
    if (name === 'class') document.body.classList.add(...value.split(' '))
    else document.body.setAttribute(name, value)
  }
}
