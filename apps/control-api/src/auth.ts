import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
export const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

export interface FeishuIdentity {
  tenantKey: string
  openId: string
  unionId: string
  name: string
  avatarUrl: string
}

export interface FeishuOAuthClientOptions {
  appId: string
  appSecret: string
  redirectUri: string
  fetchImpl?: typeof fetch
}

export class FeishuOAuthError extends Error {
  constructor(
    readonly code: 'TOKEN_EXCHANGE_FAILED' | 'USER_INFO_FAILED',
    readonly details?: {
      httpStatus: number
      providerCode?: string
      providerError?: string
      requestId?: string
    }
  ) {
    super(code)
    this.name = 'FeishuOAuthError'
  }
}

function textField(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : ''
}

export function oauthRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function safeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export function normalizePublicOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new Error('CUDDLY_PUBLIC_ORIGIN must be an HTTPS origin without a path')
  }
  return url.origin
}

export function feishuCallbackUri(publicOrigin: string): string {
  return `${normalizePublicOrigin(publicOrigin)}/api/v1/auth/feishu/callback`
}

export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) return '/'
  try {
    const parsed = new URL(value, 'https://cuddly.invalid')
    if (parsed.origin !== 'https://cuddly.invalid') return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

export function parseCookieHeader(value: string | undefined): Record<string, string> {
  if (!value) return {}
  const cookies: Record<string, string> = {}
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) continue
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      cookies[name] = part.slice(separator + 1).trim()
    }
  }
  return cookies
}

export function withAuthError(returnTo: string, error: string): string {
  const target = new URL(sanitizeReturnTo(returnTo), 'https://cuddly.invalid')
  target.searchParams.set('auth_error', error)
  return `${target.pathname}${target.search}${target.hash}`
}

export class FeishuOAuthClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: FeishuOAuthClientOptions) {
    if (!options.appId.trim() || !options.appSecret.trim()) {
      throw new Error('Feishu OAuth credentials are required')
    }
    this.fetchImpl = options.fetchImpl || fetch
  }

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL(FEISHU_AUTHORIZE_URL)
    url.searchParams.set('client_id', this.options.appId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', this.options.redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const body = {
      grant_type: 'authorization_code',
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      code,
      redirect_uri: this.options.redirectUri,
      code_verifier: verifier,
    }
    const response = await this.fetchImpl(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const accessToken = textField(payload?.access_token, 4_096)
    const providerCode =
      typeof payload?.code === 'number' || typeof payload?.code === 'string'
        ? String(payload.code).slice(0, 64)
        : ''
    const providerError = textField(payload?.error, 80)
    const requestId = textField(response.headers.get('x-tt-logid'), 160)
    if (!response.ok || providerError || (providerCode && providerCode !== '0') || !accessToken) {
      throw new FeishuOAuthError('TOKEN_EXCHANGE_FAILED', {
        httpStatus: response.status,
        ...(providerCode ? { providerCode } : {}),
        ...(providerError ? { providerError } : {}),
        ...(requestId ? { requestId } : {}),
      })
    }
    return accessToken
  }

  async fetchIdentity(accessToken: string): Promise<FeishuIdentity> {
    const response = await this.fetchImpl(FEISHU_USER_INFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    const payload = (await response.json().catch(() => null)) as {
      code?: unknown
      data?: Record<string, unknown>
    } | null
    const data = payload?.data
    const identity: FeishuIdentity = {
      tenantKey: textField(data?.tenant_key, 160),
      openId: textField(data?.open_id, 160),
      unionId: textField(data?.union_id, 160),
      name: textField(data?.name, 120),
      avatarUrl: textField(data?.avatar_middle || data?.avatar_big || data?.avatar_url, 2_048),
    }
    if (
      !response.ok ||
      payload?.code !== 0 ||
      !identity.tenantKey ||
      !identity.openId ||
      !identity.name
    ) {
      throw new FeishuOAuthError('USER_INFO_FAILED')
    }
    return identity
  }
}
