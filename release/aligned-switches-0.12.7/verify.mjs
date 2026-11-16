import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../../apps/console/dist/', import.meta.url)
const origin = 'https://bifrost.vanillacake.cn'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const index = await readFile(new URL('index.html', root), 'utf8')
const bundles = [...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1])
for (const url of ['/', ...bundles, '/help/', '/help/images/extension-projects.png', '/pc-plugin/', '/pc-plugin/cake-layout.css', '/pc-plugin/popup.css', '/pc-plugin/popup.js', '/pc-plugin/branch-picker.js', '/pc-plugin/cakeui-theme.css', '/ui/cakeui-theme.css']) {
  const response = await fetch(origin + url)
  assert.equal(response.status, 200, url)
  const relative = url.endsWith('/') ? `${url}index.html` : url
  const local = await readFile(new URL(relative.slice(1), root))
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(local), `${url}: deployment hash`)
  console.log(`Verified deployed asset ${url}`)
}
const session = await fetch(origin + '/api/v1/auth/session')
assert.equal(session.status, 401, 'Anonymous API requests must still require authentication')
console.log('Version 0.12.7 assets and unchanged anonymous authentication verified.')
