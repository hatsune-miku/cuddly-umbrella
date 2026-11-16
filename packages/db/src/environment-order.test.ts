import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from './memory-store'
import { PostgresStore } from './postgres-store'
import { saveEnvironmentSchema } from '@cuddly/contracts'

describe('environment display order', () => {
  it('sorts by manual priority, then name, retains priorities on legacy saves and archive/unarchive', async () => {
    const store = new MemoryStore()
    const base = (await store.listEnvironments())[0]!
    for (const [slug, name, sortOrder] of [
      ['qa', 'QA', 20],
      ['online', '线上', -10],
      ['tttt', 'tttt', 10],
    ] as const) {
      await store.saveEnvironment({ ...base, id: slug, slug, name, sortOrder }, 'tester')
    }
    const slugs = async () =>
      (await store.listEnvironments()).filter((e) => e.id !== base.id).map((e) => e.slug)
    expect(await slugs()).toEqual(['online', 'tttt', 'qa'])
    const qa = (await store.getEnvironment('qa'))!
    await store.saveEnvironment({ ...qa, sortOrder: -20 }, 'tester')
    expect(await slugs()).toEqual(['qa', 'online', 'tttt'])
    const { sortOrder: _, ...legacy } = qa
    await store.saveEnvironment(legacy, 'legacy-client')
    expect((await store.getEnvironment('qa'))!.sortOrder).toBe(-20)
    await store.saveEnvironment({ ...legacy, status: 'ARCHIVED' }, 'tester')
    expect(await slugs()).toEqual(['online', 'tttt'])
    expect((await store.listEnvironments(true))[0]!.slug).toBe('qa')
    await store.saveEnvironment({ ...legacy, status: 'ACTIVE', sortOrder: -10 }, 'tester')
    const ties = (await store.listEnvironments()).filter((e) => e.sortOrder === -10)
    expect(ties.map((e) => e.name)).toEqual(['QA', '线上'].sort((a, b) => a.localeCompare(b)))
    expect((await store.getEnvironment(base.id))!.currentRevisionId).toBe(base.currentRevisionId)
  })

  it('uses persisted priority in the SQL directory and maps it for all consumers', async () => {
    const store = new PostgresStore('postgres://unused:unused@127.0.0.1:1/unused')
    const query = vi
      .spyOn(store.pool, 'query')
      .mockResolvedValue({
        rows: [{ id: 'online', slug: 'online', name: '线上', sort_order: -10 }],
      } as never)
    try {
      expect((await store.listEnvironments())[0]!.sortOrder).toBe(-10)
      expect(query.mock.calls[0]![0]).toContain('ORDER BY sort_order, name, slug, id')
      expect(query.mock.calls[0]![0]).toContain("WHERE status <> 'ARCHIVED'")
      await store.listEnvironments(true)
      expect(query.mock.calls[1]![0]).not.toContain('WHERE')
    } finally {
      await store.close()
    }
  })

  it('validates integer priorities while accepting old clients that omit the field', () => {
    const body = { slug: 'qa', name: 'QA', backendOrigin: 'https://qa.example.test' }
    for (const sortOrder of [-1000000, 0, 1000000])
      expect(saveEnvironmentSchema.safeParse({ ...body, sortOrder }).success).toBe(true)
    for (const sortOrder of [-1000001, 1000001, 0.5, '1', null])
      expect(saveEnvironmentSchema.safeParse({ ...body, sortOrder }).success).toBe(false)
    expect(saveEnvironmentSchema.parse(body).sortOrder).toBeUndefined()
  })
})
