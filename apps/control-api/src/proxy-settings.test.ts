import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore } from '@cuddly/db'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { ProxySettingsService } from './proxy-settings'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function fixture(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cuddly-proxy-'))
  directories.push(directory)
  const store = new MemoryStore()
  const configPath = path.join(directory, 'config.yaml')
  const service = new ProxySettingsService({
    store,
    settingsSecret: 'settings-test-secret',
    configPath,
    mihomoConfigPath: '/root/.config/mihomo/config.yaml',
    mihomoControllerUrl: 'http://mihomo:9090',
    mihomoControllerSecret: 'controller-secret',
    fetchImpl,
  })
  await service.start()
  return { store, configPath, service }
}

describe('ProxySettingsService', () => {
  it('encrypts the subscription and writes a constrained Mihomo config', async () => {
    const subscriptionUrl =
      'https://subscription.example.test/view/private-subscription-config?token=secret'
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === subscriptionUrl) {
        return new Response(`
mixed-port: 1234
external-controller: 0.0.0.0:9999
external-ui: /tmp/ui
tun:
  enable: true
proxies:
  - name: internal
    type: trojan
    server: proxy.example.test
    port: 443
    password: hidden
proxy-groups:
  - name: AUTO
    type: select
    proxies: [internal]
rules:
  - MATCH,AUTO
`)
      }
      return new Response(null, { status: 204 })
    }
    const { store, configPath, service } = await fixture(fetchImpl)

    const view = await service.update(
      { enabled: true, subscriptionUrl, refreshIntervalMinutes: 30 },
      'gz'
    )
    const stored = await store.getRuntimeSettings(['proxy.subscription_url'])
    const serialized = JSON.stringify(stored[0]?.value)
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>

    expect(serialized).not.toContain(subscriptionUrl)
    expect(view.subscriptionUrlMasked).toBe('https://subscription.example.test/view/privat...?***')
    expect(view.sources.subscriptionUrl).toBe('database')
    expect(config['mixed-port']).toBe(7890)
    expect(config['external-controller']).toBe('0.0.0.0:9090')
    expect(config['external-ui']).toBeUndefined()
    expect(config.tun).toEqual({ enable: false })
  })

  it('rolls back the database override and config when a new subscription is invalid', async () => {
    let valid = true
    const subscriptionUrl = 'https://subscription.example.test/view/config'
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === subscriptionUrl) {
        return new Response(
          valid
            ? 'proxies: [{name: node, type: direct}]\nrules: [MATCH,DIRECT]'
            : 'no-proxies: true'
        )
      }
      return new Response(null, { status: 204 })
    }
    const { store, configPath, service } = await fixture(fetchImpl)
    await service.update({ enabled: true, subscriptionUrl }, 'gz')
    const previousConfig = await readFile(configPath, 'utf8')
    const previousStored = await store.getRuntimeSettings(['proxy.subscription_url'])

    valid = false
    await expect(
      service.update({ subscriptionUrl: 'https://subscription.example.test/view/config' }, 'gz')
    ).rejects.toThrow('订阅中没有代理节点或代理提供者')

    expect(await readFile(configPath, 'utf8')).toBe(previousConfig)
    const restored = await store.getRuntimeSettings(['proxy.subscription_url'])
    expect(restored[0]?.value).toEqual(previousStored[0]?.value)
    expect(restored[0]?.updatedBy).toBe('gz:rollback')
  })
})
