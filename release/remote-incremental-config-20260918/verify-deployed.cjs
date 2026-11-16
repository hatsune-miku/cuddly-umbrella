const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')

// Exercise the actual deployed bundle's pure patch functions without starting another server.
const bundle = fs.readFileSync('/app/apps/runner-agent/dist/main.js', 'utf8')
const names = ['remoteProviderName', 'remoteArtifactPublicBase', 'remoteBuildPublicPath', 'remoteBuildEnvironment', 'patchRemoteAssetPrefixSource', 'patchRemoteProviderVersionSource', 'patchRemoteSentryPluginSource']
const functions = names.map((name) => {
  const start = bundle.indexOf(`\nfunction ${name}(`)
  assert.ok(start >= 0, name)
  const next = /\n(?:async )?function /.exec(bundle.slice(start + 1))
  assert.ok(next, `Function boundary: ${name}`)
  return bundle.slice(start, start + 1 + next.index)
}).join('\n')
const patches = vm.runInNewContext(`${functions}\n({${names.join(',')}})`, { RunnerFailure: class extends Error { constructor(code, message) { super(message); this.code = code } } })
const commit = 'bdcb9d0ee9552f17e198f6a517f5009157689c63'
const cache = '/srv/cuddly/git-cache/v1/repositories'
const repo = fs.readdirSync(cache).map((name) => path.join(cache, name)).find((dir) => {
  try { execFileSync('git', [`--git-dir=${dir}`, 'cat-file', '-e', commit], { stdio: 'ignore' }); return true } catch { return false }
})
assert.ok(repo, 'Failed build commit must still be in the repository cache')
const read = (file) => execFileSync('git', [`--git-dir=${repo}`, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
for (const target of ['voice_runtime', 'voice_panel']) {
  const env = patches.remoteBuildEnvironment({ targetId: target, artifactId: '11111111-2222-4333-8444-555555555555' })
  const packageJSON = JSON.parse(read(`apps/${target}/package.json`))
  const helper = { exports: {} }
  vm.runInNewContext(read('scripts/remote_incremental_assets.js'), { module: helper, require, process: { env, versions: process.versions }, URL, Buffer })
  const module = { exports: {} }
  const config = patches.patchRemoteAssetPrefixSource(patches.patchRemoteProviderVersionSource(read(`apps/${target}/scripts/get_config.js`)))
  vm.runInNewContext(config, {
    module, process: { env }, __dirname: `/fixture/apps/${target}/scripts`,
    require: (name) => {
      if (['fs', 'path', 'os'].includes(name)) return require(name)
      if (name === '../package.json') return packageJSON
      if (name.endsWith('/remote_version')) return { resolve_build_remote_version: () => env.VERSION }
      if (name.endsWith('/remote_incremental_assets')) return helper.exports
      if (name.endsWith('/webapp_package_source_aliases')) return { getWebappPackageSourcePaths: () => [] }
      throw new Error(`Unexpected fixture import: ${name}`)
    },
  })
  assert.equal(module.exports.get_output_config('production').publicPath, 'auto')
  assert.equal(module.exports.get_output_config('development').publicPath, 'auto')
  assert.equal(module.exports.get_remote_asset_public_path(), env.REMOTE_ASSET_PUBLIC_PATH)
  const buildSource = read(`apps/${target}/scripts/rspack.config.build.js`)
  const sentry = patches.patchRemoteSentryPluginSource(buildSource)
  if (buildSource.includes('sentryWebpackPlugin')) assert.ok(sentry.includes('CUDDLY_DISABLE_SENTRY_UPLOAD'))
  else assert.equal(sentry, buildSource)
  assert.equal(patches.patchRemoteSentryPluginSource(sentry), sentry)
  console.log(`Deployed Runner verified against failed commit: ${target}, runtime=auto, metadata=artifact path, Sentry compatible`)
}
