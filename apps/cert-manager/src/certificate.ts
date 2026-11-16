import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { isValidCertificateHostname, normalizeCertificateHostname } from './commands'

const DEFAULT_CERTIFICATE_ROOT = '/etc/letsencrypt'
export const DEFAULT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

export type CertificateInspectionReason =
  | 'fresh'
  | 'missing'
  | 'unreadable'
  | 'malformed'
  | 'hostname-mismatch'
  | 'not-yet-valid'
  | 'expiring'

export interface CertificateInspection {
  runCertbot: boolean
  reason: CertificateInspectionReason
  expiresAt: string | null
}

export interface LocalCertificateInspectionOptions {
  certificateRoot?: string
  nowMs?: number
  renewBeforeMs?: number
  requiredHostnames?: string[]
}

export function inspectCertificatePem(
  pem: string,
  rawHostname: string,
  options: Pick<
    LocalCertificateInspectionOptions,
    'nowMs' | 'renewBeforeMs' | 'requiredHostnames'
  > = {}
): CertificateInspection {
  const hostname = normalizeCertificateHostname(rawHostname)
  if (!isValidCertificateHostname(hostname)) {
    throw new Error(`Certificate hostname is invalid: ${rawHostname}`)
  }
  const nowMs = options.nowMs ?? Date.now()
  const renewBeforeMs = options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS
  try {
    const certificate = new X509Certificate(pem)
    const expiresMs = Date.parse(certificate.validTo)
    const validFromMs = Date.parse(certificate.validFrom)
    const expiresAt = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null
    const requiredHostnames = [hostname, ...(options.requiredHostnames ?? [])]
    if (!requiredHostnames.every((requiredHostname) => certificate.checkHost(requiredHostname))) {
      return { runCertbot: true, reason: 'hostname-mismatch', expiresAt }
    }
    if (!Number.isFinite(validFromMs) || validFromMs > nowMs) {
      return { runCertbot: true, reason: 'not-yet-valid', expiresAt }
    }
    if (!Number.isFinite(expiresMs)) {
      return { runCertbot: true, reason: 'malformed', expiresAt: null }
    }
    if (expiresMs - nowMs <= renewBeforeMs) {
      return { runCertbot: true, reason: 'expiring', expiresAt }
    }
    return { runCertbot: false, reason: 'fresh', expiresAt }
  } catch {
    return { runCertbot: true, reason: 'malformed', expiresAt: null }
  }
}

export async function inspectLocalCertificate(
  rawHostname: string,
  options: LocalCertificateInspectionOptions = {}
): Promise<CertificateInspection> {
  const hostname = normalizeCertificateHostname(rawHostname)
  if (!isValidCertificateHostname(hostname)) {
    throw new Error(`Certificate hostname is invalid: ${rawHostname}`)
  }
  const certificateRoot = options.certificateRoot || DEFAULT_CERTIFICATE_ROOT
  const certificatePath = path.join(certificateRoot, 'live', hostname, 'fullchain.pem')
  let pem: string
  try {
    pem = await readFile(certificatePath, 'utf8')
  } catch (error) {
    return {
      runCertbot: true,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      expiresAt: null,
    }
  }
  return inspectCertificatePem(pem, hostname, options)
}
