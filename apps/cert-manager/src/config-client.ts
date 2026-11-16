import { readFile } from 'node:fs/promises'

import type { CertificateConfig } from './commands'
import { parseCertificateConfig } from './config'

export const INTERNAL_API_TOKEN_FILE = '/srv/cuddly/cert-auth/token'

export interface CertificateConfigLoaderOptions {
  configUrl: string
  internalApiToken: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function readInternalApiToken(filePath = INTERNAL_API_TOKEN_FILE): Promise<string> {
  const token = (await readFile(filePath, 'utf8')).trim()
  if (!token) throw new Error(`internal API token file is empty: ${filePath}`)
  return token
}

export function createCertificateConfigLoader(
  options: CertificateConfigLoaderOptions
): () => Promise<CertificateConfig> {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  return async () => {
    const response = await fetchImpl(options.configUrl, {
      headers: {
        Authorization: `Bearer ${options.internalApiToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`certificate config returned HTTP ${response.status}`)
    return parseCertificateConfig(await response.json())
  }
}
