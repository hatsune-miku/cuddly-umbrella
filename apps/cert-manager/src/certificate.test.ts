import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RENEW_BEFORE_MS,
  inspectCertificatePem,
  inspectLocalCertificate,
} from './certificate'

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDVTCCAj2gAwIBAgIUR4+wrGB5kw1hJxarVHqPZJCwt4EwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbbWFpbi5iaWZyb3N0LnZhbmlsbGFjYWtlLmNuMB4XDTI2
MDgyNDA0Mjc1OFoXDTM2MDgyMTA0Mjc1OFowJjEkMCIGA1UEAwwbbWFpbi5iaWZy
b3N0LnZhbmlsbGFjYWtlLmNuMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAxYRlBVkPLI2DibJBcBXPVhs2Mvz+ZpbyuHyw74PdybSYjPvkfDsh+aJoI/Db
2ora7leIqWy/EUDk4OY9eMpAf4Te+u9EXmjv7/mnA3TPkvIRFYsVw7Y4qCQxV1Nk
WPyjBQeTymdyoE3W+0AQMAW3So4JhT9+CVFeqiKbUrtpXolIoJO4yTtXeyPohwLQ
Ig32hvVmTluE7Mpr/joOuqloRF3dzp6TfthuK5YovEHa7dJQ3uKRO6Vd6eamQFR/
wADzMnGpNT/nbhy4Shit7bEHxlcxiFhozWc4MoNKOTq964/CC8pWWdrbIgswp7P5
u6Op9ytqV9odSISXz27QwP+JPwIDAQABo3sweTAdBgNVHQ4EFgQUBpICf+gjD+Vq
FGcbhaCIETrxBbwwHwYDVR0jBBgwFoAUBpICf+gjD+VqFGcbhaCIETrxBbwwDwYD
VR0TAQH/BAUwAwEB/zAmBgNVHREEHzAdghttYWluLmJpZnJvc3QudmFuaWxsYWNh
a2UuY24wDQYJKoZIhvcNAQELBQADggEBAC+egHXJpzp7KI093Wbw4libYN+mSrGV
PbDImLzEHEBKWkyYl+/y/GviAtyLEXAaRmreX0DntACgFCivnEyrr5OLCCOpnV9c
F5sE4LHl7M0kNBckELfIkaB4naMBwC9qnQ/iPqUBVMKJf0h0vtwSaz+RXo6wZkc6
THX6HvAAEi3bmEsRKsWh3ASmC2MtpPxPe85KFgbGPNHJuhAQ/F8ddB0OcsumEiJT
wgqh9fFs5pfdNtyzO2nr37+8NuizdM86nbMmT+tg/Wha/58ARzmaZ7LOKLs8UUda
ETW0dKm0Z5uk/XWXvAm887isNI0lRxhlFrAoKx1d78c7S2oW1WNIlSo=
-----END CERTIFICATE-----`

const cleanupDirectories: string[] = []

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('local certificate inspection', () => {
  it('skips Certbot only while the matching certificate has more than 30 days left', () => {
    const expiresMs = Date.parse('2036-08-21T04:27:58.000Z')
    expect(
      inspectCertificatePem(TEST_CERTIFICATE, 'main.bifrost.vanillacake.cn', {
        nowMs: expiresMs - DEFAULT_RENEW_BEFORE_MS - 1,
      })
    ).toMatchObject({ runCertbot: false, reason: 'fresh' })
    expect(
      inspectCertificatePem(TEST_CERTIFICATE, 'main.bifrost.vanillacake.cn', {
        nowMs: expiresMs - DEFAULT_RENEW_BEFORE_MS,
      })
    ).toMatchObject({ runCertbot: true, reason: 'expiring' })
  })

  it('renews malformed, mismatched, and not-yet-valid certificates', () => {
    expect(inspectCertificatePem('not a certificate', 'main.bifrost.vanillacake.cn')).toEqual({
      runCertbot: true,
      reason: 'malformed',
      expiresAt: null,
    })
    expect(inspectCertificatePem(TEST_CERTIFICATE, 'voice.bifrost.vanillacake.cn')).toMatchObject({
      runCertbot: true,
      reason: 'hostname-mismatch',
    })
    expect(
      inspectCertificatePem(TEST_CERTIFICATE, 'main.bifrost.vanillacake.cn', {
        requiredHostnames: ['p-00000000000000000000000000000000.bifrost.vanillacake.cn'],
      })
    ).toMatchObject({ runCertbot: true, reason: 'hostname-mismatch' })
    expect(
      inspectCertificatePem(TEST_CERTIFICATE, 'main.bifrost.vanillacake.cn', {
        nowMs: Date.parse('2026-08-24T04:27:57.000Z'),
      })
    ).toMatchObject({ runCertbot: true, reason: 'not-yet-valid' })
  })

  it('reads the live fullchain and treats a missing lineage as requiring Certbot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-certificate-inspection-'))
    cleanupDirectories.push(root)
    const hostname = 'main.bifrost.vanillacake.cn'
    const liveDirectory = path.join(root, 'live', hostname)
    await mkdir(liveDirectory, { recursive: true })
    await writeFile(path.join(liveDirectory, 'fullchain.pem'), TEST_CERTIFICATE)
    const expiresMs = Date.parse('2036-08-21T04:27:58.000Z')

    await expect(
      inspectLocalCertificate(hostname, {
        certificateRoot: root,
        nowMs: expiresMs - DEFAULT_RENEW_BEFORE_MS - 1,
      })
    ).resolves.toMatchObject({ runCertbot: false, reason: 'fresh' })
    await expect(
      inspectLocalCertificate('missing.bifrost.vanillacake.cn', { certificateRoot: root })
    ).resolves.toEqual({ runCertbot: true, reason: 'missing', expiresAt: null })
  })
})
