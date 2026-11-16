import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILD_HISTORY_STATUSES,
  buildHistoryPageNumbers,
  buildHistoryQuery,
  normalizeBuildHistoryPage,
} from '../build-history.js'

test('requests a complete environment-scoped history page with filters', () => {
  const path = buildHistoryQuery({
    environmentSlug: 'shared',
    targetId: 'online-h5',
    status: 'FAILED',
    query: ' gz/87 ',
    page: 3,
    pageSize: 20,
  })
  const url = new URL(path, 'https://bifrost.example')
  assert.equal(url.pathname, '/api/v1/build-jobs')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    environment: 'shared',
    page: '3',
    pageSize: '20',
    targetId: 'online-h5',
    status: 'FAILED',
    query: 'gz/87',
  })
})

test('keeps failed and canceled jobs in the complete status catalog', () => {
  assert.ok(BUILD_HISTORY_STATUSES.includes('FAILED'))
  assert.ok(BUILD_HISTORY_STATUSES.includes('CANCELED'))
  assert.ok(BUILD_HISTORY_STATUSES.includes('SUCCEEDED'))
})

test('normalizes malformed pagination metadata without hiding an empty first page', () => {
  assert.deepEqual(
    normalizeBuildHistoryPage({ items: [], page: 0, pageSize: -1, total: 0, totalPages: 0 }),
    { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
  )
  assert.deepEqual(buildHistoryPageNumbers(3), [1, 2, 3])
})
