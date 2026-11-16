import path from 'node:path'

import type { Artifact } from '@cuddly/contracts'

export interface HotModuleOverride {
  moduleKey: string
  item: {
    name: string
    entry: string
    version: string
    restartRequired: true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function hotModuleOverrideFromArtifact(
  artifact: Artifact,
  requestOrigin?: URL
): HotModuleOverride | null {
  const remote = artifact.manifest.serve.remote
  if (
    artifact.status !== 'READY' ||
    artifact.manifest.artifactId !== artifact.id ||
    artifact.targetId !== artifact.manifest.target ||
    artifact.manifest.serve.siteAdapter !== 'kook-remote-v1' ||
    !remote ||
    remote.moduleKey !== artifact.targetId ||
    !/^[A-Za-z0-9_]+$/.test(remote.providerName)
  ) {
    return null
  }

  const normalizedEntryPath = path.posix.normalize(remote.entryPath.replaceAll('\\', '/'))
  if (
    !normalizedEntryPath ||
    normalizedEntryPath === '.' ||
    normalizedEntryPath.startsWith('/') ||
    normalizedEntryPath.startsWith('../') ||
    !artifact.manifest.files.some((file) => file.path === normalizedEntryPath)
  ) {
    return null
  }

  const expectedPath = `/__cuddly/preview-artifacts/${artifact.id}/${remote.providerName}/`
  const rawPublicBase = artifact.manifest.serve.publicBase
  let publicBase: URL
  let entry: URL
  try {
    if (rawPublicBase === expectedPath) {
      if (!requestOrigin || !['http:', 'https:'].includes(requestOrigin.protocol)) return null
      publicBase = new URL(expectedPath, requestOrigin)
    } else {
      publicBase = new URL(rawPublicBase)
    }
    entry = new URL(normalizedEntryPath, publicBase)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(publicBase.protocol) ||
    publicBase.username ||
    publicBase.password ||
    publicBase.search ||
    publicBase.hash ||
    publicBase.pathname !== expectedPath ||
    entry.origin !== publicBase.origin ||
    !entry.pathname.startsWith(publicBase.pathname)
  ) {
    return null
  }

  return {
    moduleKey: remote.moduleKey,
    item: {
      name: remote.providerName,
      entry: entry.href,
      version: remote.providerName,
      restartRequired: true,
    },
  }
}

export function applyHotModuleOverlay(
  responseBody: unknown,
  overrides: readonly HotModuleOverride[]
): boolean {
  if (overrides.length === 0 || !isRecord(responseBody)) return false
  if ('code' in responseBody && responseBody.code !== 0 && responseBody.code !== '0') return false

  const root = 'data' in responseBody ? responseBody.data : responseBody
  if (!isRecord(root)) return false

  if (Array.isArray(root.modules)) {
    const modules = [...root.modules]
    for (const override of overrides) {
      const index = modules.findIndex(
        (module) => isRecord(module) && module.key === override.moduleKey
      )
      const existing = index >= 0 && isRecord(modules[index]) ? modules[index] : {}
      const replacement = { ...existing, key: override.moduleKey, ...override.item }
      if (index >= 0) modules[index] = replacement
      else modules.push(replacement)
    }
    root.modules = modules
    return true
  }

  if (isRecord(root.modules)) {
    const modules = { ...root.modules }
    for (const override of overrides) {
      const candidate = modules[override.moduleKey]
      const existing: Record<string, unknown> = isRecord(candidate) ? candidate : {}
      modules[override.moduleKey] = { ...existing, ...override.item }
    }
    root.modules = modules
    return true
  }

  const isRemoteValue = (value: unknown): boolean =>
    (typeof value === 'string' && /^https?:\/\//i.test(value)) ||
    (isRecord(value) && typeof value.entry === 'string' && /^https?:\/\//i.test(value.entry))
  if (!Object.values(root).some(isRemoteValue)) return false
  for (const override of overrides) {
    const candidate = root[override.moduleKey]
    const existing: Record<string, unknown> = isRecord(candidate) ? candidate : {}
    root[override.moduleKey] = { ...existing, ...override.item }
  }
  return true
}
