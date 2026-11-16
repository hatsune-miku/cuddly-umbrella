import type { PermissionContext } from '@cuddly/contracts'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { BifrostApiError, BifrostClient, normalizeOrigin } from './client'
import { readCredential, removeCredential } from './credentials'
import { login } from './login'
import { createMcpServer } from './server'

async function main(): Promise<void> {
  const origin = normalizeOrigin(process.env.BIFROST_URL || 'https://bifrost.vanillacake.cn')
  const directory = process.env.BIFROST_CREDENTIALS_DIR || undefined
  const client = new BifrostClient({
    origin,
    token: async () =>
      process.env.BIFROST_MCP_TOKEN ||
      process.env.BIFROST_SESSION_TOKEN ||
      (await readCredential(origin, directory)).token,
  })
  const command = process.argv[2] || 'serve'
  if (command === 'login') {
    const credential = await login({ origin, directory })
    console.error(
      `已授权：${credential.identity.name}；有效期至 ${credential.expiresAt}。凭据已保存在本机用户目录，不会输出到对话。`
    )
    return
  }
  if (command === 'status') {
    console.error(JSON.stringify({ origin, session: await client.request({ path: '/api/v1/auth/session' }) }, null, 2))
    return
  }
  if (command === 'logout') {
    if (process.env.BIFROST_MCP_TOKEN) {
      console.error('静态 Token 请在 Bifrost 主页的 MCP 接入中撤销，再移除客户端配置。')
      return
    }
    try {
      await client.request({ method: 'POST', path: '/api/v1/auth/logout' })
    } catch (error) {
      if (!(error instanceof BifrostApiError) || !['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)) throw error
    }
    if (!process.env.BIFROST_SESSION_TOKEN) await removeCredential(origin, directory)
    console.error('已撤销当前 MCP 会话；不会退出浏览器中原来的飞书会话。')
    return
  }
  if (command !== 'serve') throw new Error('用法：node apps/mcp-server/dist/main.js [serve|login|status|logout]')
  const context = (await client.request({ path: '/api/v1/auth/session' })) as PermissionContext
  const server = createMcpServer(client, context)
  await server.connect(new StdioServerTransport())
  process.once('SIGINT', () => {
    void server.close()
  })
  process.once('SIGTERM', () => {
    void server.close()
  })
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof BifrostApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'MCP 启动失败'
  )
  process.exitCode = 1
})
