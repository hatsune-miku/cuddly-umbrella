import type { CertificateConfig } from './commands'

export function parseCertificateConfig(value: unknown): CertificateConfig {
  if (!value || typeof value !== 'object') throw new Error('certificate config is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.autoSslEnabled !== 'boolean') {
    throw new Error('certificate config autoSslEnabled is invalid')
  }
  if (
    !Array.isArray(record.hostnames) ||
    !record.hostnames.every((item) => typeof item === 'string')
  ) {
    throw new Error('certificate config hostnames are invalid')
  }
  if (
    record.autoSslEmail !== undefined &&
    record.autoSslEmail !== null &&
    typeof record.autoSslEmail !== 'string'
  ) {
    throw new Error('certificate config autoSslEmail is invalid')
  }
  return {
    enabled: record.autoSslEnabled,
    email: typeof record.autoSslEmail === 'string' ? record.autoSslEmail : '',
    hostnames: record.hostnames,
  }
}
