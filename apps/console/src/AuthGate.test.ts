import { describe, expect, it } from 'vitest'

import { authErrorMessage } from './AuthGate'

describe('Feishu login presentation', () => {
  it('turns callback failures into concise user-facing guidance', () => {
    expect(authErrorMessage('access_denied')).toContain('已取消')
    expect(authErrorMessage('invalid_state')).toContain('失效')
    expect(authErrorMessage('invalid_callback')).toContain('失效')
    expect(authErrorMessage('oauth_failed')).toContain('稍后重试')
    expect(authErrorMessage(null)).toBe('')
  })
})
