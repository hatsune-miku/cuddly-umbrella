import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import productConfig from '../../../product.config.json'
import { EXTENSION_NAME, PRODUCT_DISPLAY_NAME, PRODUCT_NAME } from './index'

describe('product branding', () => {
  it('derives every display title from the single configured product name', () => {
    expect(Object.keys(productConfig)).toEqual(['name'])
    expect(PRODUCT_NAME).toBe(productConfig.name)
    expect(PRODUCT_DISPLAY_NAME).toBe(productConfig.name)
    expect(EXTENSION_NAME).toBe(productConfig.name)
    expect(PRODUCT_DISPLAY_NAME).not.toContain(' QA')
  })

  it('keeps the configured brand out of production display string literals', async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const consumers = [
      'apps/console/index.html',
      'apps/console/src/main.tsx',
      'apps/console/src/App.tsx',
      'apps/console/src/AuthGate.tsx',
      'apps/console/src/BranchPicker.tsx',
      'apps/console/src/ShareLanding.tsx',
      'apps/browser-extension/popup.html',
      'apps/browser-extension/popup.js',
      'apps/browser-extension/service-worker.js',
      'apps/browser-extension/extension-protocol.js',
      'apps/gateway/src/app.ts',
      'apps/runner-agent/src/runner.ts',
    ]

    for (const relativePath of consumers) {
      const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8')
      const hardCodedLines = source.split(/\r?\n/).filter((line) => {
        const brandIndex = line.indexOf(PRODUCT_NAME)
        if (brandIndex < 0) return false
        return ["'", '"', '`'].some((quote) => {
          const quoteIndex = line.indexOf(quote)
          return quoteIndex >= 0 && quoteIndex < brandIndex
        })
      })
      expect(hardCodedLines, `${relativePath} hard-codes ${PRODUCT_NAME}`).toEqual([])
    }
  })
})
