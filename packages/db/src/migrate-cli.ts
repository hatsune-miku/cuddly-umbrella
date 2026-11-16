import { PostgresStore } from './postgres-store'

const databaseUrl = 'postgres://cuddly:cuddly-internal@postgres:5432/cuddly'

const store = new PostgresStore(databaseUrl)
await store.initialize()
await store.close()
console.log('[cuddly] database schema is ready')
