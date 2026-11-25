import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

const mode = process.argv[2]?.trim() || 'download'
const environmentId = '00000000-0000-4000-8000-000000000001'
const job = {
  jobId: randomUUID(), artifactId: randomUUID(), targetId: 'isolated-fixture',
  environmentId, environmentSlug: 'isolated', branch: 'main', requestedBy: 'fixture',
  artifactBaseUrl: 'http://127.0.0.1',
  project: {
    id: 'isolated-fixture', repositoryUrl: 'file:///fixture-repo',
    environment: { id: environmentId, slug: 'isolated', name: 'Fixture', backendOrigin: 'https://example.test' },
    installCommand: mode === 'timeout' ? 'FIXTURE_HANG=1 npm install --package-lock=false --no-audit --no-fund' : 'npm install --package-lock=false --no-audit --no-fund',
    buildCommand: 'npm run build', outputDirectory: 'dist', siteAdapter: 'generic-static-v1',
  },
}
const start = Date.now()
const response = await fetch('http://127.0.0.1:9882/internal/run', {
  method: 'POST', headers: { authorization: 'Bearer cuddly-internal-runner-v1', 'content-type': 'application/json' },
  body: JSON.stringify(job), signal: AbortSignal.timeout(60000),
})
assert.equal(response.status, 200)
const events = (await response.text()).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
const result = events.at(-1)
const log = await fs.readFile(`/srv/cuddly/logs/${job.jobId}.log`, 'utf8')
if (mode === 'timeout') {
  assert.equal(result.code, 'INSTALL_TIMEOUT', JSON.stringify(result))
  assert.ok(Date.now() - start < 15000)
  const pid = Number(await fs.readFile('/srv/cuddly/fixture-child.pid', 'utf8'))
  // Docker init must reap the terminated npm lifecycle descendant.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.match(log, /fixture lifecycle entered/)
  assert.match(log, /\[TIMEOUT\]/)
} else {
  assert.equal(result.type, 'result', JSON.stringify(result))
  assert.match(log, mode === 'cache' ? /FIXTURE_BINARY_CACHE_HIT/ : /FIXTURE_BINARY_DOWNLOADED/)
  assert.match(log, /FIXTURE_BUILD_OK/)
}
console.log(JSON.stringify({ mode, result: result.code || result.type, elapsedMs: Date.now() - start, ready: await (await fetch('http://127.0.0.1:9882/health/ready')).json() }))
