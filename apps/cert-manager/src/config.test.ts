import { describe, expect, it } from 'vitest'

import { parseCertificateConfig } from './config'

describe('certificate config parsing', () => {
  it('accepts the internal auto SSL response', () => {
    expect(
      parseCertificateConfig({
        autoSslEnabled: true,
        autoSslEmail: 'ops@example.com',
        hostnames: ['main.bifrost.vanillacake.cn'],
      })
    ).toEqual({
      enabled: true,
      email: 'ops@example.com',
      hostnames: ['main.bifrost.vanillacake.cn'],
    })
  })

  it('does not accept the retired certificate config field names', () => {
    expect(() =>
      parseCertificateConfig({
        enabled: true,
        email: 'ops@example.com',
        hostnames: ['main.bifrost.vanillacake.cn'],
      })
    ).toThrow('autoSslEnabled')
  })
})
