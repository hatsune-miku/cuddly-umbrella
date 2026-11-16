export * from './memory-store'
export * from './postgres-store'
export * from './project-templates'
export * from './store'
export * from './system-settings'
export * from './public-identity'
export { McpTokenLimitError } from './mcp-tokens'

import type { CuddlyStore } from './store'
import { MemoryStore } from './memory-store'
import { PostgresStore } from './postgres-store'

const DATABASE_URL = 'postgres://cuddly:cuddly-internal@postgres:5432/cuddly'

export function createStore(): CuddlyStore {
  if (process.env.NODE_ENV !== 'production') return new MemoryStore()
  return new PostgresStore(DATABASE_URL)
}
