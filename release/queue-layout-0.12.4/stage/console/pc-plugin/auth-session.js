const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function compactText(value, maximumLength) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximumLength) : ''
}

function safeAvatarUrl(value) {
  const candidate = compactText(value, 2048)
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

export function normalizeAuthSession(value) {
  if (!value || value.authenticated !== true || !value.identity) return null
  const name = compactText(value.identity.name, 80)
  const csrfToken = compactText(value.csrfToken, 512)
  if (!name || !csrfToken) return null
  return {
    authenticated: true,
    guest: value.guest === true,
    identity: {
      name,
      avatarUrl: safeAvatarUrl(value.identity.avatarUrl),
    },
    csrfToken,
  }
}

export function requestNeedsCsrf(init = {}) {
  return MUTATING_METHODS.has(String(init.method || 'GET').toUpperCase())
}

export function authenticatedRequestInit(init = {}, csrfToken = '') {
  const needsCsrf = requestNeedsCsrf(init)
  if (needsCsrf && !csrfToken) throw new Error('飞书登录状态无效，请重新登录')
  return {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      ...(needsCsrf ? { 'x-cuddly-csrf': csrfToken } : {}),
    },
  }
}

export function feishuLoginUrl(controlOrigin) {
  const url = new URL('/api/v1/auth/feishu/start', controlOrigin)
  url.searchParams.set('return_to', '/')
  return url.href
}
