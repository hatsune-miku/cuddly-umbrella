import { describe, expect, it } from 'vitest'

import {
  configurationGroupErrorMessage,
  readinessPresentation,
  shareTokenFromPathname,
} from './ShareLanding'
import { ApiError } from './api'

describe('configuration share route', () => {
  it('accepts only an exact 32-character base64url token', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_12345'
    expect(token).toHaveLength(32)
    expect(shareTokenFromPathname(`/s/${token}`)).toBe(token)
  })

  it('does not take over unrelated console or malformed paths', () => {
    expect(shareTokenFromPathname('/')).toBeNull()
    expect(shareTokenFromPathname('/settings')).toBeNull()
    expect(shareTokenFromPathname('/s/short')).toBeNull()
    expect(shareTokenFromPathname(`/s/${'a'.repeat(32)}/extra`)).toBeNull()
    expect(shareTokenFromPathname(`/s/${'a'.repeat(31)}!`)).toBeNull()
  })
})

describe('configuration group presentation', () => {
  it('distinguishes official, ready, missing, and unavailable selections', () => {
    expect(readinessPresentation('OFFICIAL')).toMatchObject({ label: '官方', tone: 'official' })
    expect(readinessPresentation('READY')).toMatchObject({ label: '可用', tone: 'ready' })
    expect(readinessPresentation('MISSING')).toMatchObject({ label: '未就绪', tone: 'missing' })
    expect(readinessPresentation('UNAVAILABLE')).toMatchObject({
      label: '不可用',
      tone: 'unavailable',
    })
  })

  it('turns API failures into useful QA-facing messages', () => {
    expect(configurationGroupErrorMessage(new ApiError(404, null))).toContain('不存在')
    expect(configurationGroupErrorMessage(new ApiError(409, null))).toContain('当前不可用')
    expect(configurationGroupErrorMessage(new Error('network'))).toContain('网络')
  })
})
