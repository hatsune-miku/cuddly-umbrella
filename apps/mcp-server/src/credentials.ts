import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { BifrostApiError, normalizeOrigin } from './client'

export interface Credential {
  origin: string
  token: string
  expiresAt: string
  identity: { name: string }
}

export function credentialPath(origin: string, directory = path.join(homedir(), '.config', 'bifrost', 'mcp')): string {
  const key = createHash('sha256').update(normalizeOrigin(origin)).digest('hex').slice(0, 24)
  return path.join(directory, `${key}.json`)
}

export async function saveCredential(credential: Credential, directory?: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential.token) || !Number.isFinite(Date.parse(credential.expiresAt))) {
    throw new BifrostApiError('INVALID_CREDENTIAL', '登录响应缺少有效凭据')
  }
  const file = credentialPath(credential.origin, directory)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(credential)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function readCredential(origin: string, directory?: string): Promise<Credential> {
  try {
    const credential = JSON.parse(await readFile(credentialPath(origin, directory), 'utf8')) as Credential
    if (credential.origin !== normalizeOrigin(origin) || !/^[A-Za-z0-9_-]{43}$/.test(credential.token))
      throw new Error()
    if (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()) {
      throw new BifrostApiError(
        'AUTH_EXPIRED',
        '旧版 MCP 登录已过期；请在 Bifrost 主页生成个人 Token 并设置 BIFROST_MCP_TOKEN'
      )
    }
    return credential
  } catch (error) {
    if (error instanceof BifrostApiError) throw error
    throw new BifrostApiError('AUTH_REQUIRED', '请在 Bifrost 主页的 MCP 接入中生成 Token，并设置 BIFROST_MCP_TOKEN')
  }
}

export async function removeCredential(origin: string, directory?: string): Promise<void> {
  await rm(credentialPath(origin, directory), { force: true })
}
