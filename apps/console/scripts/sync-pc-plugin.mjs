import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(consoleRoot, '..', '..')
const extensionRoot = path.join(repositoryRoot, 'apps', 'browser-extension')
const outputRoot = path.join(consoleRoot, 'public', 'pc-plugin')
const adapterSource = path.join(consoleRoot, 'pc-plugin', 'host-adapter.js')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
// Distribute the injector entry alongside the hosted UI; it does not run on the website.
await cp(path.join(consoleRoot, 'pc-plugin', 'bifrost.js'), path.join(outputRoot, 'bifrost.js'))

for (const filename of [
  'cakeui.css',
  'cakeui-theme.css',
  'cakeui-dom.js',
  'cakeui-primitives.js',
  'cake-layout.css',
  'auth-session.js',
  'binding-selection.js',
  'branch-picker.js',
  'build-history.js',
  'build-queue.js',
  'config-share.js',
  'configuration-groups.js',
  'environment-selection.js',
  'extension-protocol.js',
  'in-place-url-rules.js',
  'popup-state.js',
  'popup-tabs.js',
  'preview-routing.js',
  'popup.css',
  'popup.js',
]) {
  await cp(path.join(extensionRoot, filename), path.join(outputRoot, filename))
}
const extensionManifest = JSON.parse(
  await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')
)
const pcManifest = {
  name: `${extensionManifest.name} PC`,
  short_name: extensionManifest.short_name,
  version: extensionManifest.version,
}
const adapter = await readFile(adapterSource, 'utf8')
await writeFile(
  path.join(outputRoot, 'host-adapter.js'),
  `globalThis.BIFROST_PC_UI_MANIFEST = ${JSON.stringify(pcManifest)};\n${adapter}`,
  'utf8'
)

const popupHtml = await readFile(path.join(extensionRoot, 'popup.html'), 'utf8')
const pcHtml = popupHtml.replace(
  '<script type="module" src="popup.js"></script>',
  '<script src="host-adapter.js"></script>\n    <script type="module" src="popup.js"></script>'
)
await writeFile(path.join(outputRoot, 'index.html'), pcHtml, 'utf8')

console.log('[console] synced reusable browser-extension UI to /pc-plugin/')
