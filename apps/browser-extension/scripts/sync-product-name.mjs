import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(extensionRoot, '../..')
const productConfigPath = path.join(repositoryRoot, 'product.config.json')
const manifestPath = path.join(extensionRoot, 'manifest.json')
const kfcManifestPath = path.join(repositoryRoot, 'kfc.manifest.json')
const kfcExtensionManifestPath = path.join(extensionRoot, 'kfc.manifest.json')

const productConfig = JSON.parse(await readFile(productConfigPath, 'utf8'))
const productName = typeof productConfig.name === 'string' ? productConfig.name.trim() : ''
if (!productName || productName !== productConfig.name || productName.length > 40) {
  throw new Error('product.config.json name must be a trimmed string between 1 and 40 characters')
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedName = productName
const synchronized = []
if (manifest.name !== expectedName || manifest.short_name !== productName) {
  manifest.name = expectedName
  manifest.short_name = productName
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  synchronized.push('browser extension')
}

for (const [kfcPath, kfcName, label] of [
  [kfcManifestPath, expectedName, 'KFC website manifest'],
  [kfcExtensionManifestPath, `${productName} 浏览器插件`, 'KFC extension manifest'],
]) {
  if (existsSync(kfcPath)) {
    const kfcManifest = JSON.parse(await readFile(kfcPath, 'utf8'))
    if (kfcManifest.name !== kfcName) {
      kfcManifest.name = kfcName
      await writeFile(kfcPath, `${JSON.stringify(kfcManifest, null, 2)}\n`, 'utf8')
      synchronized.push(label)
    }
  }
}

if (synchronized.length > 0) {
  console.log(`[product] synchronized ${synchronized.join(' and ')} name: ${expectedName}`)
}
