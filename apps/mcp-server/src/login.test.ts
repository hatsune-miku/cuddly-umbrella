import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { credentialPath, readCredential, removeCredential, saveCredential } from './credentials'
import { login } from './login'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'bifrost-mcp-login-'))
  roots.push(root)
  return root
}

it('saves credentials outside the workspace, keyed by origin, and enforces expiry', async () => {
  const root = await directory()
  const value = {
    origin: 'https://bifrost.test',
    token: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + 100000).toISOString(),
    identity: { name: '测试' },
  }
  await saveCredential(value, root)
  expect(await readCredential(value.origin, root)).toEqual(value)
  expect(credentialPath('https://other.test', root)).not.toBe(credentialPath(value.origin, root))
  await expect(readCredential('https://other.test', root)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  await saveCredential({ ...value, expiresAt: '2000-01-01T00:00:00.000Z' }, root)
  await expect(readCredential(value.origin, root)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  await removeCredential(value.origin, root)
  await expect(readFile(credentialPath(value.origin, root))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts only the correct loopback callback state and exchanges a PKCE code without printing credentials', async () => {
  const root = await directory()
  const token = randomBytes(32).toString('base64url')
  const code = randomBytes(32).toString('base64url')
  let auth: URL
  let callbacks: Promise<void> | undefined
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://bifrost.test/api/v1/auth/mcp/token')
    const body = JSON.parse(String(init?.body))
    expect(body.code).toBe(code)
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge')
    )
    expect(init?.redirect).toBe('error')
    return Response.json({
      token,
      expiresAt: new Date(Date.now() + 100000).toISOString(),
      identity: { name: '测试用户' },
    })
  })
  const result = await login({
    origin: 'https://bifrost.test',
    directory: root,
    fetchImpl,
    timeoutMs: 5000,
    open: (url) => {
      auth = new URL(url)
      callbacks = (async () => {
        const callback = new URL(auth.searchParams.get('redirect_uri')!)
        expect(callback.hostname).toBe('127.0.0.1')
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', 'x'.repeat(43))
        expect((await fetch(callback)).status).toBe(400)
        callback.searchParams.set('state', '中'.repeat(43))
        expect((await fetch(callback)).status).toBe(400)
        callback.searchParams.set('state', auth.searchParams.get('state')!)
        expect((await fetch(callback)).status).toBe(200)
      })()
    },
  })
  await callbacks
  expect(result.token).toBe(token)
  expect((await readCredential('https://bifrost.test', root)).identity.name).toBe('测试用户')
  expect(fetchImpl).toHaveBeenCalledOnce()
})

it('cancellation and timeout do not save credentials', async () => {
  const root = await directory()
  let callbackRequest: Promise<Response> | undefined
  await expect(
    login({
      origin: 'https://bifrost.test',
      directory: root,
      timeoutMs: 1000,
      open: (url) => {
        const auth = new URL(url)
        const callback = new URL(auth.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', auth.searchParams.get('state')!)
        callback.searchParams.set('error', 'access_denied')
        callbackRequest = fetch(callback)
      },
    })
  ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  await callbackRequest
  await expect(
    login({
      origin: 'https://bifrost.test',
      directory: root,
      timeoutMs: 20,
      open: () => undefined,
    })
  ).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' })
  await expect(readCredential('https://bifrost.test', root)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
})
