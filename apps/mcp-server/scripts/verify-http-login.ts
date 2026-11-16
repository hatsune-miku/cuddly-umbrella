import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { MemoryStore } from '@cuddly/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createControlApp } from '../../control-api/src/app'
import { FeishuOAuthClient, oauthRandomToken, pkceChallenge } from '../../control-api/src/auth'

// Isolated headless UI/protocol smoke fixture. Never uses real identity, storage, or builds.
const store = new MemoryStore()
const session = oauthRandomToken()
const csrf = oauthRandomToken()
await store.createAuthSession({
  token: session,
  csrfToken: csrf,
  tenantKey: 'fixture',
  openId: 'fixture-user',
  unionId: '',
  name: 'QA · 远程 MCP 验证',
  avatarUrl: '',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
})
const server = createServer()
server.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const resource = `${origin}/api/v1/mcp`
const app = createControlApp({
  store,
  settingsSecret: 'fixture-only',
  internalApiToken: 'fixture-only',
  auth: {
    publicOrigin: origin,
    client: new FeishuOAuthClient({
      appId: 'fixture',
      appSecret: 'fixture',
      redirectUri: `${origin}/api/v1/auth/feishu/callback`,
      fetchImpl: async () => {
        throw new Error('External OAuth forbidden in fixture')
      },
    }),
  },
  mcp: { apiOrigin: origin },
})
app.get('/ui/:asset', (req, res) => {
  if (!['auth.css', 'cakeui.css'].includes(req.params.asset)) {
    res.sendStatus(404)
    return
  }
  res.sendFile(path.resolve('apps/console/public/ui', req.params.asset))
})
server.on('request', app)
// A separate callback origin also verifies the consent form's redirect CSP.
const callback = createServer((_req, res) => {
  res.end('MCP connected; you may close this window.')
})
callback.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => callback.once('listening', resolve))
const redirectUri = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/callback`
let browser: any
const client = new Client({ name: 'bundled-http-smoke', version: '1' })
try {
  const response = await fetch(`${origin}/api/v1/auth/mcp-http/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: '远程 MCP 验证客户端',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  assert.equal(response.status, 201)
  const registered = (await response.json()) as { client_id: string }
  const verifier = oauthRandomToken()
  const authorizeUrl = `${origin}/api/v1/auth/mcp-http/authorize?${new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    resource,
    response_type: 'code',
    state: 'fixture-state',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    scope: 'bifrost:read bifrost:operate bifrost:admin',
  })}`
  let code: string
  if (process.env.SMOKE_NO_BROWSER === '1') {
    const started = await fetch(authorizeUrl, { redirect: 'manual' })
    const request = new URL(started.headers.get('location')!, origin).searchParams.get('request')!
    const approved = await fetch(`${origin}/api/v1/auth/mcp-http/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `cuddly_session=${session}` },
      body: new URLSearchParams({ request, csrf, decision: 'approve', permissionLevel: '2' }),
    })
    assert.equal(approved.status, 303)
    code = new URL(approved.headers.get('location')!).searchParams.get('code')!
  } else {
    const playwrightPath =
      process.env.PLAYWRIGHT_MODULE ||
      'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
    const { chromium } = await import(pathToFileURL(playwrightPath).href)
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROMIUM_PATH || 'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
    })
    const context = await browser.newContext({ viewport: { width: 1000, height: 820 } })
    await context.addCookies([{ name: 'cuddly_session', value: session, url: origin }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('console', (event: { type: () => string; text: () => string }) => {
      if (event.type() === 'error') errors.push(event.text())
    })
    await page.goto(authorizeUrl)
    await page.getByRole('button', { name: '授权连接', exact: true }).waitFor()
    assert.equal(await page.getByRole('spinbutton').inputValue(), '2')
    await mkdir('output/mcp-review', { recursive: true })
    await page.screenshot({ path: 'output/mcp-review/http-authorize.png', fullPage: true })
    await page.setViewportSize({ width: 360, height: 820 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: 'output/mcp-review/http-authorize-mobile.png', fullPage: true })
    await page.getByRole('button', { name: '授权连接', exact: true }).click()
    await page.waitForURL(`${redirectUri}?**`)
    assert.equal(
      errors.filter((message) => /form-action|Content Security Policy|Refused to send form/i.test(message)).length,
      0
    )
    const url = new URL(page.url())
    assert.equal(url.searchParams.get('state'), 'fixture-state')
    code = url.searchParams.get('code')!
  }
  const exchanged = await fetch(`${origin}/api/v1/auth/mcp-http/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: registered.client_id,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  })
  assert.equal(exchanged.status, 200)
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    })
  )
  assert.equal((await client.listTools()).tools.length, 29)
  const whoami = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
  assert.notEqual(whoami.isError, true)
  assert.ok(!JSON.stringify(whoami).includes('QA · 远程 MCP 验证'))
  assert.ok(JSON.stringify(whoami).includes('用户-'))
  const revoked = await fetch(`${origin}/api/v1/auth/mcp-http/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: registered.client_id, token: tokens.refresh_token }),
  })
  assert.equal(revoked.status, 200)
  console.log(
    'HTTP consent -> cross-origin callback -> PKCE -> real MCP handshake -> 29 tools -> public actor -> revocation passed.'
  )
} finally {
  await client.close()
  await browser?.close()
  for (const http of [server, callback]) {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}
