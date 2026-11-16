import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(root, '../..')
const productConfig = JSON.parse(
  await readFile(path.join(repositoryRoot, 'product.config.json'), 'utf8')
)
const productName = typeof productConfig.name === 'string' ? productConfig.name.trim() : ''
if (!productName || productName !== productConfig.name || productName.length > 40) {
  throw new Error('product.config.json name must be a trimmed string between 1 and 40 characters')
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
if (manifest.manifest_version !== 3) throw new Error('Browser extension must use Manifest V3')
if (manifest.version !== '0.12.10')
  throw new Error('Browser extension release must be version 0.12.10')
if (Number(manifest.minimum_chrome_version) < 116) {
  throw new Error('Side Panel action behavior requires Chrome 116 or newer')
}
if (manifest.action?.default_popup) throw new Error('Toolbar action must open the Side Panel')
if (manifest.name !== productName || manifest.short_name !== productName) {
  throw new Error('Browser extension manifest product name is out of sync')
}
if (!manifest.permissions?.includes('alarms')) {
  throw new Error('Browser extension must declare the alarms permission')
}
if (
  !manifest.permissions?.includes('sidePanel') ||
  manifest.side_panel?.default_path !== 'sidepanel.html'
) {
  throw new Error('Browser extension must expose sidepanel.html through the Side Panel API')
}
for (const file of [
  'cakeui.css',
  'cakeui-theme.css',
  'cakeui-dom.js',
  'cakeui-primitives.js',
  'cake-layout.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'sidepanel.html',
  'sidepanel.js',
  'auth-session.js',
  'popup-state.js',
  'popup-tabs.js',
  'configuration-groups.js',
  'branch-picker.js',
  'build-queue.js',
  'build-history.js',
  'binding-selection.js',
  'environment-selection.js',
  'preview-routing.js',
  'extension-protocol.js',
  'in-place-url-rules.js',
  'service-worker.js',
  'in-place-hot-module-main.js',
  'in-place-hot-module-bridge.js',
]) {
  await readFile(path.join(root, file))
}
const inPlaceOrigins = [
  'https://*.kookapp.cn/*',
  'https://*.dev.chuanyuapp.com/*',
  'http://*.dev.chuanyuapp.com/*',
  'https://localhost/*',
  'http://localhost/*',
]
const mainContentScript = manifest.content_scripts?.find(
  (entry) => entry.world === 'MAIN' && entry.js?.includes('in-place-hot-module-main.js')
)
const bridgeContentScript = manifest.content_scripts?.find(
  (entry) => entry.world === 'ISOLATED' && entry.js?.includes('in-place-hot-module-bridge.js')
)
for (const contentScript of [mainContentScript, bridgeContentScript]) {
  if (
    !contentScript ||
    contentScript.run_at !== 'document_start' ||
    JSON.stringify(contentScript.matches) !== JSON.stringify(inPlaceOrigins)
  ) {
    throw new Error(
      'In-place hot-module scripts must run at document_start on every supported KOOK environment origin'
    )
  }
}

const popupHtml = await readFile(path.join(root, 'popup.html'), 'utf8')
for (const requiredId of [
  'module-list',
  'queue-list',
  'queue-summary',
  'build-queue-tab',
  'build-history-tab',
  'build-queue-panel',
  'build-history-panel',
  'build-history-summary',
  'build-history-refresh',
  'build-history-target',
  'build-history-status',
  'build-history-query',
  'build-history-list',
  'build-history-total',
  'build-history-page-size',
  'build-history-previous',
  'build-history-page',
  'build-history-next',
  'job-detail-dialog',
  'job-detail-content',
  'job-detail-retry',
  'job-detail-cancel',
  'apply-button-wrap',
  'projects-tab',
  'queue-tab',
  'projects-panel',
  'project-version-tabs',
  'requirements-tab',
  'branches-tab',
  'requirements-panel',
  'branches-panel',
  'requirements-list',
  'share-url-prefix',
  'share-url-hint',
  'configuration-group-edit-dialog',
  'configuration-group-delete-dialog',
  'branch-picker-dropdown',
  'branch-picker-search',
  'branch-picker-list',
  'branch-picker-count',
  'auth-gate',
  'login-button',
  'identity-panel',
  'identity-name',
  'logout-button',
  'workspace-tabs',
  'environment-bar',
  'environment-select',
  'active-title',
]) {
  if (!popupHtml.includes(`id="${requiredId}"`)) {
    throw new Error(`Browser extension popup is missing #${requiredId}`)
  }
}
if (popupHtml.includes('Proudly Crafted With CakeDesign.')) {
  throw new Error('Browser extension popup must not include the CakeDesign credit line')
}
if (popupHtml.includes('auth-gate-mark') || popupHtml.includes('>飞</span')) {
  throw new Error('Authentication UI must not present 飞 as a Feishu brand mark')
}
if (popupHtml.includes('branch-picker-dialog')) {
  throw new Error('Branch picker must use an anchored dropdown instead of a full-screen dialog')
}
if (
  !popupHtml.includes('<strong id="queue-title">全局构建队列</strong>') ||
  !popupHtml.includes('<span class="queue-title-credit">POWERED BY 打包嘟嘟</span>')
) {
  throw new Error('Build queue title must show the 打包嘟嘟 credit on a separate line')
}
const popupJs = await readFile(path.join(root, 'popup.js'), 'utf8')
const statusBarMarkup = popupHtml.match(/<footer\s+[^>]*id="status-bar"[^>]*>/s)?.[0] || ''
if (
  !popupJs.includes('elements.statusText.title = message') ||
  !popupJs.includes("elements.statusText.removeAttribute('title')") ||
  !statusBarMarkup.includes('role="status"') ||
  !statusBarMarkup.includes('aria-live="polite"') ||
  !statusBarMarkup.includes('aria-atomic="true"')
) {
  throw new Error(
    'Popup status messages must expose their complete text through title and an atomic live region'
  )
}
if (!popupJs.includes("api('/api/v1/environments')") || popupJs.includes('/matrix')) {
  throw new Error(
    'Popup environments must come from the environment catalog, not a Revision matrix'
  )
}
const previewRoutingJs = await readFile(path.join(root, 'preview-routing.js'), 'utf8')
if (!previewRoutingJs.includes('environmentSlug') || previewRoutingJs.includes('hasSelection')) {
  throw new Error('Preview routing must support environment-only all-official sessions')
}
for (const removedIdentityFeature of [
  'ACTOR_KEY',
  'ACTOR_ID_KEY',
  'actor-name',
  'x-cuddly-actor',
  'popup-identity',
]) {
  if (popupHtml.includes(removedIdentityFeature) || popupJs.includes(removedIdentityFeature)) {
    throw new Error(
      `Browser extension still contains custom actor behavior: ${removedIdentityFeature}`
    )
  }
}
for (const match of popupJs.matchAll(/document\.querySelector\('#([^']+)'\)/g)) {
  if (!popupHtml.includes(`id="${match[1]}"`)) {
    throw new Error(`popup.js references missing element #${match[1]}`)
  }
}
const popupCss = await readFile(path.join(root, 'popup.css'), 'utf8')
if (!popupCss.includes('width: 560px;') || !popupCss.includes('height: 600px;')) {
  throw new Error('Browser extension popup must stay within the Chromium 800x600 limit')
}
if (!popupCss.includes('grid-template-columns: minmax(166px, 0.32fr) minmax(180px, 1fr) auto;')) {
  throw new Error('Browser extension module rows must reserve 166px for project names')
}
if (!popupCss.includes('.queue-title > .queue-title-credit')) {
  throw new Error('Build queue credit must have a dedicated secondary text style')
}
if (
  !popupCss.includes('.module-loading-spinner') ||
  !popupJs.includes("elements.moduleList.setAttribute('aria-busy', 'true')") ||
  !popupJs.includes("spinner.setAttribute('aria-hidden', 'true')")
) {
  throw new Error('Browser extension module list must expose an accessible loading state')
}
if (!popupJs.includes('if (branch || isSite) {')) {
  throw new Error('Official Remote selections must omit the redundant module metadata row')
}
if (
  !popupJs.includes('api(buildHistoryQuery(filters))') ||
  !popupJs.includes('BUILD_HISTORY_STATUSES') ||
  !popupJs.includes('BUILD_HISTORY_PAGE_SIZES') ||
  !popupJs.includes("setBuildTaskTab('history', { refresh: true })")
) {
  throw new Error('Popup must expose the environment-scoped, filtered build history workflow')
}
if (popupJs.includes('scheduleBuildHistoryPoll') || popupJs.includes('BUILD_HISTORY_POLL_MS')) {
  throw new Error('Build history must refresh on demand instead of using the queue polling loop')
}
if (
  !popupCss.includes('.build-history-filters') ||
  !popupCss.includes('.build-history-pagination') ||
  !popupCss.includes('.build-history-item')
) {
  throw new Error('Popup build history must provide compact filters, records, and pagination')
}
const branchPickerJs = await readFile(path.join(root, 'branch-picker.js'), 'utf8')
if (popupJs.includes('queueJumpButton') || branchPickerJs.includes('showModal(')) {
  throw new Error('Popup still contains the legacy queue jump or modal branch picker behavior')
}
const authSessionJs = await readFile(path.join(root, 'auth-session.js'), 'utf8')
const serviceWorkerJs = await readFile(path.join(root, 'service-worker.js'), 'utf8')
const extensionProtocolJs = await readFile(path.join(root, 'extension-protocol.js'), 'utf8')
for (const [file, source] of [
  ['popup.html', popupHtml],
  ['popup.js', popupJs],
  ['service-worker.js', serviceWorkerJs],
  ['extension-protocol.js', extensionProtocolJs],
]) {
  if (source.includes(productName)) {
    throw new Error(
      `${file} must read the product name from manifest.json instead of hard-coding it`
    )
  }
}
if (!authSessionJs.includes("credentials: 'include'") || !popupJs.includes('csrfToken')) {
  throw new Error('Popup API requests must carry the authenticated session and CSRF token')
}
if (
  !serviceWorkerJs.includes('/api/v1/auth/session') ||
  !serviceWorkerJs.includes("'x-cuddly-csrf'") ||
  serviceWorkerJs.includes("credentials: 'omit'")
) {
  throw new Error('Service worker mutations must carry the authenticated session and CSRF token')
}
console.log('[browser-extension] manifest and entry files are valid')
