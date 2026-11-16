import { DEFAULT_PREVIEW_BASE_DOMAIN, type CertificateConfig } from './commands'
import { createCertificateConfigLoader, readInternalApiToken } from './config-client'
import { CertificateManager } from './manager'

const CONFIG_URL = 'http://control-api:9880/api/v1/internal/auto-ssl-config'
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
const previewBaseDomain = process.env.CUDDLY_PREVIEW_BASE_DOMAIN ?? DEFAULT_PREVIEW_BASE_DOMAIN
const dnsProvider =
  process.env.CUDDLY_AUTO_SSL_DNS_PROVIDER === 'tencentcloud' ? 'tencentcloud' : null
const internalApiToken = await readInternalApiToken()
const loadConfig: () => Promise<CertificateConfig> = createCertificateConfigLoader({
  configUrl: CONFIG_URL,
  internalApiToken,
})

const manager = new CertificateManager({
  loadConfig,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  previewBaseDomain,
  dnsProvider,
})
manager.start()
console.log(`[cert-manager] started for *.${previewBaseDomain}`)

function shutdown(): void {
  manager.stop()
  console.log('[cert-manager] stopped')
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
