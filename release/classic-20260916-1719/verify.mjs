import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const origin = 'https://bifrost.vanillacake.cn'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const index = await readFile(path.join(root, 'apps/console/dist/index.html'), 'utf8')
const bundles = [...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1])
for (const url of ['/', ...bundles, '/help/', '/help/guide.css', '/help/images/console-projects.png', '/help/images/extension-projects.png', '/pc-plugin/', '/pc-plugin/cake-layout.css', '/pc-plugin/cakeui-dom.js', '/pc-plugin/cakeui.css', '/ui/cakeui.css', '/ui/cakeui-theme.css', '/ui/auth.css']) {
  const response = await fetch(origin + url)
  assert.equal(response.status, 200, url)
  const relative = url.endsWith('/') ? `${url}index.html` : url
  const local = await readFile(path.join(root, 'apps/console/dist', relative.slice(1)))
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(local), `${url}: deployment hash`)
  console.log(`Verified deployed asset ${url}`)
}
const session = await fetch(origin + '/api/v1/auth/session')
assert.equal(session.status, 401, 'Anonymous API requests must still require authentication')
const complete = await fetch(origin + '/api/v1/auth/feishu/complete')
assert.equal(complete.status, 200)
assert.match(complete.headers.get('content-security-policy'), /style-src 'self'/)
assert.match(await complete.text(), /href="\/ui\/cakeui.css"/)

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe' })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('link', { name: '使用飞书登录' }).waitFor()
  assert.equal(await page.locator('.cake-theme[data-theme="blue"]').count(), 1)
  assert.equal(await page.locator('.auth-action.cake-button').count(), 1)
  await page.screenshot({ path: path.join(here, 'live-login.png'), animations: 'disabled' })
  await page.addInitScript(() => { window.close = () => {} })
  await page.goto(origin + '/api/v1/auth/feishu/complete')
  await page.getByRole('button', { name: '关闭此页' }).waitFor()
  assert.equal(await page.locator('#close-page').evaluate(el => getComputedStyle(el).borderRadius), '10px')
  await page.screenshot({ path: path.join(here, 'live-oauth-complete.png'), animations: 'disabled' })
  assert.deepEqual(errors, [])
  console.log('Live login, OAuth completion, CakeUI rendering and unchanged anonymous authorization verified.')
} finally {
  await browser.close()
}
