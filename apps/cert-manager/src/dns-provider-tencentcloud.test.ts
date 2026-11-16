import { describe, expect, it } from 'vitest'

import { challengeRecord, parseTencentCloudDnsCredentials } from './dns-provider-tencentcloud'

describe('Tencent Cloud DNS-01 support', () => {
  it('reads the dedicated secret file without accepting an incomplete credential', () => {
    expect(
      parseTencentCloudDnsCredentials(
        'TENCENTCLOUD_SECRET_ID=id\nTENCENTCLOUD_SECRET_KEY=secret\nTENCENTCLOUD_DNS_ZONE=vanillacake.cn\n'
      )
    ).toEqual({ secretId: 'id', secretKey: 'secret', zone: 'vanillacake.cn' })
    expect(() => parseTencentCloudDnsCredentials('TENCENTCLOUD_SECRET_ID=id')).toThrow('incomplete')
  })

  it('maps the wildcard authorization to one DNSPod subdomain', () => {
    expect(challengeRecord('*.bifrost.vanillacake.cn', 'vanillacake.cn')).toEqual({
      fqdn: '_acme-challenge.bifrost.vanillacake.cn',
      subdomain: '_acme-challenge.bifrost',
    })
  })
})
