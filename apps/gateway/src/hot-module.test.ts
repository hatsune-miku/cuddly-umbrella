import type { Artifact } from '@cuddly/contracts'
import { describe, expect, it } from 'vitest'

import { applyHotModuleOverlay, hotModuleOverrideFromArtifact } from './hot-module'

function remoteArtifact(overrides: Partial<Artifact> = {}): Artifact {
  const id = overrides.id || '00000000-0000-4000-8000-000000000123'
  const providerName = 'cuddly_base_000000000000'
  return {
    id,
    buildJobId: '00000000-0000-4000-8000-000000000124',
    environmentId: '00000000-0000-4000-8000-000000000125',
    environmentSlug: 'shared',
    targetId: 'base',
    branch: 'feature/hot-module',
    status: 'READY',
    storageKey: `ready/base/${id}`,
    builtAt: '2026-08-25T00:00:00.000Z',
    createdBy: 'gz',
    manifest: {
      schemaVersion: 1,
      artifactId: id,
      target: 'base',
      branch: 'feature/hot-module',
      builtAt: '2026-08-25T00:00:00.000Z',
      serve: {
        siteAdapter: 'kook-remote-v1',
        entrypoints: ['remoteEntry.js'],
        publicBase: `https://bifrost.vanillacake.cn/__cuddly/preview-artifacts/${id}/${providerName}/`,
        remote: { moduleKey: 'base', providerName, entryPath: 'remoteEntry.js' },
      },
      files: [
        {
          path: 'remoteEntry.js',
          size: 100,
          contentType: 'text/javascript',
          digest: 'sha256:test',
          cacheClass: 'asset',
        },
      ],
    },
    ...overrides,
  }
}

describe('hot-module Artifact overrides', () => {
  it('keeps legacy absolute Artifact origins and requires a restart', () => {
    expect(hotModuleOverrideFromArtifact(remoteArtifact())).toEqual({
      moduleKey: 'base',
      item: {
        name: 'cuddly_base_000000000000',
        entry:
          'https://bifrost.vanillacake.cn/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/remoteEntry.js',
        version: 'cuddly_base_000000000000',
        restartRequired: true,
      },
    })
    expect(
      hotModuleOverrideFromArtifact(remoteArtifact(), new URL('https://test.bifrost.example'))?.item
        .entry
    ).toBe(
      'https://bifrost.vanillacake.cn/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/remoteEntry.js'
    )
  })

  it('resolves a new root-relative Artifact against the current preview host', () => {
    const artifact = remoteArtifact()
    artifact.manifest.serve.publicBase =
      '/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/'

    expect(
      hotModuleOverrideFromArtifact(artifact, new URL('https://test.bifrost.example'))!.item.entry
    ).toBe(
      'https://test.bifrost.example/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/remoteEntry.js'
    )
    expect(hotModuleOverrideFromArtifact(artifact)).toBeNull()
  })

  it('rejects mismatched modules and untrusted public paths', () => {
    const mismatched = remoteArtifact()
    mismatched.manifest.serve.remote!.moduleKey = 'discover'
    expect(hotModuleOverrideFromArtifact(mismatched)).toBeNull()

    const untrusted = remoteArtifact()
    untrusted.manifest.serve.publicBase = 'https://example.test/not-an-artifact/'
    expect(hotModuleOverrideFromArtifact(untrusted)).toBeNull()

    for (const publicBase of [
      '//evil.example/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/',
      '/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/../',
      '/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000123/cuddly_base_000000000000/?redirect=1',
      '/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000999/cuddly_base_000000000000/',
    ]) {
      const malicious = remoteArtifact()
      malicious.manifest.serve.publicBase = publicBase
      expect(
        hotModuleOverrideFromArtifact(malicious, new URL('https://test.bifrost.example'))
      ).toBeNull()
    }
  })
})

describe('hot-module response overlay', () => {
  const baseOverride = hotModuleOverrideFromArtifact(remoteArtifact())!

  it('only replaces selected modules and preserves official response metadata', () => {
    const response = {
      code: 0,
      message: 'official',
      traceId: 'trace-1',
      data: {
        id: 42,
        version: 'v8',
        futureField: true,
        modules: {
          base: {
            id: 10,
            name: 'official_base',
            entry: 'https://img.kookapp.cn/base/remoteEntry.js',
            version: 'official_base',
            restartRequired: false,
            futureModuleField: 'kept',
          },
          discover: {
            name: 'official_discover',
            entry: 'https://img.kookapp.cn/discover/remoteEntry.js',
          },
        },
      },
    }

    expect(applyHotModuleOverlay(response, [baseOverride])).toBe(true)
    expect(response).toMatchObject({
      code: 0,
      message: 'official',
      traceId: 'trace-1',
      data: {
        id: 42,
        version: 'v8',
        futureField: true,
        modules: {
          base: {
            id: 10,
            name: baseOverride.item.name,
            entry: baseOverride.item.entry,
            version: baseOverride.item.version,
            restartRequired: true,
            futureModuleField: 'kept',
          },
          discover: {
            name: 'official_discover',
            entry: 'https://img.kookapp.cn/discover/remoteEntry.js',
          },
        },
      },
    })
  })

  it('supports the documented array form without removing unknown modules', () => {
    const response = {
      modules: [
        { key: 'base', entry: 'https://official/base.js', custom: 1 },
        { key: 'discover', entry: 'https://official/discover.js' },
      ],
    }
    expect(applyHotModuleOverlay(response, [baseOverride])).toBe(true)
    expect(response.modules).toEqual([
      { key: 'base', custom: 1, ...baseOverride.item },
      { key: 'discover', entry: 'https://official/discover.js' },
    ])
  })

  it('accepts the request layer string success code used by some test deployments', () => {
    const response = {
      code: '0',
      data: {
        modules: {
          base: { name: 'official', retained: true },
        },
      },
    }
    expect(applyHotModuleOverlay(response, [baseOverride])).toBe(true)
    expect(response.data.modules.base).toMatchObject({
      ...baseOverride.item,
      retained: true,
    })
  })

  it('supports a legacy flat Remote map but refuses unrelated JSON objects', () => {
    const flat = {
      code: 0,
      data: {
        base: 'https://img.chuanyuapp.com/base_new/base_v1001/remoteEntry.js',
        discover: {
          name: 'official_discover',
          entry: 'https://img.chuanyuapp.com/discover_new/discover_v1001/remoteEntry.js',
        },
      },
    }
    expect(applyHotModuleOverlay(flat, [baseOverride])).toBe(true)
    expect(flat.data.base).toEqual(baseOverride.item)

    const unrelated = { code: 0, data: { id: 7, version: 'v7' } }
    expect(applyHotModuleOverlay(unrelated, [baseOverride])).toBe(false)
    expect(unrelated).toEqual({ code: 0, data: { id: 7, version: 'v7' } })
  })

  it('fails open for errors and unknown response shapes', () => {
    const error = { code: 401, message: 'login required' }
    const malformed = { code: 0, data: { version: 'v8' } }
    expect(applyHotModuleOverlay(error, [baseOverride])).toBe(false)
    expect(applyHotModuleOverlay(malformed, [baseOverride])).toBe(false)
    expect(error).toEqual({ code: 401, message: 'login required' })
    expect(malformed).toEqual({ code: 0, data: { version: 'v8' } })
  })
})
