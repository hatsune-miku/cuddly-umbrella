// Render current application components with synthetic documentation data.
// No production API is contacted and no build, preview or share is created.
import http from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'apps/console/public/help/images')
const reviewOutput = path.join(root, 'output/cake-ui-review')
const capture = async (page, file) => {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  await page.screenshot({ path: file, animations: 'disabled' })
}
const manifest = JSON.parse(
  await fs.readFile(path.join(root, 'apps/browser-extension/manifest.json'), 'utf8')
)
const now = Date.now()
const uiErrors = []
const date = (minutes) => new Date(now - minutes * 60000).toISOString()
const environments = [
  {
    id: 'demo-test',
    slug: 'tttt',
    name: 'tttt',
    sortOrder: -20,
    backendOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    useInternalProxy: true,
  },
  {
    id: 'demo-online',
    slug: 'shared',
    name: '线上环境',
    sortOrder: -10,
    backendOrigin: 'https://www.kookapp.cn',
    useInternalProxy: false,
  },
  {
    id: 'demo-qa',
    slug: 'qa',
    name: 'QA',
    sortOrder: 20,
    backendOrigin: 'https://qa-www.dev.chuanyuapp.com',
    useInternalProxy: true,
  },
].map((e) => ({ ...e, status: 'ACTIVE', resourceProxyPrefixes: [], currentRevisionId: null }))
const environment = environments[0]
const targetNames = {
  webapp: '网页端',
  'online-h5': '在线 H5',
  base: 'base',
  discover: 'discover',
  guild: 'guild',
  voice_runtime: 'voice_runtime',
}
const targets = Object.entries(targetNames).map(([id, name]) => ({
  id,
  name,
  kind: id === 'webapp' ? 'webapp' : id === 'online-h5' ? 'online-h5' : 'remote',
  defaultBranch: 'master',
  enabled: true,
  required: false,
  configured: true,
}))
const binding = {
  id: 'main',
  name: '网页端',
  hostname: 'main.bifrost.vanillacake.cn',
  targetId: 'webapp',
  environmentSlug: 'tttt',
  fallbackOrigin: 'https://www.kookapp.cn',
  officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
  upstreamOrigin: environment.backendOrigin,
  enabled: true,
  remoteTargetIds: ['base', 'discover', 'guild', 'voice_runtime'],
  resourceProxyPrefixes: [],
}
const job = (id, targetId, branch, status, minutes, extra = {}) => ({
  id,
  environmentId: environment.id,
  environmentSlug: environment.slug,
  targetId,
  branch,
  profile: 'qa-web',
  status,
  requestedBy: '演示用户',
  createdAt: date(minutes + 1),
  startedAt: status === 'QUEUED' ? null : date(minutes),
  finishedAt: status === 'FAILED' || status === 'SUCCEEDED' ? date(8) : null,
  failureCode: null,
  failureMessage: null,
  targetSnapshot: null,
  logPath: null,
  ...extra,
})
const running = job('demo-build-001', 'discover', 'feature/discover-filter', 'BUILDING', 3, {
  queuePosition: null,
  isMine: true,
})
const queued = job('demo-build-002', 'guild', 'release/qa', 'QUEUED', 1, {
  queuePosition: 1,
  isMine: false,
  requestedBy: '另一位同事',
})
const failed = job('demo-build-003', 'online-h5', 'feature/party-page', 'FAILED', 13, {
  failureCode: 'BUILD_FAILED',
  failureMessage: '依赖模块尚未构建，请检查 workspace packages 的构建顺序。',
})
const history = [running, queued, failed, job('demo-build-004', 'base', 'master', 'SUCCEEDED', 20)]
let historyItems = history
let historyDelay = 0
let queue = { running: [running], queued: [queued], generatedAt: date(0) }
const artifact = (targetId, branch, minutes = 25) => ({
  id: `demo-${targetId}-${branch.replaceAll('/', '-')}`,
  branch,
  targetId,
  environmentId: environment.id,
  environmentSlug: environment.slug,
  builtAt: date(minutes),
  status: 'READY',
})
const branchItems = (id) => [
  {
    branch: 'feature/discover-filter',
    buildStatus: 'IDLE',
    latestArtifact: artifact(id, 'feature/discover-filter', 18),
    latestJob: id === 'discover' ? running : null,
  },
  {
    branch: 'release/qa',
    buildStatus: 'IDLE',
    latestArtifact: artifact(id, 'release/qa', 90),
    latestJob: id === 'guild' ? queued : null,
  },
  {
    branch: 'master',
    buildStatus: 'IDLE',
    latestArtifact: artifact(id, 'master', 120),
    latestJob: null,
  },
  {
    branch: 'feature/layout-draft',
    buildStatus: 'FAILED',
    latestArtifact: null,
    latestJob: { ...failed, targetId: id, branch: 'feature/layout-draft' },
  },
]
const groupToken = '00000000000000000000000000000001'
const group = {
  id: groupToken,
  token: groupToken,
  previewSlug: groupToken,
  previewHostnamePrefix: 'discover-review',
  name: '发现页筛选优化',
  environmentId: environment.id,
  environmentSlug: environment.slug,
  siteBindingId: binding.id,
  schemaVersion: 1,
  items: binding.remoteTargetIds
    .map((id) =>
      id === 'discover'
        ? { targetId: id, mode: 'branch', branch: 'feature/discover-filter' }
        : { targetId: id, mode: 'official' }
    )
    .concat({ targetId: 'webapp', mode: 'official' }),
  createdBy: '演示用户',
  updatedBy: '演示用户',
  createdAt: date(40),
  updatedAt: date(20),
  revision: 1,
  sharePath: `/s/${groupToken}`,
  directPreviewUrl: 'https://discover-review.bifrost.vanillacake.cn/',
}
let configurationGroups = [group]
const matrix = {
  environment,
  revision: null,
  rows: targets.map((target) => ({
    target,
    config: { enabled: true, required: false, targetId: target.id, environmentId: environment.id },
    current: null,
    latestArtifact: artifact(target.id, 'master'),
    activeJob: target.id === 'discover' ? running : target.id === 'guild' ? queued : null,
  })),
}

function api(url) {
  const p = url.pathname
  if (p.endsWith('/proxy-settings'))
    return {
      enabled: false,
      subscriptionConfigured: false,
      subscriptionUrlMasked: null,
      refreshIntervalMinutes: 60,
      sources: {
        enabled: 'default',
        subscriptionUrl: 'default',
        refreshIntervalMinutes: 'default',
      },
      status: {
        mihomoReachable: true,
        lastAppliedAt: null,
        lastCheckedAt: date(0),
        lastError: null,
      },
    }
  if (p.endsWith('/system-settings'))
    return {
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
      inPlaceUrlRules: [],
    }
  if (p.endsWith('/projects'))
    return {
      environment,
      items: targets.map((target) => ({
        targetId: target.id,
        environmentId: environment.id,
        enabled: true,
        required: false,
        installCommand: 'corepack pnpm install --frozen-lockfile',
        buildCommand: 'corepack pnpm build:test',
        outputDirectory: 'dist',
      })),
    }
  if (p.endsWith('/auth/session'))
    return {
      authenticated: true,
      identity: { name: '演示用户', avatarUrl: '' },
      csrfToken: 'documentation-fixture-only',
    }
  if (p.endsWith('/environments')) return { items: environments }
  if (p.endsWith('/runtime'))
    return { previewBaseDomain: 'bifrost.vanillacake.cn', inPlaceUrlRules: [] }
  if (p.endsWith('/matrix')) return matrix
  if (p.endsWith('/build-queue')) return queue
  if (p.endsWith('/build-targets')) return { items: targets, environment }
  if (p.endsWith('/branches'))
    return { items: branchItems(p.split('/').at(-2)), remoteAvailable: true }
  if (
    p.includes('/site-bindings/') &&
    [...url.searchParams.values()].some((v) => v.includes('example.com'))
  )
    return { items: [] }
  if (
    p.endsWith('/site-bindings/resolve') ||
    p.endsWith('/site-bindings/candidates') ||
    p.endsWith('/admin/site-bindings')
  )
    return { items: [binding] }
  if (p.endsWith('/config-groups/resolve-preview')) return null
  if (p.endsWith('/config-groups')) return { items: configurationGroups }
  if (p.endsWith('/build-jobs')) {
    const pageSize = Number(url.searchParams.get('pageSize')) || 20
    const page = Number(url.searchParams.get('page')) || 1
    return {
      items: historyItems.slice((page - 1) * pageSize, page * pageSize),
      total: historyItems.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(historyItems.length / pageSize)),
    }
  }
  if (p.endsWith('/detail')) {
    const selected = history.find((j) => j.id === p.split('/').at(-2)) || running
    return {
      job: selected,
      artifact: null,
      commands: [
        {
          stage: 'CHECKOUT',
          label: '准备源码',
          command: 'git fetch origin feature/discover-filter',
        },
        {
          stage: 'INSTALLING',
          label: '安装依赖',
          command: "corepack pnpm --filter '{./apps/discover}...' install --frozen-lockfile",
        },
        {
          stage: 'BUILDING',
          label: '打包',
          command:
            "corepack pnpm --filter '{./apps/discover}^...' --if-present build\ncorepack pnpm --filter './apps/discover' build:test",
        },
      ],
      events: ['QUEUED', 'LEASED', 'CHECKOUT', 'INSTALLING', 'BUILDING'].map((status, index) => ({
        id: `event-${index}`,
        jobId: selected.id,
        status,
        createdAt: date(4 - index * 0.5),
      })),
    }
  }
  if (p.endsWith('/log'))
    return {
      content:
        '[INSTALLING] Workspace dependencies ready\n[BUILDING] packages/utils build completed\n[BUILDING] packages/logic-models build completed\n[BUILDING] apps/discover\nRsbuild is compiling client bundles...\n',
      size: 200,
      complete: false,
      truncated: false,
      updatedAt: date(0),
    }
  throw new Error(`Unmocked documentation API: ${p}`)
}

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  try {
    if (u.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new Error('Documentation fixtures do not perform writes')
      if (u.pathname.endsWith('/build-jobs') && historyDelay)
        await new Promise((resolve) => setTimeout(resolve, historyDelay))
      const body = api(u)
      res.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(body || {}))
    }
    const prefix = u.pathname.startsWith('/_extension/')
      ? 'apps/browser-extension'
      : 'apps/console/dist'
    const relative = u.pathname.startsWith('/_extension/')
      ? u.pathname.slice(12)
      : u.pathname.slice(1)
    const base = path.join(root, prefix)
    const target = path.resolve(
      base,
      !relative || relative.endsWith('/') ? `${relative}index.html` : relative
    )
    if (!target.startsWith(base + path.sep)) throw new Error('Invalid asset path')
    const bytes = await fs.readFile(target)
    res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' })
    res.end(bytes)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(error.message)
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
await fs.mkdir(output, { recursive: true })
await fs.mkdir(reviewOutput, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE ||
    'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
})
try {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 800 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => uiErrors.push(`Console: ${error.message}`))
  await page.goto(origin)
  await page
    .getByRole('button', { name: '按分支', exact: true })
    .or(page.getByRole('tab', { name: '按分支', exact: true }))
    .click()
  await page.getByText('tttt 已刷新', { exact: true }).waitFor()
  assert.equal(
    await page
      .locator('.version-mode-toolbar')
      .getByRole('combobox', { name: '当前环境', exact: true })
      .count(),
    1
  )
  assert.equal(
    await page
      .locator('.version-mode-toolbar')
      .getByRole('combobox', { name: '要打开的站点', exact: true })
      .count(),
    1
  )
  assert.equal(
    await page.locator('.version-mode-main').evaluate((el) => {
      const tabs = el.querySelector('.version-mode-tabs').getBoundingClientRect()
      const selectors = el.querySelector('.version-context-controls').getBoundingClientRect()
      return (
        selectors.left > tabs.right &&
        Math.abs(tabs.top + tabs.bottom - (selectors.top + selectors.bottom)) < 2
      )
    }),
    true,
    'Desktop context selectors must sit alongside the version tabs'
  )
  assert.equal(
    await page
      .locator('.target-list')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
    2,
    'The desktop project layout must remain two columns'
  )
  assert.equal(
    await page.locator('.version-mode-main').evaluate((el) => {
      const main = el.querySelector('.main-view-tabs').getBoundingClientRect()
      const sub = el.querySelector('.version-mode-tabs').getBoundingClientRect()
      return main.right < sub.left && Math.abs(main.top + main.bottom - sub.top - sub.bottom) < 2
    }),
    true,
    'Primary and secondary console navigation share a row'
  )
  await assertAlignedSwitches(page, '.main-view-tabs', '.version-mode-tabs', [
    '.environment-switcher .cake-combobox',
    '.site-switcher .cake-combobox',
  ])
  await capture(page, path.join(output, 'console-projects.png'))
  await page.locator('.queue-row').first().click()
  await page
    .locator('.job-detail-tabs')
    .getByRole('button', { name: '控制台', exact: true })
    .click()
  await page.locator('.job-console').waitFor()
  assert.deepEqual(
    await page.locator('.job-console').evaluate((el) => {
      const style = getComputedStyle(el)
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.userSelect,
        style.backgroundColor,
        style.color,
      ]
    }),
    ['0px', '0px', 'text', 'rgb(255, 255, 255)', 'rgb(17, 17, 17)']
  )
  await capture(page, path.join(reviewOutput, 'console-log.png'))
  await page.getByTitle('关闭任务详情').click()
  await page.locator('.branch-picker-trigger').first().click()
  await page.locator('dialog.branch-picker-dialog[open]').first().waitFor()
  await page.locator('dialog[open]').getByPlaceholder('搜索分支名称').fill('layout')
  assert.equal(await page.locator('dialog[open] [role="option"]').count(), 2)
  await capture(page, path.join(reviewOutput, 'console-branch-picker.png'))
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await page.getByTitle('环境与项目设置').click()
  await page.getByRole('switch', { name: /走公司内网/ }).waitFor()
  assert.equal(await page.getByRole('spinbutton', { name: '显示顺序' }).inputValue(), '-20')
  assert.deepEqual(
    await page.locator('.environments-layout .project-index-item > span').allTextContents(),
    environments.map((e) => e.name)
  )
  await capture(page, path.join(reviewOutput, 'console-environments.png'))
  for (const name of ['项目', '代理', '系统']) {
    await page.locator('.management-tabs').getByRole('button', { name, exact: true }).click()
    await capture(page, path.join(reviewOutput, `console-settings-${name}.png`))
  }
  await page.getByTitle('关闭管理后台').click()
  await page
    .getByRole('button', { name: '按需求', exact: true })
    .or(page.getByRole('tab', { name: '按需求', exact: true }))
    .click()
  await page.getByText('发现页筛选优化', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('combobox', { name: '当前环境', exact: true }).isVisible(),
    true
  )
  await capture(page, path.join(output, 'console-requirements.png'))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.getByRole('combobox', { name: '要打开的站点', exact: true }).isVisible(),
    true
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await capture(page, path.join(reviewOutput, 'console-mobile.png'))
  await page.setViewportSize({ width: 1180, height: 800 })
  await page
    .locator('.main-view-tabs')
    .getByRole('button', { name: '构建记录', exact: true })
    .click()
  assert.equal(
    await page.getByRole('combobox', { name: '当前环境', exact: true }).isVisible(),
    true,
    'History retains an environment picker'
  )
  assert.equal(await page.getByRole('combobox', { name: '当前环境', exact: true }).count(), 1)

  assert.equal(await page.locator('.version-mode-tabs').count(), 0)
  assert.equal(await page.locator('.history-filters .main-view-tabs').count(), 1)
  await capture(page, path.join(reviewOutput, 'console-history.png'))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await capture(page, path.join(reviewOutput, 'console-history-mobile.png'))

  const popupContext = await browser.newContext({
    viewport: { width: 672, height: 600 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  await popupContext.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  )
  await popupContext.addInitScript(
    ({ origin, manifest }) => {
      const defaultScoped = {
        selectedBranches: {
          webapp: '',
          base: '',
          discover: 'feature/discover-filter',
          guild: 'release/qa',
          voice_runtime: 'master',
        },
        submittedBuildBranches: {},
        siteOverrideEnabled: false,
      }
      const scopedByTab = { 1: defaultScoped }
      let currentTab = {
        id: 1,
        windowId: 10,
        title: '网页端',
        url: 'https://main.bifrost.vanillacake.cn/',
      }
      const listeners = {}
      const tabEvent = (name) => ({
        addListener: (fn) => {
          listeners[name] = fn
        },
      })
      window.testTabs = {
        activate: (id, windowId = 10) => {
          if (windowId === 10) currentTab = { ...currentTab, id }
          listeners.activated?.({ tabId: id, windowId })
        },
        navigate: (url) => {
          currentTab = { ...currentTab, url }
          listeners.updated?.(currentTab.id, { url }, currentTab)
        },
      }
      const storage = { 'cuddly.controlOrigin': origin, 'cuddly.projectVersionTab.v1': 'branches' }
      const event = { addListener() {}, removeListener() {} }
      window.chrome = {
        runtime: {
          getManifest: () => manifest,
          getURL: (p) => `${origin}/_extension/${p}`,
          onMessage: event,
          sendMessage: async (m) => {
            if (m.type === 'read-popup-scoped-state')
              return { ok: true, state: scopedByTab[m.tabId] || null }
            if (m.type === 'write-popup-scoped-state') {
              scopedByTab[m.tabId] = m
              return { ok: true }
            }
            if (m.type === 'get-extension-capabilities')
              return {
                ok: true,
                capabilities: {
                  protocolVersion: 13,
                  commands: [
                    'apply-configuration-group',
                    'apply-site-preview-transaction',
                    'apply-remote-preview-transaction',
                    'remove-preview-transaction',
                  ],
                },
              }
            return { ok: true }
          },
        },
        windows: { getCurrent: async () => ({ id: 10 }) },
        tabs: {
          query: async () => [{ ...currentTab }],
          onUpdated: tabEvent('updated'),
          onActivated: tabEvent('activated'),
          create: async () => {},
          update: async () => {},
        },
        storage: {
          local: {
            get: async () => storage,
            set: async (v) => Object.assign(storage, v),
            remove: async () => {},
          },
          onChanged: event,
        },
        permissions: { contains: async () => true, request: async () => true },
      }
    },
    { origin, manifest }
  )
  const popup = await popupContext.newPage()
  popup.on('pageerror', (error) => uiErrors.push(`Popup: ${error.message}`))
  await popup.goto(`${origin}/_extension/popup.html`)
  await popup.locator('#module-list .module-row').first().waitFor()
  assert.equal(await popup.locator('.project-version-toolbar #environment-select').count(), 1)
  assert.equal(
    await popup.locator('#workspace-toolbar').evaluate((el) => {
      const main = el.querySelector('#workspace-tabs').getBoundingClientRect()
      const sub = el.querySelector('#project-version-tabs').getBoundingClientRect()
      return main.right < sub.left && Math.abs(main.top + main.bottom - sub.top - sub.bottom) < 2
    }),
    true,
    'Popup primary and secondary tabs share one row at 1.2x'
  )
  await assertAlignedSwitches(popup, '#workspace-tabs', '#project-version-tabs', [
    '#environment-select',
    '#site-context-select',
  ])
  assert.equal(await popup.locator('#site-context-select').inputValue(), binding.id)
  assert.deepEqual(
    await popup
      .locator('#environment-select option')
      .evaluateAll((options) => options.map((option) => option.value)),
    environments.map((e) => e.slug)
  )
  assert.equal(await popup.locator('#environment-select').inputValue(), 'tttt')
  assert.equal(
    await popup.locator('#site-context-select').isDisabled(),
    true,
    'The current endpoint remains determined by the active tab'
  )
  assert.equal(
    await popup.locator('.project-version-toolbar').evaluate((el) => {
      const tabs = el.querySelector('#project-version-tabs').getBoundingClientRect()
      const env = el.querySelector('#environment-select').getBoundingClientRect()
      const site = el.querySelector('#site-context-select').getBoundingClientRect()
      return (
        env.left > tabs.right &&
        site.left > env.right &&
        Math.abs(env.top - site.top) < 1 &&
        site.right <= innerWidth
      )
    }),
    true,
    'Popup environment and endpoint must fit alongside the tabs at 1.2x zoom'
  )
  assert.deepEqual(
    await popup.evaluate(() => ({
      zoom: getComputedStyle(document.body).zoom,
      width: document.body.getBoundingClientRect().width,
      height: document.querySelector('.popup-shell').getBoundingClientRect().height,
      chromeSelection: getComputedStyle(document.querySelector('#status-bar')).userSelect,
      moduleSelection: getComputedStyle(document.querySelector('.module-meta')).userSelect,
    })),
    { zoom: '1.2', width: 672, height: 600, chromeSelection: 'none', moduleSelection: 'none' }
  )
  assert.equal(await popup.locator('button:not(.cake-button)').count(), 0)
  assert.deepEqual(
    await popup.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    { width: 672, height: 600 },
    'The extension is 1.2x wider while staying within the 600px popup height limit'
  )
  assert.ok(
    Math.abs(
      (await popup
        .locator('#module-list .module-row')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).gridTemplateColumns))) - 166
    ) < 0.1,
    'The compact module name, branch and build row must remain intact'
  )
  await capture(popup, path.join(output, 'extension-projects.png'))
  const discoverRow = popup
    .locator('.module-row')
    .filter({ has: popup.getByText('discover', { exact: true }) })
  await discoverRow.locator('.branch-picker-trigger').click()
  await popup.getByRole('searchbox').waitFor()
  assert.equal(
    await popup.locator('#branch-picker-dropdown').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }),
    true,
    'The scaled dropdown must remain inside the popup'
  )
  await capture(popup, path.join(output, 'extension-branches.png'))
  await popup.keyboard.press('Escape')
  configurationGroups = Array.from({ length: 13 }, (_, index) => ({
    ...group,
    id: String(index + 1).padStart(32, '0'),
    token: String(index + 1).padStart(32, '0'),
    name:
      index === 1
        ? '这是一个较长的提测需求标题用于检查省略号和环境标签的布局'.repeat(2)
        : `需求 ${index + 1}`,
    items:
      index === 2
        ? [{ targetId: 'discover', mode: 'branch', branch: `feature/${'long-branch-'.repeat(15)}` }]
        : group.items,
    createdAt: date(40 + index),
  }))
  await popup.locator('#requirements-tab').click()
  assert.equal(
    await popup.locator('#environment-select').isVisible(),
    true,
    'Environment stays visible in requirement mode'
  )
  assert.equal(await popup.locator('#site-context-select').isVisible(), true)
  await popup.locator('#requirements-refresh').click()
  await popup.waitForFunction(() => document.querySelectorAll('.requirement-row').length === 13)
  await capture(popup, path.join(reviewOutput, 'extension-requirements.png'))
  const requirementLayout = await popup.locator('#requirements-list').evaluate((list) => {
    const rect = (el) => {
      const { x, y, width, height, bottom, right } = el.getBoundingClientRect()
      return { x, y, width, height, bottom, right }
    }
    return {
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      overflowX: list.scrollWidth > list.clientWidth,
      rows: [...list.children].map((row) => ({
        row: rect(row),
        use: rect(row.querySelector('.requirement-use')),
        title: rect(row.querySelector('.requirement-title-line')),
        badge: rect(row.querySelector('.requirement-environment')),
        branches: rect(row.querySelector('.requirement-branches')),
        meta: rect(row.querySelector('.requirement-meta')),
        actions: rect(row.querySelector('.requirement-actions')),
      })),
    }
  })
  assert.equal(requirementLayout.overflowX, false, 'Requirement titles must not widen the popup')
  assert.ok(
    requirementLayout.scrollHeight > requirementLayout.clientHeight,
    `Long requirement lists must scroll instead of compressing rows: ${JSON.stringify(requirementLayout)}`
  )
  for (const { row, use, title, badge, branches, meta, actions } of requirementLayout.rows) {
    assert.ok(
      Math.abs(title.x - use.x - 12 * 1.2) < 1,
      'Requirement titles must share a scaled 12px left inset'
    )
    assert.ok(
      title.y >= use.y && title.bottom <= use.bottom,
      'Requirement titles must not be clipped'
    )
    assert.ok(badge.right <= use.right, 'Long titles must leave the environment badge visible')
    assert.ok(branches.y >= title.bottom, 'Branch summaries must follow the title without overlap')
    assert.ok(
      meta.y >= branches.bottom && meta.bottom <= use.bottom,
      'Metadata must remain inside its row'
    )
    assert.ok(use.bottom <= row.bottom, 'Rows must contain the full button height')
    assert.ok(
      use.right <= actions.x && actions.right <= row.right,
      'Actions must not overlap the text'
    )
  }
  for (let index = 1; index < requirementLayout.rows.length; index++) {
    const gap = requirementLayout.rows[index].row.y - requirementLayout.rows[index - 1].row.bottom
    assert.ok(gap >= 4 && gap <= 8, 'Requirement rows should have a small, consistent gap')
  }
  await popup.locator('.requirement-row').last().scrollIntoViewIfNeeded()
  assert.equal(
    await popup
      .locator('.requirement-row')
      .last()
      .getByRole('button', { name: /删除/ })
      .isVisible(),
    true
  )
  // The PC injector reuses these styles at a wider viewport; names must not drift
  // back to centered alignment or acquire a fixed row height there either.
  await popup.evaluate(() => document.documentElement.classList.add('pc-plugin'))
  await popup.setViewportSize({ width: 860, height: 700 })
  assert.equal(
    await popup.locator('.requirement-row').evaluateAll((rows) =>
      rows.every((row) => {
        const use = row.querySelector('.requirement-use').getBoundingClientRect()
        const title = row.querySelector('.requirement-title-line').getBoundingClientRect()
        const meta = row.querySelector('.requirement-meta').getBoundingClientRect()
        return (
          Math.abs(title.x - use.x - 12) < 1 &&
          meta.bottom <= use.bottom &&
          use.bottom <= row.getBoundingClientRect().bottom
        )
      })
    ),
    true,
    'PC injector requirement rows must retain the same alignment and intrinsic sizing'
  )
  await popup.locator('.requirement-row').first().scrollIntoViewIfNeeded()
  await capture(popup, path.join(reviewOutput, 'pc-requirements.png'))
  await popup.evaluate(() => document.documentElement.classList.remove('pc-plugin'))
  await popup.setViewportSize({ width: 672, height: 600 })
  configurationGroups = [group]
  await popup.locator('#requirements-refresh').click()
  await popup.waitForFunction(() => document.querySelectorAll('.requirement-row').length === 1)
  const singleRowHeight = await popup
    .locator('.requirement-row')
    .evaluate((row) => row.getBoundingClientRect().height)
  assert.ok(
    singleRowHeight >= 60 && singleRowHeight <= 100,
    'A single requirement should remain compact, not fill the list'
  )
  await popup.locator('#branches-tab').click()
  await popup.locator('#queue-tab').click()
  await popup.waitForFunction(
    () => document.querySelector('#queue-tab').getAttribute('aria-selected') === 'true'
  )
  await popup
    .locator('#queue-list')
    .getByText('feature/discover-filter', { exact: false })
    .first()
    .waitFor()
  await capture(popup, path.join(output, 'extension-queue.png'))
  const readQueueFrame = () =>
    popup.evaluate(() => {
      const bounds = (selector) => {
        const { top, bottom, height } = document.querySelector(selector).getBoundingClientRect()
        return { top, bottom, height }
      }
      return {
        toolbar: bounds('.toolbar'),
        tabs: bounds('.workspace-tabs'),
        subtabs: bounds('.build-task-tabs'),
        panel: bounds('#queue-panel'),
        footer: bounds('#status-bar'),
      }
    })
  await assertAlignedSwitches(popup, '#workspace-tabs', '.build-task-tabs')
  const queueFrame = await readQueueFrame()
  assert.equal(await popup.locator('#project-version-tabs').isVisible(), false)
  assert.equal(await popup.locator('#workspace-toolbar .build-task-tabs').isVisible(), true)
  assert.ok(
    Math.abs(
      queueFrame.tabs.top +
        queueFrame.tabs.bottom -
        queueFrame.subtabs.top -
        queueFrame.subtabs.bottom
    ) < 2,
    'Queue subtabs share the main navigation row'
  )
  await popup
    .locator('#queue-list')
    .getByText('feature/discover-filter', { exact: false })
    .first()
    .click()
  await popup.locator('#job-detail-dialog[open]').waitFor()
  assert.equal(
    await popup.locator('#job-detail-dialog').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }),
    true,
    'Scaled job dialogs must fit inside the popup'
  )
  await popup.getByText('执行时间线', { exact: true }).waitFor()
  await capture(popup, path.join(output, 'extension-job.png'))
  assert.equal(await popup.locator('#job-detail-cancel').isVisible(), true)
  assert.equal(await popup.locator('#job-detail-retry').isVisible(), false)
  await popup.locator('#job-log-tab').click()
  await popup.locator('.job-console').waitFor()
  assert.deepEqual(
    await popup.locator('.job-console').evaluate((el) => {
      const style = getComputedStyle(el)
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.userSelect,
        style.backgroundColor,
        style.color,
      ]
    }),
    ['0px', '0px', 'text', 'rgb(255, 255, 255)', 'rgb(17, 17, 17)'],
    'Log text must stay copyable and have square top corners'
  )
  await capture(popup, path.join(reviewOutput, 'extension-log.png'))
  await popup.keyboard.press('Escape')
  historyDelay = 350
  await popup.locator('#build-history-tab').click()
  await popup.locator('#build-history-list[aria-busy="true"]').waitFor()
  assert.deepEqual(await readQueueFrame(), queueFrame, 'Loading history must keep the frame fixed')
  await popup
    .locator('#build-history-list')
    .getByText('feature/party-page', { exact: false })
    .click()
  await popup.locator('#job-detail-retry').waitFor()
  assert.equal(await popup.locator('#job-detail-cancel').isVisible(), false)
  await capture(popup, path.join(reviewOutput, 'extension-failed-job.png'))
  await popup.keyboard.press('Escape')
  assert.deepEqual(
    await readQueueFrame(),
    queueFrame,
    'Queue/history tabs must not resize the surrounding frame'
  )
  assert.equal(await popup.locator('#build-history-previous').isDisabled(), true)
  assert.equal(await popup.locator('#build-history-next').isDisabled(), true)
  await capture(popup, path.join(reviewOutput, 'extension-history.png'))
  assert.equal(
    await popup
      .locator('#build-history-list .queue-item')
      .evaluateAll((items) =>
        items.every(
          (el) =>
            getComputedStyle(el).borderLeftWidth === '0px' &&
            getComputedStyle(el).boxShadow === 'none'
        )
      ),
    true,
    'History cards must not use a colored left border or inset shadow'
  )
  const paginationBounds = () =>
    popup.locator('.build-history-pagination').evaluate((el) => {
      const { top, bottom, height } = el.getBoundingClientRect()
      return { top, bottom, height }
    })
  const fixedPagination = await paginationBounds()
  for (const items of [
    [],
    Array.from({ length: 25 }, (_, index) => ({ ...failed, id: `history-${index}` })),
  ]) {
    historyItems = items
    await popup.locator('#build-history-refresh').click()
    await popup.locator('#build-history-list[aria-busy="true"]').waitFor()
    assert.deepEqual(await readQueueFrame(), queueFrame)
    assert.deepEqual(await paginationBounds(), fixedPagination)
    await popup.locator('#build-history-list[aria-busy="false"]').waitFor()
    assert.deepEqual(await readQueueFrame(), queueFrame)
    assert.deepEqual(await paginationBounds(), fixedPagination)
  }
  assert.equal(
    await popup.locator('#build-history-list').evaluate((el) => el.scrollHeight > el.clientHeight),
    true
  )
  await popup.locator('#build-history-next').click()
  await popup.waitForFunction(
    () => document.querySelectorAll('#build-history-list .queue-item').length === 5
  )
  assert.deepEqual(await readQueueFrame(), queueFrame, 'Short final pages must keep the same frame')
  assert.deepEqual(await paginationBounds(), fixedPagination)
  await popup.locator('#build-queue-tab').click()
  queue = { ...queue, running: [], queued: [] }
  await popup.locator('#queue-list .queue-empty').waitFor()
  assert.deepEqual(await readQueueFrame(), queueFrame, 'An empty queue must keep the same frame')
  queue = {
    ...queue,
    running: [running],
    queued: Array.from({ length: 20 }, (_, index) => ({ ...queued, id: `queued-${index}` })),
  }
  await popup.waitForFunction(
    () => document.querySelectorAll('#queue-list .queue-item').length === 21
  )
  assert.deepEqual(
    await readQueueFrame(),
    queueFrame,
    'A long queue must scroll without moving the frame'
  )
  assert.equal(
    await popup.locator('#queue-list').evaluate((el) => el.scrollHeight > el.clientHeight),
    true
  )
  await popup.evaluate(() => document.documentElement.classList.add('pc-plugin'))
  await popup.setViewportSize({ width: 860, height: 700 })
  const pcQueueFrame = await readQueueFrame()
  await popup.locator('#build-history-tab').click()
  await popup.locator('#build-history-list[aria-busy="false"]').waitFor()
  assert.deepEqual(
    await readQueueFrame(),
    pcQueueFrame,
    'PC queue/history tabs must also keep a fixed frame'
  )
  assert.equal(
    await popup.evaluate(() => getComputedStyle(document.body).zoom),
    '1',
    'PC remains unscaled'
  )
  await popup.evaluate(() => document.documentElement.classList.remove('pc-plugin'))
  await popup.setViewportSize({ width: 672, height: 600 })
  historyItems = history
  historyDelay = 0
  queue = { ...queue, running: [running], queued: [queued] }
  await popup.locator('#projects-tab').click()
  await popup.locator('#share-button').click()
  await popup.locator('#share-name').fill('发现页筛选优化')
  assert.equal(
    await popup.locator('#share-name').evaluate((el) => getComputedStyle(el).userSelect),
    'text'
  )
  assert.equal(
    await popup.locator('#share-dialog').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }),
    true,
    'Scaled share dialogs must fit inside the popup'
  )
  await popup.locator('#share-url-prefix').fill('发现页优化')
  await capture(popup, path.join(output, 'extension-share.png'))
  await popup.locator('#share-cancel').click()
  await discoverRow.locator('.branch-picker-trigger').click()
  await popup.getByRole('searchbox').fill('layout')
  await popup
    .locator('#branch-picker-list')
    .getByRole('option')
    .filter({ hasText: 'feature/layout-draft' })
    .click()
  assert.equal(await popup.locator('#apply-button').isDisabled(), true)
  assert.match(await discoverRow.locator('.branch-picker-trigger').innerText(), /上次打包失败/)
  await popup.reload()
  await popup.locator('#module-list .module-row').first().waitFor()
  // The fixture deliberately resets extension storage on reload; real persistence has
  // dedicated popup-state tests. Here we check that the UI can initialize a second time.
  assert.equal(await popup.locator('button:not(.cake-button)').count(), 0)
  assert.deepEqual(uiErrors, [], 'UI must not throw while switching views and dialogs')

  // Exercise the actual sidepanel entry and window/tab events, with isolated draft stores.
  const panel = await popupContext.newPage()
  panel.on('pageerror', (error) => uiErrors.push(`Side panel: ${error.message}`))
  await panel.setViewportSize({ width: 400, height: 850 })
  await panel.goto(`${origin}/_extension/sidepanel.html`)
  await panel.locator('#module-list .module-row').first().waitFor()
  const panelDiscover = panel
    .locator('.module-row')
    .filter({ has: panel.getByText('discover', { exact: true }) })
  await panelDiscover.locator('.branch-picker-trigger').click()
  await panel.getByRole('searchbox').fill('layout')
  await panel
    .locator('#branch-picker-list')
    .getByRole('option')
    .filter({ hasText: 'feature/layout-draft' })
    .click()
  await panel.evaluate(() => window.testTabs.activate(2, 11))
  assert.match(
    await panelDiscover.innerText(),
    /feature\/layout-draft/,
    'Other windows must not retarget the panel'
  )
  await panel.evaluate(() => window.testTabs.activate(2))
  await panel.waitForFunction(() => !document.querySelector('#projects-panel').inert)
  assert.doesNotMatch(
    await panelDiscover.innerText(),
    /feature\/layout-draft/,
    'A new tab must not inherit the previous tab draft'
  )
  await panel.evaluate(() => window.testTabs.activate(1))
  await panel.waitForFunction(() => !document.querySelector('#projects-panel').inert)
  assert.match(
    await panelDiscover.innerText(),
    /feature\/layout-draft/,
    'Switching back restores the per-tab draft'
  )
  await panel.evaluate(() => {
    window.testTabs.activate(2)
    window.testTabs.activate(1)
    window.testTabs.activate(3)
  })
  await panel.waitForFunction(() => !document.querySelector('#projects-panel').inert)
  assert.doesNotMatch(
    await panelDiscover.innerText(),
    /feature\/layout-draft/,
    'Rapid tab changes must not leak a stale draft'
  )

  for (const width of [320, 400, 560, 720]) {
    await panel.setViewportSize({ width, height: 850 })
    await panel.locator('#projects-tab').click()
    await panel.locator('#branches-tab').click()
    await assertPanelFits(panel)
    await capture(panel, path.join(reviewOutput, `sidepanel-${width}-branches.png`))
    await panelDiscover.locator('.branch-picker-trigger').click()
    await assertPanelFits(panel, '#branch-picker-dropdown')
    await panel.keyboard.press('Escape')
    await panel.locator('#share-button').click()
    await assertPanelFits(panel, '#share-dialog')
    await panel.locator('#share-cancel').click()
    await panel.locator('#requirements-tab').click()
    await assertPanelFits(panel)
    await panel.locator('#queue-tab').click()
    await panel.locator('#build-queue-tab').click()
    await assertPanelFits(panel)
    await panel.locator('.queue-job-open').first().click()
    await panel.locator('#job-detail-content .job-summary-card').waitFor()
    await assertPanelFits(panel, '#job-detail-dialog')
    await capture(panel, path.join(reviewOutput, `sidepanel-${width}-job.png`))
    await panel.locator('#job-detail-close').click()
    await panel.locator('#build-history-tab').click()
    await panel.locator('#build-history-list[aria-busy="false"]').waitFor()
    await assertPanelFits(panel)
    await capture(panel, path.join(reviewOutput, `sidepanel-${width}-history.png`))
  }
  await panel.locator('#projects-tab').click()
  await panel.locator('#share-button').click()
  await panel.evaluate(() => window.testTabs.activate(1))
  await panel.waitForFunction(() => !document.querySelector('#projects-panel').inert)
  assert.equal(
    await panel.locator('#share-dialog').isVisible(),
    false,
    'Target switches close stale share forms'
  )
  await panel.evaluate(() => window.testTabs.navigate('https://example.com/'))
  await panel.waitForFunction(() => !document.querySelector('#projects-panel').inert)
  assert.equal(
    await panel.locator('#module-list .module-row').count(),
    0,
    'Unbound pages clear old project controls'
  )
  assert.deepEqual(uiErrors, [], 'Side panel events must not throw')

  // Load the real PC host entry and adapter, including their message handshake.
  const pc = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  pc.on('pageerror', (error) => uiErrors.push(`PC: ${error.message}`))
  await pc.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  )
  await pc.goto(origin)
  await pc.setContent(
    '<button id="business-button" onclick="this.textContent=\'仍可操作 KOOK\'">模拟 KOOK 页面</button>'
  )
  await pc.evaluate(() => {
    window.module = { exports: {} }
    window.Kaiheila = { config: { appServer: 'https://tttt-www.dev.chuanyuapp.com' } }
  })
  await pc.addScriptTag({
    content: await fs.readFile(path.join(root, 'apps/console/pc-plugin/bifrost.js'), 'utf8'),
  })
  await pc.evaluate((origin) => {
    const plugin = window.module.exports
    plugin.controlOrigin = origin
    plugin.onActivate({})
    plugin.onExecute({})
  }, origin)
  const pcFrame = pc.frameLocator('#bifrost-pc-frame')
  await pcFrame.locator('#module-list .module-row').first().waitFor()
  assert.equal(
    await pcFrame.locator('.module-row').count(),
    binding.remoteTargetIds.length,
    'PC hides the page build target'
  )
  assert.equal(await pcFrame.locator('#extension-version').innerText(), `v${manifest.version}`)
  await pc.locator('#business-button').click()
  assert.equal(await pc.locator('#business-button').innerText(), '仍可操作 KOOK')
  await pc.locator('#bifrost-pc-resize').focus()
  await pc.keyboard.press('Home')
  assert.equal(
    await pc.locator('#bifrost-pc-panel').evaluate((el) => el.getBoundingClientRect().width),
    320
  )
  await capture(pc, path.join(reviewOutput, 'pc-sidepanel-narrow.png'))
  await pc.locator('#bifrost-pc-resize').focus()
  await pc.keyboard.press('End')
  await pcFrame.locator('#queue-tab').click()
  await pcFrame.locator('.queue-job-open').first().click()
  await pcFrame.locator('#job-detail-content .job-summary-card').waitFor()
  await capture(pc, path.join(reviewOutput, 'pc-sidepanel-job.png'))
  await pc.locator('#bifrost-pc-close').click()
  await pc.evaluate(() => window.module.exports.onExecute({}))
  await pcFrame.locator('#module-list .module-row').first().waitFor()
  assert.equal(
    await pc.locator('#bifrost-pc-panel').evaluate((el) => el.getBoundingClientRect().width),
    860,
    'PC remembers the chosen width'
  )
  await pc.evaluate(() => window.module.exports.onDeactivate())
  assert.equal(await pc.locator('#bifrost-pc-panel').count(), 0)
  assert.deepEqual(uiErrors, [], 'PC adapter and host entry must initialize without errors')
  console.log(`Saved documentation screenshots to ${output}`)
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

async function assertPanelFits(page, selector) {
  const overflow = await page.evaluate((selector) => {
    const candidates = selector
      ? [document.querySelector(selector)]
      : [
          document.documentElement,
          document.querySelector('.popup-shell'),
          ...document.querySelectorAll(
            '.module-row, .build-history-filters, .build-history-pagination, .requirement-row, .queue-item'
          ),
        ]
    return candidates
      .filter((el) => el && el.getBoundingClientRect().height > 0)
      .flatMap((el) => {
        const r = el.getBoundingClientRect()
        return r.left < -1 ||
          r.right > innerWidth + 1 ||
          el.scrollWidth > el.clientWidth + 1 ||
          (selector && (r.top < -1 || r.bottom > innerHeight + 1))
          ? [
              {
                className: el.className,
                left: r.left,
                right: r.right,
                scroll: el.scrollWidth,
                client: el.clientWidth,
              },
            ]
          : []
      })
  }, selector)
  assert.deepEqual(overflow, [], `Panel must fit at ${page.viewportSize().width}px`)
}

async function assertAlignedSwitches(page, mainSelector, subSelector, controlSelectors = []) {
  const metrics = await page.evaluate(
    ({ mainSelector, subSelector, controlSelectors }) => {
      const measure = (selector) => {
        const el = document.querySelector(selector)
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          top: r.top,
          bottom: r.bottom,
          height: r.height,
          background: style.backgroundColor,
          radius: style.borderRadius,
        }
      }
      return {
        main: measure(mainSelector),
        sub: measure(subSelector),
        buttons: [measure(mainSelector + ' button'), measure(subSelector + ' button')],
        controls: controlSelectors.map(measure),
      }
    },
    { mainSelector, subSelector, controlSelectors }
  )
  assert.ok(Math.abs(metrics.main.top - metrics.sub.top) < 1, 'Switch top edges align')
  assert.ok(Math.abs(metrics.main.bottom - metrics.sub.bottom) < 1, 'Switch bottom edges align')
  assert.equal(
    metrics.main.background,
    metrics.sub.background,
    'Both levels use the same switch surface'
  )
  assert.equal(metrics.main.radius, metrics.sub.radius, 'Both levels use the same switch radius')
  assert.ok(
    Math.abs(metrics.buttons[0].top - metrics.buttons[1].top) < 1,
    'Actual buttons align, not just nav wrappers'
  )
  assert.ok(
    Math.abs(metrics.buttons[0].bottom - metrics.buttons[1].bottom) < 1,
    'Actual button bottom edges align'
  )
  for (const control of metrics.controls) {
    assert.ok(Math.abs(metrics.main.top - control.top) < 1, 'Context control top edge aligns')
    assert.ok(
      Math.abs(metrics.main.bottom - control.bottom) < 1,
      'Context control bottom edge aligns'
    )
  }
}
