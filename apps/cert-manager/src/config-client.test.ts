import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createCertificateConfigLoader, readInternalApiToken } from './config-client'

describe('certificate config client', () => {
  it('reads and trims the shared internal API token file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cuddly-cert-auth-'))
    const tokenFile = path.join(directory, 'token')
    try {
      await writeFile(tokenFile, 'shared-secret\n', 'utf8')
      await expect(readInternalApiToken(tokenFile)).resolves.toBe('shared-secret')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sends the shared token as a Bearer credential', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer shared-secret')
      return Response.json({
        autoSslEnabled: true,
        autoSslEmail: 'ops@example.com',
        hostnames: ['main.bifrost.vanillacake.cn'],
      })
    }) as typeof fetch
    const loadConfig = createCertificateConfigLoader({
      configUrl: 'http://control-api:9880/api/v1/internal/auto-ssl-config',
      internalApiToken: 'shared-secret',
      fetchImpl,
    })

    await expect(loadConfig()).resolves.toEqual({
      enabled: true,
      email: 'ops@example.com',
      hostnames: ['main.bifrost.vanillacake.cn'],
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
