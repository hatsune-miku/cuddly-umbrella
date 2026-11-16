import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('console Nginx internal API isolation', () => {
  it('routes MCP discovery to the API and supports bounded long-running MCP calls', async () => {
    const config = await readFile(new URL('./console.nginx.conf', import.meta.url), 'utf8')
    expect(config).toContain('location ^~ /.well-known/oauth- {')
    expect(config).toContain('proxy_read_timeout 120s;')
    expect(config).toContain('proxy_buffering off;')
  })
  it('blocks the complete internal prefix without case sensitivity', async () => {
    const config = await readFile(new URL('./console.nginx.conf', import.meta.url), 'utf8')

    expect(config).toContain('location ~* ^/api/v1/internal(?:/|$) {')
    expect(config).not.toContain('location ^~ /api/v1/internal/')
  })

  it('serves the embedded PC plugin from its own static entry instead of the console SPA', async () => {
    const config = await readFile(new URL('./console.nginx.conf', import.meta.url), 'utf8')

    expect(config).toContain('location = /pc-plugin {')
    expect(config).toContain('location = /pc-plugin/ {')
    expect(config).toContain('try_files /pc-plugin/index.html =404;')
    expect(config).toContain('location ^~ /pc-plugin/ {')
    expect(config).toContain('try_files $uri =404;')
  })
})
