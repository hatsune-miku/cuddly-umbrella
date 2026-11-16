import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  // Keep deployable images independent of the host's workspace dependency links.
  noExternal: [/.*/],
  external: ['pg'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
