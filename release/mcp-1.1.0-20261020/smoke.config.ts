import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['apps/mcp-server/scripts/verify-http-login.ts'],
  format: ['esm'],
  outDir: 'output/mcp-http-bundle',
  noExternal: [/.*/],
  external: ['pg'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
