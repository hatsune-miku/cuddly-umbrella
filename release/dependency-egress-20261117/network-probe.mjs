import assert from 'node:assert/strict'
import https from 'node:https'
import dns from 'node:dns/promises'

// A fresh Agent deliberately ignores proxy environment variables.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[key]
assert.ok((await dns.lookup('control-api')).address)
assert.equal((await fetch('http://control-api:9880/health/live', { signal: AbortSignal.timeout(5000) })).status, 200)
for (const url of ['https://registry.npmmirror.com/esbuild', 'https://github.com/robots.txt', 'https://nodejs.org/dist/index.json']) {
  const start = Date.now()
  const status = await new Promise((resolve, reject) => {
    const request = https.get(url, { agent: new https.Agent({ keepAlive: false }), timeout: 15_000, signal: AbortSignal.timeout(20000) }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
      response.on('error', reject)
      response.on('close', () => { if (!response.complete) reject(new Error('Incomplete response')) })
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Network probe timed out')))
  })
  assert.equal(status, 200)
  console.log(JSON.stringify({ url, status, elapsedMs: Date.now() - start }))
}
console.log('NETWORK_PROBE_OK: raw HTTPS without proxy variables; Docker DNS and internal API reachable')
