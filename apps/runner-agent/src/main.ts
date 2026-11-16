import { createRunnerApp, createRunnerOptions } from './runner'

const options = await createRunnerOptions()
await options.artifactStore.initialize()
await options.artifactStore.clearStaleStagingDirectories()

const app = createRunnerApp(options)
const server = app.listen(9882, () => console.log('[runner-agent] listening on 9882'))

function shutdown() {
  server.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
