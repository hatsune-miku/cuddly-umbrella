import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { MemoryStore } from '@cuddly/db'

import { createControlApp } from '../../control-api/src/app'
import { FeishuOAuthClient, oauthRandomToken } from '../../control-api/src/auth'
import { login } from '../src/login'
import { BifrostClient } from '../src/client'

// Optional UI verification on the maintainer's workstation. Uses an isolated memory API/session,
// never opens the real user's browser or performs live builds.
const playwrightPath = process.env.PLAYWRIGHT_MODULE ||
  'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const chromiumPath = process.env.CHROMIUM_PATH ||
  'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe'
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const store = new MemoryStore()
const token = oauthRandomToken()
await store.createAuthSession({
  token, tenantKey: 'fixture', openId: 'fixture-user', unionId: '',
  name: 'QA · MCP 验证', avatarUrl: '', csrfToken: oauthRandomToken(),
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
})
const app = createControlApp({
  store, internalApiToken: 'fixture-only', settingsSecret: 'fixture-only',
  auth: { publicOrigin: 'https://fixture.test', client: new FeishuOAuthClient({
    appId: 'fixture', appSecret: 'fixture', redirectUri: 'https://fixture.test/api/v1/auth/feishu/callback',
    fetchImpl: async () => { throw new Error('No external OAuth traffic allowed') },
  }) },
})
// Fixture assets only; production serves these from the existing console image.
app.get('/ui/:asset', async (req, res) => {
  const file = path.resolve('apps/console/public/ui', req.params.asset)
  if (!['auth.css', 'cakeui.css'].includes(req.params.asset)) return res.sendStatus(404)
  res.sendFile(file)
})
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const directory = await mkdtemp(path.join(tmpdir(), 'bifrost-mcp-browser-'))
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true })
let interaction: Promise<void> | undefined
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 } })
  await context.addCookies([{ name: 'cuddly_session', value: token, url: origin }])
  const page = await context.newPage()
  const errors: string[] = []
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const credential = await login({
    origin, directory, timeoutMs: 15000,
    open: (url) => {
      interaction = (async () => {
        await page.goto(url)
        await page.getByRole('button', { name: '授权本机 MCP' }).waitFor()
        await mkdir('output/mcp-review', { recursive: true })
        await page.screenshot({ path: 'output/mcp-review/authorize.png', fullPage: true })
        await page.setViewportSize({ width: 360, height: 800 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        await page.screenshot({ path: 'output/mcp-review/authorize-mobile.png', fullPage: true })
        await page.getByRole('button', { name: '授权本机 MCP' }).click()
        await page.waitForURL(/\/callback\?/)
      })()
    },
  })
  await interaction
  assert.ok(!errors.some((message) => /form-action|Content Security Policy|Refused to send form/i.test(message)), errors.join('\n'))
  const client = new BifrostClient({ origin, token: async () => credential.token })
  const session = await client.request({ path: '/api/v1/auth/session' }) as { identity: { name: string } }
  assert.equal(session.identity.name, (await store.getAuthSession(token))!.name)
  assert.notEqual(session.identity.name, 'QA · MCP 验证')
  await client.request({ method: 'POST', path: '/api/v1/auth/logout' })
  assert.equal(await store.getAuthSession(credential.token), null)
  assert.ok(await store.getAuthSession(token))
  console.log('Browser consent -> loopback callback -> PKCE exchange -> API session -> logout passed; desktop/mobile screenshots saved.')
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
