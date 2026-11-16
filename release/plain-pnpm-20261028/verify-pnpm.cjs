const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = mkdtempSync(path.join(tmpdir(), 'cuddly-pnpm-config-'))
try {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pnpm-config-smoke', private: true }))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages: []\noverrides:\n  'webapp>@kookapp/webapp-contracts': link:./packages/webapp-contracts\n")
  const options = { cwd: root, encoding: 'utf8', timeout: 300000 }
  const version = execFileSync('pnpm', ['--version'], options).trim()
  const overrides = JSON.parse(execFileSync('pnpm', ['config', 'get', 'overrides', '--json'], options))
  assert.equal(overrides['webapp>@kookapp/webapp-contracts'], 'link:./packages/webapp-contracts')
  console.log(`Default pnpm ${version}: workspace overrides read successfully; no install or build executed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
