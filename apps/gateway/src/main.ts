import { createArtifactStore } from '@cuddly/artifact-store'
import { createStore, resolveSystemSettings } from '@cuddly/db'

import { createGatewayApp, defaultHookPath } from './app'

const store = createStore()
const artifactStore = createArtifactStore()
await Promise.all([store.initialize(), artifactStore.initialize()])

async function runtimeOptions() {
  const settings = await resolveSystemSettings(store)
  return {
    allowedHosts: settings.mobileHostnames.map((value) => value.toLowerCase()),
    proxy: {
      upstream: new URL(settings.mobileUpstream),
      publicOrigin: new URL(settings.publicMobileOrigin),
      cookieDomain: settings.cookieDomain,
      maxRewriteBytes: settings.proxyRewriteMaxMegabytes * 1024 * 1024,
    },
  }
}

const initial = await runtimeOptions()
const rawInternalProxyUrl = process.env.CUDDLY_INTERNAL_PROXY_URL?.trim()
const internalProxyUrl = rawInternalProxyUrl ? new URL(rawInternalProxyUrl) : null
const app = createGatewayApp({
  store,
  artifactStore,
  environmentSlug: 'shared',
  targetId: 'online-h5',
  allowedHosts: initial.allowedHosts,
  hookPath: defaultHookPath(),
  proxy: initial.proxy,
  internalProxyUrl,
  resolveRuntimeOptions: runtimeOptions,
  previewBaseDomain: process.env.CUDDLY_PREVIEW_BASE_DOMAIN ?? 'bifrost.vanillacake.cn',
})

const server = app.listen(9872, () => console.log('[gateway] listening on 9872'))

async function shutdown() {
  server.close()
  await store.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
