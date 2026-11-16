import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  BranchCatalogItem,
  BuildJob,
  MatrixRow,
  SiteBinding,
  SystemSettingsView,
} from '@cuddly/contracts'

import {
  BuildHistoryView,
  DEFAULT_RESOURCE_PROXY_PREFIXES,
  ConfigurationGroupsView,
  EnvironmentsSettings,
  PROJECT_VERSION_MODE_STORAGE_KEY,
  ProjectVersionTabs,
  configurationGroupBranchSelection,
  configurationGroupDirectPreviewUrl,
  configurationGroupDirectoryReady,
  configurationGroupSharePath,
  normalizeResourceProxyPrefixes,
  previewableSiteBindings,
  projectVersionModeFromKeyboard,
  projectVersionModeFromStorage,
  projectSiteSummary,
  selectedBranchAfterCatalogRefresh,
  selectedEnvironmentOrFirst,
  siteHostnameForId,
  SystemSettingsForm,
  TargetRow,
} from './App'
import type { ConfigurationGroupRecord } from './api'

function siteBinding(id: string, targetId: string): SiteBinding {
  return {
    id,
    name: id,
    hostname: `${id}.bifrost.vanillacake.cn`,
    targetId,
    environmentSlug: 'shared',
    fallbackOrigin: 'https://www.kookapp.cn',
    upstreamOrigin: 'https://www.kookapp.cn',
    officialOrigin: `https://${id}.kookapp.cn`,
    enabled: true,
    remoteTargetIds: [],
    resourceProxyPrefixes: ['https://img.kookapp.cn/'],
  }
}

describe('in-place URL rule settings', () => {
  const settings: SystemSettingsView = {
    mobileUpstream: 'https://m.kookapp.cn',
    publicMobileOrigin: 'https://m.bifrost.vanillacake.cn',
    webappUpstream: 'https://www.kookapp.cn',
    publicPreviewOrigin: 'https://bifrost.vanillacake.cn',
    mobileHostnames: ['m.bifrost.vanillacake.cn'],
    cookieDomain: '',
    buildMaxConcurrency: 3,
    runnerRequestTimeoutMinutes: 30,
    useChinaRegistry: true,
    proxyRewriteMaxMegabytes: 2,
    autoSslEnabled: false,
    autoSslEmail: '',
    inPlaceUrlRules: [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }],
  }

  it('renders compact literal-match rows with accessible controls and environment status', () => {
    const markup = renderToStaticMarkup(
      createElement(SystemSettingsForm, {
        settings,
        environments: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            slug: 'shared',
            name: '线上环境',
            status: 'ACTIVE',
            backendOrigin: 'https://www.kookapp.cn',
            useInternalProxy: false,
            resourceProxyPrefixes: [],
            currentRevisionId: null,
          },
        ],
        selectedEnvironmentSlug: 'shared',
        onChange() {},
      })
    )

    expect(markup).toContain('官网原地应用规则')
    expect(markup).toContain('绝不会打开 Bifrost')
    expect(markup).toContain('value="www.kookapp.cn"')
    expect(markup).toContain('线上环境 · shared · 可用')
    expect(markup).toContain('aria-label="第 1 条规则的 URL 包含模式"')
    expect(markup).toContain('aria-label="删除第 1 条原地应用规则"')
    expect(markup).toContain('添加规则')
  })
})

describe('build history pagination', () => {
  const failedJob: BuildJob = {
    id: '00000000-0000-4000-8000-000000000099',
    environmentId: '00000000-0000-4000-8000-000000000001',
    environmentSlug: 'shared',
    targetId: 'online-h5',
    branch: 'feature/failed-build',
    profile: 'qa-web',
    status: 'FAILED',
    requestedBy: 'gz',
    createdAt: '2026-08-26T01:00:00.000Z',
    startedAt: '2026-08-26T01:01:00.000Z',
    finishedAt: '2026-08-26T01:02:00.000Z',
    failureCode: 'BUILD_FAILED',
    failureMessage: 'build failed',
    logPath: '/api/v1/build-jobs/job/log',
    targetSnapshot: null,
  }

  it('shows failed jobs and a compact numbered page selector', () => {
    const markup = renderToStaticMarkup(
      createElement(BuildHistoryView, {
        jobs: [failedJob],
        loading: false,
        error: '',
        targetId: '',
        status: '',
        query: '',
        targets: [{ id: 'online-h5', name: '在线 H5' }],
        environmentNames: new Map([['shared', '线上环境']]),
        onTargetChange() {},
        onStatusChange() {},
        onQueryChange() {},
        onRefresh() {},
        page: 2,
        pageSize: 20,
        total: 73,
        totalPages: 4,
        onPageChange() {},
        onPageSizeChange() {},
        onOpen() {},
      })
    )

    expect(markup).toContain('全部状态')
    expect(markup).toContain('打包失败')
    expect(markup).toContain('job-status-failed')
    expect(markup).toContain('共 73 条')
    expect(markup).toContain('aria-label="每页记录数"')
    expect(markup).toContain('aria-label="上一页"')
    expect(markup).toContain('aria-label="当前页码"')
    expect(markup).toContain('第 2 / 4 页')
    expect(markup).toContain('aria-label="下一页"')
  })

  it('keeps an empty result on page one with both directions disabled', () => {
    const markup = renderToStaticMarkup(
      createElement(BuildHistoryView, {
        jobs: [],
        loading: false,
        error: '',
        targetId: '',
        status: '',
        query: '',
        targets: [],
        environmentNames: new Map(),
        onTargetChange() {},
        onStatusChange() {},
        onQueryChange() {},
        onRefresh() {},
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        onPageChange() {},
        onPageSizeChange() {},
        onOpen() {},
      })
    )

    expect(markup).toContain('没有符合条件的构建记录')
    expect(markup).toContain('共 0 条')
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="上一页")[^>]*>/)
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*aria-label="下一页")[^>]*>/)
    expect(markup).toContain('第 1 / 1 页')
  })
})

describe('site hostname generation', () => {
  it('proxies the complete KOOK protected resource origins by default', () => {
    expect(DEFAULT_RESOURCE_PROXY_PREFIXES).toEqual([
      'https://img.kookapp.cn/',
      'https://static.kookapp.cn/',
    ])
  })

  it('uses the deployed preview base domain by default', () => {
    expect(siteHostnameForId('main')).toBe('main.bifrost.vanillacake.cn')
    expect(siteHostnameForId('main-preview')).toBe('main-preview.bifrost.vanillacake.cn')
  })

  it('uses a runtime-provided preview base domain', () => {
    expect(siteHostnameForId('main', 'preview.example.test')).toBe('main.preview.example.test')
    expect(siteHostnameForId('mobile', '.QA.EXAMPLE.TEST.')).toBe('mobile.qa.example.test')
  })

  it('rejects invalid DNS-label site ids', () => {
    expect(siteHostnameForId('main_preview')).toBe('')
    expect(siteHostnameForId('main-')).toBe('')
    expect(siteHostnameForId('a'.repeat(64))).toBe('')
  })
})

describe('project site summary', () => {
  it('keeps remote projects distinct from page projects', () => {
    expect(projectSiteSummary({ id: 'base', kind: 'remote' }, [])).toBe('Remote')
    expect(projectSiteSummary({ id: 'webapp', kind: 'webapp' }, [])).toBe('未配置站点')
  })

  it('shows the hostname for one site and a count for multiple sites', () => {
    const main = siteBinding('main', 'webapp')
    const staging = siteBinding('staging', 'webapp')
    const mobile = siteBinding('mobile', 'online-h5')

    expect(projectSiteSummary({ id: 'webapp', kind: 'webapp' }, [main, mobile])).toBe(main.hostname)
    expect(projectSiteSummary({ id: 'webapp', kind: 'webapp' }, [main, staging, mobile])).toBe(
      '2 个站点'
    )
  })
})

describe('build-only project row', () => {
  it('keeps branch builds available without exposing public publication actions', () => {
    const builtAt = '2026-08-26T00:00:00.000Z'
    const row: MatrixRow = {
      target: {
        id: 'webapp',
        name: '网页端',
        kind: 'webapp',
        defaultBranch: 'master',
        enabled: true,
        required: false,
        configured: true,
      },
      config: {
        targetId: 'webapp',
        environmentId: '00000000-0000-4000-8000-000000000001',
        enabled: true,
        required: false,
        installCommand: 'pnpm install',
        buildCommand: 'pnpm build',
        outputDirectory: 'dist',
      },
      current: null,
      latestArtifact: { id: '00000000-0000-4000-8000-000000000002', branch: 'master', builtAt },
      activeJob: null,
    }
    const branch: BranchCatalogItem = {
      branch: 'master',
      buildStatus: 'IDLE',
      latestArtifact: row.latestArtifact,
      latestJob: null,
    }
    const props = {
      row,
      branchState: { items: [branch], remoteAvailable: true },
      queueItems: [],
      selectedBranch: 'master',
      busy: false,
      environmentStatus: 'ACTIVE' as const,
      onBranchChange() {},
      onBuild() {},
    }
    const markup = renderToStaticMarkup(createElement(TargetRow, props))
    const officialMarkup = renderToStaticMarkup(
      createElement(TargetRow, { ...props, selectedBranch: '' })
    )

    expect(markup).toContain('打包分支')
    expect(officialMarkup).toContain('官网页面')
    expect(markup).toContain('打最新包')
    const restricted = renderToStaticMarkup(createElement(TargetRow, { ...props, canBuild: false }))
    expect(restricted).toContain('打包分支')
    expect(restricted).not.toContain('打最新包')
    expect(markup).not.toContain('发布')
    expect(markup).not.toContain('使用此包')
    expect(markup).not.toContain('当前使用中')
  })
})

describe('environment settings selection', () => {
  const environments = [{ slug: 'shared' }, { slug: 'qa-local' }]

  it('opens the environment that is selected in the main console', () => {
    expect(selectedEnvironmentOrFirst(environments, 'qa-local')).toEqual({ slug: 'qa-local' })
  })

  it('falls back to the first environment when the current selection is unavailable', () => {
    expect(selectedEnvironmentOrFirst(environments, 'missing')).toEqual({ slug: 'shared' })
    expect(selectedEnvironmentOrFirst([], 'missing')).toBeNull()
  })

  it('shows the per-environment internal proxy toggle and its Mihomo prerequisite', () => {
    const markup = renderToStaticMarkup(
      createElement(EnvironmentsSettings, {
        environments: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            slug: 'tttt',
            name: '测试环境',
            status: 'ACTIVE',
            backendOrigin: 'https://tttt-www.dev.chuanyuapp.com',
            useInternalProxy: true,
            resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
            currentRevisionId: null,
          },
        ],
        setEnvironments() {},
        projects: [],
        proxyEnabled: false,
        onChanged() {},
        initialSelectedSlug: 'tttt',
      })
    )

    expect(markup).toContain('走公司内网')
    expect(markup).toContain('环境附加资源代理来源')
    expect(markup).toContain('https://img.chuanyuapp.com/')
    expect(markup).toContain('只在选择此环境时生效')
    expect(markup).toContain('仅业务后端请求经 Mihomo')
    expect(markup).toContain('当前未启用 Mihomo')
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/)
  })

  it('keeps the internal proxy off for a newly created environment', () => {
    const markup = renderToStaticMarkup(
      createElement(EnvironmentsSettings, {
        environments: [],
        setEnvironments() {},
        projects: [],
        proxyEnabled: true,
        onChanged() {},
        initialSelectedSlug: '',
      })
    )

    expect(markup).toContain('走公司内网')
    expect(markup).toContain('环境附加资源代理来源')
    expect(markup).not.toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/)
  })

  it('normalizes environment resource proxy lines before saving', () => {
    expect(
      normalizeResourceProxyPrefixes([
        ' https://img.chuanyuapp.com/ ',
        '',
        'https://static.kookapp.cn/',
        'https://img.chuanyuapp.com/',
      ])
    ).toEqual(['https://img.chuanyuapp.com/', 'https://static.kookapp.cn/'])
  })
})

describe('project version requirements', () => {
  const token = 'a'.repeat(32)
  const group: ConfigurationGroupRecord = {
    id: token,
    token,
    previewHostnamePrefix: 'party-week',
    name: '频道权限重构',
    environmentId: '00000000-0000-4000-8000-000000000001',
    environmentSlug: 'shared',
    siteBindingId: 'main',
    schemaVersion: 1,
    items: [
      { targetId: 'webapp', mode: 'official' },
      { targetId: 'base', mode: 'branch', branch: 'feature/permissions' },
    ],
    createdBy: '测试用户',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedBy: '测试用户',
    updatedAt: '2026-08-26T01:00:00.000Z',
    revision: 1,
    sharePath: `/s/${token}`,
    directPreviewUrl: 'https://party-week.bifrost.vanillacake.cn/',
  }

  it('defaults the remembered secondary tab to branches and restores requirements', () => {
    expect(projectVersionModeFromStorage({ getItem: () => null })).toBe('branches')
    expect(
      projectVersionModeFromStorage({
        getItem: (key) => (key === PROJECT_VERSION_MODE_STORAGE_KEY ? 'requirements' : null),
      })
    ).toBe('requirements')
    expect(projectVersionModeFromStorage({ getItem: () => 'invalid' })).toBe('branches')
  })

  it('renders the compact requirements and branches tab semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectVersionTabs, { mode: 'requirements', onChange() {} })
    )

    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('按需求')
    expect(markup).toContain('按分支')
    expect(markup).toContain('id="version-mode-requirements"')
    expect(markup).toContain('aria-selected="true"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('id="version-mode-branches"')
    expect(markup).toContain('tabindex="-1"')
  })

  it('supports roving tab navigation with arrows, Home, and End', () => {
    expect(projectVersionModeFromKeyboard('requirements', 'ArrowRight')).toBe('branches')
    expect(projectVersionModeFromKeyboard('branches', 'ArrowRight')).toBe('requirements')
    expect(projectVersionModeFromKeyboard('branches', 'ArrowLeft')).toBe('requirements')
    expect(projectVersionModeFromKeyboard('requirements', 'ArrowUp')).toBe('branches')
    expect(projectVersionModeFromKeyboard('branches', 'Home')).toBe('requirements')
    expect(projectVersionModeFromKeyboard('requirements', 'End')).toBe('branches')
    expect(projectVersionModeFromKeyboard('requirements', 'Enter')).toBeNull()
  })

  it('keeps official items explicit in the branch draft', () => {
    expect(configurationGroupBranchSelection(group.items)).toEqual({
      webapp: '',
      base: 'feature/permissions',
    })
  })

  it('does not replace an explicit official selection while refreshing branch catalogs', () => {
    const catalog: BranchCatalogItem[] = [
      {
        branch: 'master',
        buildStatus: 'IDLE',
        latestArtifact: null,
        latestJob: null,
      },
    ]
    expect(selectedBranchAfterCatalogRefresh('', catalog, 'master')).toBe('')
    expect(selectedBranchAfterCatalogRefresh(undefined, catalog, 'develop')).toBe('master')
    expect(selectedBranchAfterCatalogRefresh('missing', catalog, 'develop')).toBe('master')
  })

  it('accepts only the stable same-origin share path for a group token', () => {
    expect(configurationGroupSharePath(group)).toBe(`/s/${token}`)
    expect(configurationGroupSharePath({ ...group, sharePath: 'https://evil.example/s/a' })).toBe(
      `/s/${token}`
    )
    expect(configurationGroupSharePath({ ...group, token: 'short' })).toBe('')
  })

  it('accepts a DNS-safe custom direct preview URL for the stored prefix', () => {
    expect(configurationGroupDirectPreviewUrl(group)).toBe(
      'https://party-week.bifrost.vanillacake.cn/'
    )
    expect(
      configurationGroupDirectPreviewUrl({
        ...group,
        directPreviewUrl: 'https://party-week.attacker.example/',
      })
    ).toBe('')
  })

  it('renders compact global requirement cards with official and branch summaries', () => {
    const main = siteBinding('main', 'webapp')
    main.name = 'KOOK 网页端'
    const markup = renderToStaticMarkup(
      createElement(ConfigurationGroupsView, {
        groups: [group],
        loading: false,
        error: '',
        environments: [
          {
            id: group.environmentId,
            slug: 'shared',
            name: '线上环境',
            backendOrigin: 'https://www.kookapp.cn',
            useInternalProxy: false,
            resourceProxyPrefixes: [],
            status: 'ACTIVE',
            currentRevisionId: null,
          },
        ],
        siteBindings: [main],
        targetNames: new Map([
          ['webapp', '网页端'],
          ['base', 'Base'],
        ]),
        deletingToken: null,
        onUse() {},
        onEdit() {},
        onCopy() {},
        onDelete() {},
        onRetry() {},
      })
    )

    expect(markup).toContain('频道权限重构')
    expect(markup).toContain('线上环境')
    expect(markup).toContain('KOOK 网页端')
    expect(markup).toContain('网页端 · 官方版本')
    expect(markup).toContain('Base · feature/permissions')
    expect(markup).toContain(`href="/s/${token}"`)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('测试用户')
  })

  it('keeps stale data visible with a refresh warning and disables concurrent actions while deleting', () => {
    const markup = renderToStaticMarkup(
      createElement(ConfigurationGroupsView, {
        groups: [group],
        loading: false,
        error: 'network unavailable',
        environments: [],
        siteBindings: [],
        targetNames: new Map(),
        deletingToken: group.token,
        onUse() {},
        onEdit() {},
        onCopy() {},
        onDelete() {},
        onRetry() {},
      })
    )

    expect(markup).toContain('当前展示上次加载的数据')
    expect(markup).toContain('频道权限重构')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('删除中')
    expect(markup).toContain('disabled=""')
  })

  it('keeps enabled site bindings selectable across environment boundaries', () => {
    const shared = siteBinding('shared-main', 'webapp')
    shared.name = 'A 共享站点'
    shared.environmentSlug = 'shared'
    const tttt = siteBinding('tttt-main', 'webapp')
    tttt.name = 'B 测试站点'
    tttt.environmentSlug = 'tttt'
    const disabled = { ...siteBinding('disabled', 'webapp'), enabled: false }

    expect(previewableSiteBindings([tttt, disabled, shared]).map((binding) => binding.id)).toEqual([
      'shared-main',
      'tttt-main',
    ])
  })

  it('keeps creation disabled until both environment and site directories are usable', () => {
    expect(configurationGroupDirectoryReady([], [])).toBe(false)
    expect(configurationGroupDirectoryReady([{ status: 'ACTIVE' }], [{ enabled: false }])).toBe(
      false
    )
    expect(configurationGroupDirectoryReady([{ status: 'ARCHIVED' }], [{ enabled: true }])).toBe(
      false
    )
    expect(configurationGroupDirectoryReady([{ status: 'FROZEN' }], [{ enabled: true }])).toBe(true)
  })
})
