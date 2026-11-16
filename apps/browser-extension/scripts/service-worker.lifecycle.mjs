import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(path.join(root, 'service-worker.js'), 'utf8')
const activeKey = 'cuddly.activePreviews'
const controlKey = 'cuddly.controlOrigin'
const popupStateKey = 'cuddly.popupStateByTabBindingEnvironment.v2'
const tabEnvironmentKey = 'cuddly.environmentByTab.v1'
const alarmPrefix = 'cuddly.previewExpiry.'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createHarness({
  active = {},
  rules = [],
  tabs = [],
  popupState = undefined,
  localPopupState = undefined,
  tabEnvironmentPreferences = undefined,
  controlOrigin = undefined,
  fetchHandler = undefined,
  authSession = {
    authenticated: true,
    identity: { name: 'QA Alice', avatarUrl: '' },
    csrfToken: 'csrf-token',
  },
  sessionUnavailable = false,
  alarmCreateFailures = 0,
  tabReloadFailures = 0,
  tabUpdateFailures = 0,
  inPlaceUrlRules = [],
  originPermissionGranted = true,
  registeredContentScripts = [],
  pageIdentityHotModuleBody = undefined,
  pageIdentityAuthorization = 'raw-local-authorization',
  pageIdentityApp = '1.2.3',
} = {}) {
  const storage = {
    [activeKey]: clone(active),
    ...(controlOrigin === undefined ? {} : { [controlKey]: controlOrigin }),
    ...(localPopupState === undefined ? {} : { [popupStateKey]: clone(localPopupState) }),
    ...(tabEnvironmentPreferences === undefined
      ? {}
      : { [tabEnvironmentKey]: clone(tabEnvironmentPreferences) }),
  }
  const sessionStorage = {
    ...(popupState === undefined ? {} : { [popupStateKey]: clone(popupState) }),
  }
  const sessionRules = clone(rules)
  const contentScripts = clone(registeredContentScripts)
  const tabState = clone(tabs)
  const tabUpdates = []
  const fetchRequests = []
  const runtimeRequests = []
  const sessionRequests = []
  const operationLog = []
  const pageSessionStorage = {}
  const alarms = new Map()
  const listeners = {}
  const event = (name) => ({ addListener: (listener) => (listeners[name] = listener) })
  const updatedEvent = {
    addListener: (listener) => {
      listeners.updated = (tabId, changeInfo, tab) => {
        const current = tabState.find((candidate) => candidate.id === tabId)
        if (current && changeInfo?.url) Object.assign(current, clone(tab), { url: changeInfo.url })
        return listener(tabId, changeInfo, tab)
      }
    },
  }
  const chrome = {
    sidePanel: {
      setPanelBehavior: async (options) =>
        operationLog.push({ type: 'side-panel-behavior', ...options }),
    },
    alarms: {
      create: async (name, info) => {
        if (alarmCreateFailures > 0) {
          alarmCreateFailures -= 1
          throw new Error('Alarm create failed')
        }
        alarms.set(name, clone(info))
      },
      clear: async (name) => alarms.delete(name),
      getAll: async () => [...alarms].map(([name, info]) => ({ name, ...clone(info) })),
      onAlarm: event('alarm'),
    },
    declarativeNetRequest: {
      getSessionRules: async () => clone(sessionRules),
      testMatchOutcome: async ({ url, tabId }) => ({
        matchedRules: sessionRules.flatMap((rule) => {
          const filter = rule.condition?.urlFilter
          const tabMatches = !rule.condition?.tabIds || rule.condition.tabIds.includes(tabId)
          const typeMatches =
            !rule.condition?.resourceTypes || rule.condition.resourceTypes.includes('main_frame')
          const urlMatches =
            typeof filter === 'string' && filter.startsWith('|')
              ? url.startsWith(filter.slice(1))
              : false
          return tabMatches && typeMatches && urlMatches
            ? [{ ruleId: rule.id, rulesetId: '_session' }]
            : []
        }),
      }),
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        for (const ruleId of removeRuleIds) {
          const index = sessionRules.findIndex((rule) => rule.id === ruleId)
          if (index >= 0) sessionRules.splice(index, 1)
        }
        sessionRules.push(...clone(addRules))
      },
    },
    runtime: {
      getManifest: () => ({
        content_scripts: [
          { matches: ['https://www.kookapp.cn/*'] },
          { matches: ['https://tttt-www.dev.chuanyuapp.com/*'] },
        ],
      }),
      onInstalled: event('installed'),
      onMessage: event('message'),
      onStartup: event('startup'),
    },
    permissions: {
      contains: async () => originPermissionGranted,
    },
    scripting: {
      executeScript: async (details) => {
        if (details.args?.[0] === '__BIFROST_LOCALHOST_REMOTE_HANDOFF_V1__') {
          const [, expectedOrigin, handoff] = details.args
          const tabId = details.target?.tabId
          const tab = tabState.find((candidate) => candidate.id === tabId)
          let matches = false
          try {
            const tabUrl = new URL(tab?.url || '')
            matches = tabUrl.hostname === 'localhost' && tabUrl.origin === expectedOrigin
          } catch {
            matches = false
          }
          if (matches) {
            if (handoff) pageSessionStorage[tabId] = clone(handoff)
            else delete pageSessionStorage[tabId]
          }
          operationLog.push({
            type: 'page-session-storage-write',
            tabId,
            expectedOrigin,
            handoff: clone(handoff),
            matches,
          })
          return [{ result: matches }]
        }
        if (details.args?.[0] === 'authorization') {
          operationLog.push({
            type: 'read-page-authorization',
            tabId: details.target?.tabId,
            world: details.world,
          })
          return [{ result: pageIdentityAuthorization }]
        }
        operationLog.push({
          type: 'execute-script',
          target: clone(details.target),
          world: details.world,
        })
        if (!details.args) {
          return [{ result: { authorization: pageIdentityAuthorization, app: pageIdentityApp } }]
        }
        return [
          {
            result: {
              ok: pageIdentityHotModuleBody !== undefined,
              status: pageIdentityHotModuleBody === undefined ? 401 : 200,
              body: clone(pageIdentityHotModuleBody),
            },
          },
        ]
      },
      getRegisteredContentScripts: async ({ ids } = {}) =>
        clone(
          ids?.length ? contentScripts.filter((script) => ids.includes(script.id)) : contentScripts
        ),
      registerContentScripts: async (scripts) => {
        for (const script of scripts) {
          if (contentScripts.some((candidate) => candidate.id === script.id)) {
            throw new Error(`Duplicate script id ${script.id}`)
          }
          contentScripts.push(clone(script))
        }
        operationLog.push({ type: 'register-content-scripts', scripts: clone(scripts) })
      },
      updateContentScripts: async (scripts) => {
        for (const script of scripts) {
          const index = contentScripts.findIndex((candidate) => candidate.id === script.id)
          if (index < 0) throw new Error(`Unknown script id ${script.id}`)
          contentScripts[index] = clone(script)
        }
        operationLog.push({ type: 'update-content-scripts', scripts: clone(scripts) })
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) {
          const index = contentScripts.findIndex((script) => script.id === id)
          if (index >= 0) contentScripts.splice(index, 1)
        }
        operationLog.push({ type: 'unregister-content-scripts', ids: clone(ids) })
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: clone(storage[key]) }),
        set: async (values) => Object.assign(storage, clone(values)),
      },
      session: {
        get: async (key) => {
          if (sessionUnavailable) throw new Error('Session storage unavailable')
          return { [key]: clone(sessionStorage[key]) }
        },
        set: async (values) => {
          if (sessionUnavailable) throw new Error('Session storage unavailable')
          Object.assign(sessionStorage, clone(values))
          operationLog.push({ type: 'session-storage-set', values: clone(values) })
        },
      },
    },
    tabs: {
      onRemoved: event('removed'),
      onUpdated: updatedEvent,
      get: async (tabId) => {
        const tab = tabState.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('No tab with id')
        return clone(tab)
      },
      query: async () => clone(tabState),
      create: async (createProperties) => {
        const id = Math.max(0, ...tabState.map((tab) => tab.id || 0)) + 1
        const tab = { id, status: 'complete', ...clone(createProperties) }
        tabState.push(tab)
        operationLog.push({
          type: 'tab-create',
          createProperties: clone(createProperties),
          tabId: id,
        })
        return clone(tab)
      },
      remove: async (tabId) => {
        const index = tabState.findIndex((tab) => tab.id === tabId)
        if (index >= 0) tabState.splice(index, 1)
        operationLog.push({ type: 'tab-remove', tabId })
      },
      reload: async (tabId) => {
        if (tabReloadFailures > 0) {
          tabReloadFailures -= 1
          throw new Error('Tab reload failed')
        }
        const tab = tabState.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('No tab with id')
        tabUpdates.push({ tabId, reload: true })
        operationLog.push({ type: 'tab-reload', tabId })
      },
      update: async (tabId, update) => {
        if (tabUpdateFailures > 0) {
          tabUpdateFailures -= 1
          throw new Error('Tab update failed')
        }
        const tab = tabState.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('No tab with id')
        Object.assign(tab, clone(update))
        tabUpdates.push({ tabId, ...clone(update) })
        operationLog.push({ type: 'tab-update', tabId, update: clone(update) })
        return clone(tab)
      },
    },
  }
  const fetch = async (url, init) => {
    const request = { url: String(url), init: clone(init) }
    if (request.url.endsWith('/api/v1/auth/session')) {
      sessionRequests.push(request)
      operationLog.push({ type: 'session-fetch', ...request })
      return {
        ok: Boolean(authSession),
        status: authSession ? 200 : 401,
        json: async () => clone(authSession),
      }
    }
    if (request.url.endsWith('/api/v1/runtime')) {
      runtimeRequests.push(request)
      operationLog.push({ type: 'runtime-fetch', ...request })
      return {
        ok: true,
        status: 200,
        json: async () => ({ inPlaceUrlRules: clone(inPlaceUrlRules) }),
      }
    }
    fetchRequests.push(request)
    operationLog.push({ type: 'fetch', ...request })
    if (fetchHandler) return fetchHandler(String(url), init)
    return { ok: true, status: 204, json: async () => null }
  }
  const context = vm.createContext({
    chrome,
    Date,
    Promise,
    URL,
    AbortController,
    clearTimeout,
    encodeURIComponent,
    fetch,
    setTimeout,
  })
  new vm.Script(source, { filename: 'service-worker.js' }).runInContext(context)
  return {
    alarms,
    contentScripts,
    fetchRequests,
    sessionRules,
    listeners,
    operationLog,
    pageSessionStorage,
    runtimeRequests,
    sessionRequests,
    sessionStorage,
    storage,
    tabUpdates,
    flush: () => vm.runInContext('mutationQueue', context),
  }
}

async function sendMessage(harness, message, sender = {}) {
  return new Promise((resolve) => {
    assert.equal(harness.listeners.message(message, sender, resolve), true)
  })
}

test('toolbar action opens the side panel after installation and browser startup', async () => {
  const harness = createHarness()
  harness.listeners.installed()
  await harness.flush()
  harness.listeners.startup()
  await harness.flush()
  assert.deepEqual(
    harness.operationLog.filter((entry) => entry.type === 'side-panel-behavior'),
    [
      { type: 'side-panel-behavior', openPanelOnActionClick: true },
      { type: 'side-panel-behavior', openPanelOnActionClick: true },
    ]
  )
})

const shareToken = 'AbcdEFGHijklMNOPqrstUVWXyz01_-23'
const shareUrl = `https://bifrost.vanillacake.cn/s/${shareToken}`

function configurationGroupResponse({
  mode = 'preview',
  previewOrigin = 'https://main.bifrost.vanillacake.cn',
  previewToken = 'configuration-group-preview',
  revision = 1,
  siteBranch = '',
  siteArtifactId = '',
} = {}) {
  return {
    mode,
    configurationGroup: {
      token: shareToken,
      name: '消息列表提测',
      revision,
      environmentSlug: 'shared',
      items: [
        siteBranch
          ? { targetId: 'webapp', mode: 'branch', branch: siteBranch }
          : { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/message-list' },
      ],
      siteBinding: {
        id: 'main-online',
        hostname: 'main.bifrost.vanillacake.cn',
        targetId: 'webapp',
        officialOrigin: 'https://www.kookapp.cn',
        environmentSlug: 'shared',
      },
    },
    ...(mode === 'preview'
      ? {
          previewOrigin,
          preview: {
            token: previewToken,
            siteBindingId: 'main-online',
            environmentSlug: 'shared',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ...(siteArtifactId ? { siteArtifactId } : {}),
            selections: [
              {
                moduleKey: 'base',
                targetId: 'base',
                artifactId: '00000000-0000-4000-8000-000000000031',
                branch: 'feature/message-list',
                builtAt: '2026-08-26T08:00:00.000Z',
                providerName: 'cuddly_base_requirement',
                version: 'cuddly_base_requirement',
                entryPath: 'remoteEntry.js',
              },
            ],
          },
        }
      : {}),
  }
}

function jsonResponse(body, { ok = true, status = 201 } = {}) {
  return { ok, status, json: async () => clone(body) }
}

function configurationGroupFetchHandler(options = {}) {
  const response = configurationGroupResponse(options)
  return async (url, init = {}) => {
    if (!url.endsWith('/previews')) {
      return jsonResponse(response.configurationGroup, { status: 200 })
    }
    const previewResponse = clone(response)
    const requestBody = init.body ? JSON.parse(init.body) : {}
    if (requestBody.applicationMode === 'remote-only') {
      previewResponse.applicationMode = 'remote-only'
      delete previewResponse.preview.siteArtifactId
    }
    return jsonResponse(previewResponse, { status: 201 })
  }
}

test('claims an exact same-origin share once and persists branches before preview navigation', async () => {
  const harness = createHarness({
    tabs: [{ id: 21, url: shareUrl }],
    fetchHandler: configurationGroupFetchHandler(),
  })

  harness.listeners.updated(21, { url: shareUrl }, { id: 21, url: shareUrl })
  harness.listeners.updated(21, { url: shareUrl }, { id: 21, url: shareUrl })
  await harness.flush()

  assert.equal(harness.fetchRequests.length, 2)
  assert.equal(
    harness.fetchRequests[0].url,
    `https://bifrost.vanillacake.cn/api/v1/config-groups/${shareToken}`
  )
  assert.deepEqual(harness.fetchRequests[0].init, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers: { 'x-cuddly-csrf': 'csrf-token' },
  })
  assert.equal(
    harness.fetchRequests[1].url,
    `https://bifrost.vanillacake.cn/api/v1/config-groups/${shareToken}/previews`
  )
  assert.deepEqual(harness.fetchRequests[1].init, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify({ expectedRevision: 1 }),
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-cuddly-csrf': 'csrf-token' },
  })
  assert.deepEqual(harness.sessionRequests[0].init, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
  })
  assert.deepEqual(
    harness.sessionStorage[popupStateKey]['21:main-online:shared'].selectedBranches,
    {
      webapp: '',
      base: 'feature/message-list',
    }
  )
  assert.deepEqual(harness.storage[tabEnvironmentKey]['21'], {
    officialOrigin: 'https://www.kookapp.cn',
    environmentSlug: 'shared',
    updatedAt: harness.storage[tabEnvironmentKey]['21'].updatedAt,
  })
  assert.deepEqual(harness.tabUpdates, [{ tabId: 21, url: 'https://main.bifrost.vanillacake.cn/' }])
  const active = harness.storage[activeKey]['21']
  assert.equal(active.shareUrl, shareUrl)
  assert.equal(active.configGroupToken, shareToken)
  assert.equal(active.name, '消息列表提测')
  const persistedAt = harness.operationLog.findIndex(
    (entry) =>
      entry.type === 'session-storage-set' && entry.values[popupStateKey]?.['21:main-online:shared']
  )
  const previewRequestedAt = harness.operationLog.findIndex(
    (entry) => entry.type === 'fetch' && entry.url.endsWith('/previews')
  )
  const navigatedAt = harness.operationLog.findIndex((entry) => entry.type === 'tab-update')
  assert.ok(
    persistedAt >= 0 && persistedAt < previewRequestedAt && previewRequestedAt < navigatedAt
  )
})

test('keeps a bodyless preview request compatible with a legacy group response without revision', async () => {
  const response = configurationGroupResponse()
  delete response.configurationGroup.revision
  const harness = createHarness({
    tabs: [{ id: 34, url: shareUrl }],
    fetchHandler: async (url) =>
      jsonResponse(url.endsWith('/previews') ? response : response.configurationGroup, {
        status: url.endsWith('/previews') ? 201 : 200,
      }),
  })

  harness.listeners.updated(34, { url: shareUrl }, { id: 34, url: shareUrl })
  await harness.flush()

  assert.deepEqual(harness.fetchRequests[1].init, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: { 'x-cuddly-csrf': 'csrf-token' },
  })
  assert.equal(harness.storage[activeKey]['34'].preview.token, 'configuration-group-preview')
})

test('does not mutate a shared configuration without an authenticated Feishu session', async () => {
  const harness = createHarness({
    authSession: null,
    tabs: [{ id: 30, url: shareUrl }],
    fetchHandler: async () => {
      throw new Error('mutation must not run')
    },
  })

  harness.listeners.updated(30, { url: shareUrl }, { id: 30, url: shareUrl })
  await harness.flush()

  assert.equal(harness.sessionRequests.length, 1)
  assert.equal(harness.fetchRequests.length, 0)
  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.storage[activeKey]['30'], undefined)
})

test('does not claim shares from another origin or a non-exact token path', async () => {
  for (const url of [
    shareUrl,
    'https://preview-control.example/s/short',
    `https://preview-control.example/s/${shareToken}/`,
  ]) {
    const harness = createHarness({
      controlOrigin: 'https://preview-control.example',
      tabs: [{ id: 22, url }],
      fetchHandler: async () => {
        throw new Error('must not fetch')
      },
    })
    harness.listeners.updated(22, { url }, { id: 22, url })
    await harness.flush()
    assert.equal(harness.fetchRequests.length, 0)
    assert.equal(harness.tabUpdates.length, 0)
  }
})

test('uses the currently configured control origin when claiming a share', async () => {
  const customOrigin = 'https://preview-control.example'
  const customShareUrl = `${customOrigin}/s/${shareToken}`
  const harness = createHarness({
    controlOrigin: customOrigin,
    tabs: [{ id: 29, url: customShareUrl }],
    fetchHandler: configurationGroupFetchHandler(),
  })

  harness.listeners.updated(29, { url: customShareUrl }, { id: 29, url: customShareUrl })
  await harness.flush()

  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    [
      `${customOrigin}/api/v1/config-groups/${shareToken}`,
      `${customOrigin}/api/v1/config-groups/${shareToken}/previews`,
    ]
  )
  assert.equal(harness.storage[activeKey]['29'].controlOrigin, customOrigin)
  assert.equal(harness.storage[activeKey]['29'].shareUrl, customShareUrl)
})

test('keeps a share landing in place when an artifact is unavailable', async () => {
  const harness = createHarness({
    tabs: [{ id: 23, url: shareUrl }],
    fetchHandler: async (url) =>
      url.endsWith('/previews')
        ? jsonResponse(
            {
              code: 'CONFIGURATION_GROUP_ARTIFACT_NOT_READY',
              message: 'base 分支尚无可用产物',
            },
            { ok: false, status: 409 }
          )
        : jsonResponse(configurationGroupResponse().configurationGroup, { status: 200 }),
  })

  harness.listeners.updated(23, { url: shareUrl }, { id: 23, url: shareUrl })
  await harness.flush()

  assert.equal(harness.fetchRequests.length, 2)
  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.storage[activeKey]['23'], undefined)
  assert.equal(
    harness.sessionStorage[popupStateKey]['23:main-online:shared'].selectedBranches.base,
    'feature/message-list'
  )
})

test('applies a Remote-only configuration group in place on its exact official environment', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/31?from=requirement#voice'
  const harness = createHarness({
    tabs: [{ id: 31, url: currentUrl }],
    fetchHandler: configurationGroupFetchHandler({ previewToken: 'direct-requirement-preview' }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 31,
    token: shareToken,
  })

  assert.equal(result.ok, true)
  assert.equal(result.active.preview.token, 'direct-requirement-preview')
  assert.equal(result.active.mode, 'remote')
  assert.deepEqual(harness.tabUpdates, [{ tabId: 31, reload: true }])
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.storage[activeKey]['31'].shareUrl, shareUrl)
  assert.equal(harness.storage[tabEnvironmentKey]['31'].configurationGroupBindingId, undefined)
  assert.equal(
    harness.sessionStorage[popupStateKey]['31:main-online:shared'].selectedBranches.base,
    'feature/message-list'
  )
  assert.equal(
    harness.sessionStorage[popupStateKey]['31:main-online:shared'].siteOverrideEnabled,
    false
  )
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    [
      `https://bifrost.vanillacake.cn/api/v1/config-groups/${shareToken}`,
      `https://bifrost.vanillacake.cn/api/v1/config-groups/${shareToken}/previews`,
    ]
  )
})

test('opens Bifrost only when a configuration group explicitly selects a page branch', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/41?from=requirement'
  const harness = createHarness({
    tabs: [{ id: 41, url: currentUrl }],
    fetchHandler: configurationGroupFetchHandler({
      previewToken: 'site-requirement-preview',
      siteBranch: 'feature/page-shell',
      siteArtifactId: '00000000-0000-4000-8000-000000000041',
    }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 41,
    token: shareToken,
  })

  assert.equal(result.ok, true)
  assert.equal(result.active.mode, 'site')
  assert.deepEqual(harness.tabUpdates, [
    { tabId: 41, url: 'https://main.bifrost.vanillacake.cn/channels/41?from=requirement' },
  ])
  assert.equal(
    harness.sessionStorage[popupStateKey]['41:main-online:shared'].siteOverrideEnabled,
    true
  )
})

test('a matching URL rule asks how to apply a configuration group with a page branch', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/42'
  const harness = createHarness({
    tabs: [{ id: 42, url: currentUrl }],
    inPlaceUrlRules: [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }],
    fetchHandler: configurationGroupFetchHandler({
      previewToken: 'forbidden-site-requirement',
      siteBranch: 'feature/page-shell',
      siteArtifactId: '00000000-0000-4000-8000-000000000042',
    }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 42,
    token: shareToken,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONFIG_GROUP_SITE_OVERRIDE_CONFIRMATION_REQUIRED')
  assert.deepEqual(clone(result.confirmation), {
    currentBranch: '官方原版',
    targetBranch: 'feature/page-shell',
  })
  assert.deepEqual(harness.tabUpdates, [])
  assert.equal(
    harness.fetchRequests.some((request) => request.url.endsWith('/previews')),
    false
  )
  assert.deepEqual(harness.storage[activeKey], {})
})

test('applies only Remote artifacts after confirming that the official page should stay open', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/43?from=requirement'
  const harness = createHarness({
    tabs: [{ id: 43, url: currentUrl }],
    inPlaceUrlRules: [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }],
    fetchHandler: configurationGroupFetchHandler({
      previewToken: 'remote-only-requirement',
      siteBranch: 'feature/page-shell',
      siteArtifactId: '00000000-0000-4000-8000-000000000043',
    }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 43,
    token: shareToken,
    applicationMode: 'remote-only',
    confirmedSiteBranch: 'feature/page-shell',
  })

  assert.equal(result.ok, true, JSON.stringify(clone(result)))
  assert.equal(result.active.mode, 'remote')
  assert.equal(result.active.preview.siteArtifactId, undefined)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 43, reload: true }])
  assert.deepEqual(JSON.parse(harness.fetchRequests[1].init.body), {
    expectedRevision: 1,
    applicationMode: 'remote-only',
  })
})

test('opens Bifrost after confirming that both Remote and page artifacts should be applied', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/44?from=requirement'
  const harness = createHarness({
    tabs: [{ id: 44, url: currentUrl }],
    inPlaceUrlRules: [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }],
    fetchHandler: configurationGroupFetchHandler({
      previewToken: 'complete-requirement',
      siteBranch: 'feature/page-shell',
      siteArtifactId: '00000000-0000-4000-8000-000000000044',
    }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 44,
    token: shareToken,
    applicationMode: 'complete',
    confirmedSiteBranch: 'feature/page-shell',
  })

  assert.equal(result.ok, true)
  assert.equal(result.active.mode, 'site')
  assert.deepEqual(harness.tabUpdates, [
    { tabId: 44, url: 'https://main.bifrost.vanillacake.cn/channels/44?from=requirement' },
  ])
  assert.deepEqual(JSON.parse(harness.fetchRequests[1].init.body), { expectedRevision: 1 })
})

test('returns a persisted-selection marker and keeps the business page when a group is not ready', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/32'
  const harness = createHarness({
    tabs: [{ id: 32, url: currentUrl }],
    fetchHandler: async (url) =>
      url.endsWith('/previews')
        ? jsonResponse(
            {
              code: 'CONFIG_GROUP_ARTIFACTS_NOT_READY',
              message: '配置组中仍有分支没有成功可用的打包产物',
              missing: [
                {
                  targetId: 'base',
                  targetName: '基础模块',
                  branch: 'feature/message-list',
                },
              ],
            },
            { ok: false, status: 409 }
          )
        : jsonResponse(configurationGroupResponse().configurationGroup, { status: 200 }),
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 32,
    token: shareToken,
  })

  assert.deepEqual(clone(result), {
    ok: false,
    message: '缺少可用打包产物：基础模块 · feature/message-list',
    code: 'CONFIG_GROUP_ARTIFACTS_NOT_READY',
    selectionPersisted: true,
  })
  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.storage[activeKey]['32'], undefined)
  assert.equal(
    harness.sessionStorage[popupStateKey]['32:main-online:shared'].selectedBranches.base,
    'feature/message-list'
  )
  assert.equal(harness.storage[tabEnvironmentKey]['32'].environmentSlug, 'shared')
  assert.equal(harness.storage[tabEnvironmentKey]['32'].configurationGroupBindingId, 'main-online')
})

test('refreshes and persists a concurrently edited group before retrying its preview once', async () => {
  const currentUrl = 'https://www.kookapp.cn/channels/33'
  let detailReads = 0
  let previewWrites = 0
  const harness = createHarness({
    tabs: [{ id: 33, url: currentUrl }],
    fetchHandler: async (url) => {
      if (!url.endsWith('/previews')) {
        detailReads += 1
        const detail = configurationGroupResponse({ revision: detailReads }).configurationGroup
        if (detailReads === 2) {
          detail.environmentSlug = 'tttt'
          detail.items = [
            { targetId: 'webapp', mode: 'official' },
            { targetId: 'base', mode: 'branch', branch: 'feature/concurrent-update' },
          ]
        }
        return jsonResponse(detail, { status: 200 })
      }

      previewWrites += 1
      if (previewWrites === 1) {
        return jsonResponse(
          {
            code: 'CONFIG_GROUP_REVISION_CONFLICT',
            message: '配置组已被其他人更新，请刷新后重试',
            currentRevision: 2,
          },
          { ok: false, status: 409 }
        )
      }
      return jsonResponse(
        {
          code: 'CONFIG_GROUP_ARTIFACTS_NOT_READY',
          message: '配置组中仍有分支没有成功可用的打包产物',
          missing: [
            {
              targetId: 'base',
              targetName: '基础模块',
              branch: 'feature/concurrent-update',
            },
          ],
        },
        { ok: false, status: 409 }
      )
    },
  })

  const result = await sendMessage(harness, {
    type: 'apply-configuration-group',
    tabId: 33,
    token: shareToken,
  })

  assert.deepEqual(clone(result), {
    ok: false,
    message: '缺少可用打包产物：基础模块 · feature/concurrent-update',
    code: 'CONFIG_GROUP_ARTIFACTS_NOT_READY',
    selectionPersisted: true,
  })
  assert.equal(detailReads, 2)
  assert.equal(previewWrites, 2)
  assert.deepEqual(
    harness.fetchRequests
      .filter((request) => request.url.endsWith('/previews'))
      .map((request) => JSON.parse(request.init.body)),
    [{ expectedRevision: 1 }, { expectedRevision: 2 }]
  )
  assert.deepEqual(harness.sessionStorage[popupStateKey]['33:main-online:tttt'].selectedBranches, {
    webapp: '',
    base: 'feature/concurrent-update',
  })
  assert.deepEqual(harness.storage[tabEnvironmentKey]['33'], {
    officialOrigin: 'https://www.kookapp.cn',
    environmentSlug: 'tttt',
    configurationGroupBindingId: 'main-online',
    configurationGroupHostname: 'main.bifrost.vanillacake.cn',
    updatedAt: harness.storage[tabEnvironmentKey]['33'].updatedAt,
  })
  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.storage[activeKey]['33'], undefined)
})

test('persists an official configuration and navigates to the bound official origin', async () => {
  const harness = createHarness({
    tabs: [{ id: 24, url: shareUrl }],
    fetchHandler: configurationGroupFetchHandler({ mode: 'official' }),
  })

  harness.listeners.updated(24, { url: shareUrl }, { id: 24, url: shareUrl })
  await harness.flush()

  assert.deepEqual(
    harness.sessionStorage[popupStateKey]['24:main-online:shared'].selectedBranches,
    {
      webapp: '',
      base: 'feature/message-list',
    }
  )
  assert.deepEqual(harness.tabUpdates, [{ tabId: 24, url: 'https://www.kookapp.cn/' }])
  assert.equal(harness.storage[activeKey]['24'], undefined)
  assert.equal(harness.sessionRules.length, 0)
})

test('rejects a preview origin that does not match the configuration site binding', async () => {
  const harness = createHarness({
    tabs: [{ id: 25, url: shareUrl }],
    fetchHandler: configurationGroupFetchHandler({ previewOrigin: 'https://attacker.example' }),
  })

  harness.listeners.updated(25, { url: shareUrl }, { id: 25, url: shareUrl })
  await harness.flush()

  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.storage[activeKey]['25'], undefined)
  assert.equal(
    harness.sessionStorage[popupStateKey]['25:main-online:shared'].selectedBranches.base,
    'feature/message-list'
  )
})

test('scans existing share landing tabs on both browser startup and extension install', async () => {
  for (const eventName of ['startup', 'installed']) {
    const harness = createHarness({
      tabs: [{ id: 26, url: shareUrl }],
      fetchHandler: configurationGroupFetchHandler(),
    })

    harness.listeners[eventName]()
    await harness.flush()

    assert.deepEqual(harness.tabUpdates, [
      { tabId: 26, url: 'https://main.bifrost.vanillacake.cn/' },
    ])
    assert.equal(harness.storage[activeKey]['26'].configGroupToken, shareToken)
  }
})

test('returns an expired shared preview to its share landing instead of the official site', async () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const harness = createHarness({
    active: {
      27: {
        mode: 'site',
        ruleIds: [1027],
        preview: { token: 'expired-shared-preview', expiresAt: past },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        shareUrl,
        configGroupToken: shareToken,
        name: '消息列表提测',
      },
    },
    rules: [{ id: 1027 }],
    tabs: [{ id: 27, url: 'https://main.bifrost.vanillacake.cn/' }],
  })

  harness.listeners.alarm({ name: `${alarmPrefix}27` })
  await harness.flush()

  assert.deepEqual(harness.tabUpdates, [{ tabId: 27, url: shareUrl }])
  assert.equal(harness.storage[activeKey]['27'], undefined)
  assert.equal(harness.sessionRules.length, 0)
})

test('reconciles an expired shared preview through the landing and rebuilds it', async () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const harness = createHarness({
    active: {
      28: {
        mode: 'site',
        ruleIds: [1028],
        preview: { token: 'old-shared-preview', expiresAt: past },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        shareUrl,
        configGroupToken: shareToken,
        name: '消息列表提测',
      },
    },
    rules: [{ id: 1028 }],
    tabs: [{ id: 28, url: 'https://main.bifrost.vanillacake.cn/' }],
    fetchHandler: async (url) => {
      if (!url.includes('/config-groups/')) return jsonResponse(null, { status: 204 })
      return configurationGroupFetchHandler({ previewToken: 'rebuilt-shared-preview' })(url)
    },
  })

  harness.listeners.installed()
  await harness.flush()

  assert.deepEqual(harness.tabUpdates, [
    { tabId: 28, url: shareUrl },
    { tabId: 28, url: 'https://main.bifrost.vanillacake.cn/' },
  ])
  assert.equal(harness.storage[activeKey]['28'].preview.token, 'rebuilt-shared-preview')
  assert.equal(
    harness.fetchRequests.filter((request) => request.url.includes('/config-groups/')).length,
    2
  )
})

test('finishes a session-scoped branch selection write after the popup stops listening', async () => {
  const harness = createHarness({ tabs: [{ id: 7 }] })

  assert.equal(
    harness.listeners.message(
      {
        type: 'write-popup-scoped-state',
        tabId: 7,
        bindingId: 'main',
        environmentSlug: 'online',
        selectedBranches: { base: 'feature/share-config' },
        submittedBuildBranches: { base: 'feature/share-config' },
      },
      {},
      () => undefined
    ),
    true
  )
  await harness.flush()

  assert.equal(
    harness.sessionStorage[popupStateKey]['7:main:online'].selectedBranches.base,
    'feature/share-config'
  )
  assert.equal(harness.storage[popupStateKey], undefined)

  const restored = await sendMessage(harness, {
    type: 'read-popup-scoped-state',
    tabId: 7,
    bindingId: 'main',
    environmentSlug: 'online',
  })
  assert.equal(restored.ok, true)
  assert.equal(restored.state.selectedBranches.base, 'feature/share-config')
})

test('serializes rapid popup writes without losing another tab or binding scope', async () => {
  const harness = createHarness({ tabs: [{ id: 7 }, { id: 8 }] })
  const first = sendMessage(harness, {
    type: 'write-popup-scoped-state',
    tabId: 7,
    bindingId: 'main',
    environmentSlug: 'online',
    selectedBranches: { base: 'feature/a' },
    submittedBuildBranches: {},
  })
  const otherScope = sendMessage(harness, {
    type: 'write-popup-scoped-state',
    tabId: 8,
    bindingId: 'main',
    environmentSlug: 'test',
    selectedBranches: { base: 'develop' },
    submittedBuildBranches: {},
  })
  const latest = sendMessage(harness, {
    type: 'write-popup-scoped-state',
    tabId: 7,
    bindingId: 'main',
    environmentSlug: 'online',
    selectedBranches: { base: 'feature/b' },
    submittedBuildBranches: {},
  })
  await Promise.all([first, otherScope, latest])

  assert.equal(
    harness.sessionStorage[popupStateKey]['7:main:online'].selectedBranches.base,
    'feature/b'
  )
  assert.equal(
    harness.sessionStorage[popupStateKey]['8:main:test'].selectedBranches.base,
    'develop'
  )
})

test('cleans stale local fallback scopes at startup and when a tab closes', async () => {
  const harness = createHarness({
    sessionUnavailable: true,
    tabs: [{ id: 7, url: 'https://www.kookapp.cn' }],
    localPopupState: {
      '7:main:online': { selectedBranches: { base: 'feature/live' }, updatedAt: 2 },
      '8:main:online': { selectedBranches: { base: 'feature/stale' }, updatedAt: 1 },
      malformed: { selectedBranches: { base: 'feature/invalid' }, updatedAt: 3 },
    },
    tabEnvironmentPreferences: {
      7: {
        officialOrigin: 'https://www.kookapp.cn',
        environmentSlug: 'online',
        updatedAt: 2,
      },
      8: {
        officialOrigin: 'https://www.kookapp.cn',
        environmentSlug: 'test',
        updatedAt: 1,
      },
    },
  })

  harness.listeners.startup()
  await harness.flush()
  assert.deepEqual(Object.keys(harness.storage[popupStateKey]), ['7:main:online'])
  assert.deepEqual(Object.keys(harness.storage[tabEnvironmentKey]), ['7'])

  harness.listeners.removed(7)
  await harness.flush()
  assert.deepEqual(harness.storage[popupStateKey], {})
  assert.deepEqual(harness.storage[tabEnvironmentKey], {})
})

test('creates and clears a one-time expiry alarm with a Remote-only site preview', async () => {
  const harness = createHarness({ tabs: [{ id: 7 }] })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const applied = await sendMessage(harness, {
    type: 'apply-site-preview',
    tabId: 7,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://www.kookapp.cn/channels/7',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/7',
    preview: {
      token: 'preview',
      expiresAt,
      selections: [{ moduleKey: 'base', artifactId: 'artifact-base' }],
    },
  })

  assert.equal(applied.ok, true)
  assert.equal(applied.active.mode, 'site')
  assert.equal(harness.sessionRules.length, 1)
  assert.ok(harness.sessionRules.every((rule) => rule.condition.tabIds?.[0] === 7))
  assert.equal(harness.alarms.get(`${alarmPrefix}7`).when, Date.parse(expiresAt))
  assert.equal(harness.storage[activeKey]['7'].preview.token, 'preview')

  const removed = await sendMessage(harness, { type: 'remove-preview', tabId: 7 })
  assert.equal(removed.ok, true)
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.alarms.has(`${alarmPrefix}7`), false)
  assert.equal(harness.storage[activeKey]['7'], undefined)
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    ['https://bifrost.vanillacake.cn/api/v1/previews/preview']
  )
})

test('restores valid alarms and removes expired or closed-tab previews', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const past = new Date(Date.now() - 60_000).toISOString()
  const active = {
    1: {
      mode: 'site',
      ruleIds: [1001],
      preview: { token: 'valid', expiresAt: future },
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      controlOrigin: 'https://bifrost.vanillacake.cn',
      officialOrigin: 'https://www.kookapp.cn',
    },
    2: {
      mode: 'remote',
      ruleIds: [1002, 1003],
      preview: { expiresAt: future },
      webappOrigin: 'https://www.kookapp.cn',
      hotModuleUrl: 'https://bifrost.vanillacake.cn/preview/legacy/hot-module',
    },
    3: {
      mode: 'site',
      ruleIds: [1004],
      preview: { token: 'closed', expiresAt: future },
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      controlOrigin: 'https://bifrost.vanillacake.cn',
    },
    4: {
      mode: 'site',
      ruleIds: [1005],
      preview: { token: 'expired', expiresAt: past },
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      controlOrigin: 'https://bifrost.vanillacake.cn',
      officialOrigin: 'https://www.kookapp.cn',
    },
  }
  const harness = createHarness({
    active,
    rules: [{ id: 1999 }],
    tabs: [
      { id: 1, url: 'https://main.bifrost.vanillacake.cn/channels/1' },
      { id: 2, url: 'https://www.kookapp.cn/channels/2' },
      { id: 4, url: 'https://main.bifrost.vanillacake.cn/channels/4' },
    ],
  })
  harness.alarms.set(`${alarmPrefix}99`, { when: Date.now() + 60_000 })

  harness.listeners.installed({ reason: 'update' })
  await harness.flush()

  assert.deepEqual(Object.keys(harness.storage[activeKey]), ['1'])
  assert.deepEqual(
    harness.sessionRules.map((rule) => rule.id),
    [1001]
  )
  assert.equal(harness.alarms.get(`${alarmPrefix}1`).when, Date.parse(future))
  assert.equal(harness.alarms.has(`${alarmPrefix}99`), false)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 4, url: 'https://www.kookapp.cn/channels/4' }])
  assert.deepEqual(harness.fetchRequests.map((request) => request.url).sort(), [
    'https://bifrost.vanillacake.cn/api/v1/previews/closed',
    'https://bifrost.vanillacake.cn/api/v1/previews/expired',
  ])

  harness.storage[activeKey]['1'].preview.expiresAt = past
  harness.listeners.alarm({ name: `${alarmPrefix}1` })
  await harness.flush()

  assert.equal(harness.storage[activeKey]['1'], undefined)
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.alarms.has(`${alarmPrefix}1`), false)
  assert.deepEqual(harness.tabUpdates.at(-1), {
    tabId: 1,
    url: 'https://www.kookapp.cn/channels/1',
  })
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/valid'
  )
})

test('clears preview state when its tab leaves the preview origin', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      8: {
        mode: 'site',
        ruleIds: [1008],
        preview: { token: 'preview-8', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1008 }],
    tabs: [{ id: 8, url: 'https://main.bifrost.vanillacake.cn/channels/8' }],
  })

  harness.listeners.updated(
    8,
    { url: 'https://www.kookapp.cn/channels/8' },
    { id: 8, url: 'https://www.kookapp.cn/channels/8' }
  )
  await harness.flush()

  assert.equal(harness.storage[activeKey]['8'], undefined)
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.alarms.has(`${alarmPrefix}8`), false)
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/preview-8'
  )
})

test('reports capabilities used to detect a stale service worker', async () => {
  const harness = createHarness()
  const result = await sendMessage(harness, { type: 'get-extension-capabilities' })

  assert.equal(result.ok, true)
  assert.equal(result.capabilities.protocolVersion, 13)
  assert.deepEqual(
    [...result.capabilities.commands],
    [
      'apply-configuration-group',
      'apply-site-preview',
      'remove-preview',
      'apply-site-preview-transaction',
      'apply-remote-preview-transaction',
      'remove-preview-transaction',
    ]
  )
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.storage[activeKey], {})
})

test('rejects the legacy Remote redirect command with an actionable reload instruction', async () => {
  const harness = createHarness()
  const result = await sendMessage(harness, {
    type: 'apply-remote-preview',
    tabId: 9,
    webappOrigin: 'https://www.kookapp.cn',
    hotModuleUrl: 'https://bifrost.vanillacake.cn/preview/hot-module',
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /chrome:\/\/extensions/)
  assert.match(result.message, /重新加载/)
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.storage[activeKey], {})
})

test('applies an in-place Remote preview and exposes only its public overlay fields', async () => {
  const harness = createHarness({
    tabs: [{ id: 9, url: 'https://www.kookapp.cn/channels/9?from=official#voice' }],
  })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 9,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://www.kookapp.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    bindingEnvironmentSlug: 'online',
    originalUrl: 'https://www.kookapp.cn/channels/9?from=official#voice',
    preview: {
      token: 'remote-preview-token',
      environmentSlug: 'online',
      expiresAt,
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: '00000000-0000-4000-8000-000000000009',
          branch: 'feature/remote',
          providerName: 'cuddly_base_remote',
          version: 'cuddly_base_remote',
          entryPath: 'remoteEntry.js',
        },
      ],
    },
  })

  assert.equal(applied.ok, true)
  assert.equal(applied.active.mode, 'remote')
  assert.equal(applied.active.pageOrigin, 'https://www.kookapp.cn')
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 9, reload: true }])
  assert.equal(harness.alarms.get(`${alarmPrefix}9`).when, Date.parse(expiresAt))

  const config = await sendMessage(
    harness,
    { type: 'read-in-place-hot-module-config' },
    {
      frameId: 0,
      tab: { id: 9, url: 'https://www.kookapp.cn/channels/9?from=official#voice' },
    }
  )
  assert.deepEqual(clone(config), {
    ok: true,
    config: [
      {
        moduleKey: 'base',
        name: 'cuddly_base_remote',
        entry:
          'https://main.bifrost.vanillacake.cn/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000009/cuddly_base_remote/remoteEntry.js',
        version: 'cuddly_base_remote',
        restartRequired: true,
      },
    ],
  })
  assert.equal(JSON.stringify(config).includes('remote-preview-token'), false)
})

test('applies a test-environment Remote preview on localhost without changing its origin', async () => {
  const harness = createHarness({
    tabs: [{ id: 109, url: 'http://localhost:5173/channels/109' }],
  })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 109,
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    pageOrigin: 'http://localhost:5173',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
    preview: {
      token: 'localhost-remote-preview',
      environmentSlug: 'tttt',
      expiresAt,
      selections: [
        {
          moduleKey: 'discover',
          targetId: 'discover',
          artifactId: '00000000-0000-4000-8000-000000000109',
          branch: 'feature/local-test',
          providerName: 'discover',
          version: 'discover_local_test',
          entryPath: 'remoteEntry.js',
        },
      ],
    },
  })

  assert.equal(applied.ok, true)
  assert.equal(applied.active.pageOrigin, 'http://localhost:5173')
  assert.deepEqual(harness.tabUpdates, [{ tabId: 109, reload: true }])
  assert.deepEqual(harness.pageSessionStorage[109], {
    origin: 'http://localhost:5173',
    expiresAt: Date.parse(expiresAt),
    modules: [
      {
        moduleKey: 'discover',
        name: 'discover',
        entry:
          'https://main-tttt.bifrost.vanillacake.cn/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000109/discover/remoteEntry.js',
        version: 'discover_local_test',
        restartRequired: true,
      },
    ],
  })
  const handoffWriteIndex = harness.operationLog.findIndex(
    ({ type }) => type === 'page-session-storage-write'
  )
  const reloadIndex = harness.operationLog.findIndex(({ type }) => type === 'tab-reload')
  assert.ok(handoffWriteIndex >= 0 && handoffWriteIndex < reloadIndex)
  const config = await sendMessage(
    harness,
    { type: 'read-in-place-hot-module-config' },
    { frameId: 0, tab: { id: 109, url: 'http://localhost:5173/channels/109' } }
  )
  assert.equal(config.ok, true)
  assert.equal(config.config[0]?.moduleKey, 'discover')
})

test('clears the one-time localhost MF handoff when its apply reload rolls back', async () => {
  const harness = createHarness({
    tabs: [{ id: 113, url: 'http://localhost:5173/channels/113' }],
    tabReloadFailures: 1,
  })

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 113,
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    pageOrigin: 'http://localhost:5173',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
    preview: {
      token: 'localhost-rollback-preview',
      environmentSlug: 'tttt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [
        {
          moduleKey: 'discover',
          artifactId: '00000000-0000-4000-8000-000000000113',
          providerName: 'discover',
          version: 'discover_rollback',
          entryPath: 'remoteEntry.js',
        },
      ],
    },
  })

  assert.equal(applied.ok, false)
  assert.equal(harness.storage[activeKey]['113'], undefined)
  assert.equal(harness.pageSessionStorage[113], undefined)
  assert.deepEqual(
    harness.operationLog
      .filter(({ type }) => type === 'page-session-storage-write')
      .map(({ handoff }) => Boolean(handoff)),
    [true, false]
  )
})

test('resolves one localhost Remote from tttt without changing the other modules', async () => {
  const ttttEntry = 'https://img.chuanyuapp.com/discover_new/discover_v700_test/remoteEntry.js'
  const harness = createHarness({
    tabs: [{ id: 110, url: 'http://localhost:5173/channels/110' }],
    pageIdentityApp: '',
    fetchHandler: async (url) => {
      if (url === 'http://localhost:5173/api/v3/version/hot-module?app=5.6.7') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              modules: {
                discover: {
                  name: 'discover_v700_test',
                  entry: ttttEntry,
                  version: '700',
                },
                base: {
                  name: 'base_v100_test',
                  entry: 'https://img.chuanyuapp.com/base_new/base_v100_test/remoteEntry.js',
                },
              },
            },
          }),
        }
      }
      return { ok: true, status: 204, json: async () => null }
    },
  })

  const remembered = await sendMessage(
    harness,
    { type: 'remember-hot-module-request-context', app: '5.6.7' },
    { frameId: 0, tab: { id: 110, url: 'http://localhost:5173/channels/110' } }
  )
  assert.deepEqual(clone(remembered), { ok: true })

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 110,
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    pageOrigin: 'http://localhost:5173',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
    sourceOverrides: [{ moduleKey: 'discover', source: 'tttt' }],
    preview: {
      token: 'localhost-tttt-source-preview',
      environmentSlug: 'tttt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [],
    },
  })

  assert.equal(applied.ok, true)
  assert.deepEqual(clone(harness.fetchRequests[0].init.headers), {
    accept: 'application/json',
    Authorization: 'raw-local-authorization',
  })
  assert.deepEqual(clone(applied.active.preview.selections), [
    {
      source: 'tttt',
      moduleKey: 'discover',
      targetId: 'discover',
      branch: '走tttt',
      providerName: 'discover_v700_test',
      version: '700',
      entry: ttttEntry,
      restartRequired: true,
    },
  ])
  const config = await sendMessage(
    harness,
    { type: 'read-in-place-hot-module-config' },
    { frameId: 0, tab: { id: 110, url: 'http://localhost:5173/channels/110' } }
  )
  assert.deepEqual(clone(config.config), [
    {
      moduleKey: 'discover',
      name: 'discover_v700_test',
      entry: ttttEntry,
      version: '700',
      restartRequired: true,
    },
  ])
})

test('uses the page host-context version before falling back to a temporary tttt login tab', async () => {
  const ttttEntry = 'https://img.chuanyuapp.com/discover_new/discover_v701_test/remoteEntry.js'
  const harness = createHarness({
    tabs: [{ id: 111, url: 'http://localhost:5173/channels/111' }],
    fetchHandler: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, message: 'Unauthorized' }),
    }),
    pageIdentityHotModuleBody: {
      code: 0,
      data: {
        modules: {
          discover: {
            name: 'discover_v701_test',
            entry: ttttEntry,
            version: '701',
          },
        },
      },
    },
  })

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 111,
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    pageOrigin: 'http://localhost:5173',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
    sourceOverrides: [{ moduleKey: 'discover', source: 'tttt' }],
    preview: {
      token: 'localhost-tttt-page-identity-preview',
      environmentSlug: 'tttt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [],
    },
  })

  assert.equal(applied.ok, true)
  assert.equal(applied.active.preview.selections[0]?.entry, ttttEntry)
  assert.deepEqual(
    harness.fetchRequests.slice(0, 2).map(({ url }) => url),
    [
      'http://localhost:5173/api/v3/version/hot-module?app=1.2.3',
      'https://tttt-www.dev.chuanyuapp.com/api/v3/version/hot-module?app=1.2.3',
    ]
  )
  assert.match(source, /window\.__KOOK_HOST_CONTEXT__\?\.services\?\.config/)
  assert.match(source, /getAppVersion\.call\(config\)/)
  assert.deepEqual(
    harness.operationLog.filter(({ type }) => type.startsWith('tab-') || type === 'execute-script'),
    [
      { type: 'execute-script', target: { tabId: 111 }, world: 'MAIN' },
      {
        type: 'tab-create',
        createProperties: {
          url: 'https://tttt-www.dev.chuanyuapp.com',
          active: false,
        },
        tabId: 112,
      },
      { type: 'execute-script', target: { tabId: 112 }, world: 'MAIN' },
      { type: 'tab-remove', tabId: 112 },
      { type: 'tab-reload', tabId: 111 },
    ]
  )
})

test('a matching URL rule rejects Site navigation and keeps repeated applies in place', async () => {
  const inPlaceRule = { pattern: 'www.kookapp.cn', environmentSlug: 'online' }
  const currentUrl = 'https://www.kookapp.cn/channels/90'
  const harness = createHarness({
    tabs: [{ id: 90, url: currentUrl }],
    inPlaceUrlRules: [inPlaceRule],
  })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const blocked = await sendMessage(harness, {
    type: 'apply-site-preview-transaction',
    tabId: 90,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: currentUrl,
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/90',
    preview: { token: 'forbidden-site-preview', expiresAt, selections: [] },
  })
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /只能原地应用/)
  assert.deepEqual(harness.tabUpdates, [])
  assert.deepEqual(harness.storage[activeKey], {})

  for (const token of ['forced-remote-one', 'forced-remote-two']) {
    const applied = await sendMessage(harness, {
      type: 'apply-remote-preview-transaction',
      tabId: 90,
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      pageOrigin: 'https://www.kookapp.cn',
      controlOrigin: 'https://bifrost.vanillacake.cn',
      officialOrigin: 'https://www.kookapp.cn',
      bindingEnvironmentSlug: 'online',
      inPlaceRule,
      preview: {
        token,
        siteBindingId: 'main',
        environmentSlug: 'online',
        expiresAt,
        selections: [
          {
            moduleKey: 'discover',
            targetId: 'discover',
            artifactId: '00000000-0000-4000-8000-000000000090',
            providerName: 'cuddly_discover_forced',
            version: 'cuddly_discover_forced',
            entryPath: 'remoteEntry.js',
          },
        ],
      },
    })
    assert.equal(applied.ok, true)
    assert.equal(applied.active.mode, 'remote')
    assert.deepEqual(clone(applied.active.inPlaceRule), inPlaceRule)
  }

  assert.deepEqual(harness.tabUpdates, [
    { tabId: 90, reload: true },
    { tabId: 90, reload: true },
  ])
  assert.equal(
    harness.tabUpdates.some((update) => typeof update.url === 'string'),
    false
  )
  assert.equal(
    harness.operationLog.some((entry) => entry.type === 'register-content-scripts'),
    false
  )
})

test('a matching rule locks its environment and dynamically installs scripts for a new official host', async () => {
  const inPlaceRule = { pattern: 'qa-web.example.test/special', environmentSlug: 'qa' }
  const currentUrl = 'https://qa-web.example.test/special/channels/91'
  const harness = createHarness({
    tabs: [
      { id: 91, url: currentUrl },
      { id: 92, url: 'https://qa-web.example.test/special/channels/92' },
    ],
    inPlaceUrlRules: [inPlaceRule],
  })
  const baseMessage = {
    type: 'apply-remote-preview-transaction',
    tabId: 91,
    previewOrigin: 'https://qa-main.bifrost.vanillacake.cn',
    pageOrigin: 'https://qa-web.example.test',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://qa-web.example.test',
    bindingEnvironmentSlug: 'qa',
    inPlaceRule,
    preview: {
      token: 'dynamic-host-preview',
      environmentSlug: 'qa',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: '00000000-0000-4000-8000-000000000091',
          providerName: 'cuddly_base_dynamic',
          version: 'cuddly_base_dynamic',
          entryPath: 'remoteEntry.js',
        },
      ],
    },
  }

  const mismatch = await sendMessage(harness, {
    ...baseMessage,
    bindingEnvironmentSlug: 'shared',
    preview: { ...baseMessage.preview, environmentSlug: 'shared' },
  })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.message, /锁定 qa 环境/)
  assert.deepEqual(harness.tabUpdates, [])

  const applied = await sendMessage(harness, baseMessage)
  assert.equal(applied.ok, true)
  const registration = harness.operationLog.find(
    (entry) => entry.type === 'register-content-scripts'
  )
  assert.deepEqual(
    registration.scripts.map((script) => ({
      matches: script.matches,
      runAt: script.runAt,
      world: script.world,
    })),
    [
      {
        matches: ['https://qa-web.example.test/*'],
        runAt: 'document_start',
        world: 'MAIN',
      },
      {
        matches: ['https://qa-web.example.test/*'],
        runAt: 'document_start',
        world: 'ISOLATED',
      },
    ]
  )
  assert.ok(
    harness.operationLog.findIndex((entry) => entry.type === 'register-content-scripts') <
      harness.operationLog.findIndex((entry) => entry.type === 'tab-reload')
  )
  const secondApplied = await sendMessage(harness, {
    ...baseMessage,
    tabId: 92,
    preview: { ...baseMessage.preview, token: 'dynamic-host-preview-two' },
  })
  assert.equal(secondApplied.ok, true)
  assert.equal(harness.contentScripts.length, 2)
  assert.equal(
    harness.operationLog.filter((entry) => entry.type === 'register-content-scripts').length,
    1
  )
  assert.equal(
    harness.operationLog.filter((entry) => entry.type === 'update-content-scripts').length,
    1
  )
  assert.deepEqual(harness.tabUpdates, [
    { tabId: 91, reload: true },
    { tabId: 92, reload: true },
  ])
})

test('a dynamic official host fails closed until the popup grants its origin permission', async () => {
  const inPlaceRule = { pattern: 'qa-web.example.test', environmentSlug: 'qa' }
  const harness = createHarness({
    tabs: [{ id: 93, url: 'https://qa-web.example.test/channels/93' }],
    inPlaceUrlRules: [inPlaceRule],
    originPermissionGranted: false,
  })
  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 93,
    previewOrigin: 'https://qa-main.bifrost.vanillacake.cn',
    pageOrigin: 'https://qa-web.example.test',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://qa-web.example.test',
    bindingEnvironmentSlug: 'qa',
    inPlaceRule,
    preview: {
      token: 'dynamic-host-no-permission',
      environmentSlug: 'qa',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [{ moduleKey: 'base' }],
    },
  })

  assert.equal(applied.ok, false)
  assert.match(applied.message, /页面访问权限/)
  assert.deepEqual(harness.contentScripts, [])
  assert.deepEqual(harness.tabUpdates, [])
  assert.deepEqual(harness.storage[activeKey], {})
})

test('leaving a path-scoped in-place rule clears the overlay and reloads the same origin', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const active = {
    mode: 'remote',
    ruleIds: [],
    preview: {
      token: 'path-scoped-preview',
      environmentSlug: 'qa',
      expiresAt: future,
      selections: [{ moduleKey: 'base' }],
    },
    previewOrigin: 'https://qa-main.bifrost.vanillacake.cn',
    pageOrigin: 'https://qa-web.example.test',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://qa-web.example.test',
    bindingEnvironmentSlug: 'qa',
    inPlaceRule: { pattern: 'qa-web.example.test/special', environmentSlug: 'qa' },
  }
  const harness = createHarness({
    active: { 94: active },
    tabs: [{ id: 94, url: 'https://qa-web.example.test/special/channels/94' }],
  })

  harness.listeners.updated(
    94,
    { url: 'https://qa-web.example.test/other/channels/94' },
    { id: 94, url: 'https://qa-web.example.test/other/channels/94' }
  )
  await harness.flush()

  assert.equal(harness.storage[activeKey]['94'], undefined)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 94, reload: true }])
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/path-scoped-preview'
  )
})

test('refuses in-place Remote preview when the tab does not match the selected environment', async () => {
  const harness = createHarness({
    tabs: [{ id: 10, url: 'https://www.kookapp.cn/channels/10' }],
  })
  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 10,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
    preview: {
      token: 'wrong-environment-preview',
      environmentSlug: 'tttt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [{ moduleKey: 'base' }],
    },
  })

  assert.equal(applied.ok, false)
  assert.match(applied.message, /当前标签页.*所选环境/)
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.storage[activeKey], {})
  assert.equal(harness.tabUpdates.length, 0)
})

test('rolls back and revokes an in-place Preview when its reload fails', async () => {
  const harness = createHarness({
    tabs: [{ id: 33, url: 'https://www.kookapp.cn/channels/33' }],
    tabReloadFailures: 1,
  })
  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 33,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://www.kookapp.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    bindingEnvironmentSlug: 'online',
    preview: {
      token: 'reload-failed-preview',
      environmentSlug: 'online',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      selections: [{ moduleKey: 'base' }],
    },
  })

  assert.equal(applied.ok, false)
  assert.match(applied.message, /Tab reload failed/)
  assert.deepEqual(harness.storage[activeKey], {})
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.alarms.has(`${alarmPrefix}33`), false)
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/reload-failed-preview'
  )
})

test('keeps the new official-page draft when a Remote reload rolls back an old Site Preview', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const scope = '35:main:online'
  const harness = createHarness({
    active: {
      35: {
        mode: 'site',
        ruleIds: [1035],
        preview: {
          token: 'old-site-preview',
          siteBindingId: 'main',
          environmentSlug: 'online',
          siteArtifactId: '00000000-0000-4000-8000-000000000035',
          expiresAt: future,
        },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1035 }],
    popupState: {
      [scope]: {
        selectedBranches: { webapp: 'master', discover: 'feature/discover' },
        submittedBuildBranches: {},
        siteOverrideEnabled: false,
        updatedAt: 1,
      },
    },
    tabs: [{ id: 35, url: 'https://www.kookapp.cn/channels/35' }],
    tabReloadFailures: 1,
  })

  const applied = await sendMessage(harness, {
    type: 'apply-remote-preview-transaction',
    tabId: 35,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://www.kookapp.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    bindingEnvironmentSlug: 'online',
    preview: {
      token: 'new-remote-preview',
      siteBindingId: 'main',
      environmentSlug: 'online',
      expiresAt: future,
      selections: [{ moduleKey: 'discover' }],
    },
  })

  assert.equal(applied.ok, false)
  assert.equal(harness.storage[activeKey]['35'].preview.token, 'old-site-preview')
  assert.equal(harness.sessionStorage[popupStateKey][scope].siteOverrideEnabled, false)
})

test('keeps the new page-override draft when Site navigation rolls back a Remote Preview', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const scope = '36:main:online'
  const harness = createHarness({
    active: {
      36: {
        mode: 'remote',
        ruleIds: [],
        preview: {
          token: 'old-remote-preview',
          siteBindingId: 'main',
          environmentSlug: 'online',
          expiresAt: future,
          selections: [{ moduleKey: 'discover' }],
        },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        pageOrigin: 'https://www.kookapp.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        bindingEnvironmentSlug: 'online',
      },
    },
    popupState: {
      [scope]: {
        selectedBranches: { webapp: 'feature/page', discover: 'feature/discover' },
        submittedBuildBranches: {},
        siteOverrideEnabled: true,
        updatedAt: 1,
      },
    },
    tabs: [{ id: 36, url: 'https://www.kookapp.cn/channels/36' }],
    tabUpdateFailures: 1,
  })

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview-transaction',
    tabId: 36,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://www.kookapp.cn/channels/36',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/36',
    preview: {
      token: 'new-site-preview',
      siteBindingId: 'main',
      environmentSlug: 'online',
      siteArtifactId: '00000000-0000-4000-8000-000000000036',
      expiresAt: future,
      selections: [],
    },
  })

  assert.equal(applied.ok, false)
  assert.equal(harness.storage[activeKey]['36'].preview.token, 'old-remote-preview')
  assert.equal(harness.sessionStorage[popupStateKey][scope].siteOverrideEnabled, true)
})

test('rejects a forged in-place command with a page Artifact or mismatched environment', async () => {
  for (const preview of [
    {
      token: 'site-artifact-preview',
      environmentSlug: 'online',
      siteArtifactId: '00000000-0000-4000-8000-000000000001',
      selections: [{ moduleKey: 'base' }],
    },
    {
      token: 'other-environment-preview',
      environmentSlug: 'tttt',
      selections: [{ moduleKey: 'base' }],
    },
    {
      token: 'empty-remote-preview',
      environmentSlug: 'online',
      selections: [],
    },
  ]) {
    const harness = createHarness({
      tabs: [{ id: 34, url: 'https://www.kookapp.cn/channels/34' }],
    })
    const result = await sendMessage(harness, {
      type: 'apply-remote-preview-transaction',
      tabId: 34,
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      pageOrigin: 'https://www.kookapp.cn',
      controlOrigin: 'https://bifrost.vanillacake.cn',
      officialOrigin: 'https://www.kookapp.cn',
      bindingEnvironmentSlug: 'online',
      preview: {
        ...preview,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /站点环境或预览产物不匹配/)
    assert.deepEqual(harness.storage[activeKey], {})
    assert.equal(harness.tabUpdates.length, 0)
  }
})

test('applies a site preview with one tab-scoped session header rule', async () => {
  const harness = createHarness({
    tabs: [{ id: 11, url: 'https://main.bifrost.vanillacake.cn/channels/11' }],
  })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview',
    tabId: 11,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://www.kookapp.cn/channels/11',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/11',
    preview: { token: 'site-preview', expiresAt, selections: [] },
  })

  assert.equal(applied.ok, true)
  assert.equal(harness.sessionRules.length, 1)
  assert.deepEqual(harness.sessionRules[0].condition.tabIds, [11])
  assert.equal(harness.sessionRules[0].condition.urlFilter, '|https://main.bifrost.vanillacake.cn/')
  assert.equal(harness.sessionRules[0].condition.regexFilter, undefined)
  assert.equal(harness.sessionRules[0].condition.resourceTypes.includes('main_frame'), true)
  assert.equal(harness.sessionRules[0].condition.resourceTypes.includes('xmlhttprequest'), true)
  assert.deepEqual(harness.sessionRules[0].action.requestHeaders, [
    { header: 'x-cuddly-preview-token', operation: 'set', value: 'site-preview' },
  ])
})

test('applies rules, state, and navigation in one background transaction', async () => {
  const harness = createHarness({
    tabs: [{ id: 14, url: 'https://www.kookapp.cn/channels/14?from=official#voice' }],
  })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview-transaction',
    tabId: 14,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://www.kookapp.cn/channels/14?from=official#voice',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/14?from=official#voice',
    preview: { token: 'transaction-preview', expiresAt, selections: [] },
  })

  assert.equal(applied.ok, true)
  assert.equal(harness.storage[activeKey]['14'].preview.token, 'transaction-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.equal(harness.alarms.get(`${alarmPrefix}14`).when, Date.parse(expiresAt))
  assert.deepEqual(harness.tabUpdates, [
    {
      tabId: 14,
      url: 'https://main.bifrost.vanillacake.cn/channels/14?from=official#voice',
    },
  ])
})

test('finishes an apply transaction even when its popup no longer receives the response', async () => {
  const harness = createHarness({ tabs: [{ id: 15, url: 'https://www.kookapp.cn/channels/15' }] })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  assert.equal(
    harness.listeners.message(
      {
        type: 'apply-site-preview-transaction',
        tabId: 15,
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        originalUrl: 'https://www.kookapp.cn/channels/15',
        targetUrl: 'https://main.bifrost.vanillacake.cn/channels/15',
        preview: { token: 'closed-popup-preview', expiresAt, selections: [] },
      },
      {},
      () => undefined
    ),
    true
  )
  await harness.flush()

  assert.equal(harness.storage[activeKey]['15'].preview.token, 'closed-popup-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.deepEqual(harness.tabUpdates, [
    { tabId: 15, url: 'https://main.bifrost.vanillacake.cn/channels/15' },
  ])
})

test('rejects a transaction target outside the declared preview origin before mutation', async () => {
  const harness = createHarness({ tabs: [{ id: 16, url: 'https://www.kookapp.cn/channels/16' }] })
  const expiresAt = new Date(Date.now() + 60_000).toISOString()

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview-transaction',
    tabId: 16,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://www.kookapp.cn/channels/16',
    targetUrl: 'https://attacker.example/channels/16',
    preview: { token: 'invalid-target-preview', expiresAt, selections: [] },
  })

  assert.equal(applied.ok, false)
  assert.match(applied.message, /configured preview origin/)
  assert.deepEqual(harness.storage[activeKey], {})
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.tabUpdates.length, 0)
  assert.equal(harness.fetchRequests.length, 0)
})

test('revokes the previous token only after a replacement is active', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      12: {
        mode: 'site',
        ruleIds: [1012],
        preview: { token: 'old-preview', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1012 }],
    tabs: [{ id: 12, url: 'https://main.bifrost.vanillacake.cn/channels/12' }],
  })

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview',
    tabId: 12,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://main.bifrost.vanillacake.cn/channels/12',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/12',
    preview: { token: 'new-preview', expiresAt: future, selections: [] },
  })

  assert.equal(applied.ok, true)
  assert.equal(harness.storage[activeKey]['12'].preview.token, 'new-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.equal(harness.sessionRules[0].action.requestHeaders[0].value, 'new-preview')
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    ['https://bifrost.vanillacake.cn/api/v1/previews/old-preview']
  )
})

test('revokes a failed replacement and restores the previous local preview', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      13: {
        mode: 'site',
        ruleIds: [1013],
        preview: { token: 'stable-preview', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1013 }],
    tabs: [{ id: 13, url: 'https://main.bifrost.vanillacake.cn/channels/13' }],
    alarmCreateFailures: 1,
  })

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview',
    tabId: 13,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://main.bifrost.vanillacake.cn/channels/13',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/13',
    preview: { token: 'failed-preview', expiresAt: future, selections: [] },
  })

  assert.equal(applied.ok, false)
  assert.equal(harness.storage[activeKey]['13'].preview.token, 'stable-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.equal(harness.sessionRules[0].action.requestHeaders[0].value, 'stable-preview')
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    ['https://bifrost.vanillacake.cn/api/v1/previews/failed-preview']
  )
})

test('restores the previous preview when transactional apply navigation fails', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      17: {
        mode: 'site',
        ruleIds: [1017],
        preview: { token: 'stable-preview', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1017 }],
    tabs: [{ id: 17, url: 'https://main.bifrost.vanillacake.cn/channels/17' }],
    tabUpdateFailures: 1,
  })

  const applied = await sendMessage(harness, {
    type: 'apply-site-preview-transaction',
    tabId: 17,
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
    originalUrl: 'https://main.bifrost.vanillacake.cn/channels/17',
    targetUrl: 'https://main.bifrost.vanillacake.cn/channels/17',
    preview: { token: 'failed-preview', expiresAt: future, selections: [] },
  })

  assert.equal(applied.ok, false)
  assert.match(applied.message, /Tab update failed/)
  assert.equal(harness.storage[activeKey]['17'].preview.token, 'stable-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.equal(harness.sessionRules[0].action.requestHeaders[0].value, 'stable-preview')
  assert.equal(harness.alarms.get(`${alarmPrefix}17`).when, Date.parse(future))
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    ['https://bifrost.vanillacake.cn/api/v1/previews/failed-preview']
  )
})

test('removes preview state and returns to the official origin in one transaction', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      18: {
        mode: 'site',
        ruleIds: [1018],
        preview: { token: 'remove-preview', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1018 }],
    tabs: [
      {
        id: 18,
        url: 'https://main.bifrost.vanillacake.cn/channels/18?from=preview#text',
      },
    ],
  })

  const removed = await sendMessage(harness, {
    type: 'remove-preview-transaction',
    tabId: 18,
  })

  assert.equal(removed.ok, true)
  assert.equal(harness.storage[activeKey]['18'], undefined)
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.tabUpdates, [
    { tabId: 18, url: 'https://www.kookapp.cn/channels/18?from=preview#text' },
  ])
  assert.deepEqual(
    harness.fetchRequests.map((request) => request.url),
    ['https://bifrost.vanillacake.cn/api/v1/previews/remove-preview']
  )
})

test('restores preview state and does not revoke it when remove navigation fails', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const harness = createHarness({
    active: {
      19: {
        mode: 'site',
        ruleIds: [1019],
        preview: { token: 'keep-preview', expiresAt: future },
        previewOrigin: 'https://main.bifrost.vanillacake.cn',
        controlOrigin: 'https://bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
      },
    },
    rules: [{ id: 1019 }],
    tabs: [{ id: 19, url: 'https://main.bifrost.vanillacake.cn/channels/19' }],
    tabUpdateFailures: 1,
  })

  const removed = await sendMessage(harness, {
    type: 'remove-preview-transaction',
    tabId: 19,
  })

  assert.equal(removed.ok, false)
  assert.match(removed.message, /Tab update failed/)
  assert.equal(harness.storage[activeKey]['19'].preview.token, 'keep-preview')
  assert.equal(harness.sessionRules.length, 1)
  assert.equal(harness.sessionRules[0].action.requestHeaders[0].value, 'keep-preview')
  assert.equal(harness.alarms.get(`${alarmPrefix}19`).when, Date.parse(future))
  assert.equal(harness.fetchRequests.length, 0)
})

test('restores an in-place Remote preview after worker restart and reloads it on expiry', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const past = new Date(Date.now() - 60_000).toISOString()
  const remote = {
    mode: 'remote',
    ruleIds: [],
    preview: {
      token: 'restart-remote',
      environmentSlug: 'tttt',
      expiresAt: future,
      selections: [{ moduleKey: 'base' }],
    },
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    bindingEnvironmentSlug: 'tttt',
  }
  const harness = createHarness({
    active: { 31: remote },
    rules: [{ id: 9999 }],
    tabs: [{ id: 31, url: 'https://tttt-www.dev.chuanyuapp.com/channels/31' }],
  })

  harness.listeners.startup()
  await harness.flush()

  assert.equal(harness.storage[activeKey]['31'].mode, 'remote')
  assert.equal(harness.sessionRules.length, 0)
  assert.equal(harness.tabUpdates.length, 0)

  harness.storage[activeKey]['31'].preview.expiresAt = past
  harness.listeners.alarm({ name: `${alarmPrefix}31` })
  await harness.flush()

  assert.equal(harness.storage[activeKey]['31'], undefined)
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 31, reload: true }])
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/restart-remote'
  )
})

test('removing an in-place Remote preview reloads the same official tab', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const active = {
    mode: 'remote',
    ruleIds: [],
    preview: { token: 'remove-remote', expiresAt: future, selections: [] },
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://www.kookapp.cn',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://www.kookapp.cn',
  }
  const harness = createHarness({
    active: { 32: active },
    rules: [],
    tabs: [{ id: 32, url: 'https://www.kookapp.cn/channels/32' }],
  })

  const removed = await sendMessage(harness, {
    type: 'remove-preview-transaction',
    tabId: 32,
  })

  assert.equal(removed.ok, true)
  assert.equal(removed.active.mode, 'remote')
  assert.equal(harness.storage[activeKey]['32'], undefined)
  assert.equal(harness.sessionRules.length, 0)
  assert.deepEqual(harness.tabUpdates, [{ tabId: 32, reload: true }])
  assert.equal(
    harness.fetchRequests.at(-1).url,
    'https://bifrost.vanillacake.cn/api/v1/previews/remove-remote'
  )
})

test('clears a pending localhost MF handoff before removing its Remote preview', async () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  const active = {
    mode: 'remote',
    ruleIds: [],
    preview: { token: 'remove-localhost-remote', expiresAt: future, selections: [] },
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    pageOrigin: 'http://localhost:5173',
    controlOrigin: 'https://bifrost.vanillacake.cn',
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
  }
  const harness = createHarness({
    active: { 33: active },
    tabs: [{ id: 33, url: 'http://localhost:5173/channels/33' }],
  })
  harness.pageSessionStorage[33] = { stale: true }

  const removed = await sendMessage(harness, {
    type: 'remove-preview-transaction',
    tabId: 33,
  })

  assert.equal(removed.ok, true)
  assert.equal(harness.pageSessionStorage[33], undefined)
  const relevant = harness.operationLog.filter(({ type }) =>
    ['page-session-storage-write', 'tab-reload'].includes(type)
  )
  assert.deepEqual(clone(relevant), [
    {
      type: 'page-session-storage-write',
      tabId: 33,
      expectedOrigin: 'http://localhost:5173',
      handoff: null,
      matches: true,
    },
    { type: 'tab-reload', tabId: 33 },
  ])
})
