import { createHash } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { readFile, unlink, writeFile } from 'node:fs/promises'

import {
  callDnsPod,
  challengeRecord,
  readTencentCloudDnsCredentials,
} from './dns-provider-tencentcloud'

async function waitForTxt(fqdn: string, expected: string): Promise<void> {
  const resolver = new Resolver()
  // Docker's embedded DNS cache can keep the previous ACME value for its full
  // TTL. Query public recursive resolvers directly so a just-created challenge
  // can be observed without waiting for that local cache to expire.
  resolver.setServers(['1.1.1.1', '8.8.8.8'])
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const values = (await resolver.resolveTxt(fqdn)).map((parts) => parts.join(''))
      if (values.includes(expected)) return
    } catch {
      // DNS propagation is expected to lag briefly after record creation.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error('DNSPod TXT record did not propagate before the timeout')
}

async function removeStaleChallenges(
  credentials: Awaited<ReturnType<typeof readTencentCloudDnsCredentials>>,
  subdomain: string
): Promise<number> {
  const response = await callDnsPod<{ RecordList?: Array<{ RecordId?: number }> }>(
    credentials,
    'DescribeRecordList',
    {
      Domain: credentials.zone,
      Subdomain: subdomain,
      RecordType: 'TXT',
      Limit: 100,
    }
  )
  const recordIds = (response.RecordList ?? [])
    .map((item) => item.RecordId)
    .filter(
      (recordId): recordId is number =>
        typeof recordId === 'number' && Number.isSafeInteger(recordId) && recordId > 0
    )
  for (const recordId of recordIds) {
    await callDnsPod(credentials, 'DeleteRecord', {
      Domain: credentials.zone,
      RecordId: recordId,
    })
  }
  return recordIds.length
}

function challengeRunMarker(): string {
  const scope = process.env.CERTBOT_ALL_DOMAINS || process.env.CERTBOT_DOMAIN || 'unknown'
  return `/tmp/cuddly-acme-${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`
}

async function beginChallengeRun(): Promise<boolean> {
  const marker = challengeRunMarker()
  try {
    const startedAt = Number(await readFile(marker, 'utf8'))
    if (Number.isFinite(startedAt) && Date.now() - startedAt < 30 * 60_000) return false
    await unlink(marker).catch(() => undefined)
  } catch {
    // A missing marker means this is the first hook in the current order.
  }
  try {
    await writeFile(marker, String(Date.now()), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

async function finishChallengeRun(): Promise<void> {
  await unlink(challengeRunMarker()).catch(() => undefined)
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  const domain = process.env.CERTBOT_DOMAIN || ''
  const validation = process.env.CERTBOT_VALIDATION || ''
  const credentials = await readTencentCloudDnsCredentials()
  const record = challengeRecord(domain, credentials.zone)
  if (mode === 'auth') {
    if (!validation) throw new Error('CERTBOT_VALIDATION is missing')
    const firstChallenge = await beginChallengeRun()
    if (firstChallenge) await removeStaleChallenges(credentials, record.subdomain)
    const response = await callDnsPod<{ RecordId?: number }>(credentials, 'CreateRecord', {
      Domain: credentials.zone,
      SubDomain: record.subdomain,
      RecordType: 'TXT',
      RecordLine: '默认',
      Value: validation,
      TTL: 600,
    })
    if (!response.RecordId) throw new Error('DNSPod did not return a record id')
    try {
      await waitForTxt(record.fqdn, validation)
      // DNSPod's minimum TTL is 600 seconds. ACME secondary validators can retain
      // the previous TXT answer even after public resolvers already show the new
      // one, so keep Certbot paused until that cache window has elapsed.
      await new Promise((resolve) => setTimeout(resolve, 610_000))
    } catch (error) {
      await callDnsPod(credentials, 'DeleteRecord', {
        Domain: credentials.zone,
        RecordId: response.RecordId,
      }).catch(() => undefined)
      if (firstChallenge) await finishChallengeRun()
      throw error
    }
    process.stdout.write(String(response.RecordId))
    return
  }
  if (mode === 'cleanup') {
    const recordId = Number(process.env.CERTBOT_AUTH_OUTPUT)
    if (!Number.isSafeInteger(recordId) || recordId <= 0) return
    await callDnsPod(credentials, 'DeleteRecord', {
      Domain: credentials.zone,
      RecordId: recordId,
    })
    await finishChallengeRun()
    return
  }
  throw new Error('DNS hook mode must be auth or cleanup')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'DNS hook failed')
  process.exitCode = 1
})
