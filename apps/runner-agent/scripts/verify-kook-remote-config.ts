// Read-only compatibility check against a real KOOK checkout. No dependency install,
// compilation, upload, or source modification is performed.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import {
  patchRemoteAssetPrefixSource,
  patchRemoteProviderVersionSource,
  patchRemoteSentryPluginSource,
  remoteBuildEnvironment,
} from '../src/runner'

const root = process.argv[2]
if (!root) throw new Error('Pass the path to a KOOK source checkout')
const nativeRequire = createRequire(import.meta.url)
const artifactId = '11111111-2222-4333-8444-555555555555'
let checked = 0
for (const entry of await readdir(path.join(root, 'apps'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const appRoot = path.join(root, 'apps', entry.name)
  const configFile = path.join(appRoot, 'scripts/get_config.js')
  const source = await readFile(configFile, 'utf8').catch(() => null)
  if (!source) continue
  const env = remoteBuildEnvironment({ targetId: entry.name, artifactId })
  const packageJSON = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
  const incrementalModule = { exports: {} as Record<string, (...args: any[]) => any> }
  const incrementalSource = await readFile(
    path.join(root, 'scripts/remote_incremental_assets.js'),
    'utf8'
  )
  vm.runInNewContext(incrementalSource, {
    module: incrementalModule,
    require: nativeRequire,
    process: { env, versions: process.versions },
    URL,
    Buffer,
  })
  const module = { exports: {} as Record<string, (...args: any[]) => any> }
  const requireConfig = (name: string): any => {
    if (['path', 'os', 'fs'].includes(name)) return nativeRequire(name)
    if (name === '../package.json') return packageJSON
    if (name.endsWith('/remote_version'))
      return {
        resolve_build_remote_version: () => env.VERSION,
        create_remote_version_asset_plugin: () => ({}),
      }
    if (name.endsWith('/remote_incremental_assets')) return incrementalModule.exports
    if (name.endsWith('/webapp_package_source_aliases'))
      return { getWebappPackageSourcePaths: () => [], getWebappPackageSourceAliases: () => ({}) }
    if (name.includes('rspack')) return {}
    throw new Error(`Unsupported fixture dependency: ${name}`)
  }
  const patched = patchRemoteAssetPrefixSource(patchRemoteProviderVersionSource(source))
  vm.runInNewContext(patched, {
    module,
    require: requireConfig,
    process: { env },
    __dirname: path.dirname(configFile),
    URL,
  })
  assert.equal(module.exports.get_output_config('production').publicPath, 'auto')
  assert.equal(module.exports.get_output_config('development').publicPath, 'auto')
  if (module.exports.get_remote_asset_public_path) {
    assert.equal(module.exports.get_remote_asset_public_path(), env.REMOTE_ASSET_PUBLIC_PATH)
    const helper = incrementalModule.exports
    const cache = helper.create_remote_persistent_cache_config({
      remote_key: entry.name,
      asset_public_path: module.exports.get_remote_asset_public_path(),
      asset_object_prefix: 'mf-assets/v1/example',
      build_dependencies: [configFile],
      default_cache_directory: '/tmp/unused-cache',
    })
    assert.match(cache.version, /^[a-f0-9]{64}$/)
    // Run the real manifest plugin with synthetic compiler assets (no Rspack install needed).
    let manifest: any
    const plugin = helper.create_remote_release_manifest_plugin(
      {
        Compilation: { PROCESS_ASSETS_STAGE_REPORT: 1 },
        sources: {
          RawSource: class {
            constructor(public value: string) {}
          },
        },
      },
      {
        remote_key: entry.name,
        remote_version: env.VERSION,
        oss_path_key: packageJSON.oss_path_key || packageJSON.name_key,
        asset_public_path: module.exports.get_remote_asset_public_path(),
      }
    )
    const errors: Error[] = []
    plugin.apply({
      hooks: {
        thisCompilation: {
          tap: (_name: string, callback: any) =>
            callback({
              errors,
              hooks: { processAssets: { tap: (_options: any, emit: any) => emit() } },
              getAssets: () => [
                {
                  name: 'static/js/main.123456789abcdef0.js',
                  source: { buffer: () => Buffer.from('test') },
                },
              ],
              emitAsset: (_name: string, asset: any) => {
                manifest = JSON.parse(asset.value)
              },
            }),
        },
      },
    })
    assert.equal(errors.length, 0)
    assert.equal(manifest.assetPublicPath, env.REMOTE_ASSET_PUBLIC_PATH)
    assert.equal(
      manifest.assets[0].url,
      env.REMOTE_ASSET_PUBLIC_PATH + 'static/js/main.123456789abcdef0.js'
    )
  }
  const buildConfig = await readFile(path.join(appRoot, 'scripts/rspack.config.build.js'), 'utf8')
  const patchedBuild = patchRemoteSentryPluginSource(buildConfig)
  assert.equal(patchRemoteSentryPluginSource(patchedBuild), patchedBuild)
  if (buildConfig.includes('sentryWebpackPlugin'))
    assert.ok(patchedBuild.includes('CUDDLY_DISABLE_SENTRY_UPLOAD'))
  console.log(`Verified ${entry.name}: publicPath, metadata/cache helper, Sentry and idempotency`)
  checked++
}
assert.ok(checked > 0)
console.log(`Verified ${checked} real KOOK Remote configs; checkout unchanged.`)
