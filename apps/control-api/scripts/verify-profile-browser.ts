import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { MemoryStore } from '@cuddly/db'
import { createControlApp } from '../src/app'
import { FeishuOAuthClient } from '../src/auth'

const playwrightPath =
  process.env.PLAYWRIGHT_MODULE ||
  'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const chromiumPath =
  process.env.CHROMIUM_PATH ||
  'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe'
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const store = new MemoryStore()
const session = await store.createAuthSession({
  token: 'isolated-browser-test',
  kind: 'browser',
  tenantKey: 'fixture',
  openId: 'profile-test',
  unionId: '',
  name: 'Synthetic Private Person',
  avatarUrl: '',
  csrfToken: 'isolated-csrf',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
})
const user = (await store.getUserAccount(session))!
await store.updateUserPermissions(
  user.id,
  { permissionLevel: 0, roles: [], expectedRevision: user.revision },
  'fixture'
)
const app = createControlApp({
  store,
  internalApiToken: 'fixture',
  settingsSecret: 'fixture',
  auth: {
    publicOrigin: 'https://fixture.test',
    client: new FeishuOAuthClient({
      appId: 'fake',
      appSecret: 'fake',
      redirectUri: 'https://fixture.test/callback',
    }),
  },
})
app.use(express.static(path.resolve('apps/console/dist')))
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.resolve('apps/console/dist/index.html'))
})
const http = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => http.once('listening', resolve))
const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 } })
  await context.addCookies([
    { name: 'cuddly_session', value: 'isolated-browser-test', url: origin },
  ])
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('response', async (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 400) console.log('HTTP', response.status(), response.url())
  })
  let privateRequests = 0
  const errors: string[] = []
  page.on('request', (request: { url: () => string }) => {
    if (request.url().includes('/me/private-profile')) privateRequests++
  })
  page.on('pageerror', (error: Error) => errors.push(error.message))
  await page.goto(`${origin}/settings/profile`)
  console.log('Opened profile')
  const input = page.getByRole('textbox', { name: '名字', exact: true })
  await input.waitFor()
  await page.waitForFunction(() => !(document.querySelector('input') as HTMLInputElement)?.disabled)
  console.log('Profile loaded')
  assert.equal(await input.inputValue(), user.displayName)
  assert.ok(!(await page.locator('body').innerText()).includes('Synthetic Private Person'))
  assert.equal(privateRequests, 0)
  await input.fill('测试公开名字')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor()
  console.log('Name saved')
  await mkdir('output/profile-review', { recursive: true })
  await page.screenshot({ path: 'output/profile-review/profile-desktop.png', fullPage: true })
  await page.getByRole('link', { name: '账号与登录', exact: true }).click()
  await page.getByRole('link', { name: /飞书账号.*账号详情/ }).waitFor()
  assert.equal(privateRequests, 0)
  await page.getByRole('link', { name: /飞书账号.*账号详情/ }).click()
  await page.getByText('Synthetic Private Person', { exact: true }).waitFor()
  assert.ok(privateRequests > 0)
  await page.screenshot({ path: 'output/profile-review/private-detail.png', fullPage: true })
  await page.getByRole('link', { name: '返回账号与登录' }).click()
  assert.ok(!(await page.locator('body').innerText()).includes('Synthetic Private Person'))
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('link', { name: '个人资料', exact: true }).click()
  await page.waitForFunction(() => !(document.querySelector('input') as HTMLInputElement)?.disabled)
  assert.equal(await input.inputValue(), '测试公开名字')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )
  await page.screenshot({ path: 'output/profile-review/profile-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    'Profile browser checks passed: level 0 rename, no private prefetch, account detail navigation, private unmount, mobile layout, no runtime errors.'
  )
} finally {
  await browser.close()
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
}
