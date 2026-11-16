import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { FileArtifactStore } from '@cuddly/artifact-store'
import {
  createOnlineH5Manifest,
  createRemoteManifest,
  createStaticManifest,
  ONLINE_H5_ENTRYPOINTS,
} from '@cuddly/build-adapters'
import {
  configurationGroupHostnamePrefixFromHostname,
  type Artifact,
  type EnvironmentRecord,
  type SiteBinding,
} from '@cuddly/contracts'
import { MemoryStore } from '@cuddly/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGatewayApp, resourceProxyBindingForEnvironment, type GatewayOptions } from './app'

it('recognizes only one DNS-safe direct-preview label', () => {
  expect(
    configurationGroupHostnamePrefixFromHostname(
      'p-0123456789abcdef0123456789abcdef.bifrost.vanillacake.cn',
      'bifrost.vanillacake.cn'
    )
  ).toBe('p-0123456789abcdef0123456789abcdef')
  expect(
    configurationGroupHostnamePrefixFromHostname(
      'party-week.bifrost.vanillacake.cn',
      'bifrost.vanillacake.cn'
    )
  ).toBe('party-week')
  expect(
    configurationGroupHostnamePrefixFromHostname(
      'xn--fiq228cyxerz3c.bifrost.vanillacake.cn',
      'bifrost.vanillacake.cn'
    )
  ).toBe('xn--fiq228cyxerz3c')
  expect(
    configurationGroupHostnamePrefixFromHostname(
      'nested.p-0123456789abcdef0123456789abcdef.bifrost.vanillacake.cn',
      'bifrost.vanillacake.cn'
    )
  ).toBeNull()
})
import {
  RESOURCE_PROXY_BASE_PATH,
  RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
  resourceProxyRuleId,
  resourceProxyTransformVersion,
  type ResourceProxyHostResolver,
} from './resource-proxy'

const cleanupDirectories: string[] = []
const servers: Server[] = []
const TEST_ENVIRONMENT_ID = '00000000-0000-4000-8000-000000000001'
const TEST_ENVIRONMENT_SLUG = 'shared'

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const directory of cleanupDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fetchWithHost(
  url: string,
  hostname: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, { headers: { ...headers, host: hostname } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => {
        const headers = new Headers()
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!)
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers,
          })
        )
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function enableTestTarget(store: MemoryStore, targetId: string): Promise<void> {
  const target = await store.getBuildTarget(targetId)
  if (!target) throw new Error(`Missing test project: ${targetId}`)
  const saved = await store.saveBuildTarget(
    {
      ...target,
      repositoryUrl: target.repositoryUrl || `https://git.example.test/${targetId}.git`,
      enabled: true,
    },
    'gz'
  )
  await store.saveProjectEnvironmentConfig(
    {
      targetId,
      environmentId: TEST_ENVIRONMENT_ID,
      enabled: true,
      required: false,
      installCommand: saved.installCommand,
      buildCommand: saved.buildCommand,
      outputDirectory: saved.outputDirectory,
    },
    'gz'
  )
}

async function createReadyArtifact(
  store: MemoryStore,
  artifactStore: FileArtifactStore,
  branch: string,
  scriptBody: string,
  options: {
    entryHtml?: (entry: (typeof ONLINE_H5_ENTRYPOINTS)[number], artifactId: string) => string
    additionalFiles?: Record<string, string>
  } = {}
): Promise<Artifact> {
  await enableTestTarget(store, 'online-h5')
  const source = await mkdtemp(path.join(os.tmpdir(), 'cuddly-output-'))
  cleanupDirectories.push(source)
  const id = randomUUID()
  await mkdir(path.join(source, 'static'), { recursive: true })
  for (const entry of ONLINE_H5_ENTRYPOINTS) {
    await writeFile(
      path.join(source, entry),
      options.entryHtml?.(entry, id) || '<html><head></head><body>qa</body></html>',
      'utf8'
    )
  }
  await writeFile(path.join(source, 'static', 'app.12345678.js'), scriptBody, 'utf8')
  for (const [relativePath, content] of Object.entries(options.additionalFiles || {})) {
    const destination = path.join(source, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf8')
  }

  const builtAt = new Date().toISOString()
  const manifest = await createOnlineH5Manifest({
    outputDirectory: source,
    artifactId: id,
    branch,
    builtAt,
  })
  const storageKey = await artifactStore.publishDirectory({
    sourceDirectory: source,
    targetId: 'online-h5',
    artifactId: id,
    manifest,
  })
  const artifact: Artifact = {
    id,
    buildJobId: randomUUID(),
    targetId: 'online-h5',
    environmentId: TEST_ENVIRONMENT_ID,
    environmentSlug: TEST_ENVIRONMENT_SLUG,
    branch,
    status: 'READY',
    storageKey,
    manifest,
    builtAt,
    createdBy: 'gz',
  }
  await store.createArtifact(artifact)
  return artifact
}

async function createReadyRemoteArtifact(
  store: MemoryStore,
  artifactStore: FileArtifactStore,
  branch: string,
  options: {
    environmentId?: string
    environmentSlug?: string
    relativePublicBase?: boolean
    additionalFiles?: Record<string, string>
  } = {}
): Promise<Artifact> {
  await enableTestTarget(store, 'base')
  const source = await mkdtemp(path.join(os.tmpdir(), 'cuddly-remote-output-'))
  cleanupDirectories.push(source)
  await writeFile(path.join(source, 'remoteEntry.js'), 'window.remotePreview = true', 'utf8')
  await mkdir(path.join(source, 'static'), { recursive: true })
  await writeFile(path.join(source, 'static', 'chunk.12345678.js'), 'window.chunk = true', 'utf8')
  for (const [relativePath, content] of Object.entries(options.additionalFiles || {})) {
    const destination = path.join(source, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf8')
  }

  const id = randomUUID()
  const builtAt = new Date().toISOString()
  const providerName = 'cuddly_base_test'
  await writeFile(path.join(source, '.remote-version'), `${providerName}\n`, 'utf8')
  const artifactPath = `/__cuddly/preview-artifacts/${id}/${providerName}/`
  const publicBase = options.relativePublicBase
    ? artifactPath
    : `http://preview.test${artifactPath}`
  const manifest = await createRemoteManifest({
    outputDirectory: source,
    artifactId: id,
    targetId: 'base',
    branch,
    builtAt,
    publicBase,
    siteAdapter: 'kook-remote-v1',
    moduleKey: 'base',
    providerName,
  })
  const storageKey = await artifactStore.publishDirectory({
    sourceDirectory: source,
    targetId: 'base',
    artifactId: id,
    manifest,
  })
  const artifact: Artifact = {
    id,
    buildJobId: randomUUID(),
    targetId: 'base',
    environmentId: options.environmentId || TEST_ENVIRONMENT_ID,
    environmentSlug: options.environmentSlug || TEST_ENVIRONMENT_SLUG,
    branch,
    status: 'READY',
    storageKey,
    manifest,
    builtAt,
    createdBy: 'gz',
  }
  await store.createArtifact(artifact)
  return artifact
}

async function createReadyStaticArtifact(
  store: MemoryStore,
  artifactStore: FileArtifactStore,
  branch: string,
  body: string,
  documentHtml?: string,
  additionalFiles: Record<string, string> = {},
  environment: { id?: string; slug?: string } = {}
): Promise<Artifact> {
  await enableTestTarget(store, 'webapp')
  const source = await mkdtemp(path.join(os.tmpdir(), 'cuddly-static-output-'))
  cleanupDirectories.push(source)
  await mkdir(path.join(source, 'assets'), { recursive: true })
  await mkdir(path.join(source, 'static', 'js'), { recursive: true })
  await mkdir(path.join(source, 'api'), { recursive: true })
  await writeFile(
    path.join(source, 'index.html'),
    documentHtml ?? `<html><head></head><body>${body}</body></html>`
  )
  await writeFile(path.join(source, 'api', 'profile'), 'artifact must not shadow the API')
  await writeFile(
    path.join(source, 'assets', 'app.12345678.js'),
    `window.branch = ${JSON.stringify(branch)}`
  )
  await writeFile(
    path.join(source, 'static', 'js', 'runtime-index.12345678.js'),
    `window.runtimeBranch = ${JSON.stringify(branch)}`
  )
  for (const [relativePath, content] of Object.entries(additionalFiles)) {
    const destination = path.join(source, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf8')
  }

  const id = randomUUID()
  const builtAt = new Date().toISOString()
  const manifest = await createStaticManifest({
    outputDirectory: source,
    artifactId: id,
    targetId: 'webapp',
    branch,
    builtAt,
    siteAdapter: 'generic-static-v1',
  })
  const storageKey = await artifactStore.publishDirectory({
    sourceDirectory: source,
    targetId: 'webapp',
    artifactId: id,
    manifest,
  })
  const artifact: Artifact = {
    id,
    buildJobId: randomUUID(),
    targetId: 'webapp',
    environmentId: environment.id || TEST_ENVIRONMENT_ID,
    environmentSlug: environment.slug || TEST_ENVIRONMENT_SLUG,
    branch,
    status: 'READY',
    storageKey,
    manifest,
    builtAt,
    createdBy: 'gz',
  }
  await store.createArtifact(artifact)
  return artifact
}

function siteBinding(input: Partial<SiteBinding> = {}): SiteBinding {
  const legacyOrigin = (input as Partial<SiteBinding> & { upstreamOrigin?: string }).upstreamOrigin
  return {
    id: 'mobile',
    name: 'Mobile',
    hostname: '127.0.0.1',
    targetId: 'online-h5',
    environmentSlug: 'shared',
    upstreamOrigin: 'http://127.0.0.1:1',
    officialOrigin: 'https://m.kookapp.cn',
    enabled: true,
    remoteTargetIds: [],
    resourceProxyPrefixes: [],
    ...input,
    fallbackOrigin: input.fallbackOrigin || legacyOrigin || 'http://127.0.0.1:1',
  }
}

describe('environment resource proxy rules', () => {
  const environment = {
    id: TEST_ENVIRONMENT_ID,
    slug: TEST_ENVIRONMENT_SLUG,
    name: '测试环境',
    status: 'ACTIVE',
    backendOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    useInternalProxy: true,
    resourceProxyPrefixes: ['https://img.chuanyuapp.com/', 'https://static.kookapp.cn/'],
    currentRevisionId: null,
  } satisfies EnvironmentRecord

  it('merges site defaults with the active environment and removes duplicates', () => {
    const binding = siteBinding({
      resourceProxyPrefixes: ['https://img.kookapp.cn/', 'https://static.kookapp.cn/'],
    })

    expect(resourceProxyBindingForEnvironment(binding, environment).resourceProxyPrefixes).toEqual([
      'https://img.kookapp.cn/',
      'https://static.kookapp.cn/',
      'https://img.chuanyuapp.com/',
    ])
  })

  it('reuses the site binding when the environment adds no rules', () => {
    const binding = siteBinding({ resourceProxyPrefixes: ['https://img.kookapp.cn/'] })
    expect(
      resourceProxyBindingForEnvironment(binding, {
        ...environment,
        resourceProxyPrefixes: [],
      })
    ).toBe(binding)
  })

  it('selects additional rules from the Preview environment instead of the site default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-environment-resource-proxy-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const binding = siteBinding({
      resourceProxyPrefixes: ['https://img.kookapp.cn/', 'https://static.kookapp.cn/'],
    })
    const origin = await startGateway(store, new FileArtifactStore(root), binding)
    const previewEnvironment = await store.saveEnvironment(
      {
        ...environment,
        id: randomUUID(),
        slug: 'tttt',
        resourceProxyPrefixes: ['https://img.chuanyuapp.com/'],
      },
      'gz'
    )
    await store.createPreviewSession({
      token: 'tttt-resource-rules',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: previewEnvironment.id,
      environmentSlug: previewEnvironment.slug,
      siteBindingId: binding.id,
      selections: [],
    })

    const defaultBootstrap = await fetch(`${origin}/__cuddly/resource-proxy.js`).then((response) =>
      response.text()
    )
    expect(defaultBootstrap).toContain('https://img.kookapp.cn/')
    expect(defaultBootstrap).not.toContain('https://img.chuanyuapp.com/')

    const previewBootstrap = await fetch(`${origin}/__cuddly/resource-proxy.js`, {
      headers: { 'x-cuddly-preview-token': 'tttt-resource-rules' },
    }).then((response) => response.text())
    expect(previewBootstrap).toContain('https://img.kookapp.cn/')
    expect(previewBootstrap).toContain('https://static.kookapp.cn/')
    expect(previewBootstrap).toContain('https://img.chuanyuapp.com/')
  })
})

async function ensureTestSiteBinding(
  store: MemoryStore,
  id: string,
  targetId: string
): Promise<void> {
  if (await store.getSiteBinding(id)) return
  await store.saveSiteBinding(
    siteBinding({
      id,
      name: id,
      targetId,
    }),
    'gz'
  )
}

async function createSiteArtifactPreview(
  store: MemoryStore,
  token: string,
  siteBindingId: string,
  artifact: Artifact
): Promise<void> {
  await store.createPreviewSession({
    token,
    createdBy: 'gz',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    environmentId: artifact.environmentId,
    environmentSlug: artifact.environmentSlug,
    siteBindingId,
    siteArtifactId: artifact.id,
    selections: [],
  })
}

async function startGateway(
  store: MemoryStore,
  artifactStore: FileArtifactStore,
  binding: SiteBinding | null = siteBinding(),
  legacyHosts: string[] = [],
  resourceProxyHostResolver?: GatewayOptions['resourceProxyHostResolver'],
  resolveRuntimeOptions?: GatewayOptions['resolveRuntimeOptions'],
  internalProxyUrl?: URL | null
): Promise<string> {
  if (binding) await store.saveSiteBinding(binding, 'gz')
  const configuredBackendOrigin = binding
    ? (binding as SiteBinding & { upstreamOrigin?: string }).upstreamOrigin ||
      binding.fallbackOrigin
    : 'http://127.0.0.1:1'
  const environment = await store.getEnvironment(TEST_ENVIRONMENT_SLUG)
  if (environment) {
    await store.saveEnvironment({ ...environment, backendOrigin: configuredBackendOrigin }, 'gz')
  }
  const app = createGatewayApp({
    store,
    artifactStore,
    environmentSlug: 'shared',
    targetId: 'online-h5',
    allowedHosts: legacyHosts,
    hookPath: null,
    proxy: {
      upstream: new URL('http://127.0.0.1:1'),
      publicOrigin: new URL('http://localhost'),
      cookieDomain: '',
      maxRewriteBytes: 1024,
    },
    internalProxyUrl,
    resourceProxyHostResolver,
    resolveRuntimeOptions,
  })
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

describe('online H5 gateway', () => {
  it('serves a configuration group from its unique hostname without an extension header', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-direct-preview-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/direct',
      'direct-preview-webapp'
    )
    const binding = siteBinding({
      id: 'main',
      name: 'Main',
      hostname: 'main.bifrost.vanillacake.cn',
      targetId: 'webapp',
    })
    const origin = await startGateway(store, artifactStore, binding)
    const previewSlug = '0123456789abcdef0123456789abcdef'
    await store.createConfigurationGroup({
      token: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      previewSlug,
      previewHostnamePrefix: 'party-week',
      name: '无需扩展预览',
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: binding.id,
      schemaVersion: 1,
      items: [{ targetId: 'webapp', mode: 'branch', branch: artifact.branch }],
      createdBy: 'gz',
    })

    const response = await fetchWithHost(
      `${origin}/channels/7`,
      'party-week.bifrost.vanillacake.cn',
      { accept: 'text/html' }
    )
    const body = await response.text()
    expect(body).toContain('direct-preview-webapp')
    expect(response.status).toBe(200)
  })

  it('routes backend and hot-module requests through the internal proxy only when enabled', async () => {
    const backendRequests: string[] = []
    const backend = createServer((req, res) => {
      backendRequests.push(req.url || '')
      res.end('direct-backend')
    })
    backend.listen(0, '127.0.0.1')
    servers.push(backend)
    await new Promise<void>((resolve) => backend.once('listening', resolve))
    const backendAddress = backend.address()
    if (!backendAddress || typeof backendAddress === 'string') {
      throw new Error('Internal-proxy backend did not bind a TCP port')
    }
    const backendOrigin = `http://127.0.0.1:${backendAddress.port}`

    const proxyRequests: string[] = []
    const proxy = createServer((req, res) => {
      proxyRequests.push(req.url || '')
      res.end(`via-internal-proxy:${req.url}`)
    })
    proxy.listen(0, '127.0.0.1')
    servers.push(proxy)
    await new Promise<void>((resolve) => proxy.once('listening', resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') {
      throw new Error('Internal proxy did not bind a TCP port')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const environment = (await store.getEnvironment(TEST_ENVIRONMENT_SLUG))!
    await store.saveEnvironment({ ...environment, useInternalProxy: true }, 'gz')
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({ upstreamOrigin: backendOrigin }),
      [],
      undefined,
      undefined,
      new URL(`http://127.0.0.1:${proxyAddress.port}`)
    )

    const backendResponse = await fetch(`${origin}/api/profile?from=preview`)
    expect(backendResponse.status).toBe(200)
    expect(await backendResponse.text()).toBe(
      `via-internal-proxy:${backendOrigin}/api/profile?from=preview`
    )
    const hotModuleResponse = await fetch(`${origin}/api/v3/version/hot-module?platform=web`)
    expect(hotModuleResponse.status).toBe(200)
    expect(await hotModuleResponse.text()).toBe(
      `via-internal-proxy:${backendOrigin}/api/v3/version/hot-module?platform=web`
    )
    expect(proxyRequests).toEqual([
      `${backendOrigin}/api/profile?from=preview`,
      `${backendOrigin}/api/v3/version/hot-module?platform=web`,
    ])
    expect(backendRequests).toEqual([])

    expect(
      await fetch(`${origin}/channels/1`, { headers: { accept: 'text/html' } }).then((response) =>
        response.text()
      )
    ).toBe(`via-internal-proxy:${backendOrigin}/channels/1`)
    expect(backendRequests).toEqual([])
    expect(proxyRequests).toEqual([
      `${backendOrigin}/api/profile?from=preview`,
      `${backendOrigin}/api/v3/version/hot-module?platform=web`,
      `${backendOrigin}/channels/1`,
    ])

    const directRoot = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(directRoot)
    const directStore = new MemoryStore()
    const directArtifactStore = new FileArtifactStore(directRoot)
    await directArtifactStore.initialize()
    const directOrigin = await startGateway(
      directStore,
      directArtifactStore,
      siteBinding({ upstreamOrigin: backendOrigin }),
      [],
      undefined,
      undefined,
      new URL(`http://127.0.0.1:${proxyAddress.port}`)
    )
    expect(await fetch(`${directOrigin}/api/direct`).then((response) => response.text())).toBe(
      'direct-backend'
    )
    expect(backendRequests).toEqual(['/api/direct'])
    expect(proxyRequests).toHaveLength(3)
  })

  it('fails closed when an environment requires an unconfigured or unavailable proxy', async () => {
    const backendRequests: string[] = []
    const backend = createServer((req, res) => {
      backendRequests.push(req.url || '')
      res.end('must-not-be-reached-directly')
    })
    backend.listen(0, '127.0.0.1')
    servers.push(backend)
    await new Promise<void>((resolve) => backend.once('listening', resolve))
    const backendAddress = backend.address()
    if (!backendAddress || typeof backendAddress === 'string') {
      throw new Error('Fail-closed backend did not bind a TCP port')
    }
    const backendOrigin = `http://127.0.0.1:${backendAddress.port}`

    const createGateway = async (internalProxyUrl?: URL | null) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
      cleanupDirectories.push(root)
      const store = new MemoryStore()
      const environment = (await store.getEnvironment(TEST_ENVIRONMENT_SLUG))!
      await store.saveEnvironment({ ...environment, useInternalProxy: true }, 'gz')
      const artifactStore = new FileArtifactStore(root)
      await artifactStore.initialize()
      return startGateway(
        store,
        artifactStore,
        siteBinding({ upstreamOrigin: backendOrigin }),
        [],
        undefined,
        undefined,
        internalProxyUrl
      )
    }

    const withoutProxy = await fetch(`${await createGateway(null)}/api/profile`)
    expect(withoutProxy.status).toBe(503)
    expect(await withoutProxy.json()).toEqual({ code: 'INTERNAL_PROXY_NOT_CONFIGURED' })

    const unavailableProxy = await fetch(
      `${await createGateway(new URL('http://127.0.0.1:1'))}/api/profile`
    )
    expect(unavailableProxy.status).toBe(502)
    expect(await unavailableProxy.json()).toEqual({ code: 'GATEWAY_ERROR' })
    expect(backendRequests).toEqual([])
  })

  it('serves only the Preview-selected Artifact and does not proxy its missing assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyArtifact(
      store,
      artifactStore,
      'feature/mobile',
      'window.qa = true'
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'publish mobile',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: artifact.id }],
    })
    const origin = await startGateway(store, artifactStore)
    await createSiteArtifactPreview(store, 'mobile-preview', 'mobile', artifact)
    const previewHeaders = {
      accept: 'text/html',
      'x-cuddly-preview-token': 'mobile-preview',
    }

    const entry = await fetch(`${origin}/`, { headers: previewHeaders })
    expect(entry.status).toBe(200)
    const entryHtml = await entry.text()
    expect(entryHtml).toContain('/__cuddly/bootstrap.js')
    expect(entryHtml).toContain('/__cuddly/resource-proxy.js')
    expect(entryHtml).not.toContain('/__cuddly/hooks/k-inject.js')

    const runtime = await fetch(`${origin}/__cuddly/runtime`, {
      headers: previewHeaders,
    }).then((response) => response.json())
    expect(runtime).toMatchObject({
      environment: {
        id: TEST_ENVIRONMENT_ID,
        slug: TEST_ENVIRONMENT_SLUG,
        name: '公共调试环境',
        status: 'ACTIVE',
      },
    })
    const bootstrapSource = await fetch(`${origin}/__cuddly/bootstrap.js`, {
      headers: previewHeaders,
    }).then((response) => response.text())
    const bootstrap = JSON.parse(bootstrapSource.slice('window.__CUDDLY__='.length, -';'.length))
    expect(bootstrap).toMatchObject({
      environment: {
        id: TEST_ENVIRONMENT_ID,
        slug: TEST_ENVIRONMENT_SLUG,
      },
      artifact: {
        id: artifact.id,
        environmentId: TEST_ENVIRONMENT_ID,
        environmentSlug: TEST_ENVIRONMENT_SLUG,
      },
    })

    const missing = await fetch(`${origin}/static/official-only.js`, {
      headers: previewHeaders,
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'FRONTEND_ASSET_NOT_FOUND' })
  })

  it('does not expose current or historical Revision Artifacts without a Preview token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const first = await createReadyArtifact(
      store,
      artifactStore,
      'release/one',
      'window.release = 1'
    )
    const second = await createReadyArtifact(
      store,
      artifactStore,
      'release/two',
      'window.release = 2'
    )
    const revision = await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'one',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: first.id }],
    })
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: revision.id,
      message: 'two',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: second.id }],
    })
    const origin = await startGateway(store, artifactStore)

    const response = await fetch(`${origin}/__cuddly/artifacts/${first.id}/static/app.12345678.js`)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'ARTIFACT_NOT_REFERENCED' })
  })

  it('retires the sparse token endpoint and only exposes referenced Remote Artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    await store.saveBuildTarget(
      {
        id: 'base',
        name: 'Base',
        kind: 'remote',
        repositoryUrl: 'https://git.example.test/kook.git',
        defaultBranch: 'master',
        installCommand: 'pnpm install',
        buildCommand: 'pnpm --filter base build',
        outputDirectory: 'apps/base/dist',
        siteAdapter: 'kook-remote-v1',
        enabled: true,
        required: false,
        configurationSource: 'database',
      },
      'gz'
    )
    const artifact = await createReadyRemoteArtifact(store, artifactStore, 'feature/remote')
    const origin = await startGateway(store, artifactStore)

    const before = await fetch(
      `${origin}/__cuddly/preview-artifacts/${artifact.id}/cuddly_base_test/remoteEntry.js`
    )
    expect(before.status).toBe(404)
    expect(await before.json()).toMatchObject({ code: 'ARTIFACT_NOT_REFERENCED' })

    await ensureTestSiteBinding(store, 'main', 'webapp')
    await store.createPreviewSession({
      token: 'active-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: artifact.id,
          branch: artifact.branch,
          builtAt: artifact.builtAt,
          providerName: 'cuddly_base_test',
          version: 'cuddly_base_test',
          entryPath: 'remoteEntry.js',
        },
      ],
    })

    const hotModule = await fetch(
      `${origin}/__cuddly/previews/active-preview/v3/version/hot-module`
    )
    expect(hotModule.status).toBe(410)
    expect(hotModule.headers.get('access-control-allow-origin')).toBe('*')
    expect(hotModule.headers.get('cache-control')).toContain('no-store')
    expect(await hotModule.json()).toMatchObject({
      code: 'SITE_BOUND_PREVIEW_REQUIRED',
    })

    const entry = await fetch(
      `${origin}/__cuddly/preview-artifacts/${artifact.id}/cuddly_base_test/remoteEntry.js`
    )
    expect(entry.status).toBe(200)
    expect(await entry.text()).toContain('remotePreview')
    expect(entry.headers.get('cross-origin-resource-policy')).toBe('cross-origin')

    const getArtifact = store.getArtifact.bind(store)
    store.getArtifact = async (artifactId) => {
      const result = await getArtifact(artifactId)
      return result?.id === artifact.id
        ? {
            ...result,
            environmentId: '00000000-0000-4000-8000-000000000002',
            environmentSlug: 'other',
          }
        : result
    }
    const crossEnvironmentEntry = await fetch(
      `${origin}/__cuddly/preview-artifacts/${artifact.id}/cuddly_base_test/remoteEntry.js`
    )
    expect(crossEnvironmentEntry.status).toBe(404)
    expect(await crossEnvironmentEntry.json()).toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })

    const missingPreview = await fetch(`${origin}/__cuddly/previews/missing/v3/version/hot-module`)
    expect(missingPreview.status).toBe(410)
    expect(missingPreview.headers.get('cache-control')).toContain('no-store')
    expect(await missingPreview.json()).toMatchObject({ code: 'SITE_BOUND_PREVIEW_REQUIRED' })

    const invalidArtifact = await fetch(
      `${origin}/__cuddly/preview-artifacts/not-a-uuid/provider/remoteEntry.js`
    )
    expect(invalidArtifact.status).toBe(404)
    expect(invalidArtifact.headers.get('cache-control')).toContain('no-store')
  })

  it('serves a generic webapp Artifact first and proxies backend requests to the site upstream', async () => {
    let forwardedPreviewToken: string | undefined
    let forwardedInternalHeader: string | undefined
    const upstream = createServer((req, res) => {
      forwardedPreviewToken = req.headers['x-cuddly-preview-token'] as string | undefined
      forwardedInternalHeader = req.headers['x-cuddly-internal-test'] as string | undefined
      res.setHeader('Content-Type', 'text/plain')
      res.end(`upstream:${req.url}`)
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Upstream did not bind a TCP port')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyStaticArtifact(
      store,
      artifactStore,
      'master',
      'baseline-webapp'
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'publish webapp',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: artifact.id }],
    })
    await ensureTestSiteBinding(store, 'main', 'webapp')
    await store.createPreviewSession({
      token: 'private-preview-token',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      siteArtifactId: artifact.id,
      selections: [],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
        officialOrigin: 'https://www.kookapp.cn',
      })
    )
    const previewHeaders = { 'x-cuddly-preview-token': 'private-preview-token' }

    const navigation = await fetch(`${origin}/channels/123`, {
      headers: { ...previewHeaders, accept: 'text/html' },
    })
    expect(navigation.status).toBe(200)
    const navigationHtml = await navigation.text()
    expect(navigationHtml).toContain('baseline-webapp')
    expect(navigationHtml).toContain('/__cuddly/bootstrap.js')
    expect(navigationHtml).not.toContain('/__cuddly/hooks/k-inject.js')

    const asset = await fetch(`${origin}/assets/app.12345678.js`, { headers: previewHeaders })
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('master')

    const appAsset = await fetch(`${origin}/app/assets/app.12345678.js`, {
      headers: previewHeaders,
    })
    expect(appAsset.status).toBe(200)
    expect(await appAsset.text()).toContain('master')

    const appStaticAsset = await fetch(`${origin}/app/static/js/runtime-index.12345678.js`, {
      headers: previewHeaders,
    })
    expect(appStaticAsset.status).toBe(200)
    expect(await appStaticAsset.text()).toContain('master')

    const missingAsset = await fetch(`${origin}/assets/missing.js`, { headers: previewHeaders })
    expect(missingAsset.status).toBe(404)
    expect(await missingAsset.json()).toMatchObject({ code: 'FRONTEND_ASSET_NOT_FOUND' })

    const missingAppAsset = await fetch(`${origin}/app/static/js/missing.js`, {
      headers: previewHeaders,
    })
    expect(missingAppAsset.status).toBe(404)
    expect(await missingAppAsset.json()).toMatchObject({ code: 'FRONTEND_ASSET_NOT_FOUND' })

    const backend = await fetch(`${origin}/api/profile`, {
      headers: {
        'x-cuddly-preview-token': 'private-preview-token',
        'x-cuddly-internal-test': 'private-value',
      },
    })
    expect(backend.status).toBe(200)
    expect(await backend.text()).toBe('upstream:/api/profile')
    expect(forwardedPreviewToken).toBeUndefined()
    expect(forwardedInternalHeader).toBeUndefined()

    const dottedBackend = await fetch(`${origin}/api/export.csv`)
    expect(dottedBackend.status).toBe(200)
    expect(await dottedBackend.text()).toBe('upstream:/api/export.csv')

    const managementBackend = await fetch(`${origin}/mis/export.csv`)
    expect(managementBackend.status).toBe(200)
    expect(await managementBackend.text()).toBe('upstream:/mis/export.csv')
  })

  it('separates the environment backend from the site frontend fallback', async () => {
    const backendRequests: string[] = []
    const fallbackRequests: string[] = []
    const backend = createServer((req, res) => {
      backendRequests.push(`${req.method} ${req.url}`)
      res.end(`backend:${req.method}:${req.url}`)
    })
    const fallback = createServer((req, res) => {
      fallbackRequests.push(`${req.method} ${req.url}`)
      res.end(`fallback:${req.method}:${req.url}`)
    })
    backend.listen(0)
    fallback.listen(0)
    servers.push(backend, fallback)
    await Promise.all([
      new Promise<void>((resolve) => backend.once('listening', resolve)),
      new Promise<void>((resolve) => fallback.once('listening', resolve)),
    ])
    const backendAddress = backend.address()
    const fallbackAddress = fallback.address()
    if (
      !backendAddress ||
      typeof backendAddress === 'string' ||
      !fallbackAddress ||
      typeof fallbackAddress === 'string'
    ) {
      throw new Error('Environment routing test servers did not bind TCP ports')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyStaticArtifact(store, artifactStore, 'master', 'webapp')
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'environment routing',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: artifact.id }],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${backendAddress.port}`,
        fallbackOrigin: `http://127.0.0.1:${fallbackAddress.port}`,
        officialOrigin: 'https://www.kookapp.cn',
      })
    )

    expect(await fetch(`${origin}/api/profile`).then((response) => response.text())).toBe(
      'backend:GET:/api/profile'
    )
    expect(await fetch(`${origin}/mis/audit`).then((response) => response.text())).toBe(
      'backend:GET:/mis/audit'
    )
    expect(
      await fetch(`${origin}/channels/1`, { method: 'POST', body: 'update' }).then((response) =>
        response.text()
      )
    ).toBe('backend:POST:/channels/1')
    expect(
      await fetch(`${origin}/api/v3/version/hot-module`).then((response) => response.text())
    ).toBe('backend:GET:/api/v3/version/hot-module')
    expect(await fetch(`${origin}/v3/version/hot-module`).then((response) => response.text())).toBe(
      'backend:GET:/v3/version/hot-module'
    )
    expect(await fetch(`${origin}/frontend-fallback`).then((response) => response.text())).toBe(
      'fallback:GET:/frontend-fallback'
    )

    expect(backendRequests).toEqual([
      'GET /api/profile',
      'GET /mis/audit',
      'POST /channels/1',
      'GET /api/v3/version/hot-module',
      'GET /v3/version/hot-module',
    ])
    expect(fallbackRequests).toEqual(['GET /frontend-fallback'])
  })

  it('rejects invalid Preview tokens before considering an archived binding environment', async () => {
    let upstreamRequests = 0
    const upstream = createServer((_req, res) => {
      upstreamRequests += 1
      res.end('unexpected')
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind a port')

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({ upstreamOrigin: `http://127.0.0.1:${address.port}` })
    )
    const environment = (await store.getEnvironment(TEST_ENVIRONMENT_SLUG))!
    store.getEnvironment = async () => ({ ...environment, status: 'ARCHIVED' })

    const response = await fetch(`${origin}/api/profile`, {
      headers: { 'x-cuddly-preview-token': 'old-preview' },
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

    const withoutPreview = await fetch(`${origin}/api/profile`)
    expect(withoutPreview.status).toBe(503)
    expect(await withoutPreview.json()).toEqual({
      code: 'ENVIRONMENT_ARCHIVED',
      environmentSlug: TEST_ENVIRONMENT_SLUG,
    })
    expect(upstreamRequests).toBe(0)
  })

  it('reports ready from all environments instead of depending on legacy shared', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const shared = (await store.getEnvironment(TEST_ENVIRONMENT_SLUG))!
    const online = {
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'online',
      name: '线上环境',
      backendOrigin: 'https://www.kookapp.cn',
      useInternalProxy: false,
      resourceProxyPrefixes: [],
      status: 'ACTIVE' as const,
      currentRevisionId: null,
    }
    await store.saveEnvironment({ ...shared, status: 'ARCHIVED' }, 'gz')
    await store.saveEnvironment(online, 'gz')
    const origin = await startGateway(store, artifactStore, null)

    expect(await fetch(`${origin}/health/ready`).then((response) => response.json())).toEqual({
      ok: true,
    })

    await store.saveEnvironment({ ...online, status: 'ARCHIVED' }, 'gz')
    const unavailable = await fetch(`${origin}/health/ready`)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ ok: false })

    store.listEnvironments = async () => {
      throw new Error('database unavailable')
    }
    const unreadable = await fetch(`${origin}/health/ready`)
    expect(unreadable.status).toBe(503)
    expect(await unreadable.json()).toEqual({ ok: false })
  })

  it('coalesces and expires site-binding and runtime-setting lookups', async () => {
    const upstream = createServer((_req, res) => res.end('backend'))
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind a port')

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()

    let bindingLookups = 0
    const getSiteBindingByHostname = store.getSiteBindingByHostname.bind(store)
    store.getSiteBindingByHostname = async (hostname, includeDisabled) => {
      bindingLookups += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return getSiteBindingByHostname(hostname, includeDisabled)
    }
    let runtimeLookups = 0
    const upstreamOrigin = `http://127.0.0.1:${address.port}`
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({ upstreamOrigin }),
      [],
      undefined,
      async () => {
        runtimeLookups += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          allowedHosts: [],
          proxy: {
            upstream: new URL(upstreamOrigin),
            publicOrigin: new URL('http://localhost'),
            cookieDomain: '',
            maxRewriteBytes: 1024,
          },
        }
      }
    )

    const concurrent = await Promise.all([
      fetch(`${origin}/api/profile`),
      fetch(`${origin}/api/profile`),
    ])
    expect(concurrent.map((response) => response.status)).toEqual([200, 200])
    expect(bindingLookups).toBe(1)
    expect(runtimeLookups).toBe(1)

    await fetch(`${origin}/api/profile`)
    expect(bindingLookups).toBe(1)
    expect(runtimeLookups).toBe(1)

    const missingFirst = await fetchWithHost(`${origin}/api/profile`, 'missing.example.test')
    const missingSecond = await fetchWithHost(`${origin}/api/profile`, 'missing.example.test')
    expect([missingFirst.status, missingSecond.status]).toEqual([404, 404])
    expect(bindingLookups).toBe(2)

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1_001)
    const missingAfterNegativeTtl = await fetchWithHost(
      `${origin}/api/profile`,
      'missing.example.test'
    )
    expect(missingAfterNegativeTtl.status).toBe(404)
    expect(bindingLookups).toBe(3)
    expect(runtimeLookups).toBe(1)

    clock.mockReturnValue(now + 5_001)
    const afterPositiveTtl = await fetch(`${origin}/api/profile`).finally(() => clock.mockRestore())
    expect(afterPositiveTtl.status).toBe(200)
    expect(bindingLookups).toBe(4)
    expect(runtimeLookups).toBe(2)
  })

  it('keeps a network-path request target on the configured upstream authority', async () => {
    let upstreamRequestUrl = ''
    let attackerRequests = 0
    const upstream = createServer((req, res) => {
      upstreamRequestUrl = req.url || ''
      res.end('configured-upstream')
    })
    const attacker = createServer((_req, res) => {
      attackerRequests += 1
      res.end('attacker-authority')
    })
    upstream.listen(0)
    attacker.listen(0)
    servers.push(upstream, attacker)
    await Promise.all([
      new Promise<void>((resolve) => upstream.once('listening', resolve)),
      new Promise<void>((resolve) => attacker.once('listening', resolve)),
    ])
    const upstreamAddress = upstream.address()
    const attackerAddress = attacker.address()
    if (
      !upstreamAddress ||
      typeof upstreamAddress === 'string' ||
      !attackerAddress ||
      typeof attackerAddress === 'string'
    ) {
      throw new Error('Proxy regression servers did not bind TCP ports')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({ upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}` })
    )
    const networkPath = `//127.0.0.1:${attackerAddress.port}/authority-must-stay-a-path?probe=1`

    const response = await fetch(`${origin}${networkPath}`, {
      method: 'POST',
      body: 'proxy-boundary',
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('configured-upstream')
    expect(upstreamRequestUrl).toBe(networkPath)
    expect(attackerRequests).toBe(0)
  })

  it('uses one site preview token for the webapp Artifact and both hot-module paths', async () => {
    const hotModuleRequests: Array<{
      url: string
      authorization?: string
      cookie?: string
      previewToken?: string
    }> = []
    const upstream = createServer((req, res) => {
      if (req.url?.startsWith('/official.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8')
        res.write('.hero{background:url("https://img.kookapp.cn/assets/hero.png")')
        res.end('}')
        return
      }
      if (req.url?.startsWith('/already-injected')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          '<html><head><script data-cuddly-resource-proxy src="/__cuddly/resource-proxy.js"></script></head><body>official-webapp</body></html>'
        )
        return
      }
      if (req.url?.includes('/v3/version/hot-module')) {
        hotModuleRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          previewToken: req.headers['x-cuddly-preview-token'] as string | undefined,
        })
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'public, max-age=3600')
        if (req.url.includes('malformed=1')) {
          res.end('{')
          return
        }
        res.end(
          JSON.stringify({
            code: 0,
            message: 'official response',
            traceId: 'official-trace',
            data: {
              id: 42,
              version: 'v8',
              modules: {
                base: {
                  id: 1,
                  name: 'official_base',
                  entry: 'https://img.kookapp.cn/base_new/official/remoteEntry.js',
                  version: 'official_base',
                  restartRequired: false,
                },
                discover: {
                  name: 'official_discover',
                  entry: 'https://img.kookapp.cn/discover_new/official/remoteEntry.js',
                  version: 'official_discover',
                  restartRequired: false,
                },
              },
            },
          })
        )
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.write(
        '<html><head><link rel="stylesheet" href="/official.css">' +
          '<script id="static-app" defer src="https://static.kookapp.cn/app/static/js/runtime-index.js"></script></head>'
      )
      res.end(
        '<body><img src="https://img.kookapp.cn/assets/hero.png">official-webapp</body></html>'
      )
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Hot-module upstream did not bind a TCP port')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const baseline = await createReadyStaticArtifact(
      store,
      artifactStore,
      'master',
      'baseline-webapp'
    )
    const previewSite = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/site',
      'preview-webapp'
    )
    const remote = await createReadyRemoteArtifact(store, artifactStore, 'feature/remote')
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'publish webapp',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: baseline.id }],
    })
    await ensureTestSiteBinding(store, 'main', 'webapp')
    await ensureTestSiteBinding(store, 'other', 'webapp')
    await store.createPreviewSession({
      token: 'site-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      siteArtifactId: previewSite.id,
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: remote.id,
          branch: remote.branch,
          builtAt: remote.builtAt,
          providerName: 'cuddly_base_test',
          version: 'cuddly_base_test',
          entryPath: 'remoteEntry.js',
        },
      ],
    })
    await store.createPreviewSession({
      token: 'remote-only-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: remote.id,
          branch: remote.branch,
          builtAt: remote.builtAt,
          providerName: 'cuddly_base_test',
          version: 'cuddly_base_test',
          entryPath: 'remoteEntry.js',
        },
      ],
    })
    await store.createPreviewSession({
      token: 'other-site-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'other',
      siteArtifactId: previewSite.id,
      selections: [],
    })
    await store.createPreviewSession({
      token: 'expired-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      selections: [],
    })
    const previewLookupCounts = new Map<string, number>()
    const getPreviewSession = store.getPreviewSession.bind(store)
    store.getPreviewSession = async (token) => {
      previewLookupCounts.set(token, (previewLookupCounts.get(token) || 0) + 1)
      return getPreviewSession(token)
    }
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
        officialOrigin: 'https://www.kookapp.cn',
        remoteTargetIds: ['base'],
        resourceProxyPrefixes: ['https://img.kookapp.cn/', 'https://static.kookapp.cn/'],
      })
    )

    const resolveCurrentArtifact = vi.spyOn(store, 'resolveCurrentArtifact')
    const baselineResponse = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
    expect(baselineResponse.status).toBe(200)
    const baselineHtml = await baselineResponse.text()
    expect(baselineHtml).toContain('official-webapp')
    expect(baselineHtml).not.toContain('baseline-webapp')
    expect(baselineHtml).not.toContain('/__cuddly/bootstrap.js')
    expect(resolveCurrentArtifact).not.toHaveBeenCalled()

    const previewHeaders = {
      accept: 'text/html',
      'x-cuddly-preview-token': 'site-preview',
    }
    const previewResponse = await fetch(`${origin}/`, { headers: previewHeaders })
    expect(previewResponse.status).toBe(200)
    expect(await previewResponse.text()).toContain('preview-webapp')

    const mismatchedResponse = await fetch(`${origin}/`, {
      headers: { ...previewHeaders, 'x-cuddly-preview-token': 'other-site-preview' },
    })
    expect(mismatchedResponse.status).toBe(404)
    expect(mismatchedResponse.headers.get('cache-control')).toContain('no-store')
    expect(await mismatchedResponse.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

    const expiredPreview = await fetch(`${origin}/channels/1`, {
      headers: { 'x-cuddly-preview-token': 'expired-preview' },
    })
    expect(expiredPreview.status).toBe(404)
    expect(expiredPreview.headers.get('cache-control')).toContain('no-store')
    expect(await expiredPreview.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

    const missingPreview = await fetch(`${origin}/__cuddly/bootstrap.js`, {
      headers: { 'x-cuddly-preview-token': 'missing-preview' },
    })
    expect(missingPreview.status).toBe(404)
    expect(missingPreview.headers.get('cache-control')).toContain('no-store')
    expect(await missingPreview.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

    const remoteOnlyPage = await fetch(`${origin}/channels/1`, {
      headers: {
        accept: 'text/html',
        'x-cuddly-preview-token': 'remote-only-preview',
      },
    })
    expect(remoteOnlyPage.status).toBe(200)
    const remoteOnlyHtml = await remoteOnlyPage.text()
    const resourceProxyPath = `${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId('https://img.kookapp.cn/')}`
    const staticResourceProxyPath = `${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId('https://static.kookapp.cn/')}`
    const transformVersion = resourceProxyTransformVersion(
      siteBinding({
        resourceProxyPrefixes: ['https://img.kookapp.cn/', 'https://static.kookapp.cn/'],
      })
    )
    expect(remoteOnlyHtml).toContain('official-webapp')
    expect(remoteOnlyHtml).toContain('/__cuddly/resource-proxy.js')
    expect(remoteOnlyHtml).not.toContain('/__cuddly/bootstrap.js')
    expect(remoteOnlyHtml).toContain(`${resourceProxyPath}/assets/hero.png`)
    expect(remoteOnlyHtml).toContain(`${staticResourceProxyPath}/app/static/js/runtime-index.js`)
    expect(remoteOnlyHtml).not.toContain('https://static.kookapp.cn/')
    expect(remoteOnlyHtml.indexOf('/__cuddly/resource-proxy.js')).toBeLessThan(
      remoteOnlyHtml.indexOf(`${staticResourceProxyPath}/app/static/js/runtime-index.js`)
    )
    expect(remoteOnlyHtml).toContain(
      `/official.css?${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${transformVersion}`
    )

    const officialCss = await fetch(
      `${origin}/official.css?${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${transformVersion}`,
      { headers: { 'x-cuddly-preview-token': 'remote-only-preview' } }
    )
    expect(officialCss.status).toBe(200)
    expect(await officialCss.text()).toContain(`${resourceProxyPath}/assets/hero.png`)

    const alreadyInjected = await fetch(`${origin}/already-injected`, {
      headers: { 'x-cuddly-preview-token': 'remote-only-preview' },
    })
    expect((await alreadyInjected.text()).match(/data-cuddly-resource-proxy/g)).toHaveLength(1)

    const officialHead = await fetch(`${origin}/channels/1`, {
      method: 'HEAD',
      headers: { 'x-cuddly-preview-token': 'remote-only-preview' },
    })
    expect(officialHead.status).toBe(200)
    expect(officialHead.headers.get('cache-control')).toContain('no-store')
    expect(await officialHead.text()).toBe('')

    const invalidSiteArtifact = await fetch(`${origin}/__cuddly/artifacts/not-a-uuid/app.js`, {
      headers: { 'x-cuddly-preview-token': 'site-preview' },
    })
    expect(invalidSiteArtifact.status).toBe(404)
    expect(invalidSiteArtifact.headers.get('cache-control')).toContain('no-store')

    const previewAsset = await fetch(
      `${origin}/__cuddly/artifacts/${previewSite.id}/assets/app.12345678.js`,
      { headers: { 'x-cuddly-preview-token': 'site-preview' } }
    )
    expect(previewAsset.status).toBe(200)
    expect(await previewAsset.text()).toContain('feature/site')

    const unscopedPreviewAsset = await fetch(
      `${origin}/__cuddly/artifacts/${previewSite.id}/assets/app.12345678.js`
    )
    expect(unscopedPreviewAsset.status).toBe(404)

    const mismatchedPreviewAsset = await fetch(
      `${origin}/__cuddly/artifacts/${previewSite.id}/assets/app.12345678.js`,
      { headers: { 'x-cuddly-preview-token': 'other-site-preview' } }
    )
    expect(mismatchedPreviewAsset.status).toBe(404)
    expect(mismatchedPreviewAsset.headers.get('cache-control')).toContain('no-store')
    expect(await mismatchedPreviewAsset.json()).toMatchObject({ code: 'PREVIEW_NOT_FOUND' })

    for (const hotModulePath of [
      '/api/v3/version/hot-module?app=1.2.3&addon=4&id=42',
      '/v3/version/hot-module?app=1.2.3&addon=4&id=42',
    ]) {
      const response = await fetch(`${origin}${hotModulePath}`, {
        headers: {
          authorization: 'Bearer qa-session',
          cookie: 'session=qa-cookie',
          'x-cuddly-preview-token': 'site-preview',
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('content-length')).toBeNull()
      expect(await response.json()).toEqual({
        code: 0,
        message: 'official response',
        traceId: 'official-trace',
        data: {
          id: 42,
          version: 'v8',
          modules: {
            base: {
              id: 1,
              name: 'cuddly_base_test',
              entry: remote.manifest.serve.publicBase + 'remoteEntry.js',
              version: 'cuddly_base_test',
              restartRequired: true,
            },
            discover: {
              name: 'official_discover',
              entry: 'https://img.kookapp.cn/discover_new/official/remoteEntry.js',
              version: 'official_discover',
              restartRequired: false,
            },
          },
        },
      })
    }
    expect(hotModuleRequests).toHaveLength(2)
    expect(
      hotModuleRequests.every((request) => request.url.endsWith('?app=1.2.3&addon=4&id=42'))
    ).toBe(true)
    expect(
      hotModuleRequests.every((request) => request.authorization === 'Bearer qa-session')
    ).toBe(true)
    expect(hotModuleRequests.every((request) => request.cookie === 'session=qa-cookie')).toBe(true)
    expect(hotModuleRequests.every((request) => request.previewToken === undefined)).toBe(true)

    const malformedOfficial = await fetch(`${origin}/api/v3/version/hot-module?malformed=1`, {
      headers: { 'x-cuddly-preview-token': 'site-preview' },
    })
    expect(malformedOfficial.status).toBe(200)
    expect(malformedOfficial.headers.get('cache-control')).toBe('private, no-store')
    expect(await malformedOfficial.text()).toBe('{')

    const hotModuleRequestCount = hotModuleRequests.length
    await store.saveSiteBinding(
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
        officialOrigin: 'https://www.kookapp.cn',
        remoteTargetIds: [],
        resourceProxyPrefixes: ['https://img.kookapp.cn/'],
      }),
      'gz'
    )
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5_001)
    const stalePreview = await fetch(`${origin}/api/v3/version/hot-module`, {
      headers: { 'x-cuddly-preview-token': 'site-preview' },
    }).finally(() => clock.mockRestore())
    expect(stalePreview.status).toBe(410)
    expect(stalePreview.headers.get('cache-control')).toContain('no-store')
    expect(await stalePreview.json()).toMatchObject({ code: 'PREVIEW_REMOTE_NOT_ALLOWED' })
    expect(hotModuleRequests).toHaveLength(hotModuleRequestCount)
    expect(previewLookupCounts.get('site-preview')).toBe(1)
  })

  it('keeps a Preview on its captured environment when the binding default changes', async () => {
    const upstream = createServer((_req, res) => res.end('backend'))
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind a port')

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    await ensureTestSiteBinding(store, 'main', 'webapp')
    await store.createPreviewSession({
      token: 'environment-bound-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      selections: [],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${address.port}`,
      })
    )
    const first = await fetch(`${origin}/api/profile`, {
      headers: { 'x-cuddly-preview-token': 'environment-bound-preview' },
    })
    expect(first.status).toBe(200)
    await first.text()

    const rebound = { ...(await store.getSiteBinding('main'))!, environmentSlug: 'other' }
    store.getSiteBindingByHostname = async () => rebound
    const getEnvironment = store.getEnvironment.bind(store)
    store.getEnvironment = async (idOrSlug) =>
      idOrSlug === 'other'
        ? {
            id: '00000000-0000-4000-8000-000000000002',
            slug: 'other',
            name: '另一环境',
            backendOrigin: `http://127.0.0.1:${address.port}`,
            useInternalProxy: false,
            resourceProxyPrefixes: [],
            status: 'ACTIVE',
            currentRevisionId: null,
          }
        : getEnvironment(idOrSlug)

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5_001)
    const reboundPreview = await fetch(`${origin}/api/profile`, {
      headers: { 'x-cuddly-preview-token': 'environment-bound-preview' },
    }).finally(() => clock.mockRestore())
    expect(reboundPreview.status).toBe(200)
    expect(reboundPreview.headers.get('cache-control')).toContain('no-store')
    await reboundPreview.text()

    const runtime = await fetch(`${origin}/__cuddly/runtime`, {
      headers: { 'x-cuddly-preview-token': 'environment-bound-preview' },
    }).then((response) => response.json())
    expect(runtime.environment).toMatchObject({
      id: TEST_ENVIRONMENT_ID,
      slug: TEST_ENVIRONMENT_SLUG,
    })
  })

  it('does not authorize an Artifact whose environment differs from the bound site', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyArtifact(
      store,
      artifactStore,
      'master',
      'window.ready = true'
    )
    await store.publishRevision({
      environmentId: TEST_ENVIRONMENT_SLUG,
      baseRevisionId: null,
      message: 'environment guard',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: artifact.id }],
    })
    const origin = await startGateway(store, artifactStore)
    await createSiteArtifactPreview(store, 'environment-guard-preview', 'mobile', artifact)
    const getArtifact = store.getArtifact.bind(store)
    store.getArtifact = async (artifactId) => {
      const result = await getArtifact(artifactId)
      return result
        ? {
            ...result,
            environmentId: '00000000-0000-4000-8000-000000000002',
            environmentSlug: 'other',
          }
        : null
    }

    const response = await fetch(
      `${origin}/__cuddly/artifacts/${artifact.id}/static/app.12345678.js`,
      { headers: { 'x-cuddly-preview-token': 'environment-guard-preview' } }
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'ARTIFACT_NOT_REFERENCED' })
  })

  it('ignores the current Revision and overlays a Remote only for its Preview token', async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          code: 0,
          message: 'official',
          data: {
            id: 7,
            version: 'v7',
            modules: {
              base: {
                name: 'official_base',
                entry: 'https://img.kookapp.cn/base_new/official/remoteEntry.js',
                version: 'official_base',
                restartRequired: false,
              },
              discover: {
                name: 'official_discover',
                entry: 'https://img.kookapp.cn/discover_new/official/remoteEntry.js',
                version: 'official_discover',
                restartRequired: false,
              },
            },
          },
        })
      )
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Environment hot-module upstream did not bind a TCP port')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    await store.saveBuildTarget(
      {
        ...(await store.getBuildTarget('base'))!,
        repositoryUrl: 'ssh://git.example.test/kook.git',
        enabled: true,
        configurationSource: 'database',
      },
      'gz'
    )
    const site = await createReadyStaticArtifact(store, artifactStore, 'master', 'webapp')
    const resourcePrefix = 'https://img.chuanyuapp.com/'
    const remoteCssPath = 'static/discover.12345678.css'
    const remoteCssSource =
      '.discover{--discover-menu-icon-light:url(https://img.chuanyuapp.com/assets/item/resources/discover.png)}'
    const remote = await createReadyRemoteArtifact(store, artifactStore, 'feature/public-base', {
      additionalFiles: { [remoteCssPath]: remoteCssSource },
    })
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'publish Remote',
      createdBy: 'gz',
      selections: [
        { targetId: 'webapp', artifactId: site.id },
        { targetId: 'base', artifactId: remote.id },
      ],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
        officialOrigin: 'https://www.kookapp.cn',
        remoteTargetIds: ['base'],
        resourceProxyPrefixes: [resourcePrefix],
      })
    )

    const resolveCurrentRemoteArtifacts = vi.spyOn(store, 'resolveCurrentRemoteArtifacts')
    const withoutPreview = await fetch(`${origin}/api/v3/version/hot-module`)
    expect(withoutPreview.status).toBe(200)
    expect(await withoutPreview.json()).toMatchObject({
      data: {
        id: 7,
        version: 'v7',
        modules: {
          base: { name: 'official_base', restartRequired: false },
          discover: { name: 'official_discover' },
        },
      },
    })
    expect(resolveCurrentRemoteArtifacts).not.toHaveBeenCalled()

    const legacyEntryPath = new URL(`${remote.manifest.serve.publicBase}remoteEntry.js`).pathname
    const legacyEntry = await fetch(`${origin}${legacyEntryPath}`)
    expect(legacyEntry.status).toBe(404)
    expect(await legacyEntry.json()).toMatchObject({ code: 'ARTIFACT_NOT_REFERENCED' })

    await store.createPreviewSession({
      token: 'remote-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'main',
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: remote.id,
          branch: remote.branch,
          builtAt: remote.builtAt,
          providerName: remote.manifest.serve.remote!.providerName,
          version: remote.manifest.serve.remote!.providerName,
          entryPath: remote.manifest.serve.remote!.entryPath,
        },
      ],
    })
    const previewHeaders = { 'x-cuddly-preview-token': 'remote-preview' }
    const selected = await fetch(`${origin}/api/v3/version/hot-module`, {
      headers: previewHeaders,
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({
      data: {
        id: 7,
        version: 'v7',
        modules: {
          base: {
            name: 'cuddly_base_test',
            entry: `${remote.manifest.serve.publicBase}remoteEntry.js`,
            restartRequired: true,
          },
          discover: { name: 'official_discover' },
        },
      },
    })

    const entryPath = new URL(`${remote.manifest.serve.publicBase}remoteEntry.js`).pathname
    const publishedEntry = await fetch(`${origin}${entryPath}`, { headers: previewHeaders })
    expect(publishedEntry.status).toBe(200)
    expect(await publishedEntry.text()).toContain('remotePreview')

    const remoteCssPathname = new URL(`${remote.manifest.serve.publicBase}${remoteCssPath}`)
      .pathname
    const publishedCss = await fetch(`${origin}${remoteCssPathname}`, { headers: previewHeaders })
    expect(publishedCss.status).toBe(200)
    expect(publishedCss.headers.get('accept-ranges')).toBe('none')
    expect(await publishedCss.text()).toBe(
      remoteCssSource.replace(
        resourcePrefix,
        `${origin}${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId(resourcePrefix)}/`
      )
    )
  })

  it('uses a Preview environment instead of the binding default for backend and Artifacts', async () => {
    const backend = (name: string) =>
      createServer((req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=3600')
        if (req.url?.includes('/v3/version/hot-module')) {
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              code: 0,
              environment: name,
              data: {
                modules: {
                  base: {
                    name: `official_${name}`,
                    entry: `https://img.kookapp.cn/${name}/remoteEntry.js`,
                  },
                },
              },
            })
          )
          return
        }
        if (req.url?.startsWith('/api/')) {
          res.end(`${name}-backend:${req.url}`)
          return
        }
        res.setHeader('Content-Type', 'text/html')
        res.end(`<html><body>${name}-official</body></html>`)
      })
    const sharedBackend = backend('shared')
    const testBackend = backend('test')
    sharedBackend.listen(0)
    testBackend.listen(0)
    servers.push(sharedBackend, testBackend)
    await Promise.all([
      new Promise<void>((resolve) => sharedBackend.once('listening', resolve)),
      new Promise<void>((resolve) => testBackend.once('listening', resolve)),
    ])
    const sharedAddress = sharedBackend.address()
    const testAddress = testBackend.address()
    if (
      !sharedAddress ||
      typeof sharedAddress === 'string' ||
      !testAddress ||
      typeof testAddress === 'string'
    ) {
      throw new Error('Cross-environment Preview upstreams did not bind TCP ports')
    }
    const sharedBackendOrigin = `http://127.0.0.1:${sharedAddress.port}`
    const testBackendOrigin = `http://127.0.0.1:${testAddress.port}`

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const sharedRemote = await createReadyRemoteArtifact(store, artifactStore, 'feature/shared', {
      relativePublicBase: true,
    })
    const testEnvironment = {
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'test',
      name: '测试环境',
      status: 'ACTIVE' as const,
      backendOrigin: testBackendOrigin,
      useInternalProxy: false,
      resourceProxyPrefixes: [],
      currentRevisionId: null,
    }
    await store.saveEnvironment(testEnvironment, 'gz')
    const [baseTarget, webappTarget] = await Promise.all([
      store.getBuildTarget('base'),
      store.getBuildTarget('webapp'),
    ])
    for (const target of [baseTarget, webappTarget]) {
      if (!target) throw new Error('Missing cross-environment test target')
      await store.saveProjectEnvironmentConfig(
        {
          environmentId: testEnvironment.id,
          targetId: target.id,
          enabled: true,
          required: false,
          installCommand: target.installCommand,
          buildCommand: target.buildCommand,
          outputDirectory: target.outputDirectory,
        },
        'gz'
      )
    }
    const testRemote = await createReadyRemoteArtifact(store, artifactStore, 'feature/test', {
      environmentId: testEnvironment.id,
      environmentSlug: testEnvironment.slug,
      relativePublicBase: true,
    })
    const testSite = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/test-site',
      'test-preview-site',
      undefined,
      {},
      { id: testEnvironment.id, slug: testEnvironment.slug }
    )

    const hostname = 'main.bifrost.example'
    const bindingId = 'main'
    const bindingFor = (environmentSlug: string) =>
      siteBinding({
        id: bindingId,
        hostname,
        targetId: 'webapp',
        environmentSlug,
        upstreamOrigin: sharedBackendOrigin,
        fallbackOrigin: sharedBackendOrigin,
        remoteTargetIds: ['base'],
      })

    // Model a Preview whose immutable environment differs from the site's current default.
    await store.saveSiteBinding(bindingFor(testEnvironment.slug), 'gz')
    await store.createPreviewSession({
      token: 'test-environment-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: testEnvironment.id,
      environmentSlug: testEnvironment.slug,
      siteBindingId: bindingId,
      siteArtifactId: testSite.id,
      selections: [
        {
          moduleKey: 'base',
          targetId: 'base',
          artifactId: testRemote.id,
          branch: testRemote.branch,
          builtAt: testRemote.builtAt,
          providerName: testRemote.manifest.serve.remote!.providerName,
          version: testRemote.manifest.serve.remote!.providerName,
          entryPath: testRemote.manifest.serve.remote!.entryPath,
        },
      ],
    })
    await store.createPreviewSession({
      token: 'test-environment-official-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: testEnvironment.id,
      environmentSlug: testEnvironment.slug,
      siteBindingId: bindingId,
      selections: [],
    })
    const origin = await startGateway(store, artifactStore, bindingFor(TEST_ENVIRONMENT_SLUG))
    const previewHeaders = { 'x-cuddly-preview-token': 'test-environment-preview' }
    const officialPreviewHeaders = {
      'x-cuddly-preview-token': 'test-environment-official-preview',
    }

    expect(
      await fetchWithHost(`${origin}/api/profile`, hostname).then((response) => response.text())
    ).toBe('shared-backend:/api/profile')
    const previewBackend = await fetchWithHost(`${origin}/api/profile`, hostname, previewHeaders)
    expect(await previewBackend.text()).toBe('test-backend:/api/profile')
    expect(previewBackend.headers.get('cache-control')).toBe('private, no-store')

    const officialPreviewBackend = await fetchWithHost(
      `${origin}/api/profile`,
      hostname,
      officialPreviewHeaders
    )
    expect(await officialPreviewBackend.text()).toBe('test-backend:/api/profile')
    expect(officialPreviewBackend.headers.get('cache-control')).toBe('private, no-store')

    const officialPage = await fetchWithHost(`${origin}/channels/1`, hostname, {
      accept: 'text/html',
    })
    expect(await officialPage.text()).toContain('shared-official')
    const previewPage = await fetchWithHost(`${origin}/channels/1`, hostname, {
      ...previewHeaders,
      accept: 'text/html',
    })
    expect(previewPage.status).toBe(200)
    expect(await previewPage.text()).toContain('test-preview-site')
    const officialPreviewPage = await fetchWithHost(`${origin}/channels/1`, hostname, {
      ...officialPreviewHeaders,
      accept: 'text/html',
    })
    expect(await officialPreviewPage.text()).toContain('shared-official')
    expect(officialPreviewPage.headers.get('cache-control')).toBe('private, no-store')

    const officialHotModule = await fetchWithHost(
      `${origin}/api/v3/version/hot-module`,
      hostname
    ).then((response) => response.json())
    expect(officialHotModule).toMatchObject({
      environment: 'shared',
      data: { modules: { base: { name: 'official_shared' } } },
    })
    const previewHotModule = await fetchWithHost(
      `${origin}/api/v3/version/hot-module`,
      hostname,
      previewHeaders
    ).then((response) => response.json())
    expect(previewHotModule).toMatchObject({
      environment: 'test',
      data: {
        modules: {
          base: {
            name: testRemote.manifest.serve.remote!.providerName,
            entry: `http://${hostname}${testRemote.manifest.serve.publicBase}remoteEntry.js`,
          },
        },
      },
    })

    const officialPreviewHotModuleResponse = await fetchWithHost(
      `${origin}/api/v3/version/hot-module`,
      hostname,
      officialPreviewHeaders
    )
    expect(officialPreviewHotModuleResponse.headers.get('cache-control')).toBe('private, no-store')
    expect(await officialPreviewHotModuleResponse.json()).toMatchObject({
      environment: 'test',
      data: { modules: { base: { name: 'official_test' } } },
    })

    const runtime = await fetchWithHost(
      `${origin}/__cuddly/runtime`,
      hostname,
      previewHeaders
    ).then((response) => response.json())
    expect(runtime.environment).toMatchObject({ id: testEnvironment.id, slug: 'test' })
    const bootstrapSource = await fetchWithHost(
      `${origin}/__cuddly/bootstrap.js`,
      hostname,
      previewHeaders
    ).then((response) => response.text())
    const bootstrap = JSON.parse(bootstrapSource.slice('window.__CUDDLY__='.length, -1))
    expect(bootstrap).toMatchObject({
      environment: { id: testEnvironment.id, slug: testEnvironment.slug },
      artifact: { id: testSite.id, environmentId: testEnvironment.id },
    })

    const testEntry = `${testRemote.manifest.serve.publicBase}remoteEntry.js`
    expect((await fetchWithHost(`${origin}${testEntry}`, hostname, previewHeaders)).status).toBe(
      200
    )
    const crossEnvironment = await fetchWithHost(
      `${origin}${sharedRemote.manifest.serve.publicBase}remoteEntry.js`,
      hostname,
      previewHeaders
    )
    expect(crossEnvironment.status).toBe(404)
    expect(await crossEnvironment.json()).toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
  })

  it('proxies only configured resource paths without forwarding credentials', async () => {
    const upstreamRequests: Array<{
      url: string
      headers: Record<string, string | string[] | undefined>
    }> = []
    const upstream = createServer((req, res) => {
      upstreamRequests.push({ url: req.url || '', headers: req.headers })
      if (req.url?.startsWith('/assets/inside')) {
        res.statusCode = 302
        res.setHeader('Location', '/assets/final?redirected=1')
        res.end()
        return
      }
      if (req.url?.startsWith('/assets/outside')) {
        res.statusCode = 302
        res.setHeader('Location', '/private/secret.json')
        res.end()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Set-Cookie', 'upstream-secret=1; Path=/')
      res.end(JSON.stringify({ path: req.url }))
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Resource upstream did not bind a TCP port')
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const resourcePrefix = `http://assets.example.com:${upstreamAddress.port}/assets/`
    const resourceProxyHostResolver: ResourceProxyHostResolver = async (hostname) => ({
      hostname,
      addresses: [{ address: '127.0.0.1', family: 4 }],
      lookup: (_requestedHostname, options, callback) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
        else callback(null, '127.0.0.1', 4)
      },
    })
    await ensureTestSiteBinding(store, 'mobile', 'online-h5')
    await store.createPreviewSession({
      token: 'private-preview',
      createdBy: 'gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environmentId: TEST_ENVIRONMENT_ID,
      environmentSlug: TEST_ENVIRONMENT_SLUG,
      siteBindingId: 'mobile',
      selections: [],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        resourceProxyPrefixes: [resourcePrefix],
      }),
      [],
      resourceProxyHostResolver
    )
    const proxyPath = `${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId(resourcePrefix)}`

    const proxied = await fetch(`${origin}${proxyPath}/saying.json?language=zh-CN`, {
      headers: {
        authorization: 'Bearer private',
        cookie: 'session=private',
        'x-client-version': 'private-version',
        'x-cuddly-preview-token': 'private-preview',
        'x-signature': 'private-signature',
      },
    })
    expect(proxied.status).toBe(200)
    expect(await proxied.json()).toEqual({ path: '/assets/saying.json?language=zh-CN' })
    expect(proxied.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(proxied.headers.get('set-cookie')).toBeNull()
    expect(proxied.headers.get('access-control-allow-origin')).toBeNull()
    expect(proxied.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(upstreamRequests[0]).toMatchObject({ url: '/assets/saying.json?language=zh-CN' })
    expect(upstreamRequests[0]!.headers.authorization).toBeUndefined()
    expect(upstreamRequests[0]!.headers.cookie).toBeUndefined()
    expect(upstreamRequests[0]!.headers['x-client-version']).toBeUndefined()
    expect(upstreamRequests[0]!.headers['x-cuddly-preview-token']).toBeUndefined()
    expect(upstreamRequests[0]!.headers['x-signature']).toBeUndefined()
    expect(upstreamRequests[0]!.headers.origin).toBe(
      `http://assets.example.com:${upstreamAddress.port}`
    )

    const beforeRejectedRequests = upstreamRequests.length
    const traversal = await fetch(`${origin}${proxyPath}/%252e%252e/private.json`)
    expect(traversal.status).toBe(404)
    expect(await traversal.json()).toEqual({ code: 'RESOURCE_PROXY_ROUTE_NOT_FOUND' })
    const unknownRule = await fetch(
      `${origin}${RESOURCE_PROXY_BASE_PATH}/${'0'.repeat(64)}/saying.json`
    )
    expect(unknownRule.status).toBe(404)
    const write = await fetch(`${origin}${proxyPath}/saying.json`, {
      method: 'POST',
      body: 'not-forwarded',
    })
    expect(write.status).toBe(405)
    expect(upstreamRequests).toHaveLength(beforeRejectedRequests)

    const insideRedirect = await fetch(`${origin}${proxyPath}/inside`, {
      redirect: 'manual',
    })
    expect(insideRedirect.status).toBe(302)
    expect(insideRedirect.headers.get('location')).toBe(`${proxyPath}/final?redirected=1`)
    const outsideRedirect = await fetch(`${origin}${proxyPath}/outside`, {
      redirect: 'manual',
    })
    expect(outsideRedirect.status).toBe(502)
    expect(await outsideRedirect.json()).toEqual({
      code: 'RESOURCE_PROXY_REDIRECT_OUTSIDE_PREFIX',
    })
  })

  it('injects the resource proxy bootstrap before application scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const artifact = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/resource-proxy',
      '<script id="application-script">window.applicationStarted = true</script>'
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'resource proxy',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: artifact.id }],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        resourceProxyPrefixes: ['https://img.kookapp.cn/assets/'],
      })
    )
    await createSiteArtifactPreview(store, 'resource-proxy-preview', 'main', artifact)
    const previewHeaders = { 'x-cuddly-preview-token': 'resource-proxy-preview' }

    const response = await fetch(`${origin}/channels/1`, {
      headers: { ...previewHeaders, accept: 'text/html' },
    })
    expect(response.status).toBe(200)
    const entry = artifact.manifest.files.find((file) => file.path === 'index.html')
    expect(entry).toBeDefined()
    const artifactEtag = `"${entry!.digest}"`
    const injectedEtag = response.headers.get('etag')
    expect(injectedEtag).toMatch(/^"sha256:[a-f0-9]{64}"$/)
    expect(injectedEtag).not.toBe(artifactEtag)
    const html = await response.text()
    const proxyScriptIndex = html.indexOf(
      '<script data-cuddly-resource-proxy src="/__cuddly/resource-proxy.js"></script>'
    )
    expect(proxyScriptIndex).toBeGreaterThanOrEqual(0)
    expect(proxyScriptIndex).toBeLessThan(html.indexOf('application-script'))

    const staleArtifactEtag = await fetch(`${origin}/channels/1`, {
      headers: { ...previewHeaders, accept: 'text/html', 'if-none-match': artifactEtag },
    })
    expect(staleArtifactEtag.status).toBe(200)
    expect(staleArtifactEtag.headers.get('etag')).toBe(injectedEtag)
    await staleArtifactEtag.text()

    const currentInjectedEtag = await fetch(`${origin}/channels/1`, {
      headers: { ...previewHeaders, accept: 'text/html', 'if-none-match': injectedEtag! },
    })
    expect(currentInjectedEtag.status).toBe(304)
    expect(currentInjectedEtag.headers.get('etag')).toBe(injectedEtag)

    const bootstrap = await fetch(`${origin}/__cuddly/resource-proxy.js`, {
      headers: previewHeaders,
    })
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get('cache-control')).toBe('no-store')
    expect(bootstrap.headers.get('content-type')).toContain('text/javascript')
    const source = await bootstrap.text()
    expect(source).toContain('https://img.kookapp.cn/assets/')
    expect(source).toMatch(/credentials:\s*["']omit["']/)
    expect(source).toContain('XMLHttpRequestConstructor.prototype.open')
  })

  it('rewrites configured resource URLs in HTML and cache-busted Artifact CSS', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const resourcePrefix = 'https://img.kookapp.cn/'
    const stylesheetPath = 'assets/theme.12345678.css'
    const stylesheetSource =
      '.hero{background-image:url("https://img.kookapp.cn/backgrounds/hero.png")}'
    const scriptPath = 'assets/runtime.12345678.js'
    const scriptSource = 'window.runtimeAsset = "https://img.kookapp.cn/runtime/asset.json"'
    const documentHtml = [
      '<html><head>',
      `<link rel="stylesheet" href="/${stylesheetPath}" integrity="sha256-original">`,
      '<script src="https://img.kookapp.cn/remotes/remoteEntry.js"></script>',
      '</head><body>',
      '<img src="https://img.kookapp.cn/avatars/user.png" ',
      'srcset="https://img.kookapp.cn/avatars/user.png 1x, https://img.kookapp.cn/avatars/user@2x.png 2x">',
      '<div style="background:url(\'https://img.kookapp.cn/backgrounds/inline.png\')"></div>',
      '<script>window.inlineAsset = "https://img.kookapp.cn/api/config.json"</script>',
      '</body></html>',
    ].join('')
    const artifact = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/text-rewrite',
      '',
      documentHtml,
      {
        [stylesheetPath]: stylesheetSource,
        [scriptPath]: scriptSource,
      }
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'text rewrite',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: artifact.id }],
    })
    const binding = siteBinding({
      id: 'main',
      name: 'Main',
      targetId: 'webapp',
      resourceProxyPrefixes: [resourcePrefix],
    })
    const origin = await startGateway(store, artifactStore, binding)
    await createSiteArtifactPreview(store, 'text-rewrite-preview', 'main', artifact)
    const previewHeaders = { 'x-cuddly-preview-token': 'text-rewrite-preview' }
    const proxyPrefix = `${origin}${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId(resourcePrefix)}/`
    const transformVersion = resourceProxyTransformVersion(binding)
    const stylesheetUrl = `/${stylesheetPath}?${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${transformVersion}`

    const navigation = await fetch(`${origin}/channels/1`, {
      headers: { ...previewHeaders, accept: 'text/html' },
    })
    expect(navigation.status).toBe(200)
    const html = await navigation.text()
    expect(html).toContain(`href="${stylesheetUrl}"`)
    expect(html).not.toContain('integrity="sha256-original"')
    expect(html).toContain(`src="${proxyPrefix}remotes/remoteEntry.js"`)
    expect(html).toContain(`src="${proxyPrefix}avatars/user.png"`)
    expect(html).toContain(
      `srcset="${proxyPrefix}avatars/user.png 1x, ${proxyPrefix}avatars/user@2x.png 2x"`
    )
    expect(html).toContain(`url('${proxyPrefix}backgrounds/inline.png')`)
    expect(html).toContain(`window.inlineAsset = "${proxyPrefix}api/config.json"`)
    expect(html).not.toContain(resourcePrefix)

    const stylesheetMetadata = artifact.manifest.files.find((file) => file.path === stylesheetPath)
    expect(stylesheetMetadata).toBeDefined()
    const artifactEtag = `"${stylesheetMetadata!.digest}"`
    const stylesheet = await fetch(`${origin}${stylesheetUrl}`, {
      headers: { ...previewHeaders, 'if-none-match': artifactEtag },
    })
    expect(stylesheet.status).toBe(200)
    const rewrittenStylesheet = stylesheetSource.replace(resourcePrefix, proxyPrefix)
    expect(await stylesheet.text()).toBe(rewrittenStylesheet)
    expect(stylesheet.headers.get('etag')).not.toBe(artifactEtag)
    expect(stylesheet.headers.get('content-length')).toBe(
      String(Buffer.byteLength(rewrittenStylesheet))
    )
    expect(stylesheet.headers.get('accept-ranges')).toBe('none')
    expect(stylesheet.headers.get('cache-control')).toBe('private, no-store')

    const transformedEtag = stylesheet.headers.get('etag')
    const notModified = await fetch(`${origin}${stylesheetUrl}`, {
      headers: { ...previewHeaders, 'if-none-match': transformedEtag! },
    })
    expect(notModified.status).toBe(304)

    const rangedStylesheet = await fetch(`${origin}${stylesheetUrl}`, {
      headers: { ...previewHeaders, range: 'bytes=0-9' },
    })
    expect(rangedStylesheet.status).toBe(200)
    expect(rangedStylesheet.headers.get('content-range')).toBeNull()
    expect(await rangedStylesheet.text()).toBe(rewrittenStylesheet)

    const script = await fetch(`${origin}/${scriptPath}`, { headers: previewHeaders })
    expect(await script.text()).toBe(scriptSource)
    expect(script.headers.get('accept-ranges')).toBe('bytes')
  })

  it('versions internal Artifact CSS links in gift-gacha HTML and rewrites their content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const resourcePrefix = 'https://img.kookapp.cn/'
    const binding = siteBinding({ resourceProxyPrefixes: [resourcePrefix] })
    const origin = await startGateway(store, artifactStore, binding)
    const stylesheetPath = 'static/gift.12345678.css'
    const stylesheetSource = [
      '.gift{background:url("https://img.kookapp.cn//gift/background.png")}',
      '.gift-protocol{background:url("//img.kookapp.cn//gift/protocol.png")}',
    ].join('')
    const proxyRulePath = `${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId(resourcePrefix)}`
    const artifact = await createReadyArtifact(
      store,
      artifactStore,
      'feature/gift-css',
      'window.gift = true',
      {
        entryHtml: (entry, artifactId) =>
          entry === 'gift-gacha.htm'
            ? [
                '<html><head>',
                `<link rel="stylesheet" href="/__cuddly/artifacts/${artifactId}/${stylesheetPath}?theme=night&amp;lang=zh#palette" integrity="sha256-artifact">`,
                `<link rel=preload href="${origin}/__cuddly/artifacts/${artifactId}/${stylesheetPath}?absolute=1#absolute" integrity="sha256-absolute">`,
                `<link rel="preload" href="${stylesheetPath}?relative=1#relative" integrity="sha256-relative">`,
                `<link rel="icon" href="/__cuddly/artifacts/${artifactId}/${stylesheetPath}?icon=1#icon" integrity="sha256-icon">`,
                `<link rel="stylesheet" href="${proxyRulePath}/already-proxied.css" integrity="sha256-proxy">`,
                '</head><body>gift</body></html>',
              ].join('')
            : '<html><head></head><body>qa</body></html>',
        additionalFiles: { [stylesheetPath]: stylesheetSource },
      }
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'gift CSS rewrite',
      createdBy: 'gz',
      selections: [{ targetId: 'online-h5', artifactId: artifact.id }],
    })
    await createSiteArtifactPreview(store, 'gift-css-preview', binding.id, artifact)
    const previewHeaders = { 'x-cuddly-preview-token': 'gift-css-preview' }
    const transformVersion = resourceProxyTransformVersion(binding)
    const versionParameter = `${RESOURCE_PROXY_TRANSFORM_VERSION_PARAM}=${transformVersion}`

    const entry = await fetch(`${origin}/gift-gacha.htm`, {
      headers: { ...previewHeaders, accept: 'text/html' },
    })
    expect(entry.status).toBe(200)
    const html = await entry.text()
    expect(html).toContain(
      `href="/__cuddly/artifacts/${artifact.id}/${stylesheetPath}?theme=night&amp;lang=zh&amp;${versionParameter}#palette"`
    )
    expect(html).toContain(
      `href="${origin}/__cuddly/artifacts/${artifact.id}/${stylesheetPath}?absolute=1&${versionParameter}#absolute"`
    )
    expect(html).toContain(`href="${stylesheetPath}?relative=1&${versionParameter}#relative"`)
    expect(html).not.toContain('sha256-artifact')
    expect(html).not.toContain('sha256-absolute')
    expect(html).not.toContain('sha256-relative')
    expect(html).toContain(
      `<link rel="icon" href="/__cuddly/artifacts/${artifact.id}/${stylesheetPath}?icon=1#icon" integrity="sha256-icon">`
    )
    expect(html).toContain(
      `<link rel="stylesheet" href="${proxyRulePath}/already-proxied.css" integrity="sha256-proxy">`
    )

    const stylesheetMetadata = artifact.manifest.files.find((file) => file.path === stylesheetPath)
    expect(stylesheetMetadata).toBeDefined()
    const artifactEtag = `"${stylesheetMetadata!.digest}"`
    const stylesheet = await fetch(
      `${origin}/__cuddly/artifacts/${artifact.id}/${stylesheetPath}?theme=night&lang=zh&${versionParameter}`,
      { headers: { ...previewHeaders, 'if-none-match': artifactEtag } }
    )
    expect(stylesheet.status).toBe(200)
    expect(stylesheet.headers.get('etag')).not.toBe(artifactEtag)
    const expectedProxyPrefix = `${origin}${RESOURCE_PROXY_BASE_PATH}/${resourceProxyRuleId(
      resourcePrefix
    )}/`
    expect(await stylesheet.text()).toBe(
      [
        `.gift{background:url("${expectedProxyPrefix}gift/background.png")}`,
        `.gift-protocol{background:url("${expectedProxyPrefix}gift/protocol.png")}`,
      ].join('')
    )
  })

  it('ignores fake injection paths and head tags inside comments or templates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const documentHtml = [
      '<!-- <head><script src="/__cuddly/resource-proxy.js"></script></head> -->',
      '<template id="head-template"><head><script src="/template-only.js"></script></head></template>',
      '<script id="pre-body-script">window.fakeHead = "<head></head>"</script>',
      '<body><script id="application-script">window.applicationStarted = true</script></body>',
    ].join('')
    const artifact = await createReadyStaticArtifact(
      store,
      artifactStore,
      'feature/resource-proxy-comment',
      '',
      documentHtml
    )
    await store.publishRevision({
      environmentId: 'shared',
      baseRevisionId: null,
      message: 'resource proxy comment regression',
      createdBy: 'gz',
      selections: [{ targetId: 'webapp', artifactId: artifact.id }],
    })
    const origin = await startGateway(
      store,
      artifactStore,
      siteBinding({
        id: 'main',
        name: 'Main',
        targetId: 'webapp',
        resourceProxyPrefixes: ['https://img.kookapp.cn/assets/'],
      })
    )
    await createSiteArtifactPreview(store, 'comment-preview', 'main', artifact)

    const response = await fetch(`${origin}/channels/1`, {
      headers: { accept: 'text/html', 'x-cuddly-preview-token': 'comment-preview' },
    })
    expect(response.status).toBe(200)
    const html = await response.text()
    const injectedScript =
      '<script data-cuddly-resource-proxy src="/__cuddly/resource-proxy.js"></script>'
    const proxyScriptIndex = html.indexOf(injectedScript)
    const templateEnd = html.indexOf('</template>') + '</template>'.length
    expect(proxyScriptIndex).toBeGreaterThanOrEqual(templateEnd)
    expect(proxyScriptIndex).toBeLessThan(html.indexOf('pre-body-script'))
    expect(proxyScriptIndex).toBeLessThan(html.indexOf('<body>'))
    expect(html.split(injectedScript)).toHaveLength(2)
    expect(html.indexOf('/__cuddly/bootstrap.js')).toBeGreaterThan(templateEnd)
    expect(html.indexOf('/__cuddly/bootstrap.js')).toBeLessThan(html.indexOf('pre-body-script'))
    expect(html.indexOf('/__cuddly/bootstrap.js')).toBeLessThan(html.indexOf('<body>'))
  })

  it('rejects regular requests whose hostname has no enabled site binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const origin = await startGateway(store, artifactStore, null)

    const response = await fetch(`${origin}/`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'HOST_NOT_CONFIGURED' })
  })

  it('keeps configured legacy hostnames on the official frontend without a stored binding', async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<html><body>official-legacy</body></html>')
    })
    upstream.listen(0)
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.once('listening', resolve))
    const upstreamAddress = upstream.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('Legacy upstream did not bind a TCP port')
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const runtimeProxy = {
      upstream: new URL(`http://127.0.0.1:${upstreamAddress.port}`),
      publicOrigin: new URL('http://localhost'),
      cookieDomain: '',
      maxRewriteBytes: 1024,
    }
    const origin = await startGateway(
      store,
      artifactStore,
      null,
      ['127.0.0.1'],
      undefined,
      async () => ({ allowedHosts: ['127.0.0.1'], proxy: runtimeProxy })
    )

    const response = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('official-legacy')
    expect(html).not.toContain('/__cuddly/bootstrap.js')
  })

  it('does not revive a disabled site binding through the legacy hostname fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifacts-'))
    cleanupDirectories.push(root)
    const store = new MemoryStore()
    const artifactStore = new FileArtifactStore(root)
    await artifactStore.initialize()
    const origin = await startGateway(store, artifactStore, siteBinding({ enabled: false }), [
      '127.0.0.1',
    ])

    const response = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'HOST_NOT_CONFIGURED' })
  })
})
