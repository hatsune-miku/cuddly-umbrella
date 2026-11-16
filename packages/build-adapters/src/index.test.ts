import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createOnlineH5Manifest,
  createRemoteManifest,
  createStaticManifest,
  ONLINE_H5_ENTRYPOINTS,
  resolveRemoteEntry,
} from './index'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('Remote Artifact manifest', () => {
  it('records the exact module and provider contract', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-remote-manifest-'))
    directories.push(output)
    await mkdir(path.join(output, 'static'), { recursive: true })
    await writeFile(path.join(output, '.remote-version'), 'cuddly_base_test\n', 'utf8')
    await writeFile(path.join(output, 'remoteEntry.js'), 'remote', 'utf8')
    await writeFile(path.join(output, 'static', 'chunk.12345678.js'), 'chunk', 'utf8')

    const manifest = await createRemoteManifest({
      outputDirectory: output,
      artifactId: '00000000-0000-4000-8000-000000000001',
      targetId: 'base',
      branch: 'feature/preview',
      builtAt: '2026-08-13T12:00:00.000Z',
      publicBase:
        'https://preview.example.test/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000001/cuddly_base_test/',
      siteAdapter: 'kook-remote-v1',
      moduleKey: 'base',
      providerName: 'cuddly_base_test',
    })

    expect(manifest.serve.remote).toEqual({
      moduleKey: 'base',
      providerName: 'cuddly_base_test',
      entryPath: 'remoteEntry.js',
    })
    expect(resolveRemoteEntry(manifest)).toBe('remoteEntry.js')
  })

  it('rejects output built for a different federation provider', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-remote-version-'))
    directories.push(output)
    await writeFile(path.join(output, '.remote-version'), 'base_v3_prod_old\n', 'utf8')
    await writeFile(path.join(output, 'remoteEntry.js'), 'remote', 'utf8')

    await expect(
      createRemoteManifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000008',
        targetId: 'base',
        branch: 'feature/preview',
        builtAt: '2026-08-25T00:00:00.000Z',
        publicBase:
          'https://preview.example.test/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000008/cuddly_base_test/',
        siteAdapter: 'kook-remote-v1',
        moduleKey: 'base',
        providerName: 'cuddly_base_test',
      })
    ).rejects.toThrow(
      'Remote build version mismatch: expected cuddly_base_test, received base_v3_prod_old'
    )
  })

  it('accepts historical output without a marker after checking the exact provider declaration', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-remote-legacy-'))
    directories.push(output)
    await writeFile(
      path.join(output, 'remoteEntry.js'),
      '!function(){}();var cuddly_base_test,_global={};',
      'utf8'
    )

    await expect(
      createRemoteManifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000009',
        targetId: 'base',
        branch: 'historical/preview',
        builtAt: '2026-08-25T00:00:00.000Z',
        publicBase:
          'https://preview.example.test/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000009/cuddly_base_test/',
        siteAdapter: 'kook-remote-v1',
        moduleKey: 'base',
        providerName: 'cuddly_base_test',
      })
    ).resolves.toMatchObject({
      serve: { remote: { providerName: 'cuddly_base_test', entryPath: 'remoteEntry.js' } },
    })
  })

  it('rejects historical output whose federation provider does not match', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-remote-legacy-mismatch-'))
    directories.push(output)
    await writeFile(path.join(output, 'remoteEntry.js'), 'var base_v3_prod_old;', 'utf8')

    await expect(
      createRemoteManifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000010',
        targetId: 'base',
        branch: 'historical/preview',
        builtAt: '2026-08-25T00:00:00.000Z',
        publicBase:
          'https://preview.example.test/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000010/cuddly_base_test/',
        siteAdapter: 'kook-remote-v1',
        moduleKey: 'base',
        providerName: 'cuddly_base_test',
      })
    ).rejects.toThrow('Remote build does not declare the expected federation provider')
  })
})

describe('static Artifact manifest', () => {
  it('records a webapp-specific public base when the Runner supplies one', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-webapp-manifest-'))
    directories.push(output)
    await writeFile(path.join(output, 'index.htm'), '<!doctype html>', 'utf8')

    const manifest = await createStaticManifest({
      outputDirectory: output,
      artifactId: '00000000-0000-4000-8000-000000000002',
      targetId: 'webapp',
      branch: 'master',
      builtAt: '2026-08-24T00:00:00.000Z',
      siteAdapter: 'generic-static-v1',
      publicBase: '/__cuddly/artifacts/00000000-0000-4000-8000-000000000002/app/',
    })

    expect(manifest.serve.publicBase).toBe(
      '/__cuddly/artifacts/00000000-0000-4000-8000-000000000002/app/'
    )
  })

  it('rejects an asset manifest that references a missing build file', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-incomplete-manifest-'))
    directories.push(output)
    await writeFile(path.join(output, 'index.html'), '<!doctype html>', 'utf8')
    await writeFile(
      path.join(output, 'asset-manifest.json'),
      JSON.stringify({ files: { main: '/static/js/missing.js' } }),
      'utf8'
    )

    await expect(
      createStaticManifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000003',
        targetId: 'webapp',
        branch: 'master',
        builtAt: '2026-08-24T00:00:00.000Z',
        siteAdapter: 'generic-static-v1',
      })
    ).rejects.toThrow('Project manifest points to a missing file: /static/js/missing.js')
  })

  it('validates publicBase-prefixed asset manifest paths against the build root', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-prefixed-manifest-'))
    directories.push(output)
    const artifactId = '00000000-0000-4000-8000-000000000004'
    const publicBase = `/__cuddly/artifacts/${artifactId}/app/`
    await mkdir(path.join(output, 'static', 'js'), { recursive: true })
    await writeFile(path.join(output, 'index.htm'), '<!doctype html>', 'utf8')
    await writeFile(path.join(output, 'static', 'js', 'main.js'), 'main', 'utf8')
    await writeFile(
      path.join(output, 'asset-manifest.json'),
      JSON.stringify({ files: { main: `${publicBase}static/js/main.js` } }),
      'utf8'
    )

    await expect(
      createStaticManifest({
        outputDirectory: output,
        artifactId,
        targetId: 'customer-web',
        branch: 'master',
        builtAt: '2026-08-24T00:00:00.000Z',
        siteAdapter: 'generic-static-v1',
        publicBase,
      })
    ).resolves.toMatchObject({ serve: { publicBase } })
  })

  it.each([
    [
      'JavaScript',
      '<script src="https://static.kookapp.cn/app/static/js/main.12345678.js"></script>',
      'https://static.kookapp.cn/app/static/js/main.12345678.js',
    ],
    [
      'CSS',
      "<link rel='stylesheet' href='//static.kookapp.cn/app/assets/main.12345678.css'>",
      '//static.kookapp.cn/app/assets/main.12345678.css',
    ],
    [
      'unquoted asset',
      '<img src=https://static.kookapp.cn/app/assets/logo.12345678.png>',
      'https://static.kookapp.cn/app/assets/logo.12345678.png',
    ],
  ])(
    'rejects a generic webapp entrypoint that falls back to production %s',
    async (_, html, url) => {
      const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-production-fallback-'))
      directories.push(output)
      await writeFile(path.join(output, 'index.html'), html, 'utf8')

      await expect(
        createStaticManifest({
          outputDirectory: output,
          artifactId: '00000000-0000-4000-8000-000000000005',
          targetId: 'webapp',
          branch: 'master',
          builtAt: '2026-08-24T00:00:00.000Z',
          siteAdapter: 'generic-static-v1',
        })
      ).rejects.toThrow(
        `Generic static entrypoint index.html references a KOOK production app asset instead of the build artifact: ${url}`
      )
    }
  )

  it('allows public images, analytics, non-app static resources, and artifact-local assets', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-allowed-external-assets-'))
    directories.push(output)
    await writeFile(
      path.join(output, 'index.html'),
      [
        '<link rel="preload" href="https://img.kookapp.cn/assets/saying.json" as="fetch">',
        '<script src="https://hm.baidu.com/hm.js"></script>',
        '<script src="https://static.kookapp.cn/static/shared.js"></script>',
        '<script src="/__cuddly/artifacts/example/app/static/js/main.js"></script>',
        '<a href="https://static.kookapp.cn/app/static/js/not-a-resource.js">documentation</a>',
        '<!-- <script src="https://static.kookapp.cn/app/static/js/commented.js"></script> -->',
        '<script>const example = \'<img src="https://static.kookapp.cn/app/assets/example.png">\'</script>',
      ].join('\n'),
      'utf8'
    )

    await expect(
      createStaticManifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000006',
        targetId: 'webapp',
        branch: 'master',
        builtAt: '2026-08-24T00:00:00.000Z',
        siteAdapter: 'generic-static-v1',
      })
    ).resolves.toMatchObject({ serve: { siteAdapter: 'generic-static-v1' } })
  })
})

describe('online H5 Artifact manifest', () => {
  it('does not apply the generic webapp production fallback guard', async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'cuddly-online-h5-assets-'))
    directories.push(output)
    await Promise.all(
      ONLINE_H5_ENTRYPOINTS.map((entrypoint) =>
        writeFile(
          path.join(output, entrypoint),
          '<script src="https://static.kookapp.cn/app/static/js/main.js"></script>',
          'utf8'
        )
      )
    )

    await expect(
      createOnlineH5Manifest({
        outputDirectory: output,
        artifactId: '00000000-0000-4000-8000-000000000007',
        targetId: 'online-h5',
        branch: 'master',
        builtAt: '2026-08-24T00:00:00.000Z',
      })
    ).resolves.toMatchObject({ serve: { siteAdapter: 'kook-online-h5-v1' } })
  })
})
