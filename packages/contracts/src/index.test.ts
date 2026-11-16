import { describe, expect, it } from 'vitest'

import {
  createBuildJobSchema,
  createConfigurationGroupPreviewSchema,
  createConfigurationGroupSchema,
  createPreviewSchema,
  publishRevisionSchema,
  runnerJobSchema,
  saveBuildTargetSchema,
  saveEnvironmentSchema,
  saveProjectEnvironmentConfigsSchema,
  saveSiteBindingSchema,
  updateConfigurationGroupSchema,
  updateSystemSettingsSchema,
} from './index'

describe('in-place URL rule contracts', () => {
  it('trims literal patterns and environment slugs', () => {
    expect(
      updateSystemSettingsSchema.parse({
        inPlaceUrlRules: [{ pattern: '  www.kookapp.cn/channels  ', environmentSlug: ' shared ' }],
      })
    ).toEqual({
      inPlaceUrlRules: [{ pattern: 'www.kookapp.cn/channels', environmentSlug: 'shared' }],
    })
  })

  it('rejects empty patterns, invalid environments, duplicates after trim, and oversized lists', () => {
    expect(
      updateSystemSettingsSchema.safeParse({
        inPlaceUrlRules: [{ pattern: '', environmentSlug: 'shared' }],
      }).success
    ).toBe(false)
    expect(
      updateSystemSettingsSchema.safeParse({
        inPlaceUrlRules: [{ pattern: 'www.kookapp.cn', environmentSlug: 'Shared' }],
      }).success
    ).toBe(false)
    expect(
      updateSystemSettingsSchema.safeParse({
        inPlaceUrlRules: [
          { pattern: 'www.kookapp.cn', environmentSlug: 'shared' },
          { pattern: ' www.kookapp.cn ', environmentSlug: 'tttt' },
        ],
      }).success
    ).toBe(false)
    expect(
      updateSystemSettingsSchema.safeParse({
        inPlaceUrlRules: Array.from({ length: 101 }, (_, index) => ({
          pattern: `host-${index}.example.test`,
          environmentSlug: 'shared',
        })),
      }).success
    ).toBe(false)
  })
})

const siteBinding = {
  id: 'main',
  name: 'KOOK 网页端',
  hostname: 'main.bifrost.vanillacake.cn',
  targetId: 'webapp',
  environmentSlug: 'shared',
  upstreamOrigin: 'https://www.kookapp.cn',
  officialOrigin: 'https://www.kookapp.cn',
  enabled: true,
  remoteTargetIds: ['base'],
  resourceProxyPrefixes: [],
}

const siteProject = {
  id: 'webapp',
  name: '网页端',
  kind: 'webapp' as const,
  repositoryUrl: 'https://git.example.test/webapp.git',
  defaultBranch: 'master',
  installCommand: 'pnpm install',
  buildCommand: 'pnpm build',
  outputDirectory: 'dist',
  siteAdapter: 'generic-static-v1',
  enabled: true,
  required: false,
}

describe('site binding contracts', () => {
  it('accepts fallbackOrigin as primary while normalizing legacy upstreamOrigin', () => {
    const legacy = saveSiteBindingSchema.parse(siteBinding)
    expect(legacy.fallbackOrigin).toBe('https://www.kookapp.cn')
    expect(legacy.upstreamOrigin).toBe(legacy.fallbackOrigin)

    const primary = saveSiteBindingSchema.parse({
      ...siteBinding,
      fallbackOrigin: 'https://fallback.example.test/',
      upstreamOrigin: 'https://legacy.example.test',
    })
    expect(primary.fallbackOrigin).toBe('https://fallback.example.test')
    expect(primary.upstreamOrigin).toBe(primary.fallbackOrigin)
  })

  it('accepts DNS-label site ids and rejects underscores or invalid edges', () => {
    for (const id of ['main', 'main-preview', 'a', `${'a'.repeat(62)}z`]) {
      expect(saveSiteBindingSchema.safeParse({ ...siteBinding, id }).success).toBe(true)
    }
    for (const id of ['main_preview', '-main', 'main-', 'Main', 'a'.repeat(64)]) {
      expect(saveSiteBindingSchema.safeParse({ ...siteBinding, id }).success).toBe(false)
    }
  })

  it('normalizes and validates resource proxy URL prefixes', () => {
    const parsed = saveSiteBindingSchema.parse({
      ...siteBinding,
      resourceProxyPrefixes: [
        ' HTTPS://STATIC.KOOKAPP.CN:443/assets/../static/ ',
        'http://img.kookapp.cn:80/assets/',
      ],
    })
    expect(parsed.resourceProxyPrefixes).toEqual([
      'https://static.kookapp.cn/static/',
      'http://img.kookapp.cn/assets/',
    ])

    for (const prefix of [
      'ftp://static.kookapp.cn/static/',
      'https://user:secret@static.kookapp.cn/static/',
      'https://@static.kookapp.cn/static/',
      'https://static.kookapp.cn/static/?version=1',
      'https://static.kookapp.cn/static/?',
      'https://static.kookapp.cn/static/#entry',
      'https://static.kookapp.cn/static/#',
      'https://static.kookapp.cn/static',
    ]) {
      expect(
        saveSiteBindingSchema.safeParse({
          ...siteBinding,
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(false)
    }
  })

  it('rejects localhost and non-public IPv4 resource proxy targets', () => {
    for (const prefix of [
      'http://localhost/assets/',
      'http://LOCALHOST./assets/',
      'http://api.localhost/assets/',
      'http://127.0.0.1/assets/',
      'http://2130706433/assets/',
      'http://0x7f000001/assets/',
      'http://0.0.0.0/assets/',
      'http://10.0.0.1/assets/',
      'http://100.100.100.200/assets/',
      'http://169.254.169.254/latest/',
      'http://172.16.0.1/assets/',
      'http://192.168.1.1/assets/',
      'http://198.18.0.1/assets/',
      'http://198.51.100.1/assets/',
      'http://224.0.0.1/assets/',
      'http://255.255.255.255/assets/',
    ]) {
      expect(
        saveSiteBindingSchema.safeParse({
          ...siteBinding,
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(false)
    }

    for (const prefix of [
      'https://8.8.8.8/assets/',
      'https://1.1.1.1/assets/',
      'https://internal.example.test/assets/',
    ]) {
      expect(
        saveSiteBindingSchema.safeParse({
          ...siteBinding,
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(true)
    }
  })

  it('rejects non-public IPv6 resource proxy targets', () => {
    for (const prefix of [
      'http://[::]/assets/',
      'http://[::1]/assets/',
      'http://[::ffff:127.0.0.1]/assets/',
      'http://[64:ff9b::a9fe:a9fe]/assets/',
      'http://[fc00::1]/assets/',
      'http://[fd12:3456::1]/assets/',
      'http://[fe80::1]/assets/',
      'http://[ff02::1]/assets/',
      'http://[2001:db8::1]/assets/',
      'http://[2002:7f00:1::]/assets/',
      'http://[3fff::1]/assets/',
    ]) {
      expect(
        saveSiteBindingSchema.safeParse({
          ...siteBinding,
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(false)
    }

    for (const prefix of [
      'https://[2001:4860:4860::8888]/assets/',
      'https://[2606:4700:4700::1111]/assets/',
    ]) {
      expect(
        saveSiteBindingSchema.safeParse({
          ...siteBinding,
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(true)
    }
  })

  it('requires at most 20 unique normalized resource proxy prefixes', () => {
    expect(
      saveSiteBindingSchema.safeParse({
        ...siteBinding,
        resourceProxyPrefixes: [
          'https://STATIC.kookapp.cn:443/static/',
          'https://static.kookapp.cn/static/',
        ],
      }).success
    ).toBe(false)
    expect(
      saveSiteBindingSchema.safeParse({
        ...siteBinding,
        resourceProxyPrefixes: Array.from(
          { length: 21 },
          (_, index) => `https://static-${index}.kookapp.cn/`
        ),
      }).success
    ).toBe(false)
    expect(saveSiteBindingSchema.safeParse(siteBinding).success).toBe(true)
    const { resourceProxyPrefixes: _prefixes, ...missingPrefixes } = siteBinding
    expect(saveSiteBindingSchema.safeParse(missingPrefixes).success).toBe(false)
  })

  it('limits non-Remote projects to implemented site adapters', () => {
    expect(saveBuildTargetSchema.safeParse(siteProject).success).toBe(true)
    expect(
      saveBuildTargetSchema.safeParse({ ...siteProject, siteAdapter: 'kook-online-h5-v1' }).success
    ).toBe(true)
    expect(
      saveBuildTargetSchema.safeParse({ ...siteProject, siteAdapter: 'kook-remote-v1' }).success
    ).toBe(false)
    expect(
      saveBuildTargetSchema.safeParse({ ...siteProject, siteAdapter: 'custom-static-v1' }).success
    ).toBe(false)
  })

  it('accepts mini_game as a KOOK Remote while rejecting unknown module keys', () => {
    const remote = {
      ...siteProject,
      id: 'mini_game',
      kind: 'remote',
      siteAdapter: 'kook-remote-v1',
      outputDirectory: 'apps/mini_game/dist',
    }
    expect(saveBuildTargetSchema.safeParse(remote).success).toBe(true)
    expect(saveBuildTargetSchema.safeParse({ ...remote, id: 'unknown_remote' }).success).toBe(false)
  })

  it('rejects HTTP Git repository URLs with inline credentials, query, or fragment', () => {
    for (const repositoryUrl of [
      'https://user:secret@git.example.test/webapp.git',
      'https://user@git.example.test/webapp.git',
      'https://@git.example.test/webapp.git',
      'https://git.example.test/webapp.git?access_token=secret',
      'https://git.example.test/webapp.git?',
      'https://git.example.test/webapp.git#credential',
      'https://git.example.test/webapp.git#',
    ]) {
      expect(saveBuildTargetSchema.safeParse({ ...siteProject, repositoryUrl }).success).toBe(false)
    }

    for (const repositoryUrl of [
      'https://git.example.test/webapp.git',
      'ssh://git@git.example.test/webapp.git',
      'git@git.example.test:webapp.git',
    ]) {
      expect(saveBuildTargetSchema.safeParse({ ...siteProject, repositoryUrl }).success).toBe(true)
    }
  })
})

describe('environment contracts', () => {
  it('defaults legacy build requests to shared and accepts an explicit environment', () => {
    expect(
      createBuildJobSchema.parse({ targetId: 'webapp', branch: 'master' }).environmentSlug
    ).toBe('shared')
    expect(
      createBuildJobSchema.parse({
        environmentSlug: 'qa_2',
        targetId: 'webapp',
        branch: 'master',
      }).environmentSlug
    ).toBe('qa_2')
  })

  it('validates environment origins and project membership rules', () => {
    expect(
      saveEnvironmentSchema.parse({
        slug: 'staging',
        name: '测试环境',
        backendOrigin: 'https://api.example.test/',
        status: 'FROZEN',
      })
    ).toMatchObject({
      slug: 'staging',
      backendOrigin: 'https://api.example.test',
      useInternalProxy: false,
      resourceProxyPrefixes: [],
      status: 'FROZEN',
    })
    expect(
      saveEnvironmentSchema.parse({
        slug: 'intranet',
        name: '公司内网',
        backendOrigin: 'https://intranet.example.test',
        useInternalProxy: true,
      }).useInternalProxy
    ).toBe(true)
    expect(
      saveEnvironmentSchema.parse({
        slug: 'intranet',
        name: '公司内网',
        backendOrigin: 'https://intranet.example.test',
        resourceProxyPrefixes: [' HTTPS://IMG.CHUANYUAPP.COM:443/assets/../ '],
      }).resourceProxyPrefixes
    ).toEqual(['https://img.chuanyuapp.com/'])
    for (const prefix of [
      'http://localhost/assets/',
      'http://127.0.0.1/assets/',
      'https://user:secret@img.chuanyuapp.com/',
      'https://img.chuanyuapp.com/assets?token=secret',
    ]) {
      expect(
        saveEnvironmentSchema.safeParse({
          slug: 'intranet',
          name: '公司内网',
          backendOrigin: 'https://intranet.example.test',
          resourceProxyPrefixes: [prefix],
        }).success
      ).toBe(false)
    }
    expect(
      saveProjectEnvironmentConfigsSchema.safeParse({
        items: [
          {
            targetId: 'webapp',
            enabled: false,
            required: true,
            installCommand: 'pnpm install',
            buildCommand: 'pnpm build',
            outputDirectory: 'dist',
          },
        ],
      }).success
    ).toBe(false)
    expect(
      saveProjectEnvironmentConfigsSchema.safeParse({
        items: [
          {
            targetId: 'webapp',
            enabled: true,
            required: false,
            installCommand: 'pnpm install',
            buildCommand: 'pnpm build',
            outputDirectory: 'dist',
          },
          {
            targetId: 'webapp',
            enabled: true,
            required: false,
            installCommand: 'pnpm install',
            buildCommand: 'pnpm build',
            outputDirectory: 'dist',
          },
        ],
      }).success
    ).toBe(false)
  })

  it('allows an empty Revision to restore a fully official environment', () => {
    expect(
      publishRevisionSchema.safeParse({
        baseRevisionId: null,
        message: 'restore official',
        selections: [],
      }).success
    ).toBe(true)
  })

  it('requires Runner job and project environment identities to match', () => {
    const input = {
      jobId: randomUuid(1),
      artifactId: randomUuid(2),
      environmentId: randomUuid(3),
      environmentSlug: 'staging',
      targetId: 'webapp',
      branch: 'master',
      requestedBy: 'gz',
      artifactBaseUrl: 'https://artifacts.example.test',
      project: {
        id: 'webapp',
        environment: {
          id: randomUuid(3),
          slug: 'staging',
          name: '测试环境',
          backendOrigin: 'https://api.example.test',
        },
        kind: 'webapp',
        repositoryUrl: 'https://git.example.test/webapp.git',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm build',
        outputDirectory: 'dist',
        siteAdapter: 'generic-static-v1',
      },
    }
    expect(runnerJobSchema.safeParse(input).success).toBe(true)
    expect(
      runnerJobSchema.safeParse({
        ...input,
        project: {
          ...input.project,
          environment: { ...input.project.environment, slug: 'another' },
        },
      }).success
    ).toBe(false)
  })
})

describe('configuration group contracts', () => {
  const input = {
    name: '  频道权限重构  ',
    environmentSlug: 'shared',
    siteBindingId: 'main',
    items: [
      { targetId: 'webapp', mode: 'official' as const },
      { targetId: 'base', mode: 'branch' as const, branch: '  feature/permissions  ' },
    ],
  }

  it('normalizes an immutable V1 group with explicit official and branch items', () => {
    expect(createConfigurationGroupSchema.parse(input)).toEqual({
      ...input,
      name: '频道权限重构',
      schemaVersion: 1,
      items: [
        { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
      ],
    })
  })

  it('accepts ASCII or Han URL prefixes without allowing mixed-script or nested labels', () => {
    expect(
      createConfigurationGroupSchema.parse({ ...input, urlPrefix: ' Party-Week ' })
    ).toMatchObject({
      urlPrefix: 'party-week',
    })
    expect(
      createConfigurationGroupSchema.parse({ ...input, urlPrefix: '中文需求-2026' })
    ).toMatchObject({
      urlPrefix: '中文需求-2026',
    })
    expect(
      createConfigurationGroupSchema.safeParse({ ...input, urlPrefix: '中文abc' }).success
    ).toBe(false)
    expect(
      createConfigurationGroupSchema.safeParse({ ...input, urlPrefix: 'nested.party' }).success
    ).toBe(false)
  })

  it('requires unique projects and a branch only for branch mode', () => {
    expect(
      createConfigurationGroupSchema.safeParse({
        ...input,
        items: [
          { targetId: 'base', mode: 'official' },
          { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
        ],
      }).success
    ).toBe(false)
    expect(
      createConfigurationGroupSchema.safeParse({
        ...input,
        items: [{ targetId: 'base', mode: 'branch' }],
      }).success
    ).toBe(false)
    expect(
      createConfigurationGroupSchema.safeParse({
        ...input,
        items: [{ targetId: 'base', mode: 'official', branch: 'feature/permissions' }],
      }).success
    ).toBe(false)
    expect(createConfigurationGroupSchema.safeParse({ ...input, items: [] }).success).toBe(false)
    expect(createConfigurationGroupSchema.safeParse({ ...input, schemaVersion: 2 }).success).toBe(
      false
    )
  })

  it('requires a positive expected revision for a full configuration group update', () => {
    expect(
      updateConfigurationGroupSchema.parse({ ...input, schemaVersion: 1, expectedRevision: 3 })
    ).toEqual({
      ...input,
      name: '频道权限重构',
      schemaVersion: 1,
      expectedRevision: 3,
      items: [
        { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
      ],
    })
    expect(
      updateConfigurationGroupSchema.safeParse({
        ...input,
        schemaVersion: 1,
        expectedRevision: 0,
      }).success
    ).toBe(false)
    expect(updateConfigurationGroupSchema.safeParse({ ...input, schemaVersion: 1 }).success).toBe(
      false
    )
  })

  it('accepts an optional revision and application mode when creating a group preview', () => {
    expect(createConfigurationGroupPreviewSchema.parse({})).toEqual({})
    expect(
      createConfigurationGroupPreviewSchema.parse({
        expectedRevision: 3,
        applicationMode: 'remote-only',
      })
    ).toEqual({ expectedRevision: 3, applicationMode: 'remote-only' })
    expect(createConfigurationGroupPreviewSchema.safeParse({ expectedRevision: 0 }).success).toBe(
      false
    )
    expect(
      createConfigurationGroupPreviewSchema.safeParse({ applicationMode: 'site-only' }).success
    ).toBe(false)
  })
})

describe('preview contracts', () => {
  it('allows an environment-only tab preview with no Artifact override', () => {
    expect(
      createPreviewSchema.parse({
        siteBindingId: 'main',
        environmentSlug: 'staging',
      })
    ).toEqual({
      ttlMinutes: 480,
      siteBindingId: 'main',
      environmentSlug: 'staging',
      selections: [],
    })
  })

  it('requires every preview to identify its site binding', () => {
    expect(createPreviewSchema.safeParse({ environmentSlug: 'staging' }).success).toBe(false)
  })
})

function randomUuid(suffix: number): string {
  return `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
}
