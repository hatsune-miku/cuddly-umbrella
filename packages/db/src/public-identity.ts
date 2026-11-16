import type { CuddlyStore } from './store'

export function defaultDisplayName(id: string): string {
  return `用户-${id}`
}

const actorKeys = new Set(['requestedBy', 'createdBy', 'updatedBy', 'actor'])
const actorPattern = /^user:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
export function actorUserId(value: unknown): string | null {
  return typeof value === 'string' ? actorPattern.exec(value)?.[1] || null : null
}

// Output boundary shared by the API and Gateway. Old unbound name snapshots are never public.
export async function publicIdentityData(store: CuddlyStore, value: unknown): Promise<unknown> {
  const ids = new Set<string>()
  function collect(item: unknown): void {
    if (!item || typeof item !== 'object') return
    for (const [key, entry] of Object.entries(item)) {
      const id = actorKeys.has(key) ? actorUserId(entry) : null
      if (id) ids.add(id)
      collect(entry)
    }
  }
  collect(value)
  const names = ids.size ? await store.getPublicActorNames([...ids]) : {}
  function project(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(project)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item).flatMap(([key, entry]) => {
        if (key === 'autoSslEmail') return []
        if (actorKeys.has(key) && typeof entry === 'string') {
          const id = actorUserId(entry)
          return [
            [key, id ? names[id] || '已注销用户' : entry === 'system' ? '系统' : '历史用户'],
            [`${key}Id`, id],
          ]
        }
        return [[key, project(entry)]]
      })
    )
  }
  return project(value)
}
