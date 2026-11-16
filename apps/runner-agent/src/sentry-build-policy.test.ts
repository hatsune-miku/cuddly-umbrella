import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applySentryBuildPolicy,
  rewriteSentryBuildImports,
  SENTRY_BUILD_SHIM,
} from './sentry-build-policy'

const execute = promisify(execFile)
const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'bifrost-sentry-policy-'))
  roots.push(root)
  return root
}

async function save(root: string, name: string, source: string): Promise<string> {
  const filename = path.join(root, name)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, source, 'utf8')
  return filename
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Sentry build import rewriting', () => {
  it.each([
    `const SentryPlugin = require('@sentry/webpack-plugin')`,
    `const { sentryWebpackPlugin: plugin } = require('@sentry/webpack-plugin')`,
    `import { sentryWebpackPlugin as plugin } from '@sentry/webpack-plugin'`,
    `import * as plugins from '@sentry/webpack-plugin'`,
    `import Plugin from '@sentry/webpack-plugin'`,
    `export { sentryWebpackPlugin } from '@sentry/webpack-plugin'`,
    `const loaded = import('@sentry/webpack-plugin')`,
    'const loaded = import(`@sentry/webpack-plugin`)',
    `const resolved = require.resolve('@sentry/webpack-plugin')`,
    `import Sentry = require('@sentry/webpack-plugin')`,
  ])('rewrites a module reference: %s', (source) => {
    const result = rewriteSentryBuildImports('config.ts', source)
    expect(result.references).toBe(1)
    expect(result.source).toContain(`${SENTRY_BUILD_SHIM}/webpack`)
    expect(rewriteSentryBuildImports('config.ts', result.source).source).toBe(result.source)
  })

  it('does not interpret disable expressions, spreads, comments or credential values', () => {
    const source =
      `const { sentryWebpackPlugin: plugin } = require('@sentry/webpack-plugin')\r\n` +
      `module.exports = { devtool: 'source-map', plugins: [plugin({\r\n` +
      `  ...options, disable: probe || calculateDisable(), authToken: 'test-secret',\r\n` +
      `  release: { uploadLegacySourcemaps: paths() }, // custom options\r\n` +
      `}), new OtherPlugin()] }\r\n`
    expect(rewriteSentryBuildImports('config.cjs', source).source).toBe(
      source.replace("'@sentry/webpack-plugin'", JSON.stringify(`${SENTRY_BUILD_SHIM}/webpack`))
    )
  })

  it('preserves runtime SDKs, type-only imports, ordinary strings and comments', () => {
    const source = `import * as Sentry from '@sentry/react';
import type { Options } from '@sentry/webpack-plugin';
import type Plugin = require('@sentry/webpack-plugin');
const text = '@sentry/webpack-plugin';
// require('@sentry/webpack-plugin')
Sentry.init({ dsn: 'unchanged' });`
    expect(rewriteSentryBuildImports('app.ts', source)).toEqual({
      source,
      references: 0,
      packages: [],
    })
  })

  it('reports unsupported entrypoints without echoing secrets or changing source', () => {
    expect(() =>
      rewriteSentryBuildImports(
        'config.js',
        `const plugin = require('@sentry/webpack-plugin/new-api'); const authToken = 'secret';`
      )
    ).toThrow('SENTRY_BUILD_PLUGIN_UNSUPPORTED: config.js: @sentry/webpack-plugin/new-api')
  })

  it('rejects malformed targeted config instead of producing partially rewritten JavaScript', () => {
    expect(() =>
      rewriteSentryBuildImports(
        'config.js',
        `const plugin = require('@sentry/webpack-plugin'); const invalid = {`
      )
    ).toThrow('SENTRY_BUILD_CONFIG_PARSE_FAILED: config.js')
  })
})

describe('isolated Sentry build policy', () => {
  it('loads neither old nor new real Sentry plugins, keeps SDKs and other plugins, makes no upload request', async () => {
    const root = await fixture()
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.end('unexpected upload')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const originalPlugin = `require('node:http').get('http://127.0.0.1:${address.port}/upload'); throw Error('real Sentry loaded');`
    try {
      const originalPath = await save(
        root,
        'node_modules/@sentry/webpack-plugin/index.js',
        originalPlugin
      )
      await save(
        root,
        'node_modules/@sentry/react/index.js',
        `module.exports = { runtime: 'kept' }`
      )
      await save(
        root,
        'scripts/build.cjs',
        `
const Legacy = require('@sentry/webpack-plugin');
const { sentryWebpackPlugin: modern } = require('@sentry/webpack-plugin/webpack5');
const sdk = require('@sentry/react');
const probe = false;
let otherRan = false;
const config = { devtool: 'source-map', plugins: [
  new Legacy({ authToken: 'test-secret', release: 'test' }),
  modern({ disable: probe || process.env.SENTRY_UPLOAD_DISABLE === '1', telemetry: true }),
  { apply() { otherRan = true } }
] };
for (const plugin of config.plugins) plugin.apply({ hooks: new Proxy({}, { get() { throw Error('hook registered') } }) });
console.log(JSON.stringify({ otherRan, devtool: config.devtool, runtime: sdk.runtime }));
`
      )
      const result = await applySentryBuildPolicy(root)
      expect(result).toEqual({
        files: 1,
        references: 2,
        packages: ['@sentry/webpack-plugin', '@sentry/webpack-plugin/webpack5'],
      })
      const output = await execute(process.execPath, ['scripts/build.cjs'], { cwd: root })
      expect(JSON.parse(output.stdout)).toEqual({
        otherRan: true,
        devtool: 'source-map',
        runtime: 'kept',
      })
      expect(requests).toBe(0)
      expect(await readFile(originalPath, 'utf8')).toBe(originalPlugin)
      expect(await applySentryBuildPolicy(root)).toEqual({ files: 0, references: 0, packages: [] })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it.each(['mjs', 'mts', 'cts'])(
    'supports ESM, dynamic imports and compiled TypeScript: %s',
    async (extension) => {
      const root = await fixture()
      const filename = await save(
        root,
        `nested/config.${extension}`,
        `
import Plugin, { sentryWebpackPlugin as factory } from '@sentry/webpack-plugin';
import * as namespace from '@sentry/webpack-plugin';
async function main() {
  const dynamic = await import('@sentry/webpack-plugin');
  const plugins = [new Plugin({}), factory({}), namespace.sentryWebpackPlugin({}), dynamic.sentryWebpackPlugin({})];
  for (const plugin of plugins) plugin.apply({});
  console.log(plugins.length);
}
main();
`
      )
      await applySentryBuildPolicy(root)
      let entry = filename
      if (extension !== 'mjs') {
        const source = await readFile(filename, 'utf8')
        const commonjs = extension === 'cts'
        const output = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            esModuleInterop: true,
          },
        }).outputText
        entry = await save(root, `nested/compiled.${commonjs ? 'cjs' : 'mjs'}`, output)
      }
      expect((await execute(process.execPath, [entry], { cwd: root })).stdout.trim()).toBe('4')
    }
  )

  it('provides bundler-specific no-op shapes', async () => {
    const root = await fixture()
    await save(
      root,
      'config.mjs',
      `
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { sentryRollupPlugin } from '@sentry/rollup-plugin';
import { sentryEsbuildPlugin } from '@sentry/esbuild-plugin';
console.log(JSON.stringify([Object.keys(sentryVitePlugin({})), Object.keys(sentryRollupPlugin({})), Object.keys(sentryEsbuildPlugin({}))]));
`
    )
    await applySentryBuildPolicy(root)
    const output = await execute(process.execPath, ['config.mjs'], { cwd: root })
    expect(JSON.parse(output.stdout)).toEqual([['name'], ['name'], ['name', 'setup']])
  })

  it('does not suppress errors in other plugins', async () => {
    const root = await fixture()
    await save(
      root,
      'config.cjs',
      `
const { sentryWebpackPlugin } = require('@sentry/webpack-plugin');
sentryWebpackPlugin({}).apply({});
throw Error('real compilation failure');
`
    )
    await applySentryBuildPolicy(root)
    await expect(execute(process.execPath, ['config.cjs'], { cwd: root })).rejects.toThrow(
      'real compilation failure'
    )
  })

  it('never traverses source symlinks or modifies shared dependency stores', async () => {
    const root = await fixture()
    const external = await fixture()
    const source = `const plugin = require('@sentry/webpack-plugin');`
    const externalPath = await save(external, 'config.js', source)
    await symlink(
      external,
      path.join(root, 'linked-source'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await symlink(
      external,
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await save(root, 'build.cjs', source)
    await expect(applySentryBuildPolicy(root)).rejects.toThrow('SENTRY_BUILD_SHIM_UNSAFE_PATH')
    expect(await readFile(externalPath, 'utf8')).toBe(source)
    expect(await readFile(path.join(root, 'build.cjs'), 'utf8')).toBe(source)
  })

  it('does not overwrite a pre-existing package or follow a scoped-package symlink', async () => {
    const root = await fixture()
    const source = `require('@sentry/webpack-plugin')`
    await save(root, 'config.js', source)
    const filename = await save(root, `node_modules/${SENTRY_BUILD_SHIM}/index.js`, 'original')
    await expect(applySentryBuildPolicy(root)).rejects.toThrow('SENTRY_BUILD_SHIM_COLLISION')
    expect(await readFile(filename, 'utf8')).toBe('original')
  })
})
