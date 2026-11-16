import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/guanz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
)
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = await mkdtemp(path.join(tmpdir(), 'bifrost-sidepanel-check-'))
let browser
try {
  browser = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath:
      process.env.CHROMIUM_PATH ||
      'C:/Users/guanz/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe',
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  })
  const worker = browser.serviceWorkers()[0] || (await browser.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).hostname
  const page = await browser.newPage()
  await page.goto(`chrome-extension://${id}/popup.html`)
  const behavior = await page.evaluate(() => chrome.sidePanel.getPanelBehavior())
  assert.equal(behavior.openPanelOnActionClick, true)
  assert.equal(
    await page.evaluate(() => chrome.runtime.getManifest().action.default_popup),
    undefined
  )
  assert.equal((await page.evaluate(() => chrome.sidePanel.getOptions({}))).path, 'sidepanel.html')
  // Open from a genuine extension-page user gesture; this exercises Chrome's API, not a mock.
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'test-open-panel'
    button.textContent = 'Open test side panel'
    button.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'
    button.onclick = async () => {
      try {
        const current = await chrome.windows.getCurrent()
        await chrome.sidePanel.open({ windowId: current.id })
        document.body.dataset.panelOpened = 'yes'
      } catch (error) {
        document.body.dataset.panelError = String(error)
      }
    }
    document.body.append(button)
  })
  await page.locator('#test-open-panel').click()
  await page.waitForFunction(
    () => document.body.dataset.panelOpened || document.body.dataset.panelError
  )
  assert.equal(await page.evaluate(() => document.body.dataset.panelError), undefined)
  // Chrome exposes its panel as an extension view even after the bootstrap redirect.
  await page.waitForFunction(() =>
    chrome.extension
      .getViews()
      .some(
        (view) =>
          view.location.href.endsWith('popup.html?sidepanel=1') &&
          view.document.documentElement.classList.contains('sidepanel')
      )
  )
  console.log(
    'Real Chromium: extension loaded; toolbar Side Panel behavior enabled; panel opened and bootstrapped shared UI.'
  )
} finally {
  await browser?.close()
  await rm(profile, { recursive: true, force: true })
}
