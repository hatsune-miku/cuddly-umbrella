import { readFile } from 'node:fs/promises'

import { createStore, PROJECT_TEMPLATES } from '@cuddly/db'
import { readOrCreateSecret } from '@cuddly/domain'

import { createControlApp } from './app'
import { FeishuOAuthClient, feishuCallbackUri, normalizePublicOrigin } from './auth'
import { ProxySettingsService } from './proxy-settings'

async function readRequiredSecret(filePath: string, label: string): Promise<string> {
  const value = (await readFile(filePath, 'utf8')).trim()
  if (!value) throw new Error(`${label} is empty: ${filePath}`)
  return value
}

const store = createStore()
await store.initialize()

const settingsSecret = await readOrCreateSecret('/srv/cuddly/secrets/settings.key')
const internalApiToken = await readOrCreateSecret('/srv/cuddly/cert-auth/token')
const publicOrigin = normalizePublicOrigin(
  process.env.CUDDLY_PUBLIC_ORIGIN ?? 'https://bifrost.vanillacake.cn'
)
const feishuAppId = await readRequiredSecret(
  process.env.CUDDLY_FEISHU_APP_ID_FILE ?? '/srv/cuddly/secrets/feishu/app_id',
  'Feishu app id'
)
const feishuAppSecret = await readRequiredSecret(
  process.env.CUDDLY_FEISHU_APP_SECRET_FILE ?? '/srv/cuddly/secrets/feishu/app_secret',
  'Feishu app secret'
)
const feishuOAuth = new FeishuOAuthClient({
  appId: feishuAppId,
  appSecret: feishuAppSecret,
  redirectUri: feishuCallbackUri(publicOrigin),
})
const proxySettings = new ProxySettingsService({
  store,
  settingsSecret,
  configPath: '/srv/cuddly/secrets/mihomo/config.yaml',
  mihomoConfigPath: '/root/.config/mihomo/config.yaml',
  mihomoControllerUrl: 'http://mihomo:9090',
  mihomoControllerSecret: '',
})
await proxySettings.start()

const app = createControlApp({
  store,
  internalApiToken,
  auth: { client: feishuOAuth, publicOrigin },
  mcp: {
    apiOrigin: 'http://127.0.0.1:9880',
    statePath: '/srv/cuddly/secrets/mcp/oauth-state.json',
  },
  proxySettings,
  projectTemplates: PROJECT_TEMPLATES,
  settingsSecret,
  logDirectory: '/srv/cuddly/logs',
  previewBaseDomain: process.env.CUDDLY_PREVIEW_BASE_DOMAIN ?? 'bifrost.vanillacake.cn',
})

const server = app.listen(9880, () => console.log('[control-api] listening on 9880'))

async function shutdown() {
  server.close()
  proxySettings.stop()
  await store.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
