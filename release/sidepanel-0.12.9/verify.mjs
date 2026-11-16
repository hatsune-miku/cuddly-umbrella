import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../../apps/console/dist/', import.meta.url)
const origin = 'https://bifrost.vanillacake.cn'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const index = await readFile(new URL('index.html', root), 'utf8')
const bundles = [...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1])
for (const url of ['/', ...bundles, '/help/', '/pc-plugin/', '/pc-plugin/cake-layout.css', '/pc-plugin/popup.js', '/pc-plugin/host-adapter.js', '/pc-plugin/bifrost.js']) {
  const response = await fetch(origin + url)
  assert.equal(response.status, 200, url)
  const relative = url.endsWith('/') ? `${url}index.html` : url
  const local = await readFile(new URL(relative.slice(1), root))
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(local), `${url}: deployment hash`)
  console.log(`Verified deployed asset ${url}`)
}
assert.equal((await fetch(origin + '/api/v1/auth/session')).status, 401)
console.log('Version 0.12.9 assets and anonymous authentication verified.')
