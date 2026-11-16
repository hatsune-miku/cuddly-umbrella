import os from 'node:os'

import { createStore, resolveSystemSettings } from '@cuddly/db'

import { BuildWorker } from './worker'

const store = createStore()
await store.initialize()

const worker = new BuildWorker({
  store,
  runnerUrl: 'http://runner-agent:9882',
  runnerToken: 'cuddly-internal-runner-v1',
  workerId: `${os.hostname()}:${process.pid}`,
  requestTimeoutMs: 30 * 60 * 1000,
  maxConcurrency: 3,
  resolveRuntimeSettings: async () => {
    const settings = await resolveSystemSettings(store)
    return {
      maxConcurrency: settings.buildMaxConcurrency,
      requestTimeoutMs: settings.runnerRequestTimeoutMinutes * 60_000,
      artifactBaseUrl: settings.publicPreviewOrigin,
    }
  },
})

let shutdownRequested = false
async function shutdown() {
  if (shutdownRequested) return
  shutdownRequested = true
  worker.stop()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('[build-worker] polling for build jobs with database-managed runtime settings')
try {
  await worker.run(1500)
} finally {
  await store.close()
}
