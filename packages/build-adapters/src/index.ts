import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { ArtifactManifest, ArtifactManifestFile } from '@cuddly/contracts'

export const ONLINE_H5_ENTRYPOINTS = [
  'index.htm',
  'topup.htm',
  'gift-gacha.htm',
  'card-collect.htm',
  'ratings-preview.htm',
] as const

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.css': 'text/css; charset=utf-8',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
}

const HTML_HREF_RESOURCE_TAGS = new Set(['base', 'image', 'link', 'use'])
const HTML_RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])
const HTML_RESOURCE_ATTRIBUTE_PATTERN =
  /\b(src|href)[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'`=<>]+))/gi

type HtmlStartTag = {
  name: string
  source: string
}

function findHtmlTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

function htmlStartTags(html: string): HtmlStartTag[] {
  const tags: HtmlStartTag[] = []
  const lowerHtml = html.toLowerCase()
  let cursor = 0

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4)
      cursor = commentEnd < 0 ? html.length : commentEnd + 3
      continue
    }

    const end = findHtmlTagEnd(html, start)
    if (end < 0) break
    const source = html.slice(start, end + 1)
    const name = /^<[\t\n\f\r ]*([A-Za-z][A-Za-z0-9:-]*)/.exec(source)?.[1]?.toLowerCase()
    cursor = end + 1
    if (!name) continue

    tags.push({ name, source })
    if (HTML_RAW_TEXT_TAGS.has(name) && !/\/[\t\n\f\r ]*>$/.test(source)) {
      const closingTag = lowerHtml.indexOf(`</${name}`, cursor)
      if (closingTag >= 0) cursor = closingTag
    }
  }

  return tags
}

function htmlResourceReferences(html: string): string[] {
  const references: string[] = []
  for (const tag of htmlStartTags(html)) {
    for (const match of tag.source.matchAll(HTML_RESOURCE_ATTRIBUTE_PATTERN)) {
      const attribute = match[1]?.toLowerCase()
      if (attribute === 'href' && !HTML_HREF_RESOURCE_TAGS.has(tag.name)) continue
      const value = match[2] ?? match[3] ?? match[4]
      if (value) references.push(value)
    }
  }
  return references
}

function isKookProductionAppAsset(reference: string): boolean {
  let resource: URL
  try {
    resource = new URL(reference, 'https://cuddly.invalid/')
  } catch {
    return false
  }
  return resource.origin === 'https://static.kookapp.cn' && resource.pathname.startsWith('/app/')
}

async function assertNoKookProductionAppAssetFallback(
  outputDirectory: string,
  entrypoints: string[]
): Promise<void> {
  for (const entrypoint of entrypoints) {
    const html = await readFile(path.join(outputDirectory, entrypoint), 'utf8')
    const productionAsset = htmlResourceReferences(html).find(isKookProductionAppAsset)
    if (productionAsset) {
      throw new Error(
        `Generic static entrypoint ${entrypoint} references a KOOK production app asset instead of the build artifact: ${productionAsset}`
      )
    }
  }
}

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function cacheClass(filePath: string): ArtifactManifestFile['cacheClass'] {
  if (/\.html?$/i.test(filePath)) return 'html'
  if (/[.-][a-f0-9]{8,}\./i.test(filePath)) return 'immutable'
  return 'asset'
}

async function digestFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`))
  })
}

async function collectFiles(root: string, current = ''): Promise<ArtifactManifestFile[]> {
  const directory = path.join(root, current)
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ArtifactManifestFile[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = current
      ? path.posix.join(current.replaceAll('\\', '/'), entry.name)
      : entry.name
    const absolute = path.join(root, ...relative.split('/'))
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relative)))
      continue
    }
    if (!entry.isFile()) continue
    const fileStat = await stat(absolute)
    files.push({
      path: relative,
      size: fileStat.size,
      contentType: contentType(relative),
      digest: await digestFile(absolute),
      cacheClass: cacheClass(relative),
    })
  }
  return files
}

function projectManifestRelativePath(value: string, publicBase: string): string {
  const rawPath = value.split(/[?#]/, 1)[0] || ''
  const valuePath = new URL(rawPath, 'http://cuddly.invalid').pathname
  const publicBasePath = new URL(publicBase, 'http://cuddly.invalid').pathname.replace(/\/*$/, '/')
  const withoutPublicBase = valuePath.startsWith(publicBasePath)
    ? valuePath.slice(publicBasePath.length)
    : valuePath.replace(/^\/+/, '')
  const normalized = path.posix.normalize(decodeURIComponent(withoutPublicBase))
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Project manifest points outside the build output: ${value}`)
  }
  return normalized
}

async function assertProjectManifestComplete(
  outputDirectory: string,
  publicBase: string
): Promise<void> {
  const manifestPath = path.join(outputDirectory, 'asset-manifest.json')
  let raw: { files?: Record<string, string> }
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files?: Record<string, string>
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (const value of Object.values(raw.files || {})) {
    const pathname = projectManifestRelativePath(value, publicBase)
    try {
      const fileStat = await stat(path.join(outputDirectory, ...pathname.split('/')))
      if (!fileStat.isFile() || fileStat.size === 0) {
        throw new Error(`Project manifest points to an invalid file: ${value}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Project manifest points to a missing file: ${value}`, { cause: error })
      }
      throw error
    }
  }
}

export async function createOnlineH5Manifest(input: {
  outputDirectory: string
  artifactId: string
  targetId?: string
  branch: string
  builtAt: string
}): Promise<ArtifactManifest> {
  const publicBase = `/__cuddly/artifacts/${input.artifactId}/`
  for (const entrypoint of ONLINE_H5_ENTRYPOINTS) {
    const entryStat = await stat(path.join(input.outputDirectory, entrypoint))
    if (!entryStat.isFile() || entryStat.size === 0) {
      throw new Error(`Required online H5 entrypoint is missing or empty: ${entrypoint}`)
    }
  }
  await assertProjectManifestComplete(input.outputDirectory, publicBase)
  const files = await collectFiles(input.outputDirectory)
  if (files.length < ONLINE_H5_ENTRYPOINTS.length) {
    throw new Error('Online H5 artifact contains too few files')
  }
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    target: input.targetId || 'online-h5',
    branch: input.branch,
    builtAt: input.builtAt,
    serve: {
      siteAdapter: 'kook-online-h5-v1',
      entrypoints: [...ONLINE_H5_ENTRYPOINTS],
      publicBase,
    },
    files,
  }
}

export async function createStaticManifest(input: {
  outputDirectory: string
  artifactId: string
  targetId: string
  branch: string
  builtAt: string
  siteAdapter: string
  publicBase?: string
}): Promise<ArtifactManifest> {
  const publicBase = input.publicBase || `/__cuddly/artifacts/${input.artifactId}/`
  const files = await collectFiles(input.outputDirectory)
  if (files.length === 0) throw new Error('Build output is empty')
  const entrypoints = ['index.html', 'index.htm'].filter((entrypoint) =>
    files.some((file) => file.path === entrypoint)
  )
  if (entrypoints.length === 0) {
    throw new Error('Build output does not contain index.html or index.htm')
  }
  if (input.siteAdapter === 'generic-static-v1') {
    await assertNoKookProductionAppAssetFallback(input.outputDirectory, entrypoints)
  }
  await assertProjectManifestComplete(input.outputDirectory, publicBase)
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    target: input.targetId,
    branch: input.branch,
    builtAt: input.builtAt,
    serve: {
      siteAdapter: input.siteAdapter,
      entrypoints,
      publicBase,
    },
    files,
  }
}

export async function createRemoteManifest(input: {
  outputDirectory: string
  artifactId: string
  targetId: string
  branch: string
  builtAt: string
  publicBase: string
  siteAdapter: string
  moduleKey: string
  providerName: string
}): Promise<ArtifactManifest> {
  const files = await collectFiles(input.outputDirectory)
  if (files.length === 0) throw new Error('Build output is empty')
  const entrypoints = files
    .map((file) => file.path)
    .filter((filePath) => /(^|\/)remoteEntry(?:[.-][A-Za-z0-9_-]+)?\.js$/i.test(filePath))
  if (entrypoints.length === 0) {
    throw new Error('Remote build output does not contain remoteEntry*.js')
  }
  if (entrypoints.length > 1) {
    throw new Error('Remote build output contains more than one remoteEntry*.js')
  }

  let builtProviderName: string | null = null
  try {
    builtProviderName = (
      await readFile(path.join(input.outputDirectory, '.remote-version'), 'utf8')
    ).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (builtProviderName !== null && builtProviderName !== input.providerName) {
    throw new Error(
      `Remote build version mismatch: expected ${input.providerName}, received ${builtProviderName || '(empty)'}`
    )
  }
  if (builtProviderName === null) {
    const escapedProviderName = input.providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const providerDeclaration = new RegExp(
      `(?:^|[;}\\n])\\s*(?:var|let|const)\\s+${escapedProviderName}(?:\\s*[,;=])`
    )
    const remoteEntry = await readFile(path.join(input.outputDirectory, entrypoints[0]!), 'utf8')
    if (!providerDeclaration.test(remoteEntry)) {
      throw new Error(
        `Remote build does not declare the expected federation provider ${input.providerName}`
      )
    }
  }
  await assertProjectManifestComplete(input.outputDirectory, input.publicBase)
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    target: input.targetId,
    branch: input.branch,
    builtAt: input.builtAt,
    serve: {
      siteAdapter: input.siteAdapter,
      entrypoints,
      publicBase: input.publicBase,
      remote: {
        moduleKey: input.moduleKey,
        providerName: input.providerName,
        entryPath: entrypoints[0]!,
      },
    },
    files,
  }
}

export function resolveRemoteEntry(manifest: ArtifactManifest): string | null {
  return (
    manifest.serve.remote?.entryPath ??
    manifest.serve.entrypoints.find((filePath) =>
      /(^|\/)remoteEntry(?:[.-][A-Za-z0-9_-]+)?\.js$/i.test(filePath)
    ) ??
    null
  )
}

export function manifestHasFile(manifest: ArtifactManifest, relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\/+/, '')
  return manifest.files.some((file) => file.path === normalized)
}

export function manifestFile(
  manifest: ArtifactManifest,
  relativePath: string
): ArtifactManifestFile | null {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\/+/, '')
  return manifest.files.find((file) => file.path === normalized) ?? null
}
