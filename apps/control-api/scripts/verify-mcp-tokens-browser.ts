import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { MemoryStore } from '@cuddly/db'
import { createControlApp } from '../src/app'
import { FeishuOAuthClient, oauthRandomToken } from '../src/auth'

const playwrightPath =
  process.env.PLAYWRIGHT_MODULE ||
  'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const chromiumPath =
  process.env.CHROMIUM_PATH ||
  'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe'
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const store = new MemoryStore()
const cookie = oauthRandomToken()
const session = await store.createAuthSession({
  token: cookie,
  kind: 'browser',
  tenantKey: 'fixture',
  openId: 'mcp-ui-test',
  unionId: '',
  name: 'Private Synthetic Name',
  avatarUrl: '',
  csrfToken: oauthRandomToken(),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
})
const user = (await store.getUserAccount(session))!
await store.updateUserPermissions(
  user.id,
  { permissionLevel: 0, roles: [], expectedRevision: user.revision },
  'fixture'
)
const http: Server = createServer()
http.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => http.once('listening', resolve))
const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
const app = createControlApp({
  store,
  internalApiToken: 'fixture',
  settingsSecret: 'fixture',
  auth: {
    publicOrigin: origin,
    client: new FeishuOAuthClient({
      appId: 'fake',
      appSecret: 'fake',
      redirectUri: `${origin}/callback`,
    }),
  },
  mcp: { apiOrigin: origin },
})
app.use(express.static(path.resolve('apps/console/dist')))
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.resolve('apps/console/dist/index.html'))
})
http.on('request', app)
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true })
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await context.addCookies([{ name: 'cuddly_session', value: cookie, url: origin }])
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.goto(origin)
  await page.locator('summary.session-menu-trigger').click()
  await page.getByRole('link', { name: 'MCP 接入', exact: true }).click()
  await page.getByRole('heading', { name: 'MCP 接入', exact: true }).waitFor()
  const name = page.getByRole('textbox', { name: 'Token 名称', exact: true })
  await name.fill('工作电脑测试')
  await page.getByRole('button', { name: '生成 Token', exact: true }).click()
  const secret = page.getByRole('textbox', { name: '新生成的 Token', exact: true })
  await secret.waitFor()
  const token = await secret.inputValue()
  assert.match(token, /^bfpat_[A-Za-z0-9_-]{43}$/)
  assert.ok(!(await page.locator('body').innerText()).includes('Private Synthetic Name'))
  await page.getByRole('button', { name: '复制 JSON 配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已复制 JSON 配置' }).waitFor()
  const configuration = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
  assert.equal(configuration.mcpServers.bifrost.headers.Authorization, `Bearer ${token}`)
  assert.equal(configuration.mcpServers.bifrost.url, `${origin}/api/v1/mcp`)
  assert.ok(await store.getMcpTokenSession(token))
  await mkdir('output/mcp-token-review', { recursive: true })
  await page.screenshot({ path: 'output/mcp-token-review/generated-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 360, height: 900 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )
  await page.screenshot({ path: 'output/mcp-token-review/generated-mobile.png', fullPage: true })
  await page.reload()
  await page.getByText('工作电脑测试', { exact: true }).waitFor()
  assert.equal(await secret.count(), 0)
  assert.ok(!(await page.locator('body').innerText()).includes(token))
  assert.ok(
    !(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(
      token
    )
  )
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.getByRole('button', { name: '确认撤销', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已撤销' }).waitFor()
  assert.equal(await store.getMcpTokenSession(token), null)
  await page.getByText('暂无 Token', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  await context.clearCookies()
  const legacyCookie = oauthRandomToken()
  await store.createAuthSession({ ...session, token: legacyCookie, kind: 'legacy' })
  await context.addCookies([{ name: 'cuddly_session', value: legacyCookie, url: origin }])
  await page.reload()
  await page.getByRole('link', { name: '使用飞书登录', exact: true }).waitFor()
  console.log(
    'MCP Token UI passed: homepage entry at level 0, generate/copy JSON, one-time display, no browser storage, revoke, legacy re-login, 360px layout.'
  )
} finally {
  await browser.close()
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
}
