import { isIP } from 'node:net'

export const DEFAULT_PREVIEW_BASE_DOMAIN = 'bifrost.vanillacake.cn'

export interface CertificateConfig {
  enabled: boolean
  email: string
  hostnames: string[]
}

export interface CertbotCommand {
  executable: 'certbot'
  hostname: string
  args: string[]
}

export interface CertbotCommandPlan {
  commands: CertbotCommand[]
  rejectedHostnames: string[]
}

export type DnsCertificateProvider = 'tencentcloud' | null

export function normalizeCertificateHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export function isValidCertificateHostname(value: string): boolean {
  const hostname = normalizeCertificateHostname(value)
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0) return false

  const labels = hostname.split('.')
  if (labels.length < 2) return false
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )
}

export function normalizePreviewBaseDomain(value: string): string {
  const baseDomain = normalizeCertificateHostname(value)
  if (!isValidCertificateHostname(baseDomain)) {
    throw new Error(`Preview base domain is invalid: ${value}`)
  }
  return baseDomain
}

export function isDirectPreviewSubdomain(value: string, previewBaseDomain: string): boolean {
  const hostname = normalizeCertificateHostname(value)
  const baseDomain = normalizePreviewBaseDomain(previewBaseDomain)
  if (!isValidCertificateHostname(hostname)) return false

  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return false
  const siteLabel = hostname.slice(0, -suffix.length)
  return siteLabel.length > 0 && !siteLabel.includes('.')
}

export function planCertbotCommands(
  config: CertificateConfig,
  previewBaseDomain = DEFAULT_PREVIEW_BASE_DOMAIN,
  dnsProvider: DnsCertificateProvider = null
): CertbotCommandPlan {
  if (!config.enabled) return { commands: [], rejectedHostnames: [] }

  const baseDomain = normalizePreviewBaseDomain(previewBaseDomain)
  if (dnsProvider === 'tencentcloud') {
    const args = [
      'certonly',
      '--manual',
      '--preferred-challenges',
      'dns',
      '--manual-auth-hook',
      'node /app/dist/dns-hook.js auth',
      '--manual-cleanup-hook',
      'node /app/dist/dns-hook.js cleanup',
      '--non-interactive',
      '--agree-tos',
      '--keep-until-expiring',
      '--cert-name',
      baseDomain,
      '-d',
      baseDomain,
      '-d',
      `*.${baseDomain}`,
    ]
    const email = config.email.trim()
    if (email) args.push('--email', email)
    else args.push('--register-unsafely-without-email')
    return {
      commands: [{ executable: 'certbot', hostname: baseDomain, args }],
      rejectedHostnames: [],
    }
  }
  const commands: CertbotCommand[] = []
  const rejectedHostnames: string[] = []
  const seen = new Set<string>()
  const email = config.email.trim()

  for (const rawHostname of config.hostnames) {
    const hostname = normalizeCertificateHostname(rawHostname)
    if (!isDirectPreviewSubdomain(hostname, baseDomain)) {
      rejectedHostnames.push(rawHostname)
      continue
    }
    if (seen.has(hostname)) continue
    seen.add(hostname)

    const args = [
      'certonly',
      '--standalone',
      '--http-01-port',
      '8080',
      '--non-interactive',
      '--agree-tos',
      '--keep-until-expiring',
      '--cert-name',
      hostname,
      '-d',
      hostname,
    ]
    if (email) args.push('--email', email)
    else args.push('--register-unsafely-without-email')

    commands.push({ executable: 'certbot', hostname, args })
  }

  return { commands, rejectedHostnames }
}

export function displayCertbotCommand(command: CertbotCommand): string {
  return [command.executable, ...command.args].join(' ')
}
