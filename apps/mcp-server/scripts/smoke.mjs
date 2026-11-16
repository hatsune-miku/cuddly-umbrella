import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
for (const personal of [false, true]) {
  const token = `${personal ? 'bfpat_' : ''}${'s'.repeat(43)}`
  for (const [permissionLevel, expectedCount] of [
    [0, 2],
    [1, 20],
    [2, 29],
    [4, 45],
    [6, 47],
    [8, 47],
  ]) {
    const fixture = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.headers.authorization !== `Bearer ${token}` || request.url !== '/api/v1/auth/session') {
        response.writeHead(404).end('{}')
        return
      }
      response.end(
        JSON.stringify({
          authenticated: true,
          identity: { name: 'Smoke fixture', avatarUrl: '' },
          permissionLevel,
          roles: [],
          csrfToken: 'fixture-csrf',
        })
      )
    })
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    const client = new Client({ name: 'bifrost-smoke', version: '2.0.0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        BIFROST_URL: `http://127.0.0.1:${fixture.address().port}`,
        BIFROST_SESSION_TOKEN: personal ? '' : token,
        BIFROST_MCP_TOKEN: personal ? token : '',
      },
      stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      assert.equal(tools.length, expectedCount)
      const guide = await client.readResource({ uri: 'bifrost://guide' })
      assert.equal(guide.contents[0].mimeType, 'text/markdown')
      const identity = await client.callTool({ name: 'bifrost_whoami', arguments: {} })
      assert.equal(identity.structuredContent.data.permissionLevel, permissionLevel)
      assert.deepEqual(identity.structuredContent.data.roles, [])
      assert.equal(JSON.stringify(identity).includes('fixture-csrf'), false)
      assert.equal(typeof identity.structuredContent.data.session.identity.name, 'string')
      assert.notEqual(identity.structuredContent.data.session.identity.name, '[REDACTED]')
      assert.equal(identity.structuredContent.data.session.identity.name, 'Smoke fixture')
      assert.equal(Object.hasOwn(identity.structuredContent.data, 'accessMode'), false)
      if (permissionLevel < 2) assert.ok(tools.every((tool) => tool.annotations.readOnlyHint))
      console.log(
        `${personal ? 'personal token' : 'legacy session'} level ${permissionLevel}: ${tools.length} tools, stdio handshake/resources/identity OK`
      )
    } finally {
      await client.close()
      await new Promise((resolve) => fixture.close(resolve))
    }
  }
}
