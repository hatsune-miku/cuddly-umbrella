import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as Cake from '@a1knla/cakeui'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const extension = path.join(root, 'apps/browser-extension')
const css = require.resolve('@a1knla/cakeui/style.css')
function descriptor(component, props = {}) {
  const markup = renderToStaticMarkup(createElement(component, props))
  const first = markup.match(/^<([\w-]+)\s*([^>]*)>/)
  if (!first) throw new Error('CakeUI must render a native root')
  return {
    tag: first[1],
    attributes: Object.fromEntries(
      [...first[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])
    ),
  }
}
const primitives = {
  provider: descriptor(Cake.CakeProvider, { theme: 'blue', mode: 'light', density: 'compact' }),
  button: descriptor(Cake.Button, { size: 'small' }),
  text: descriptor(Cake.TextBox),
  number: descriptor(Cake.NumberBox),
  select: descriptor(Cake.ComboBox),
  textarea: descriptor(Cake.TextArea),
  spinner: descriptor(Cake.Spinner, { size: 'small', 'aria-label': '正在加载' }),
  badge: descriptor(Cake.Badge),
  progress: descriptor(Cake.ProgressBar),
}
await writeFile(
  path.join(extension, 'cakeui-primitives.js'),
  `// Generated from @a1knla/cakeui 0.1.0; do not hand-edit.\nexport const cakePrimitives = ${JSON.stringify(primitives, null, 2)}\n`
)
await copyFile(css, path.join(extension, 'cakeui.css'))
await copyFile(
  path.join(root, 'packages/ui-theme/theme.css'),
  path.join(extension, 'cakeui-theme.css')
)
const help = path.join(root, 'apps/console/public/help')
await mkdir(help, { recursive: true })
await copyFile(css, path.join(help, 'cakeui.css'))
await copyFile(path.join(root, 'packages/ui-theme/theme.css'), path.join(help, 'cakeui-theme.css'))
// Standalone OAuth pages can use the same vendored stylesheet without loading console JS.
const publicUi = path.join(root, 'apps/console/public/ui')
await mkdir(publicUi, { recursive: true })
await copyFile(css, path.join(publicUi, 'cakeui.css'))
await copyFile(
  path.join(root, 'packages/ui-theme/theme.css'),
  path.join(publicUi, 'cakeui-theme.css')
)
await copyFile(path.join(root, 'packages/ui-theme/auth.css'), path.join(publicUi, 'auth.css'))
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'))
console.log(
  `[ui] CakeUI 0.1.0 assets ready for console, extension ${manifest.version}, PC and help.`
)
