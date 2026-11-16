import assert from 'node:assert/strict'
import http from 'node:http'
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
const publicRoot = path.join(root, 'apps/console/public')
const output = path.join(root, 'output/help-review')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const file = path.resolve(
      publicRoot,
      '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname)
    )
    if (!file.startsWith(publicRoot + path.sep)) throw new Error('Invalid path')
    const data = await fs.readFile(file)
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = process.env.HELP_ORIGIN || `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_PATH ||
    'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
})
const errors = []
try {
  await fs.mkdir(output, { recursive: true })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
  })
  const screenshot = async (name) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.screen-frame img')].every((img) => {
        const box = img.getBoundingClientRect()
        return box.bottom < 0 || box.top > innerHeight || (img.complete && img.naturalWidth > 0)
      })
    )
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await page.screenshot({ path: path.join(output, name) })
  }
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      errors.push(`Unexpected external request: ${route.request().url()}`)
      return route.abort()
    }
    return route.continue()
  })
  assert.equal((await page.goto(origin + '/help/')).status(), 200)
  assert.equal(await page.locator('.guide-section').count(), 10)
  assert.equal(await page.locator('.screen-frame img').count(), 7)
  for (const img of await page.locator('.screen-frame img').all()) {
    await img.scrollIntoViewIfNeeded()
    await page.waitForFunction(
      (src) =>
        [...document.images].some(
          (el) => el.getAttribute('src') === src && el.complete && el.naturalWidth > 0
        ),
      await img.getAttribute('src')
    )
    await img.evaluate((el) => el.decode())
    assert.ok(await img.evaluate((el) => el.naturalWidth > 1000))
  }
  await page.goto(origin + '/help/')
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').textContent(), '跳到教程正文')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator(':focus').getAttribute('id'), 'help-content')
  const search = page.locator('#guide-search')
  await search.fill('localhost')
  const matches = await page.locator('.help-sidebar .chapter-link:visible').count()
  assert.ok(matches > 0 && matches < 10)
  await search.press('Enter')
  assert.notEqual(new URL(page.url()).hash, '#help-content')
  await search.fill('不存在的章节关键词-xyz')
  assert.equal(await page.locator('.help-sidebar .chapter-link:visible').count(), 0)
  assert.match(await page.locator('#search-status').textContent(), /没有匹配/)
  await search.press('Escape')
  assert.equal(await page.locator('.help-sidebar .chapter-link:visible').count(), 10)
  await page.locator('.help-sidebar a[href="#branches"]').click()
  const imageLink = page.locator('#branches [data-zoom]').first()
  await imageLink.click()
  assert.ok(await page.locator('#image-dialog').evaluate((el) => el.open))
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#image-dialog').evaluate((el) => el.open), false)
  assert.equal(
    await page.locator(':focus').getAttribute('data-zoom'),
    await imageLink.getAttribute('data-zoom')
  )
  await imageLink.click()
  await page.locator('#image-dialog button').click()
  assert.equal(await page.locator('#image-dialog').evaluate((el) => el.open), false)
  for (const [file, type] of [
    ['guide.pdf', 'application/pdf'],
    ['guide.md', 'text/plain'],
  ]) {
    const response = await page.request.get(origin + '/help/' + file)
    assert.equal(response.status(), 200)
    const contentType = response.headers()['content-type']
    assert.ok(
      contentType.startsWith(type) ||
        (file.endsWith('.md') && contentType.startsWith('application/octet-stream'))
    )
    if (file.endsWith('.md')) assert.match(await response.text(), /^# .+ 使用教程/)
    if (file.endsWith('.pdf'))
      assert.ok((await response.body()).subarray(0, 5).toString() === '%PDF-')
  }
  await page.goto(origin + '/help/')
  await screenshot('desktop-start.png')
  await page.locator('.help-sidebar a[href="#branches"]').click()
  await screenshot('desktop-branches.png')
  assert.equal(
    await page.locator('.help-sidebar [aria-current="location"]').getAttribute('href'),
    '#branches'
  )
  await page.goto(origin + '/help/#sharing')
  await page.reload()
  assert.equal(new URL(page.url()).hash, '#sharing')
  assert.ok(
    await page.locator('#sharing').evaluate((el) => Math.abs(el.getBoundingClientRect().top) < 250)
  )
  await screenshot('desktop-sharing.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/help/')
  assert.ok(await page.locator('.mobile-navigation').isVisible())
  await screenshot('mobile-start.png')
  await page.locator('.mobile-navigation summary').click()
  await page.locator('.mobile-navigation a[href="#branches"]').click()
  assert.equal(await page.locator('.mobile-navigation').evaluate((el) => el.open), false)
  for (const section of await page.locator('.guide-section').all()) {
    await section.scrollIntoViewIfNeeded()
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'No horizontal page overflow on mobile'
    )
  }
  await page.goto(origin + '/help/#branches')
  await screenshot('mobile-branches.png')
  assert.deepEqual(errors, [])
  console.log(
    '[help] Passed: 10 chapters, 7 images, local-only requests, CSP, search, anchors, dialog/keyboard, downloads and mobile layout.'
  )
  console.log(`[help] Review images: ${output}`)
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
