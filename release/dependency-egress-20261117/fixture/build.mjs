import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

assert.equal(await fs.readFile(path.join(process.env.XDG_CACHE_HOME, 'fixture-download.txt'), 'utf8'), 'fixture binary')
await fs.mkdir('dist', { recursive: true })
await fs.writeFile('dist/index.html', '<!doctype html><title>Isolated install policy fixture</title>ok')
console.log('FIXTURE_BUILD_OK: installer and build share the same persistent cache')
