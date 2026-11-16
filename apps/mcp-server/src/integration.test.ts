import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'

import { MemoryStore } from '@cuddly/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { BifrostClient } from './client'
import { createMcpServer } from './server'

import { createControlApp } from '../../control-api/src/app'
import { FeishuOAuthClient, oauthRandomToken } from '../../control-api/src/auth'

it('runs real API-backed workflows: actor, deduplication, cancellation/retry, share revisions, preview and artifact paging', async () => {
  const store = new MemoryStore()
  const target = (await store.getBuildTarget('webapp'))!
  await store.saveBuildTarget(
    { ...target, enabled: true, repositoryUrl: 'https://git.example.test/webapp.git' },
    'fixture'
  )
  const environment = (await store.getEnvironment('shared'))!
  const config = (await store.getProjectEnvironmentConfig(environment.id, 'webapp'))!
  await store.saveProjectEnvironmentConfig({ ...config, enabled: true }, 'fixture')
  await store.saveSiteBinding(
    {
      id: 'main',
      name: '网页端',
      targetId: 'webapp',
      environmentSlug: 'shared',
      hostname: 'main.bifrost.example.test',
      officialOrigin: 'https://www.kookapp.cn',
      fallbackOrigin: 'https://www.kookapp.cn',
      enabled: true,
      remoteTargetIds: [],
      resourceProxyPrefixes: [],
    },
    'fixture'
  )
  const token = oauthRandomToken()
  await store.createAuthSession({
    token,
    tenantKey: 'tenant',
    openId: 'open-id',
    unionId: 'union-id',
    name: 'MCP 测试操作者',
    avatarUrl: '',
    csrfToken: oauthRandomToken(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  })
  const http = createControlApp({
    store,
    settingsSecret: 'test-secret',
    internalApiToken: 'not-public',
    previewBaseDomain: 'bifrost.example.test',
    auth: {
      publicOrigin: 'https://bifrost.example.test',
      client: new FeishuOAuthClient({
        appId: 'fake',
        appSecret: 'fake',
        redirectUri: 'https://bifrost.example.test/api/v1/auth/feishu/callback',
        fetchImpl: async () => {
          throw new Error('No external OAuth calls in tests')
        },
      }),
    },
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => http.once('listening', resolve))
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const server = createMcpServer(new BifrostClient({ origin, token: async () => token }), {
    permissionLevel: 2,
    roles: [],
  })
  const client = new Client({ name: 'integration-test', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(right)
    await client.connect(left)
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name: `bifrost_${name}`, arguments: args })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return (result.structuredContent as { data: any }).data
    }
    const ownSession = (await store.getAuthSession(token))!
    expect((await call('whoami')).session.identity.name).toBe(ownSession.name)
    const input = {
      targetId: 'webapp',
      environmentSlug: 'shared',
      branch: 'feature/中文',
      idempotencyKey: 'integration-build-1',
    }
    const job = await call('create_build', input)
    expect(job.requestedBy).toBe(ownSession.name)
    expect(job.requestedById).toBe(ownSession.userId)
    expect((await call('create_build', input)).id).toBe(job.id)
    expect((await call('get_queue')).queued).toHaveLength(1)
    expect((await call('cancel_build', { jobId: job.id, confirm: true })).status).toBe('CANCELED')
    const retry = await call('retry_build', { jobId: job.id, idempotencyKey: 'integration-retry-1' })
    expect(retry.id).not.toBe(job.id)
    expect(retry.branch).toBe('feature/中文')
    expect((await call('list_builds', { environment: 'shared', status: 'CANCELED' })).items).toHaveLength(1)

    const requirement = await call('create_requirement', {
      name: '测试需求',
      environmentSlug: 'shared',
      siteBindingId: 'main',
      urlPrefix: '中文需求',
      items: [{ targetId: 'webapp', mode: 'official' }],
    })
    expect(requirement.directPreviewUrl).toContain('bifrost.example.test')
    const updated = await call('update_requirement', {
      token: requirement.token,
      confirm: true,
      config: {
        name: '测试需求二',
        environmentSlug: 'shared',
        siteBindingId: 'main',
        schemaVersion: 1,
        expectedRevision: requirement.revision,
        items: [{ targetId: 'webapp', mode: 'official' }],
      },
    })
    expect(updated.revision).toBe(requirement.revision + 1)
    const stale = await client.callTool({
      name: 'bifrost_update_requirement',
      arguments: {
        token: requirement.token,
        confirm: true,
        config: {
          name: '过期修改',
          environmentSlug: 'shared',
          siteBindingId: 'main',
          schemaVersion: 1,
          expectedRevision: requirement.revision,
          items: [{ targetId: 'webapp', mode: 'official' }],
        },
      },
    })
    expect(stale.isError).toBe(true)
    const preview = await call('create_requirement_preview', {
      token: requirement.token,
      expectedRevision: updated.revision,
    })
    expect(preview.preview.token).toBeTruthy()
    await call('get_preview', { token: preview.preview.token })
    await call('revoke_preview', { token: preview.preview.token, confirm: true })

    const artifactId = randomUUID()
    await store.updateBuildJob(retry.id, { status: 'UPLOADING' })
    await store.completeBuildJob(retry.id, {
      artifact: {
        id: artifactId,
        buildJobId: retry.id,
        environmentId: environment.id,
        environmentSlug: 'shared',
        targetId: 'webapp',
        branch: retry.branch,
        status: 'READY',
        storageKey: 'private/storage/key',
        builtAt: new Date().toISOString(),
        createdBy: `user:${ownSession.userId}`,
        manifest: {
          schemaVersion: 1,
          artifactId,
          target: 'webapp',
          branch: retry.branch,
          builtAt: new Date().toISOString(),
          serve: { siteAdapter: 'generic-static-v1', publicBase: '/preview/', entrypoints: ['index.html'] },
          files: ['index.html', 'main.js'].map((file) => ({
            path: file,
            size: 10,
            contentType: 'text/plain',
            digest: 'a'.repeat(64),
            cacheClass: 'asset' as const,
          })),
        },
      },
      finishedAt: new Date().toISOString(),
      logPath: '',
    })
    const artifacts = await call('list_artifacts', { targetId: 'webapp', environment: 'shared' })
    expect(artifacts.items[0]).toMatchObject({ id: artifactId, fileCount: 2 })
    expect(artifacts.items[0]).not.toHaveProperty('manifest')
    const detail = await call('get_artifact', { artifactId, pageSize: 1 })
    expect(detail.manifest.files).toHaveLength(1)
    expect(detail.hasMore).toBe(true)
    expect(detail).not.toHaveProperty('storageKey')
    expect(
      (
        (await fetch(`${origin}/api/v1/artifacts?targetId=webapp`, {
          headers: { authorization: `Bearer ${token}` },
        }).then((response) => response.json())) as { items: unknown[] }
      ).items[0]
    ).toHaveProperty('manifest')
    expect(
      (
        await fetch(`${origin}/api/v1/artifacts/${artifactId}?pageSize=10000`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(400)
    await call('delete_requirement', { token: requirement.token, confirm: true })
  } finally {
    await client.close()
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 15000)
