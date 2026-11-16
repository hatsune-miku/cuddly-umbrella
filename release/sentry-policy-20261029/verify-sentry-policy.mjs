import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applySentryBuildPolicy } from './sentry-build-policy.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'bifrost-sentry-smoke-'))
try {
  const original = path.join(root, 'node_modules/@sentry/webpack-plugin')
  await mkdir(original, { recursive: true })
  await writeFile(path.join(original, 'index.js'), "throw Error('real Sentry must not load')")
  await writeFile(path.join(root, 'legacy.cjs'), `
const Legacy = require('@sentry/webpack-plugin');
const { sentryWebpackPlugin } = require('@sentry/webpack-plugin');
const probe = true;
const config = { devtool: 'source-map', plugins: [new Legacy({}), sentryWebpackPlugin({disable: probe || process.env.SENTRY_UPLOAD_DISABLE === '1'})] };
for (const plugin of config.plugins) plugin.apply({});
console.log(config.devtool);
`)
  await writeFile(path.join(root, 'modern.mjs'), `
import { sentryWebpackPlugin } from '@sentry/webpack-plugin';
const plugin = sentryWebpackPlugin({disable: false, telemetry: true});
plugin.apply({});
console.log(plugin.name);
`)
  const result = await applySentryBuildPolicy(root)
  assert.equal(result.references, 3)
  assert.equal(execFileSync(process.execPath, [path.join(root, 'legacy.cjs')], { encoding: 'utf8' }).trim(), 'source-map')
  assert.equal(execFileSync(process.execPath, [path.join(root, 'modern.mjs')], { encoding: 'utf8' }).trim(), 'bifrost-sentry-disabled')
  assert.equal(await readFile(path.join(original, 'index.js'), 'utf8'), "throw Error('real Sentry must not load')")
  console.log('Sentry policy Linux smoke: legacy/new API, CJS/ESM and original-package isolation passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
