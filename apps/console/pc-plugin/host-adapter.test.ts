import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./host-adapter.js', import.meta.url), 'utf8')
const tokenKey = 'bifrost.pc.auth-token.v1'

function harness(
  responses: Array<Record<string, unknown> | number | Error>,
  token = '',
  saved: Record<string, string> = {}
) {
  const storage = new Map([
    ...Object.entries(saved),
    ...(token ? [[tokenKey, token] as [string, string]] : []),
  ])
  const calls: Array<{ url: string; headers: Headers; init: RequestInit }> = []
  const timers = new Map<number, { callback: () => unknown; delay: number }>()
  let timerId = 0
  const events: CustomEvent[] = []
  const opened: string[] = []
  const listeners = new Map<string, Array<(event?: unknown) => void>>()
  let reloaded = false
  const window = {
    location: {
      origin: 'https://bifrost.vanillacake.cn',
      href: 'https://bifrost.vanillacake.cn/pc-plugin/',
      reload: () => {
        reloaded = true
      },
    },
    parent: { postMessage: () => undefined },
    addEventListener: (name: string, callback: (event: unknown) => void) => {
      listeners.set(name, [...(listeners.get(name) || []), callback])
    },
    dispatchEvent: (event: CustomEvent) => events.push(event),
    setTimeout: (callback: () => unknown, delay: number) => {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout: (id: number) => timers.delete(id),
    open: (url: string) => {
      opened.push(url)
      return null
    },
  }
  const context = vm.createContext({
    window,
    URL,
    Headers,
    Request,
    Response,
    crypto,
    btoa,
    TextEncoder,
    AbortController,
    CustomEvent,
    console,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), init })
      const next = responses.shift()
      if (next === undefined) throw new Error('Unexpected request')
      if (next instanceof Error) throw next
      return new Response(JSON.stringify(typeof next === 'number' ? {} : next), {
        status: typeof next === 'number' ? next : 200,
      })
    },
  })
  vm.runInContext(source, context)
  return {
    context,
    storage,
    calls,
    opened,
    timers,
    events,
    listeners,
    tick: async (delay: number) => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay)
      if (!entry) throw new Error(`No timer for ${delay}`)
      timers.delete(entry[0])
      await entry[1].callback()
    },
    reloaded: () => reloaded,
  }
}

describe('PC permission-system compatibility', () => {
  it('shows login for the new anonymous HTTP 200 response without creating Guest sessions', async () => {
    const h = harness([{ authenticated: false, permissionLevel: 0 }])
    const response = await h.context.fetch('/api/v1/auth/session')
    expect(response.status).toBe(401)
    expect(h.calls.map((call) => call.url)).toEqual(['/api/v1/auth/session'])
  })

  it('replaces a legacy Guest bearer with an existing Feishu cookie', async () => {
    const h = harness(
      [
        { authenticated: true, guest: true },
        { authenticated: true, permissionLevel: 2 },
      ],
      'g'.repeat(43)
    )
    const response = await h.context.fetch('/api/v1/auth/session', { credentials: 'include' })
    expect((await response.json()).permissionLevel).toBe(2)
    expect(h.storage.has(tokenKey)).toBe(false)
    expect(h.calls[0].headers.get('authorization')).toBe(`Bearer ${'g'.repeat(43)}`)
    expect(h.calls[1].headers.has('authorization')).toBe(false)
  })

  it('expires stale bearer sessions and offers login when no cookie is available', async () => {
    const h = harness([401, { authenticated: false }], 's'.repeat(43))
    expect((await h.context.fetch('/api/v1/auth/session')).status).toBe(401)
    expect(h.storage.has(tokenKey)).toBe(false)
    expect(h.calls).toHaveLength(2)
  })

  it('preserves user levels, roles and CSRF without leaking credentials to other origins', async () => {
    const h = harness(
      [{ authenticated: true, permissionLevel: 8, roles: ['owner'], csrfToken: 'csrf' }, {}],
      'u'.repeat(43)
    )
    const response = await h.context.fetch('/api/v1/auth/session')
    expect(await response.json()).toMatchObject({
      permissionLevel: 8,
      roles: ['owner'],
      csrfToken: 'csrf',
    })
    await h.context.fetch('https://other.example/api/v1/test')
    expect(h.calls[1].headers.has('authorization')).toBe(false)
  })

  it('keeps service failures visible instead of silently downgrading to Guest', async () => {
    const h = harness([503])
    expect((await h.context.fetch('/api/v1/auth/session')).status).toBe(503)
    expect(h.calls).toHaveLength(1)
  })
})

const pendingKey = 'bifrost.pc.pending-login.v1'
function loginResponse() {
  return {
    id: 'r'.repeat(43),
    code: '1234-ABCD',
    expiresAt: Date.now() + 300_000,
    expiresInMs: 300_000,
    authorizationUrl: `https://bifrost.vanillacake.cn/api/v1/auth/pc-login/authorize?request=${'r'.repeat(43)}`,
  }
}
async function startLogin(h: ReturnType<typeof harness>) {
  return h.context.chrome.tabs.create({
    url: 'https://bifrost.vanillacake.cn/api/v1/auth/feishu/start',
  })
}

describe('PC system-browser login', () => {
  it.each([200, -200, 86_400_000, -86_400_000])(
    'accepts server clock skew of %i ms using a local deadline',
    async (skew) => {
      const started = Date.now()
      const h = harness([
        { ...loginResponse(), expiresAt: started + 300_000 + skew },
        { token: 'p'.repeat(43) },
      ])
      await startLogin(h)
      const pending = JSON.parse(h.storage.get(pendingKey)!)
      expect(pending.expiresAt).toBeGreaterThanOrEqual(started + 300_000)
      expect(pending.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000)
      expect(h.opened).toHaveLength(1)
      await h.tick(100)
      expect(h.reloaded()).toBe(true)
    }
  )

  it.each([0, -1, 300_001, '300000', null])(
    'rejects invalid relative expiry %s',
    async (expiresInMs) => {
      const h = harness([{ ...loginResponse(), expiresInMs }])
      await expect(startLogin(h)).rejects.toThrow('无效请求')
      expect(h.opened).toHaveLength(0)
    }
  )

  it('claims a session without cookies, BroadcastChannel or an opener and reloads', async () => {
    const h = harness([loginResponse(), 202, { token: 'p'.repeat(43) }])
    const result = await startLogin(h)
    expect(result.authHint).toContain('1234-ABCD')
    const pending = JSON.parse(h.storage.get(pendingKey)!)
    const challenge = JSON.parse(h.calls[0].init.body as string).challenge
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))
    expect(challenge).toBe(Buffer.from(digest).toString('base64url'))
    expect(h.opened[0]).not.toContain(pending.verifier)
    expect(h.opened[0]).not.toContain(challenge)
    await h.tick(100)
    expect(h.reloaded()).toBe(false)
    await h.tick(2_000)
    expect(h.storage.get(tokenKey)).toBe('p'.repeat(43))
    expect(h.storage.has(pendingKey)).toBe(false)
    expect(h.reloaded()).toBe(true)
    expect(h.timers.size).toBe(0)
    for (const call of h.calls) {
      expect(call.init.credentials).toBe('omit')
      expect(call.headers.has('authorization')).toBe(false)
    }
  })

  it('resumes after the panel is closed and reopened', async () => {
    const h = harness([loginResponse()])
    await startLogin(h)
    for (const listener of h.listeners.get('pagehide') || []) listener()
    expect(h.timers.size).toBe(0)
    const resumed = harness([{ token: 'p'.repeat(43) }], '', Object.fromEntries(h.storage))
    expect(resumed.context.BIFROST_PC_AUTH_HINT).toContain('1234-ABCD')
    await resumed.tick(100)
    expect(resumed.reloaded()).toBe(true)
    expect(resumed.opened).toHaveLength(0)
  })

  it('retries network failures but ends expired or denied requests', async () => {
    const h = harness([loginResponse(), new Error('offline'), 410])
    await startLogin(h)
    await h.tick(100)
    expect(h.timers.size).toBe(2)
    await h.tick(2_000)
    expect(h.reloaded()).toBe(false)
    expect(h.storage.has(pendingKey)).toBe(false)
    expect(h.events.at(-1)?.detail).toContain('失效')
    expect(h.timers.size).toBe(0)
  })

  it('times out and removes secrets even if the browser never responds', async () => {
    const h = harness([loginResponse()])
    await startLogin(h)
    const expiry = [...h.timers.values()].find((timer) => timer.delay > 100)!
    await h.tick(expiry.delay)
    expect(h.storage.has(pendingKey)).toBe(false)
    expect(h.events.at(-1)?.detail).toContain('超时')
    expect(h.timers.size).toBe(0)
  })

  it('rejects off-origin authorization URLs before opening the browser', async () => {
    const h = harness([{ ...loginResponse(), authorizationUrl: 'https://other.example/' }])
    await expect(startLogin(h)).rejects.toThrow('无效请求')
    expect(h.opened).toHaveLength(0)
    expect(h.storage.has(pendingKey)).toBe(false)
  })
})

it('rejects a malformed expiry in the packaged PC plugin', () => {
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    localStorage: {
      getItem: () => JSON.stringify({ preview: { expiresAt: 'invalid' } }),
      removeItem: () => undefined,
    },
  })
  vm.runInContext(readFileSync(new URL('./bifrost.js', import.meta.url), 'utf8'), context)
  const plugin = context.module.exports
  expect(plugin.readActive()).toBe(null)
  expect(() =>
    plugin.validateActive({ mode: 'remote', preview: { expiresAt: 'invalid', selections: [{}] } })
  ).toThrow()
})
