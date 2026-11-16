import type { Response } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthSession, CuddlyStore } from '@cuddly/db'
import { permissionLevelSchema } from '@cuddly/contracts'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { oauthRandomToken } from './auth'

export const MCP_PATH = '/api/v1/mcp'
export const MCP_OAUTH_PATH = '/api/v1/auth/mcp-http'
export const MCP_CONSENT_PATH = `${MCP_OAUTH_PATH}/consent`
export const MCP_SCOPES = [0, 1, 2, 4, 6, 8].map((level) => `bifrost:level:${level}`)
const ACCESS_SECONDS = 3600
const CONNECTION_MS = 7 * 24 * 3600_000

interface PendingAuthorization {
  clientId: string
  params: AuthorizationParams
  permissionLevel: number
  expires: number
}
interface Grant extends PendingAuthorization {
  session: AuthSession
}
interface Connection {
  clientId: string
  apiToken: string
  permissionLevel: number
  expires: number
  accessHash: string
  accessExpires: number
  refreshHash: string
  usedRefreshHashes: string[]
}
interface PersistentState {
  version: 2
  clients: Record<string, OAuthClientInformationFull>
  connections: Record<string, Connection>
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function scopePermissionLevel(scopes: string[] = []): number {
  if (!scopes.length) return 2
  const levels = scopes.map((scope) => {
    // Old OAuth clients may still send their original scopes; preserve, never broaden, those grants.
    const legacy: Record<string, number> = {
      'bifrost:read': 1,
      'bifrost:operate': 2,
      'bifrost:admin': 8,
    }
    if (Object.hasOwn(legacy, scope)) return legacy[scope]!
    if (!/^bifrost:level:(0|[1-9]\d*)$/.test(scope))
      throw new InvalidScopeError('Unsupported scope')
    const parsed = permissionLevelSchema.safeParse(Number(scope.slice('bifrost:level:'.length)))
    if (!parsed.success) throw new InvalidScopeError('Unsupported permission level')
    return parsed.data
  })
  return Math.max(...levels)
}

export class McpOAuthProvider implements OAuthServerProvider {
  private state: PersistentState = { version: 2, clients: {}, connections: {} }
  private pending = new Map<string, PendingAuthorization>()
  private codes = new Map<string, Grant>()
  readonly clientsStore: OAuthRegisteredClientsStore

  constructor(
    private readonly options: {
      store: CuddlyStore
      resource: string
      statePath?: string
      now?: () => number
    }
  ) {
    if (options.statePath && existsSync(options.statePath)) {
      const loaded = JSON.parse(readFileSync(options.statePath, 'utf8'))
      if (![1, 2].includes(loaded.version) || !loaded.clients || !loaded.connections) {
        throw new Error('Invalid MCP OAuth state; refusing to discard active credentials')
      }
      const connections: Record<string, Connection> = {}
      for (const [id, value] of Object.entries(loaded.connections)) {
        const connection = value as Connection & { mode?: string }
        const { mode, ...rest } = connection
        const level =
          loaded.version === 1
            ? scopePermissionLevel([`bifrost:${mode}`])
            : permissionLevelSchema.parse(connection.permissionLevel)
        connections[id] = { ...rest, permissionLevel: level }
      }
      this.state = { version: 2, clients: loaded.clients, connections }
      if (loaded.version === 1) this.save()
    }
    this.clientsStore = {
      getClient: (id) =>
        Object.hasOwn(this.state.clients, id) ? this.state.clients[id] : undefined,
      registerClient: async (input) => {
        if (Object.keys(this.state.clients).length >= 2048)
          throw new TooManyRequestsError('Client registry full')
        if (
          !input.redirect_uris.length ||
          input.redirect_uris.length > 8 ||
          (input.client_name?.length || 0) > 200 ||
          input.redirect_uris.some((uri) => {
            try {
              const url = new URL(uri)
              return (
                uri.length > 2048 ||
                Boolean(url.username || url.password || url.hash) ||
                (url.protocol !== 'https:' &&
                  !(
                    url.protocol === 'http:' &&
                    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
                  ))
              )
            } catch {
              return true
            }
          })
        )
          throw new InvalidClientMetadataError(
            'Use HTTPS or loopback redirect URIs without credentials/fragments'
          )
        const client = {
          ...input,
          client_id: oauthRandomToken(),
          client_id_issued_at: Math.floor(this.now() / 1000),
        }
        this.state.clients[client.client_id] = client
        this.save()
        return client
      },
    }
  }

  private now(): number {
    return (this.options.now || Date.now)()
  }

  acceptsOrigin(origin: string): boolean {
    return Object.values(this.state.clients).some((client) =>
      client.redirect_uris.some((uri) => new URL(uri).origin === origin)
    )
  }

  private save(): void {
    if (!this.options.statePath) return
    mkdirSync(dirname(this.options.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.options.statePath}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.options.statePath)
  }

  private target(resource?: URL): void {
    if (resource?.href !== this.options.resource)
      throw new InvalidTargetError('MCP resource parameter is required')
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.target(params.resource)
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length || 0) > 2048) {
      throw new InvalidGrantError('Invalid PKCE challenge or state')
    }
    for (const [key, value] of this.pending)
      if (value.expires <= this.now()) this.pending.delete(key)
    for (const [key, value] of this.codes) if (value.expires <= this.now()) this.codes.delete(key)
    if (this.pending.size + this.codes.size >= 512)
      throw new TooManyRequestsError('Too many pending authorizations')
    const id = oauthRandomToken()
    this.pending.set(id, {
      clientId: client.client_id,
      params,
      permissionLevel: scopePermissionLevel(params.scopes),
      expires: this.now() + 600_000,
    })
    res.redirect(303, `${MCP_CONSENT_PATH}?request=${id}`)
  }

  getPending(id: string): PendingAuthorization | undefined {
    const pending = this.pending.get(id)
    return pending && pending.expires > this.now() ? pending : undefined
  }

  complete(id: string, session: AuthSession, approved: boolean, permissionLevel: number): string {
    const pending = this.getPending(id)
    if (!pending) throw new InvalidGrantError('Authorization expired; reconnect from your client')
    if (
      !permissionLevelSchema.safeParse(permissionLevel).success ||
      permissionLevel > pending.permissionLevel
    ) {
      throw new InvalidScopeError('Consent cannot increase requested permissions')
    }
    this.pending.delete(id)
    const url = new URL(pending.params.redirectUri)
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state)
    if (approved) {
      const code = oauthRandomToken()
      this.codes.set(hash(code), {
        ...pending,
        permissionLevel,
        session,
        expires: this.now() + 60_000,
      })
      url.searchParams.set('code', code)
    } else url.searchParams.set('error', 'access_denied')
    return url.href
  }

  private grant(clientId: string, code: string): Grant {
    const grant = this.codes.get(hash(code))
    if (!grant || grant.clientId !== clientId || grant.expires <= this.now())
      throw new InvalidGrantError('Invalid code')
    return grant
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string
  ): Promise<string> {
    return this.grant(client.client_id, code).params.codeChallenge
  }

  private issue(connection: Connection): OAuthTokens {
    const access = `bmcp_${oauthRandomToken()}`
    const refresh = `brefresh_${oauthRandomToken()}`
    connection.accessHash = hash(access)
    connection.refreshHash = hash(refresh)
    connection.accessExpires = Math.min(connection.expires, this.now() + ACCESS_SECONDS * 1000)
    this.save()
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((connection.accessExpires - this.now()) / 1000)),
      scope: `bifrost:level:${connection.permissionLevel}`,
    }
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    this.target(resource)
    const grant = this.grant(client.client_id, code)
    if (redirectUri !== grant.params.redirectUri)
      throw new InvalidGrantError('Redirect URI mismatch')
    this.codes.delete(hash(code)) // Consume before any asynchronous work.
    const expires = Math.min(this.now() + CONNECTION_MS, Date.parse(grant.session.expiresAt))
    if (expires <= this.now()) throw new InvalidGrantError('Login expired')
    for (const [id, connection] of Object.entries(this.state.connections)) {
      if (connection.expires <= this.now()) delete this.state.connections[id]
    }
    if (Object.keys(this.state.connections).length >= 1024)
      throw new TooManyRequestsError('Connection registry full')
    const apiToken = oauthRandomToken()
    const user = await this.options.store.getUserAccount(grant.session)
    if (!user) throw new InvalidGrantError('A registered user is required')
    const permissionLevel = Math.min(
      grant.permissionLevel,
      user.permissionLevel,
      grant.session.permissionCeiling ?? Number.MAX_SAFE_INTEGER
    )
    await this.options.store.createAuthSession({
      ...grant.session,
      kind: 'mcp',
      token: apiToken,
      csrfToken: oauthRandomToken(),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      permissionCeiling: permissionLevel,
    })
    const connection: Connection = {
      clientId: client.client_id,
      apiToken,
      permissionLevel,
      expires,
      accessHash: '',
      accessExpires: 0,
      refreshHash: '',
      usedRefreshHashes: [],
    }
    this.state.connections[oauthRandomToken()] = connection
    return this.issue(connection)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.target(resource)
    const digest = hash(token)
    const entry = Object.entries(this.state.connections).find(
      ([, c]) =>
        c.clientId === client.client_id &&
        (c.refreshHash === digest || c.usedRefreshHashes.includes(digest))
    )
    if (!entry) throw new InvalidGrantError('Invalid refresh token')
    const [id, connection] = entry
    if (connection.refreshHash !== digest || connection.expires <= this.now()) {
      delete this.state.connections[id]
      this.save()
      await this.options.store.deleteAuthSession(connection.apiToken)
      throw new InvalidGrantError('Refresh token expired or reused; connection revoked')
    }
    const permissionLevel = scopes?.length
      ? scopePermissionLevel(scopes)
      : connection.permissionLevel
    if (permissionLevel > connection.permissionLevel)
      throw new InvalidScopeError('Cannot increase scope')
    // Rotate synchronously, before awaiting database work, to prevent parallel replay.
    connection.usedRefreshHashes.push(digest)
    connection.permissionLevel = permissionLevel
    if (connection.usedRefreshHashes.length > 2048)
      throw new InvalidGrantError('Reconnect to continue')
    return this.issue(connection)
  }

  async resolve(token: string): Promise<Connection> {
    if (!/^bmcp_[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError('Invalid MCP token')
    const connection = Object.values(this.state.connections).find(
      (c) => c.accessHash === hash(token)
    )
    if (
      !connection ||
      connection.accessExpires <= this.now() ||
      connection.expires <= this.now() ||
      !(await this.options.store.getAuthSession(connection.apiToken))
    )
      throw new InvalidTokenError('Token expired or revoked')
    // Also cap pre-migration API sessions. A delegated bearer never grants more than its consent.
    await this.options.store.limitAuthSession(connection.apiToken, connection.permissionLevel)
    return connection
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const connection = await this.resolve(token)
    return {
      token,
      clientId: connection.clientId,
      scopes: [`bifrost:level:${connection.permissionLevel}`],
      expiresAt: Math.floor(connection.accessExpires / 1000),
      resource: new URL(this.options.resource),
    }
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const digest = hash(request.token)
    for (const [id, connection] of Object.entries(this.state.connections)) {
      if (
        connection.clientId === client.client_id &&
        (connection.accessHash === digest ||
          connection.refreshHash === digest ||
          connection.usedRefreshHashes.includes(digest))
      ) {
        delete this.state.connections[id]
        this.save()
        await this.options.store.deleteAuthSession(connection.apiToken)
      }
    }
  }
}
