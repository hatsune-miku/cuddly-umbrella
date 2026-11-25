import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'

if (process.env.FIXTURE_HANG === '1') {
  process.on('SIGTERM', () => {})
  await fs.writeFile('/srv/cuddly/fixture-child.pid', String(process.pid))
  console.log('fixture lifecycle entered; deliberately ignoring SIGTERM')
  setInterval(() => {}, 1000)
} else {
  // Emulate the package's own downloader, not npm's registry requests.
  const directory = process.env.XDG_CACHE_HOME
  await fs.mkdir(directory, { recursive: true })
  const binary = path.join(directory, 'fixture-download.txt')
  try {
    await fs.access(binary)
    console.log('FIXTURE_BINARY_CACHE_HIT')
  } catch {
    await new Promise((resolve, reject) => {
      const request = https.get('https://github.com/robots.txt', { agent: new https.Agent({ keepAlive: false }), timeout: 15000, signal: AbortSignal.timeout(20000) }, (response) => {
        response.resume()
        response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`)))
        response.on('error', reject)
        response.on('close', () => { if (!response.complete) reject(new Error('Incomplete response')) })
      })
      request.on('timeout', () => request.destroy(new Error('download timeout')))
      request.on('error', reject)
    })
    await fs.writeFile(binary, 'fixture binary')
    console.log('FIXTURE_BINARY_DOWNLOADED')
  }
}
