// Execute the actual hosted adapter against the live API, without opening a browser
// or authenticating a user. This catches contract and client/server clock mismatches.
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

async function main() {
  const origin = 'https://bifrost.vanillacake.cn'
  const response = await fetch(`${origin}/pc-plugin/host-adapter.js`, { cache: 'no-store' })
  assert.equal(response.status, 200)
  const source = await response.text()
  const storage = new Map()
  const timers = new Map()
  const opened = []
  const requests = []
  let timerId = 0
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Headers,
    TextEncoder,
    AbortController,
    CustomEvent,
    crypto: webcrypto,
    btoa,
    console,
    window: {
      location: {
        origin,
        href: `${origin}/pc-plugin/`,
        reload: () => assert.fail('Unexpected login'),
      },
      parent: { postMessage: () => {} },
      addEventListener: () => {},
      dispatchEvent: () => {},
      open: (url) => {
        opened.push(url)
        return null
      },
      setTimeout: (callback, delay) => {
        timers.set(++timerId, { callback, delay })
        return timerId
      },
      clearTimeout: (id) => timers.delete(id),
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (input, init) => {
      assert.equal(init.credentials, 'omit')
      const url = new URL(input, origin)
      assert.equal(url.origin, origin)
      const result = await fetch(url, { ...init, headers: { ...init.headers, origin } })
      requests.push({
        kind: url.pathname.endsWith('/claim') ? 'claim' : 'create',
        status: result.status,
      })
      return result
    },
  })
  vm.runInContext(source, context)
  const result = await context.chrome.tabs.create({ url: `${origin}/api/v1/auth/feishu/start` })
  assert.equal(opened.length, 1)
  assert.equal(new URL(opened[0]).pathname, '/api/v1/auth/pc-login/authorize')
  assert.ok(result.authHint)
  const timer = [...timers].find(([, item]) => item.delay === 100)
  assert.ok(timer)
  timers.delete(timer[0])
  await timer[1].callback()
  assert.deepEqual(requests, [
    { kind: 'create', status: 201 },
    { kind: 'claim', status: 202 },
  ])
  assert.ok([...timers.values()].some((item) => item.delay === 2_000))
  console.log(
    JSON.stringify({
      passed: true,
      hostedAdapter: true,
      browserOpenRequested: true,
      cookies: false,
      opener: false,
      requests,
    })
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
