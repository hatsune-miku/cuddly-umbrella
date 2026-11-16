import path from 'node:path'

import type { ArtifactManifest } from '@cuddly/contracts'
import type { Request } from 'express'

export function isHtmlNavigation(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (req.headers['sec-fetch-dest'] === 'document') return true
  return String(req.headers.accept || '').includes('text/html')
}

export function isExpectedStaticPath(requestPath: string): boolean {
  if (requestPath.startsWith('/static/') || requestPath.startsWith('/__cuddly/artifacts/'))
    return true
  return /\.[A-Za-z0-9]{1,8}$/.test(requestPath)
}

/**
 * Routes requests that must retain backend semantics instead of falling through to a
 * frontend Artifact or the site's frontend fallback. This deliberately stays narrow:
 * read-only, non API/MIS paths remain frontend requests.
 */
export function isBackendProxyRequest(req: Request): boolean {
  if (!['GET', 'HEAD'].includes(req.method)) return true
  return (
    req.path === '/v3/version/hot-module' ||
    req.path === '/api' ||
    req.path.startsWith('/api/') ||
    req.path === '/mis' ||
    req.path.startsWith('/mis/')
  )
}

// Kept for callers compiled against the original H5-specific name.
export const isOnlineH5BackendRequest = isBackendProxyRequest

export function normalizeArtifactRequestPath(requestPath: string): string | null {
  try {
    const decoded = decodeURIComponent(requestPath).replaceAll('\\', '/')
    const normalized = path.posix.normalize(decoded).replace(/^\/+/, '')
    if (
      !normalized ||
      normalized === '.' ||
      normalized.startsWith('../') ||
      normalized.includes('/../')
    ) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

export function resolveOnlineH5ArtifactFile(
  requestPath: string,
  manifest: ArtifactManifest
): string | null {
  const normalized = normalizeArtifactRequestPath(requestPath)
  if (!normalized) return null
  return manifest.files.some((file) => file.path === normalized) ? normalized : null
}

export function resolveArtifactFile(
  requestPath: string,
  manifest: ArtifactManifest
): string | null {
  const exact = resolveOnlineH5ArtifactFile(requestPath, manifest)
  if (exact) return exact
  const publicBaseWithoutSuffix = manifest.serve.publicBase.split(/[?#]/, 1)[0] || ''
  const usesWebappMount =
    manifest.target === 'webapp' || /(?:^|\/)app\/?$/.test(publicBaseWithoutSuffix)
  if (!usesWebappMount || manifest.serve.siteAdapter !== 'generic-static-v1') {
    return null
  }

  const normalized = normalizeArtifactRequestPath(requestPath)
  if (!normalized?.startsWith('app/')) return null
  const relativePath = normalized.slice('app/'.length)
  return manifest.files.some((file) => file.path === relativePath) ? relativePath : null
}

export function resolveOnlineH5NavigationEntry(
  requestPath: string,
  manifest: ArtifactManifest
): string | null {
  const exactAliases: Record<string, string> = {
    '/': 'index.htm',
    '/index.html': 'index.htm',
    '/index.htm': 'index.htm',
    '/topup': 'topup.htm',
    '/topup.html': 'topup.htm',
    '/topup.htm': 'topup.htm',
    '/gift-gacha': 'gift-gacha.htm',
    '/gift-gacha.html': 'gift-gacha.htm',
    '/gift-gacha.htm': 'gift-gacha.htm',
    '/card-collect': 'card-collect.htm',
    '/card-collect.html': 'card-collect.htm',
    '/card-collect.htm': 'card-collect.htm',
    '/ratings-preview': 'ratings-preview.htm',
    '/ratings-preview.html': 'ratings-preview.htm',
    '/ratings-preview.htm': 'ratings-preview.htm',
  }
  const entry = exactAliases[requestPath] || 'index.htm'
  return manifest.files.some((file) => file.path === entry) ? entry : null
}

export function resolveArtifactNavigationEntry(
  requestPath: string,
  manifest: ArtifactManifest
): string | null {
  if (manifest.serve.siteAdapter === 'kook-online-h5-v1') {
    return resolveOnlineH5NavigationEntry(requestPath, manifest)
  }
  const entry =
    manifest.serve.entrypoints.find((candidate) =>
      manifest.files.some((file) => file.path === candidate)
    ) || null
  return entry
}

export function isSupportedStaticSiteAdapter(siteAdapter: string): boolean {
  return siteAdapter === 'kook-online-h5-v1' || siteAdapter === 'generic-static-v1'
}
