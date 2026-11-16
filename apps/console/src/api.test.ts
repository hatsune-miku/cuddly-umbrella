import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearCachedAuthSession,
  createConfigurationGroup,
  createBuild,
  currentReturnTo,
  feishuLoginUrl,
  getBuildHistory,
  getEnvironments,
  getConfigurationGroups,
  logout,
  saveEnvironment,
  updateSystemSettings,
  updateConfigurationGroup,
  deleteConfigurationGroup,
} from './api'

const session = {
  authenticated: true as const,
  identity: { name: '测试用户', avatarUrl: 'https://example.test/avatar.png' },
  csrfToken: 'csrf-session-token',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('console authentication client', () => {
  beforeEach(() => {
    clearCachedAuthSession()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the current route when starting Feishu login', () => {
    const returnTo = currentReturnTo({
      pathname: '/s/share-token',
      search: '?from=qa',
      hash: '#top',
    })
    expect(returnTo).toBe('/s/share-token?from=qa#top')
    expect(feishuLoginUrl(returnTo)).toBe(
      '/api/v1/auth/feishu/start?return_to=%2Fs%2Fshare-token%3Ffrom%3Dqa%23top'
    )
  })

  it('sends read requests with the session cookie but without a spoofable actor header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await getEnvironments()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('include')
    const headers = new Headers(init.headers)
    expect(headers.has('x-cuddly-actor')).toBe(false)
    expect(headers.has('x-cuddly-csrf')).toBe(false)
  })

  it('requests a numbered build-history page with all selected filters', async () => {
    const response = {
      items: [],
      page: 3,
      pageSize: 20,
      total: 57,
      totalPages: 3,
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBuildHistory({
        environmentSlug: 'shared',
        targetId: 'online-h5',
        status: 'FAILED',
        query: 'feature/history',
        page: 3,
        pageSize: 20,
      })
    ).resolves.toEqual(response)

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(
      '/api/v1/build-jobs?environment=shared&targetId=online-h5&status=FAILED&query=feature%2Fhistory&page=3&pageSize=20'
    )
    expect(init.credentials).toBe('include')
  })

  it('loads the authenticated session and attaches its CSRF token to write requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1' }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-id' })

    await createBuild('base', 'feature/oauth', 'shared')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [sessionPath, sessionInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(sessionPath).toBe('/api/v1/auth/session')
    expect(sessionInit.credentials).toBe('include')

    const [buildPath, buildInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(buildPath).toBe('/api/v1/build-jobs')
    expect(buildInit.credentials).toBe('include')
    const headers = new Headers(buildInit.headers)
    expect(headers.get('x-cuddly-csrf')).toBe(session.csrfToken)
    expect(headers.get('x-cuddly-actor')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('idempotency-key')).toBe('request-id')
  })

  it('uses the same verified session to protect logout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await logout()

    const [logoutPath, logoutInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(logoutPath).toBe('/api/v1/auth/logout')
    expect(logoutInit.credentials).toBe('include')
    expect(new Headers(logoutInit.headers).get('x-cuddly-csrf')).toBe(session.csrfToken)
  })

  it('persists the per-environment internal proxy choice', async () => {
    const environment = {
      slug: 'tttt',
      name: '测试环境',
      backendOrigin: 'https://tttt-www.dev.chuanyuapp.com',
      useInternalProxy: true,
      resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
      status: 'ACTIVE' as const,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(
        jsonResponse({
          id: '00000000-0000-4000-8000-000000000001',
          currentRevisionId: null,
          ...environment,
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    await saveEnvironment(environment)

    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(path).toBe('/api/v1/admin/environments/tttt')
    expect(JSON.parse(String(init.body))).toMatchObject({
      useInternalProxy: true,
      resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
    })
  })

  it('replaces the global in-place URL rule list with the system settings mutation', async () => {
    const rules = [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }]
    const input = {
      cookieDomain: '',
      buildMaxConcurrency: 3,
      runnerRequestTimeoutMinutes: 30,
      useChinaRegistry: true,
      proxyRewriteMaxMegabytes: 2,
      autoSslEnabled: false,
      autoSslEmail: '',
      inPlaceUrlRules: rules,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(input))
    vi.stubGlobal('fetch', fetchMock)

    await updateSystemSettings(input)

    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(path).toBe('/api/v1/admin/system-settings')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toMatchObject({ inPlaceUrlRules: rules })
    expect(new Headers(init.headers).get('x-cuddly-csrf')).toBe(session.csrfToken)
  })

  it('loads the global configuration group directory without a mutation token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await getConfigurationGroups()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/v1/config-groups')
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).has('x-cuddly-csrf')).toBe(false)
  })

  it('creates, revision-updates, and deletes configuration groups with the verified session', async () => {
    const token = 'a'.repeat(32)
    const input = {
      name: '频道权限重构',
      environmentSlug: 'shared',
      siteBindingId: 'main',
      items: [
        { targetId: 'webapp', mode: 'official' as const },
        { targetId: 'base', mode: 'branch' as const, branch: 'feature/permissions' },
      ],
    }
    const record = {
      id: token,
      token,
      ...input,
      environmentId: '00000000-0000-4000-8000-000000000001',
      schemaVersion: 1,
      createdBy: '测试用户',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedBy: '测试用户',
      updatedAt: '2026-08-26T00:00:00.000Z',
      revision: 1,
      sharePath: `/s/${token}`,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(record, 201))
      .mockResolvedValueOnce(jsonResponse({ ...record, name: '频道权限重构二期', revision: 2 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await createConfigurationGroup(input)
    await updateConfigurationGroup(token, {
      ...input,
      name: '频道权限重构二期',
      expectedRevision: 1,
    })
    await deleteConfigurationGroup(token)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [, createInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/config-groups')
    expect(createInit.method).toBe('POST')
    expect(JSON.parse(String(createInit.body))).toMatchObject({ ...input, schemaVersion: 1 })
    expect(new Headers(createInit.headers).get('x-cuddly-csrf')).toBe(session.csrfToken)

    const [updatePath, updateInit] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(updatePath).toBe(`/api/v1/config-groups/${token}`)
    expect(updateInit.method).toBe('PUT')
    expect(JSON.parse(String(updateInit.body))).toMatchObject({
      name: '频道权限重构二期',
      expectedRevision: 1,
      schemaVersion: 1,
    })

    const [deletePath, deleteInit] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(deletePath).toBe(`/api/v1/config-groups/${token}`)
    expect(deleteInit.method).toBe('DELETE')
    expect(new Headers(deleteInit.headers).get('x-cuddly-csrf')).toBe(session.csrfToken)
  })
})
