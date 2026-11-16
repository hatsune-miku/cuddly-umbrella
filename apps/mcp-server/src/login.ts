import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { BifrostApiError, normalizeOrigin } from './client'
import { type Credential, saveCredential } from './credentials'

export function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.on('error', () => console.error('无法自动打开浏览器，请手动打开上方授权地址。'))
  child.unref()
}

export async function login(options: {
  origin: string
  directory?: string
  open?: (url: string) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<Credential> {
  const origin = normalizeOrigin(options.origin)
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const fetchImpl = options.fetchImpl || fetch
  let redirectUri = ''
  let claimed = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    let url: URL
    try {
      url = new URL(req.url || '/', redirectUri)
    } catch {
      res.writeHead(400).end('无效的 MCP 回调')
      return
    }
    const suppliedState = url.searchParams.get('state') || ''
    if (
      claimed ||
      req.method !== 'GET' ||
      url.pathname !== '/callback' ||
      req.headers.host !== new URL(redirectUri).host ||
      !/^[A-Za-z0-9_-]{43}$/.test(suppliedState) ||
      !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))
    ) {
      res.writeHead(400).end('无效的 MCP 回调')
      return
    }
    if (url.searchParams.get('error')) {
      claimed = true
      res.end('已取消授权，可以关闭本页。')
      rejectCode(new BifrostApiError('ACCESS_DENIED', '你已取消 MCP 授权'))
      return
    }
    const code = url.searchParams.get('code') || ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      res.writeHead(400).end('无效的授权码')
      return
    }
    claimed = true
    res.end('已收到授权，可以关闭本页并返回终端查看登录结果。')
    resolveCode(code)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  redirectUri = `http://127.0.0.1:${port}/callback`
  const authorize = new URL('/api/v1/auth/mcp/authorize', origin)
  authorize.search = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: challenge }).toString()
  const timer = setTimeout(
    () => rejectCode(new BifrostApiError('LOGIN_TIMEOUT', '登录超时，请重新运行 login')),
    options.timeoutMs ?? 300_000
  )
  try {
    if (!options.open) console.error(`请在浏览器中确认授权：\n${authorize.href}`)
    ;(options.open || openBrowser)(authorize.href)
    const code = await codePromise
    const response = await fetchImpl(new URL('/api/v1/auth/mcp/token', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new BifrostApiError(
        'LOGIN_EXCHANGE_FAILED',
        `授权交换失败（HTTP ${response.status}），请重新登录；确认后端已支持 MCP`
      )
    const payload = (await response.json()) as Omit<Credential, 'origin'>
    const credential = { ...payload, origin }
    await saveCredential(credential, options.directory)
    return credential
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
