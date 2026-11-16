import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ArtifactManifest } from '@cuddly/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { ARTIFACT_METADATA_PATH, FileArtifactStore } from './index'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function artifactManifest(artifactId: string): ArtifactManifest {
  return {
    schemaVersion: 1,
    artifactId,
    target: 'webapp',
    branch: 'main',
    builtAt: '2026-08-24T00:00:00.000Z',
    serve: {
      siteAdapter: 'generic-static-v1',
      entrypoints: ['index.html'],
      publicBase: `/__cuddly/artifacts/${artifactId}/`,
    },
    files: [
      {
        path: 'index.html',
        size: 15,
        contentType: 'text/html; charset=utf-8',
        digest: 'sha256:test',
        cacheClass: 'html',
      },
    ],
  }
}

async function createStoreFixture(): Promise<{
  sourceDirectory: string
  store: FileArtifactStore
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-artifact-store-'))
  cleanupDirectories.push(root)
  const sourceDirectory = path.join(root, 'source')
  const store = new FileArtifactStore(path.join(root, 'artifacts'))
  await store.initialize()
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(path.join(sourceDirectory, 'index.html'), '<h1>Cuddly</h1>', 'utf8')
  return { sourceDirectory, store }
}

describe('FileArtifactStore.publishDirectory', () => {
  it('preserves a business manifest.json and writes Cuddly metadata separately', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = 'artifact-with-business-manifest'
    const manifest = artifactManifest(artifactId)
    const businessManifest = '{"name":"KOOK","start_url":"/"}\n'
    await writeFile(path.join(sourceDirectory, 'manifest.json'), businessManifest, 'utf8')

    const storageKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest,
    })

    await expect(store.readText(storageKey, 'manifest.json')).resolves.toBe(businessManifest)
    await expect(store.readText(storageKey, ARTIFACT_METADATA_PATH)).resolves.toBe(
      JSON.stringify(manifest, null, 2)
    )
  })

  it('does not create a public root manifest.json when the build has none', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = 'artifact-without-business-manifest'
    const manifest = artifactManifest(artifactId)

    const storageKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest,
    })

    await expect(store.readText(storageKey, 'manifest.json')).resolves.toBeNull()
    const metadata = await store.readText(storageKey, ARTIFACT_METADATA_PATH)
    expect(metadata && JSON.parse(metadata)).toEqual(manifest)
  })

  it('deletes only the ready directory whose key matches the Artifact id', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = 'artifact-to-delete'
    const storageKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest: artifactManifest(artifactId),
    })

    await store.deleteArtifactDirectory({ artifactId, storageKey })

    await expect(store.readText(storageKey, ARTIFACT_METADATA_PATH)).resolves.toBeNull()
    await expect(
      access(store.resolveStorageDirectory(`deleting/webapp/${artifactId}`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.deleteArtifactDirectory({ artifactId, storageKey })).resolves.toBeUndefined()
  })

  it('resumes an interrupted retirement from the target-scoped deleting directory', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = randomUUID()
    const storageKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest: artifactManifest(artifactId),
    })
    const deletingKey = `deleting/webapp/${artifactId}`
    await mkdir(path.dirname(store.resolveStorageDirectory(deletingKey)), { recursive: true })
    await rename(
      store.resolveStorageDirectory(storageKey),
      store.resolveStorageDirectory(deletingKey)
    )

    await store.deleteArtifactDirectory({ artifactId, storageKey })
    await expect(access(store.resolveStorageDirectory(deletingKey))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      store.deleteArtifactDirectory({ artifactId, storageKey: deletingKey })
    ).resolves.toBeUndefined()
  })

  it('inventories only system UUID directories in ready and deleting', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const readyId = randomUUID()
    const deletingId = randomUUID()
    const readyKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId: readyId,
      manifest: artifactManifest(readyId),
    })
    const deletingKey = `deleting/online-h5/${deletingId}`
    await mkdir(store.resolveStorageDirectory(deletingKey), { recursive: true })
    await mkdir(store.resolveStorageDirectory('ready/webapp/not-a-system-artifact'), {
      recursive: true,
    })
    await writeFile(
      store.resolveStorageDirectory(`ready/webapp/${randomUUID()}`),
      'not a directory',
      'utf8'
    )

    const inventory = await store.listArtifactInventory()

    expect(inventory).toHaveLength(2)
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: readyId,
          targetId: 'webapp',
          storageKey: readyKey,
          state: 'READY',
          modifiedAt: expect.any(String),
        }),
        expect.objectContaining({
          artifactId: deletingId,
          targetId: 'online-h5',
          storageKey: deletingKey,
          state: 'DELETING',
          modifiedAt: expect.any(String),
        }),
      ])
    )
    inventory.forEach((item) => expect(Number.isFinite(Date.parse(item.modifiedAt))).toBe(true))
  })

  it.skipIf(process.platform === 'win32')(
    'keeps an already opened response readable while its directory is retired',
    async () => {
      const { sourceDirectory, store } = await createStoreFixture()
      const artifactId = 'artifact-open-during-retirement'
      const storageKey = await store.publishDirectory({
        sourceDirectory,
        targetId: 'webapp',
        artifactId,
        manifest: artifactManifest(artifactId),
      })
      const file = await store.openFile(storageKey, 'index.html')
      expect(file).not.toBeNull()

      await store.deleteArtifactDirectory({ artifactId, storageKey })
      const chunks: Buffer[] = []
      for await (const chunk of file!.createStream() as NodeJS.ReadableStream &
        AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      expect(Buffer.concat(chunks).toString('utf8')).toBe('<h1>Cuddly</h1>')
    }
  )

  it('removes a partial staging copy when publication fails', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = 'artifact-publication-failure'

    await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest: artifactManifest(artifactId),
    })
    await expect(
      store.publishDirectory({
        sourceDirectory,
        targetId: 'webapp',
        artifactId,
        manifest: artifactManifest(artifactId),
      })
    ).rejects.toThrow('already exists')

    await expect(
      access(store.resolveStorageDirectory(`staging/${artifactId}`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears staging leftovers before the Runner accepts work after a restart', async () => {
    const { store } = await createStoreFixture()
    const stale = store.resolveStorageDirectory(`staging/${randomUUID()}`)
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'partial.js'), 'partial', 'utf8')

    await store.clearStaleStagingDirectories()

    await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(store.resolveStorageDirectory('staging'))).resolves.toBeUndefined()
  })

  it('rejects mismatched and non-ready storage keys without deleting files', async () => {
    const { sourceDirectory, store } = await createStoreFixture()
    const artifactId = 'artifact-kept'
    const storageKey = await store.publishDirectory({
      sourceDirectory,
      targetId: 'webapp',
      artifactId,
      manifest: artifactManifest(artifactId),
    })

    await expect(
      store.deleteArtifactDirectory({ artifactId: 'different-artifact', storageKey })
    ).rejects.toThrow('does not match')
    await expect(
      store.deleteArtifactDirectory({ artifactId, storageKey: `staging/${artifactId}` })
    ).rejects.toThrow('does not match')
    await expect(store.readText(storageKey, ARTIFACT_METADATA_PATH)).resolves.not.toBeNull()
  })
})
