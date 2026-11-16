export const BUILD_HISTORY_STATUSES = [
  'QUEUED',
  'LEASED',
  'CHECKOUT',
  'INSTALLING',
  'BUILDING',
  'VALIDATING',
  'UPLOADING',
  'CANCELING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
]

export const BUILD_HISTORY_PAGE_SIZES = [10, 20, 50]

export function buildHistoryQuery({
  environmentSlug,
  targetId = '',
  status = '',
  query = '',
  page = 1,
  pageSize = 20,
}) {
  const search = new URLSearchParams({
    environment: environmentSlug,
    page: String(page),
    pageSize: String(pageSize),
  })
  if (targetId) search.set('targetId', targetId)
  if (status) search.set('status', status)
  if (query.trim()) search.set('query', query.trim())
  return `/api/v1/build-jobs?${search}`
}

export function normalizeBuildHistoryPage(value, fallback = {}) {
  const items = Array.isArray(value?.items) ? value.items : []
  const pageSize = positiveInteger(value?.pageSize, positiveInteger(fallback.pageSize, 20))
  const total = nonNegativeInteger(value?.total, items.length)
  const totalPages = Math.max(1, positiveInteger(value?.totalPages, Math.ceil(total / pageSize)))
  const page = Math.min(totalPages, positiveInteger(value?.page, positiveInteger(fallback.page, 1)))
  return { items, page, pageSize, total, totalPages }
}

export function buildHistoryPageNumbers(totalPages) {
  return Array.from(
    { length: Math.max(1, positiveInteger(totalPages, 1)) },
    (_, index) => index + 1
  )
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}
