import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts', 'src/dns-hook.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
})
