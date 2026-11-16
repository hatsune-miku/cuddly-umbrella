import { mcpPersonalTokenPattern } from '@cuddly/contracts'

export class BifrostApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'BifrostApiError'
  }
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('BIFROST_URL 必须是 HTTPS origin；仅本机调试允许 HTTP，不要带路径或凭据')
  return url.origin
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
}

const SECRET_KEY =
  /^(csrfToken|csrf|authorization|gitAuthorizationHeader|appSecret|password|subscriptionUrl|access_token|refresh_token|client_secret)$/i

function inputSecrets(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) =>
    SECRET_KEY.test(key) && typeof item === 'string' ? [item] : inputSecrets(item)
  )
}

export function redact(value: unknown, secrets: string[] = [], parentKey = ''): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]')
    return text
      .replace(/\bbfpat_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]')
      .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@')
      .replace(
        /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|AUTHORIZATION|API_KEY|ACCESS_KEY|COOKIE)[A-Z0-9_]*)=([^\s]+)/gi,
        '$1=[REDACTED]'
      )
      .replace(/(--(?:token|password|secret|api-key|access-key)(?:=|\s+))[^\s'"`]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:password|secret|key|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, parentKey))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        // Provider-private fields remain redacted defensively; identity.name is a Bifrost display name.
        SECRET_KEY.test(key) || ['realName', 'providerUsername', 'privateProfile'].includes(key)
          ? '[REDACTED]'
          : redact(item, secrets, key),
      ])
    )
  }
  return value
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > 4 * 1024 * 1024) {
        await reader.cancel()
        throw new BifrostApiError('RESPONSE_TOO_LARGE', '响应超过 4 MiB，请缩小查询范围')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new BifrostApiError(
      'INVALID_API_RESPONSE',
      `后端返回非 JSON 响应（HTTP ${response.status}）`,
      response.status
    )
  }
}

export class BifrostClient {
  readonly origin: string
  readonly displayOrigin: string
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly options: {
      origin: string
      displayOrigin?: string
      token: () => Promise<string>
      fetchImpl?: typeof fetch
    }
  ) {
    this.origin = normalizeOrigin(options.origin)
    this.displayOrigin = normalizeOrigin(options.displayOrigin || options.origin)
    this.fetchImpl = options.fetchImpl || fetch
  }

  private async send(input: ApiRequest, token: string, csrf?: string): Promise<unknown> {
    if (
      !input.path.startsWith('/api/v1/') ||
      input.path.includes('..') ||
      input.path.includes('?') ||
      input.path.includes('#') ||
      input.path.includes('\\')
    ) {
      throw new BifrostApiError('INVALID_API_PATH', '不允许任意 URL 或越界 API 路径')
    }
    const url = new URL(input.path, this.origin)
    for (const [key, value] of Object.entries(input.query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (input.body !== undefined) headers['content-type'] = 'application/json'
    if (csrf) headers['x-cuddly-csrf'] = csrf
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: input.method || 'GET',
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: 'error',
        signal,
      })
    } catch {
      throw new BifrostApiError(
        signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
        signal.aborted ? '请求已取消或超时' : '无法连接 Bifrost（不会自动重试写操作）；请检查地址、网络和服务状态'
      )
    }
    const payload = await boundedJson(response)
    if (!response.ok) {
      const error = payload as { code?: string; message?: string } | null
      throw new BifrostApiError(
        error?.code || `HTTP_${response.status}`,
        response.status === 401
          ? '凭据无效或已撤销，请在 Bifrost 主页的 MCP 接入中生成 Token 并更新配置'
          : String(
              redact(error?.message || `Bifrost HTTP ${response.status}`, [
                token,
                csrf || '',
                ...inputSecrets(input.body),
              ])
            ),
        response.status,
        redact(payload, [token, csrf || '', ...inputSecrets(input.body)])
      )
    }
    return payload
  }

  async request(input: ApiRequest): Promise<unknown> {
    if (input.method && input.method !== 'GET' && JSON.stringify(input.body)?.includes('[REDACTED]')) {
      throw new BifrostApiError('REDACTED_INPUT', '不能把脱敏占位符写回配置；请在管理后台修改包含秘密的设置')
    }
    const token = await this.options.token()
    const personal = mcpPersonalTokenPattern.test(token)
    if (!personal && !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new BifrostApiError('AUTH_REQUIRED', '请在 Bifrost 主页的 MCP 接入中生成 Token，并设置 BIFROST_MCP_TOKEN')
    }
    let csrf: string | undefined
    if (input.method && input.method !== 'GET') {
      const session = (await this.send({ path: '/api/v1/auth/session', signal: input.signal }, token)) as {
        csrfToken?: string
        guest?: boolean
      }
      if (session.guest) throw new BifrostApiError('FEISHU_REQUIRED', 'MCP 写操作不能使用访客身份')
      if (!personal && !session.csrfToken) throw new BifrostApiError('CSRF_MISSING', '会话缺少 CSRF 凭据，请重新登录')
      csrf = session.csrfToken
    }
    const data = await this.send(input, token, csrf)
    return redact(data, [token, csrf || '', ...inputSecrets(input.body)])
  }
}
