import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface TencentCloudDnsCredentials {
  secretId: string
  secretKey: string
  zone: string
}

export function parseTencentCloudDnsCredentials(source: string): TencentCloudDnsCredentials {
  const values = new Map<string, string>()
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const secretId = values.get('TENCENTCLOUD_SECRET_ID') || ''
  const secretKey = values.get('TENCENTCLOUD_SECRET_KEY') || ''
  const zone = (values.get('TENCENTCLOUD_DNS_ZONE') || '').toLowerCase().replace(/\.$/, '')
  if (!secretId || !secretKey || !/^[a-z0-9.-]+$/.test(zone)) {
    throw new Error('Tencent Cloud DNS credentials are incomplete')
  }
  return { secretId, secretKey, zone }
}

export async function readTencentCloudDnsCredentials(): Promise<TencentCloudDnsCredentials> {
  const file = process.env.CUDDLY_DNS_CREDENTIALS_FILE || '/srv/cuddly/secrets/tencentcloud-dns.env'
  return parseTencentCloudDnsCredentials(await readFile(file, 'utf8'))
}

export function challengeRecord(domain: string, zone: string): { fqdn: string; subdomain: string } {
  const normalizedDomain = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  const normalizedZone = zone.toLowerCase().replace(/\.$/, '')
  const fqdn = `_acme-challenge.${normalizedDomain}`
  const suffix = `.${normalizedZone}`
  if (!fqdn.endsWith(suffix)) throw new Error('Certificate domain is outside the DNS zone')
  return { fqdn, subdomain: fqdn.slice(0, -suffix.length) }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

export async function callDnsPod<T>(
  credentials: TencentCloudDnsCredentials,
  action: string,
  payload: Record<string, unknown>
): Promise<T> {
  const service = 'dnspod'
  const host = 'dnspod.tencentcloudapi.com'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify(payload)
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`
  const scope = `${date}/${service}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`
  const secretDate = hmac(`TC3${credentials.secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign).toString('hex')
  const authorization = `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const response = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': '2021-03-23',
    },
    body,
  })
  const result = (await response.json()) as {
    Response?: { Error?: { Code?: string; Message?: string }; [key: string]: unknown }
  }
  if (!response.ok || result.Response?.Error) {
    throw new Error(`DNSPod ${action} failed: ${result.Response?.Error?.Code || response.status}`)
  }
  return result.Response as T
}
