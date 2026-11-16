import type { Response } from 'express'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MemoryStore } from '@cuddly/db'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

import { oauthRandomToken, pkceChallenge } from './auth'
import { McpOAuthProvider } from './mcp-provider'

async function fixture(statePath?: string) {
  const store = new MemoryStore()
  let now = Date.now()
  const resource = new URL('https://bifrost.example.test/api/v1/mcp')
  const provider = new McpOAuthProvider({
    store,
    resource: resource.href,
    now: () => now,
    statePath,
  })
  const client = await provider.clientsStore.registerClient!({
    client_name: 'test',
    redirect_uris: ['http://127.0.0.1:12345/callback'],
    token_endpoint_auth_method: 'none',
  })
  const session = {
    token: oauthRandomToken(),
    csrfToken: oauthRandomToken(),
    name: 'User',
    tenantKey: 't',
    openId: 'u',
    unionId: '',
    avatarUrl: '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 2 * 86400_000).toISOString(),
  }
  await store.createAuthSession(session)
  async function authorize() {
    let redirect = ''
    await provider.authorize(
      client,
      {
        resource,
        redirectUri: client.redirect_uris[0]!,
        codeChallenge: pkceChallenge(oauthRandomToken()),
        scopes: ['bifrost:read'],
        state: 'state',
      },
      {
        redirect: (_status: number, url: string) => {
          redirect = url
        },
      } as Response
    )
    return new URL(redirect, resource).searchParams.get('request')!
  }
  async function code() {
    const pending = await authorize()
    const redirect = provider.complete(pending, session, true, 1)
    return new URL(redirect).searchParams.get('code')!
  }
  async function exchange(value: string, requestClient = client) {
    return provider.exchangeAuthorizationCode(
      requestClient,
      value,
      undefined,
      client.redirect_uris[0],
      resource
    )
  }
  return {
    provider,
    client,
    session,
    resource,
    store,
    authorize,
    code,
    exchange,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('MCP OAuth expiry and binding', () => {
  it('migrates old OAuth connections without breaking tokens or broadening their API sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bifrost-permissions-'))
    const statePath = join(directory, 'state.json')
    try {
      const f = await fixture(statePath)
      const tokens = await f.exchange(await f.code())
      const connection = await f.provider.resolve(tokens.access_token)
      await f.store.deleteAuthSession(connection.apiToken)
      await f.store.createAuthSession({ ...f.session, token: connection.apiToken })
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      state.version = 1
      for (const item of Object.values(state.connections) as Record<string, unknown>[]) {
        item.mode = 'read'
        delete item.permissionLevel
      }
      writeFileSync(statePath, JSON.stringify(state))
      const migrated = new McpOAuthProvider({
        store: f.store,
        resource: f.resource.href,
        statePath,
      })
      expect((await migrated.verifyAccessToken(tokens.access_token)).scopes).toEqual([
        'bifrost:level:1',
      ])
      expect(await f.store.getAuthSession(connection.apiToken)).toMatchObject({
        permissionCeiling: 1,
      })
      const saved = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(saved.version).toBe(2)
      expect(Object.values(saved.connections)[0]).toMatchObject({ permissionLevel: 1 })
      expect(JSON.stringify(saved)).not.toContain('"mode"')
      const refreshed = await migrated.exchangeRefreshToken(
        f.client,
        tokens.refresh_token!,
        ['bifrost:level:0'],
        f.resource
      )
      await migrated.verifyAccessToken(refreshed.access_token)
      expect(await f.store.getAuthSession(connection.apiToken)).toMatchObject({
        permissionCeiling: 0,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('expires pending requests and single-use authorization codes', async () => {
    const f = await fixture()
    const id = await f.authorize()
    f.advance(600_001)
    expect(f.provider.getPending(id)).toBeUndefined()
    const code = await f.code()
    f.advance(60_001)
    await expect(f.exchange(code)).rejects.toThrow('Invalid code')
  })

  it('binds codes and refresh tokens to clients and the exact audience', async () => {
    const f = await fixture()
    const other = { ...f.client, client_id: oauthRandomToken() } as OAuthClientInformationFull
    const code = await f.code()
    await expect(f.exchange(code, other)).rejects.toThrow()
    const tokens = await f.exchange(code)
    await expect(
      f.provider.exchangeRefreshToken(other, tokens.refresh_token!, undefined, f.resource)
    ).rejects.toThrow()
    await expect(f.provider.exchangeRefreshToken(f.client, tokens.refresh_token!)).rejects.toThrow(
      'resource'
    )
    await expect(f.provider.resolve(f.session.token)).rejects.toThrow('Invalid MCP token')
    const auth = await f.provider.verifyAccessToken(tokens.access_token)
    expect(auth.resource?.href).toBe(f.resource.href)
  })

  it('expires access tokens, permits refresh within lifetime and expires the connection', async () => {
    const f = await fixture()
    const tokens = await f.exchange(await f.code())
    f.advance(3600_001)
    await expect(f.provider.resolve(tokens.access_token)).rejects.toThrow('expired')
    const second = await f.provider.exchangeRefreshToken(
      f.client,
      tokens.refresh_token!,
      undefined,
      f.resource
    )
    expect((await f.provider.verifyAccessToken(second.access_token)).scopes).toEqual([
      'bifrost:level:1',
    ])
    f.advance(2 * 86400_000)
    await expect(
      f.provider.exchangeRefreshToken(f.client, second.refresh_token!, undefined, f.resource)
    ).rejects.toThrow('expired')
    await expect(f.provider.resolve(second.access_token)).rejects.toThrow()
  })

  it('honors internal session revocation and prevents concurrent code redemption', async () => {
    const f = await fixture()
    const code = await f.code()
    const results = await Promise.allSettled([f.exchange(code), f.exchange(code)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const success = results.find(
      (result) => result.status === 'fulfilled'
    ) as PromiseFulfilledResult<{
      access_token: string
    }>
    const connection = await f.provider.resolve(success.value.access_token)
    await f.store.deleteAuthSession(connection.apiToken)
    await expect(f.provider.resolve(success.value.access_token)).rejects.toThrow()
  })
})
