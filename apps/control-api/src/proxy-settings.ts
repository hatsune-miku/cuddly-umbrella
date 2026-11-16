import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  ProxySettingsView,
  RuntimeSettingSource,
  UpdateProxySettingsInput,
} from '@cuddly/contracts'
import type { CuddlyStore, RuntimeSettingChange } from '@cuddly/db'
import { decryptSetting, encryptSetting, type EncryptedValue } from '@cuddly/domain'
import { parse, stringify } from 'yaml'

const SETTING_KEYS = {
  enabled: 'proxy.enabled',
  subscriptionUrl: 'proxy.subscription_url',
  refreshIntervalMinutes: 'proxy.refresh_interval_minutes',
} as const

interface ProxyStatus {
  mihomoReachable: boolean
  lastAppliedAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
}

export interface ProxySettingsServiceOptions {
  store: CuddlyStore
  settingsSecret: string
  configPath: string
  mihomoConfigPath: string
  mihomoControllerUrl: string
  mihomoControllerSecret: string
  fetchImpl?: typeof fetch
}

export function maskSubscriptionUrl(value: string): string {
  const url = new URL(value)
  const visiblePath = url.pathname.length > 18 ? `${url.pathname.slice(0, 12)}...` : url.pathname
  return `${url.protocol}//${url.host}${visiblePath}${url.search ? '?***' : ''}`
}

function directConfig(controllerSecret: string): Record<string, unknown> {
  return {
    'mixed-port': 7890,
    'allow-lan': true,
    mode: 'direct',
    'log-level': 'info',
    'external-controller': '0.0.0.0:9090',
    secret: controllerSecret,
    ipv6: false,
    tun: { enable: false },
    proxies: [],
    'proxy-groups': [],
    rules: ['MATCH,DIRECT'],
  }
}

function sanitizeSubscription(raw: string, controllerSecret: string): Record<string, unknown> {
  let document: unknown
  try {
    document = parse(raw)
  } catch {
    throw new Error('订阅内容不是有效的 Clash YAML')
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('订阅内容不是有效的 Clash 配置')
  }
  const config = document as Record<string, unknown>
  if (!Array.isArray(config.proxies) && !config['proxy-providers']) {
    throw new Error('订阅中没有代理节点或代理提供者')
  }
  config['mixed-port'] = 7890
  config['allow-lan'] = true
  config['bind-address'] = '*'
  config['external-controller'] = '0.0.0.0:9090'
  config.secret = controllerSecret
  config.tun = { enable: false }
  config.ipv6 = false
  delete config['external-ui']
  delete config['external-ui-url']
  delete config['external-controller-unix']
  delete config['external-controller-pipe']
  delete config['socks-port']
  delete config.port
  delete config['redir-port']
  delete config['tproxy-port']
  delete config.listeners
  return config
}

export class ProxySettingsService {
  private readonly fetchImpl: typeof fetch
  private timer: NodeJS.Timeout | null = null
  private applying: Promise<void> | null = null
  private status: ProxyStatus = {
    mihomoReachable: false,
    lastAppliedAt: null,
    lastCheckedAt: null,
    lastError: null,
  }

  constructor(private readonly options: ProxySettingsServiceOptions) {
    this.fetchImpl = options.fetchImpl || fetch
  }

  async start(): Promise<void> {
    await mkdir(path.dirname(this.options.configPath), { recursive: true })
    await this.apply().catch((error) => {
      this.status.lastError = error instanceof Error ? error.message : String(error)
    })
    this.schedule()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async getView(): Promise<ProxySettingsView> {
    const resolved = await this.resolve()
    return {
      enabled: resolved.enabled,
      subscriptionConfigured: Boolean(resolved.subscriptionUrl),
      subscriptionUrlMasked: resolved.subscriptionUrl
        ? maskSubscriptionUrl(resolved.subscriptionUrl)
        : null,
      refreshIntervalMinutes: resolved.refreshIntervalMinutes,
      sources: resolved.sources,
      status: { ...this.status },
    }
  }

  async update(input: UpdateProxySettingsInput, actor: string): Promise<ProxySettingsView> {
    const changes: RuntimeSettingChange[] = []
    if (input.enabled !== undefined) {
      changes.push({ key: SETTING_KEYS.enabled, value: input.enabled })
    }
    if (input.subscriptionUrl !== undefined) {
      changes.push({
        key: SETTING_KEYS.subscriptionUrl,
        value: encryptSetting(input.subscriptionUrl, this.options.settingsSecret),
      })
    }
    if (input.refreshIntervalMinutes !== undefined) {
      changes.push({
        key: SETTING_KEYS.refreshIntervalMinutes,
        value: input.refreshIntervalMinutes,
      })
    }
    await this.updateWithRollback(changes, actor)
    this.schedule()
    return this.getView()
  }

  async reset(keys: Array<keyof typeof SETTING_KEYS>, actor: string): Promise<ProxySettingsView> {
    await this.updateWithRollback(
      keys.map((key) => ({ key: SETTING_KEYS[key], value: null })),
      actor
    )
    this.schedule()
    return this.getView()
  }

  async refresh(): Promise<ProxySettingsView> {
    await this.apply()
    this.schedule()
    return this.getView()
  }

  private async resolve(): Promise<{
    enabled: boolean
    subscriptionUrl: string
    refreshIntervalMinutes: number
    sources: ProxySettingsView['sources']
  }> {
    const records = await this.options.store.getRuntimeSettings(Object.values(SETTING_KEYS))
    const byKey = new Map(records.map((record) => [record.key, record.value]))
    const source = (key: string): RuntimeSettingSource => (byKey.has(key) ? 'database' : 'default')
    const encrypted = byKey.get(SETTING_KEYS.subscriptionUrl) as EncryptedValue | undefined
    return {
      enabled: (byKey.get(SETTING_KEYS.enabled) as boolean | undefined) ?? false,
      subscriptionUrl: encrypted ? decryptSetting(encrypted, this.options.settingsSecret) : '',
      refreshIntervalMinutes:
        (byKey.get(SETTING_KEYS.refreshIntervalMinutes) as number | undefined) ?? 60,
      sources: {
        enabled: source(SETTING_KEYS.enabled),
        subscriptionUrl: source(SETTING_KEYS.subscriptionUrl),
        refreshIntervalMinutes: source(SETTING_KEYS.refreshIntervalMinutes),
      },
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    void this.resolve()
      .then((resolved) => resolved.refreshIntervalMinutes)
      .catch(() => 60)
      .then((minutes) => {
        this.timer = setTimeout(async () => {
          try {
            await this.apply()
          } catch (error) {
            this.status.lastError = error instanceof Error ? error.message : String(error)
          } finally {
            this.schedule()
          }
        }, minutes * 60_000)
        this.timer.unref()
      })
  }

  private async apply(): Promise<void> {
    if (this.applying) return this.applying
    this.applying = this.applyOnce()
      .catch((error) => {
        this.status.lastError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.applying = null
      })
    return this.applying
  }

  private async updateWithRollback(changes: RuntimeSettingChange[], actor: string): Promise<void> {
    const keys = changes.map((change) => change.key)
    const previous = new Map(
      (await this.options.store.getRuntimeSettings(keys)).map((record) => [
        record.key,
        record.value,
      ])
    )
    await this.options.store.updateRuntimeSettings(changes, actor)
    try {
      await this.apply()
    } catch (error) {
      await this.options.store.updateRuntimeSettings(
        keys.map((key) => ({ key, value: previous.has(key) ? previous.get(key)! : null })),
        `${actor}:rollback`
      )
      await this.apply().catch(() => undefined)
      throw error
    }
  }

  private async applyOnce(): Promise<void> {
    const resolved = await this.resolve()
    this.status.lastCheckedAt = new Date().toISOString()
    let config = directConfig(this.options.mihomoControllerSecret)
    if (resolved.enabled) {
      if (!resolved.subscriptionUrl) throw new Error('代理已启用，但没有配置订阅链接')
      const response = await this.fetchImpl(resolved.subscriptionUrl, {
        headers: { 'user-agent': 'Cuddly/1.0 Mihomo' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`订阅下载失败：HTTP ${response.status}`)
      config = sanitizeSubscription(await response.text(), this.options.mihomoControllerSecret)
    }

    const temporaryPath = `${this.options.configPath}.tmp`
    const previousConfig = await readFile(this.options.configPath).catch(() => null)
    await writeFile(temporaryPath, stringify(config), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.options.configPath)
    try {
      await this.reloadMihomo()
    } catch (error) {
      if (previousConfig) {
        await writeFile(temporaryPath, previousConfig, { mode: 0o600 })
        await rename(temporaryPath, this.options.configPath)
        await this.reloadMihomo().catch(() => undefined)
      }
      throw error
    }
    this.status.lastAppliedAt = new Date().toISOString()
    this.status.lastError = null
  }

  private async reloadMihomo(): Promise<void> {
    const headers = this.options.mihomoControllerSecret
      ? { authorization: `Bearer ${this.options.mihomoControllerSecret}` }
      : undefined
    const response = await this.fetchImpl(
      `${this.options.mihomoControllerUrl}/configs?force=true`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ path: this.options.mihomoConfigPath }),
        signal: AbortSignal.timeout(10_000),
      }
    ).catch(() => null)
    this.status.mihomoReachable = Boolean(response?.ok)
    if (!response?.ok) {
      throw new Error('Mihomo 暂不可达，配置已写入并将在容器启动后加载')
    }
  }
}
