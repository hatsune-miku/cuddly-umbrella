import { describe, expect, it, vi } from 'vitest'

import {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  FeishuOAuthClient,
  FeishuOAuthError,
  feishuCallbackUri,
  parseCookieHeader,
  pkceChallenge,
  safeStringEqual,
  sanitizeReturnTo,
  withAuthError,
} from './auth'

const redirectUri = 'https://bifrost.vanillacake.cn/api/v1/auth/feishu/callback'

describe('Feishu OAuth client', () => {
  it('builds the official authorization URL with state and PKCE but no extra scope', () => {
    const client = new FeishuOAuthClient({
      appId: 'cli_test',
      appSecret: 'secret',
      redirectUri,
    })
    const url = new URL(client.authorizationUrl('state-value', 'challenge-value'))
    expect(url.origin + url.pathname).toBe(FEISHU_AUTHORIZE_URL)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cli_test',
      response_type: 'code',
      redirect_uri: redirectUri,
      state: 'state-value',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
    })
  })

  it('exchanges a one-time code with the v2 JSON endpoint and PKCE verifier', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, access_token: 'user-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const client = new FeishuOAuthClient({
      appId: 'cli_test',
      appSecret: 'secret',
      redirectUri,
      fetchImpl,
    })

    await expect(client.exchangeCode('one-time-code', 'pkce-verifier')).resolves.toBe(
      'user-access-token'
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(FEISHU_TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cli_test',
      client_secret: 'secret',
      code: 'one-time-code',
      redirect_uri: redirectUri,
      code_verifier: 'pkce-verifier',
    })
  })

  it('maps only the required user identity and does not expose upstream failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              name: ' 测试 用户 ',
              open_id: 'ou_test',
              union_id: 'on_test',
              tenant_key: 'tenant_test',
              avatar_middle: 'https://example.test/avatar.png',
              mobile: 'should-not-be-returned',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'secret leak' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    const client = new FeishuOAuthClient({
      appId: 'cli_test',
      appSecret: 'secret',
      redirectUri,
      fetchImpl,
    })

    await expect(client.fetchIdentity('access-token')).resolves.toEqual({
      tenantKey: 'tenant_test',
      openId: 'ou_test',
      unionId: 'on_test',
      name: '测试 用户',
      avatarUrl: 'https://example.test/avatar.png',
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FEISHU_USER_INFO_URL)
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer access-token'
    )
    await expect(client.exchangeCode('bad-code', 'verifier')).rejects.toMatchObject({
      name: 'FeishuOAuthError',
      code: 'TOKEN_EXCHANGE_FAILED',
      details: {
        httpStatus: 400,
        providerError: 'invalid_client',
      },
    } satisfies Partial<FeishuOAuthError>)
  })
})

describe('OAuth request safety helpers', () => {
  it('keeps callback and return locations on the configured HTTPS origin', () => {
    expect(feishuCallbackUri('https://bifrost.vanillacake.cn')).toBe(redirectUri)
    expect(sanitizeReturnTo('/s/abc?environment=shared#ready')).toBe(
      '/s/abc?environment=shared#ready'
    )
    expect(sanitizeReturnTo('//evil.example/path')).toBe('/')
    expect(sanitizeReturnTo('https://evil.example/path')).toBe('/')
    expect(withAuthError('/s/abc?x=1', 'access_denied')).toBe('/s/abc?x=1&auth_error=access_denied')
  })

  it('parses cookies, derives PKCE and compares secrets without length leakage', () => {
    expect(parseCookieHeader('a=one; encoded=hello%20world; broken=%ZZ')).toEqual({
      a: 'one',
      encoded: 'hello world',
      broken: '%ZZ',
    })
    expect(pkceChallenge('verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(safeStringEqual('same', 'same')).toBe(true)
    expect(safeStringEqual('short', 'a much longer value')).toBe(false)
  })
})
