import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import type { ArtifactManifest, RunnerArtifactInventoryItem } from '@cuddly/contracts'

export const ARTIFACT_METADATA_PATH = '.cuddly/manifest.json'

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe ${label}: ${value}`)
  }
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
}

const SYSTEM_ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeRelativePath(value: string): string {
  const decoded = decodeURIComponent(value).replaceAll('\\', '/')
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '')
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Unsafe artifact path: ${value}`)
  }
  return normalized
}

export interface ArtifactFileHandle {
  absolutePath: string
  size: number
  createStream: (range?: { start: number; end: number }) => NodeJS.ReadableStream
  close: () => Promise<void>
}

export class FileArtifactStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.root, 'staging'), { recursive: true }),
      mkdir(path.join(this.root, 'ready'), { recursive: true }),
      mkdir(path.join(this.root, 'deleting'), { recursive: true }),
    ])
  }

  async clearStaleStagingDirectories(): Promise<void> {
    const staging = path.join(this.root, 'staging')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
  }

  async publishDirectory(input: {
    sourceDirectory: string
    targetId: string
    artifactId: string
    manifest: ArtifactManifest
  }): Promise<string> {
    assertSafeSegment(input.targetId, 'target id')
    assertSafeSegment(input.artifactId, 'artifact id')
    const staging = path.join(this.root, 'staging', input.artifactId)
    const readyParent = path.join(this.root, 'ready', input.targetId)
    const ready = path.join(readyParent, input.artifactId)

    let published = false
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(path.dirname(staging), { recursive: true })
      await cp(input.sourceDirectory, staging, { recursive: true, force: false })
      const metadataPath = path.join(staging, ...ARTIFACT_METADATA_PATH.split('/'))
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(metadataPath, JSON.stringify(input.manifest, null, 2), 'utf8')
      await mkdir(readyParent, { recursive: true })
      try {
        await access(ready)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await rename(staging, ready)
        published = true
        return path.posix.join('ready', input.targetId, input.artifactId)
      }
      throw new Error(`Artifact directory already exists: ${ready}`)
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  resolveStorageDirectory(storageKey: string): string {
    const normalized = normalizeRelativePath(storageKey)
    const resolved = path.resolve(this.root, normalized)
    const root = path.resolve(this.root)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Storage key escapes artifact root: ${storageKey}`)
    }
    return resolved
  }

  resolveFilePath(storageKey: string, relativePath: string): string {
    const base = this.resolveStorageDirectory(storageKey)
    const normalized = normalizeRelativePath(relativePath)
    const resolved = path.resolve(base, ...normalized.split('/'))
    if (!resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error(`Artifact path escapes storage directory: ${relativePath}`)
    }
    return resolved
  }

  async openFile(storageKey: string, relativePath: string): Promise<ArtifactFileHandle | null> {
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const absolutePath = this.resolveFilePath(storageKey, relativePath)
      fileHandle = await open(absolutePath, 'r')
      const fileStat = await fileHandle.stat()
      if (!fileStat.isFile()) {
        await fileHandle.close()
        return null
      }
      let claimed = false
      return {
        absolutePath,
        size: fileStat.size,
        createStream: (range) => {
          if (claimed) throw new Error('Artifact file handle has already been consumed')
          claimed = true
          return fileHandle!.createReadStream({ ...range, autoClose: true })
        },
        close: async () => {
          if (claimed) return
          claimed = true
          await fileHandle!.close()
        },
      }
    } catch {
      await fileHandle?.close().catch(() => undefined)
      return null
    }
  }

  async readText(storageKey: string, relativePath: string): Promise<string | null> {
    try {
      return await readFile(this.resolveFilePath(storageKey, relativePath), 'utf8')
    } catch {
      return null
    }
  }

  async listArtifactInventory(): Promise<RunnerArtifactInventoryItem[]> {
    const artifacts: RunnerArtifactInventoryItem[] = []
    const roots = [
      { directory: 'ready', state: 'READY' as const },
      { directory: 'deleting', state: 'DELETING' as const },
    ]

    for (const root of roots) {
      let targets
      try {
        targets = await readdir(path.join(this.root, root.directory), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const target of targets) {
        if (!target.isDirectory() || !isSafeSegment(target.name)) continue
        const targetDirectory = path.join(this.root, root.directory, target.name)
        let entries
        try {
          entries = await readdir(targetDirectory, { withFileTypes: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || !SYSTEM_ARTIFACT_ID_PATTERN.test(entry.name)) continue
          const storageKey = path.posix.join(root.directory, target.name, entry.name)
          try {
            const directoryStat = await lstat(this.resolveStorageDirectory(storageKey))
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue
            artifacts.push({
              artifactId: entry.name,
              targetId: target.name,
              storageKey,
              state: root.state,
              modifiedAt: directoryStat.mtime.toISOString(),
            })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    }

    return artifacts.sort(
      (a, b) =>
        a.modifiedAt.localeCompare(b.modifiedAt) ||
        a.state.localeCompare(b.state) ||
        a.targetId.localeCompare(b.targetId) ||
        a.artifactId.localeCompare(b.artifactId)
    )
  }

  async deleteArtifactDirectory(input: { artifactId: string; storageKey: string }): Promise<void> {
    assertSafeSegment(input.artifactId, 'artifact id')
    const normalized = normalizeRelativePath(input.storageKey)
    const segments = normalized.split('/')
    if (
      segments.length !== 3 ||
      !['ready', 'deleting'].includes(segments[0]!) ||
      segments[2] !== input.artifactId
    ) {
      throw new Error(`Storage key does not match Artifact ${input.artifactId}`)
    }
    assertSafeSegment(segments[1]!, 'target id')
    const readyKey = path.posix.join('ready', segments[1]!, input.artifactId)
    const deletingKey = path.posix.join('deleting', segments[1]!, input.artifactId)
    const ready = this.resolveStorageDirectory(readyKey)
    const deleting = this.resolveStorageDirectory(deletingKey)
    await mkdir(path.dirname(deleting), { recursive: true })
    if (segments[0] === 'ready') {
      try {
        await rename(ready, deleting)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await rm(deleting, { recursive: true, force: true })
  }
}

export function createArtifactStore(): FileArtifactStore {
  return new FileArtifactStore(
    process.env.NODE_ENV === 'production' ? '/srv/cuddly/artifacts' : path.resolve('data/artifacts')
  )
}
