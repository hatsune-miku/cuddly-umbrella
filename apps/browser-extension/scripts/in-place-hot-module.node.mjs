import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = await readFile(path.join(root, 'in-place-hot-module-main.js'), 'utf8')
const bridgeSource = await readFile(path.join(root, 'in-place-hot-module-bridge.js'), 'utf8')

const remote = {
  moduleKey: 'base',
  name: 'cuddly_base_feature',
  entry:
    'https://main.bifrost.vanillacake.cn/__cuddly/preview-artifacts/00000000-0000-4000-8000-000000000001/cuddly_base_feature/remoteEntry.js',
  version: 'cuddly_base_feature',
  restartRequired: true,
}

function mainHarness(
  fetchImpl,
  origin = 'https://www.kookapp.cn',
  XMLHttpRequest,
  ResponseType,
  initialSessionStorage = {}
) {
  const listeners = new Map()
  const postedMessages = []
  const sessionValues = new Map(Object.entries(initialSessionStorage))
  const window = {
    location: new URL(`${origin}/channels/1`),
    fetch: fetchImpl,
    ...(XMLHttpRequest ? { XMLHttpRequest } : {}),
    ...(ResponseType ? { Response: ResponseType } : {}),
    setTimeout,
    sessionStorage: {
      getItem(key) {
        return sessionValues.has(key) ? sessionValues.get(key) : null
      },
      setItem(key, value) {
        sessionValues.set(String(key), String(value))
      },
      removeItem(key) {
        sessionValues.delete(String(key))
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin })
    },
  }
  const context = vm.createContext({
    Headers,
    Object,
    Promise,
    Reflect,
    Request,
    Response,
    URL,
    window,
    sessionValues,
  })
  new vm.Script(mainSource, { filename: 'in-place-hot-module-main.js' }).runInContext(context)
  return {
    window,
    postedMessages,
    sessionValues,
    configure(modules) {
      listeners.get('message')?.({
        source: window,
        origin,
        data: {
          channel: 'bifrost:in-place-hot-module:v1',
          type: 'configuration',
          modules,
        },
      })
    },
  }
}

test('replaces only selected localhost MF providers and consumes the one-time handoff', async () => {
  const origin = 'https://localhost:3000'
  const handoffKey = '__BIFROST_LOCALHOST_REMOTE_HANDOFF_V1__'
  const harness = mainHarness(async () => Response.json({}), origin, undefined, undefined, {
    [handoffKey]: JSON.stringify({
      origin,
      expiresAt: Date.now() + 60_000,
      modules: [remote],
    }),
  })
  const providers = new Map()
  const mf = {
    add(config) {
      providers.set(config.key, config.provider)
    },
    async get(path) {
      return providers.get(path.split('/')[0])?.()
    },
  }

  harness.window.__MF = mf
  mf.add({
    key: 'base',
    provider() {
      return {
        name: this.key,
        entry: 'https://localhost:3031/remoteEntry.js',
        local: true,
      }
    },
  })
  mf.add({
    key: 'discover',
    provider() {
      return {
        name: this.key,
        entry: 'https://localhost:3005/remoteEntry.js',
        local: true,
      }
    },
  })

  assert.deepEqual(JSON.parse(JSON.stringify(await mf.get('base'))), {
    name: remote.name,
    entry: remote.entry,
    local: true,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await mf.get('discover'))), {
    name: 'discover',
    entry: 'https://localhost:3005/remoteEntry.js',
    local: true,
  })
  assert.equal(harness.sessionValues.has(handoffKey), false)
})

test('waits for the localhost bridge configuration before the first MF load', async () => {
  const harness = mainHarness(async () => Response.json({}), 'http://localhost:5173')
  const providers = new Map()
  const mf = {
    add(config) {
      providers.set(config.key, config.provider)
    },
    async get(path) {
      return providers.get(path.split('/')[0])?.()
    },
  }
  harness.window.__MF = mf
  mf.add({
    key: 'base',
    provider: () => ({ name: 'base', entry: 'https://localhost:3031/remoteEntry.js' }),
  })

  const loading = mf.get('base')
  harness.configure([remote])
  assert.deepEqual(JSON.parse(JSON.stringify(await loading)), {
    name: remote.name,
    entry: remote.entry,
  })
})

test('does not patch MF providers outside exact localhost', async () => {
  const harness = mainHarness(async () => Response.json({}), 'https://www.kookapp.cn')
  const nativeAdd = () => 'native-add'
  const nativeGet = async () => 'native-get'
  const mf = { add: nativeAdd, get: nativeGet }
  harness.window.__MF = mf
  harness.configure([remote])

  assert.equal(mf.add, nativeAdd)
  assert.equal(mf.get, nativeGet)
})

test('keeps the official request unchanged and overlays only selected object modules', async () => {
  const requests = []
  const official = {
    code: 0,
    traceId: 'official-trace',
    data: {
      cursor: 42,
      modules: {
        base: {
          name: 'official_base',
          entry: 'https://static.kookapp.cn/base/remoteEntry.js',
          version: 'official',
          restartRequired: false,
          officialField: 'preserved',
        },
        discover: { name: 'official_discover', enabled: true },
      },
    },
  }
  const nativeResponse = new Response(JSON.stringify(official), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-official': 'preserved' },
  })
  const harness = mainHarness(async (...args) => {
    requests.push(args)
    return nativeResponse
  })
  harness.configure([remote])

  const init = {
    headers: { authorization: 'Bearer official', 'x-signature': 'official-signature' },
  }
  const response = await harness.window.fetch(
    '/api/v3/version/hot-module?app=1.2.3&cursor=42',
    init
  )

  assert.deepEqual(requests, [['/api/v3/version/hot-module?app=1.2.3&cursor=42', init]])
  assert.deepEqual(JSON.parse(JSON.stringify(harness.postedMessages[0])), {
    targetOrigin: 'https://www.kookapp.cn',
    message: {
      channel: 'bifrost:in-place-hot-module:v1',
      type: 'request-context',
      app: '1.2.3',
    },
  })
  assert.equal(requests[0][1], init)
  assert.equal(requests[0][1].headers, init.headers)
  assert.notEqual(response, nativeResponse)
  assert.equal(response.headers.get('x-official'), 'preserved')
  assert.deepEqual(await response.json(), {
    code: 0,
    traceId: 'official-trace',
    data: {
      cursor: 42,
      modules: {
        base: {
          name: remote.name,
          entry: remote.entry,
          version: remote.version,
          restartRequired: true,
          officialField: 'preserved',
        },
        discover: { name: 'official_discover', enabled: true },
      },
    },
  })
})

test('supports the array protocol shape and preserves unselected module fields', async () => {
  const harness = mainHarness(async () =>
    Response.json({
      code: 0,
      data: {
        modules: [
          { key: 'discover', name: 'official_discover' },
          { key: 'base', name: 'official_base', retained: 1 },
        ],
      },
    })
  )
  harness.configure([remote])

  const body = await harness.window
    .fetch('https://www.kookapp.cn/v3/version/hot-module')
    .then((response) => response.json())
  assert.deepEqual(body.data.modules, [
    { key: 'discover', name: 'official_discover' },
    {
      key: 'base',
      name: remote.name,
      entry: remote.entry,
      version: remote.version,
      restartRequired: true,
      retained: 1,
    },
  ])
})

test('overlays the test-environment fetch response with the same-origin protocol', async () => {
  const harness = mainHarness(
    async () =>
      Response.json({
        code: '0',
        data: {
          modules: {
            base: { name: 'official_test_base', retained: 'test-environment' },
          },
        },
      }),
    'https://tttt-www.dev.chuanyuapp.com'
  )
  harness.configure([remote])

  const body = await harness.window
    .fetch('/api/v3/version/hot-module?id=7')
    .then((response) => response.json())
  assert.deepEqual(body.data.modules.base, {
    name: remote.name,
    entry: remote.entry,
    version: remote.version,
    restartRequired: true,
    retained: 'test-environment',
  })
})

test('supports legacy flat-map responses without treating arbitrary JSON as hot-module data', async () => {
  const harness = mainHarness(async () =>
    Response.json({
      code: 0,
      data: {
        base: 'https://img.chuanyuapp.com/base_new/base_v1001/remoteEntry.js',
        discover: {
          name: 'official_discover',
          entry: 'https://img.chuanyuapp.com/discover_new/discover_v1001/remoteEntry.js',
        },
      },
    })
  )
  harness.configure([remote])
  const body = await harness.window
    .fetch('/api/v3/version/hot-module')
    .then((response) => response.json())
  assert.deepEqual(body.data.base, {
    name: remote.name,
    entry: remote.entry,
    version: remote.version,
    restartRequired: true,
  })

  const unrelated = { code: 0, data: { id: 7, version: 'v7' } }
  const unrelatedHarness = mainHarness(async () => Response.json(unrelated))
  unrelatedHarness.configure([remote])
  assert.deepEqual(
    await unrelatedHarness.window
      .fetch('/api/v3/version/hot-module')
      .then((response) => response.json()),
    unrelated
  )
})

test('overlays XMLHttpRequest text and json responses used by older test deployments', () => {
  const origin = 'https://tttt-www.dev.chuanyuapp.com'
  const official = {
    code: 0,
    data: {
      modules: {
        base: { name: 'official_test_base', retained: true },
      },
    },
  }
  class MockXMLHttpRequest {
    constructor() {
      this.status = 200
      this.responseType = ''
      this.body = JSON.stringify(official)
    }

    open(method, url) {
      this.method = method
      this.responseURL = new URL(url, origin).href
    }

    get responseText() {
      return this.body
    }

    get response() {
      return this.responseType === 'json' ? JSON.parse(this.body) : this.body
    }
  }

  const harness = mainHarness(async () => Response.json(official), origin, MockXMLHttpRequest)
  harness.configure([remote])

  const textRequest = new harness.window.XMLHttpRequest()
  textRequest.open('GET', '/api/v3/version/hot-module?app=test')
  assert.equal(JSON.parse(textRequest.responseText).data.modules.base.name, remote.name)
  assert.equal(JSON.parse(textRequest.response).data.modules.base.entry, remote.entry)

  const jsonRequest = new harness.window.XMLHttpRequest()
  jsonRequest.responseType = 'json'
  jsonRequest.open('GET', '/v3/version/hot-module')
  assert.equal(jsonRequest.response.data.modules.base.name, remote.name)

  const unrelated = new harness.window.XMLHttpRequest()
  unrelated.open('GET', '/api/v3/user/me')
  assert.equal(unrelated.responseText, JSON.stringify(official))
})

test('overlays Response parsing when the application captured fetch before document_start', async () => {
  const origin = 'https://tttt-www.dev.chuanyuapp.com'
  const official = {
    code: 0,
    data: {
      modules: {
        base: { name: 'official_test_base', retained: 'captured-fetch' },
      },
    },
  }
  class MockResponse {
    constructor(body, url) {
      this.body = body
      this.url = url
      this.ok = true
    }

    async json() {
      return JSON.parse(this.body)
    }

    async text() {
      return this.body
    }
  }

  const capturedFetch = async () =>
    new MockResponse(JSON.stringify(official), `${origin}/api/v3/version/hot-module?id=7`)
  const harness = mainHarness(capturedFetch, origin, undefined, MockResponse)
  harness.configure([remote])

  const jsonBody = await (await capturedFetch()).json()
  assert.deepEqual(JSON.parse(JSON.stringify(jsonBody.data.modules.base)), {
    name: remote.name,
    entry: remote.entry,
    version: remote.version,
    restartRequired: true,
    retained: 'captured-fetch',
  })
  const textBody = JSON.parse(await (await capturedFetch()).text())
  assert.equal(textBody.data.modules.base.entry, remote.entry)
})

test('fails open for non-target, failed, malformed, and business-error responses', async () => {
  for (const scenario of [
    {
      url: '/api/v3/users/me',
      response: Response.json({ code: 0, data: { modules: {} } }),
    },
    {
      url: 'https://other.example.test/api/v3/version/hot-module',
      response: Response.json({ code: 0, data: { modules: {} } }),
    },
    {
      url: '/api/v3/version/hot-module',
      response: new Response('unauthorized', { status: 401 }),
    },
    {
      url: '/api/v3/version/hot-module',
      response: new Response('not-json', { status: 200 }),
    },
    {
      url: '/api/v3/version/hot-module',
      response: Response.json({ code: 401, data: { modules: {} } }),
    },
    {
      url: '/api/v3/version/hot-module',
      response: Response.json({ code: 0, data: { modules: null } }),
    },
  ]) {
    const harness = mainHarness(async () => scenario.response)
    harness.configure([remote])
    assert.equal(await harness.window.fetch(scenario.url), scenario.response)
  }

  const postResponse = Response.json({ code: 0, data: { modules: {} } })
  const postHarness = mainHarness(async () => postResponse)
  postHarness.configure([remote])
  assert.equal(
    await postHarness.window.fetch('/api/v3/version/hot-module', { method: 'POST' }),
    postResponse
  )
})

test('waits for a cold bridge and leaves the response untouched when configuration is empty', async () => {
  const officialBody = {
    code: 0,
    data: { modules: { base: { name: 'official', retained: true } } },
  }
  const coldRequests = []
  const coldHarness = mainHarness(async (...args) => {
    coldRequests.push(args)
    return Response.json(officialBody)
  })
  const pending = coldHarness.window
    .fetch('/api/v3/version/hot-module')
    .then((response) => response.json())
  setTimeout(() => coldHarness.configure([remote]), 10)
  assert.equal((await pending).data.modules.base.name, remote.name)
  assert.deepEqual(coldRequests, [['/api/v3/version/hot-module']])

  const nativeResponse = Response.json(officialBody)
  const emptyHarness = mainHarness(async () => nativeResponse)
  emptyHarness.configure([])
  assert.equal(await emptyHarness.window.fetch('/api/v3/version/hot-module'), nativeResponse)
})

test('isolated bridge publishes only the public module overlay fields', async () => {
  let postedResolve
  let messageListener
  const runtimeMessages = []
  const posted = new Promise((resolve) => {
    postedResolve = resolve
  })
  const window = {
    location: new URL('https://www.kookapp.cn/channels/1'),
    postMessage(message, targetOrigin) {
      postedResolve({ message, targetOrigin })
    },
    addEventListener(type, listener) {
      if (type === 'message') messageListener = listener
    },
  }
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message)
        if (message.type === 'remember-hot-module-request-context') return { ok: true }
        assert.equal(message.type, 'read-in-place-hot-module-config')
        return {
          ok: true,
          config: [
            { ...remote, token: 'must-not-cross-worlds', csrfToken: 'must-not-cross-worlds' },
          ],
        }
      },
    },
  }
  new vm.Script(bridgeSource, { filename: 'in-place-hot-module-bridge.js' }).runInContext(
    vm.createContext({ chrome, window })
  )

  assert.deepEqual(JSON.parse(JSON.stringify(await posted)), {
    targetOrigin: 'https://www.kookapp.cn',
    message: {
      channel: 'bifrost:in-place-hot-module:v1',
      type: 'configuration',
      modules: [remote],
    },
  })
  messageListener({
    source: window,
    origin: 'https://www.kookapp.cn',
    data: {
      channel: 'bifrost:in-place-hot-module:v1',
      type: 'request-context',
      app: '3.4.5-beta.1',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    { type: 'read-in-place-hot-module-config' },
    { type: 'remember-hot-module-request-context', app: '3.4.5-beta.1' },
  ])
})
