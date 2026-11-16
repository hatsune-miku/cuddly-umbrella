import { describe, expect, it } from 'vitest'

import {
  isDirectPreviewSubdomain,
  isValidCertificateHostname,
  normalizeCertificateHostname,
  normalizePreviewBaseDomain,
  planCertbotCommands,
} from './commands'

describe('certbot command planning', () => {
  it('does not plan any certbot process while automatic SSL is disabled', () => {
    expect(
      planCertbotCommands({
        enabled: false,
        email: 'ops@example.com',
        hostnames: ['main.bifrost.vanillacake.cn'],
      })
    ).toEqual({ commands: [], rejectedHostnames: [] })
  })

  it('preserves configured order, normalizes names, and removes duplicates', () => {
    const plan = planCertbotCommands({
      enabled: true,
      email: ' ops@example.com ',
      hostnames: [
        ' Main.Bifrost.VanillaCake.cn. ',
        'voice.bifrost.vanillacake.cn',
        'main.bifrost.vanillacake.cn',
      ],
    })

    expect(plan.rejectedHostnames).toEqual([])
    expect(plan.commands.map((command) => command.hostname)).toEqual([
      'main.bifrost.vanillacake.cn',
      'voice.bifrost.vanillacake.cn',
    ])
    expect(plan.commands[0]).toEqual({
      executable: 'certbot',
      hostname: 'main.bifrost.vanillacake.cn',
      args: [
        'certonly',
        '--standalone',
        '--http-01-port',
        '8080',
        '--non-interactive',
        '--agree-tos',
        '--keep-until-expiring',
        '--cert-name',
        'main.bifrost.vanillacake.cn',
        '-d',
        'main.bifrost.vanillacake.cn',
        '--email',
        'ops@example.com',
      ],
    })
  })

  it('uses Certbot unsafe registration when the email is empty', () => {
    const plan = planCertbotCommands({
      enabled: true,
      email: '  ',
      hostnames: ['main.bifrost.vanillacake.cn'],
    })

    expect(plan.commands[0]?.args).toContain('--register-unsafely-without-email')
    expect(plan.commands[0]?.args).not.toContain('--email')
  })

  it('rejects wildcard, IP, single-label, malformed, and oversized hostnames', () => {
    const invalid = [
      '*.bifrost.vanillacake.cn',
      '127.0.0.1',
      'localhost',
      '-main.bifrost.vanillacake.cn',
      `main.${'a'.repeat(64)}.cn`,
    ]
    const plan = planCertbotCommands({ enabled: true, email: '', hostnames: invalid })

    expect(plan.commands).toEqual([])
    expect(plan.rejectedHostnames).toEqual(invalid)
    expect(isValidCertificateHostname('main.bifrost.vanillacake.cn')).toBe(true)
    expect(normalizeCertificateHostname(' MAIN.Example.COM. ')).toBe('main.example.com')
  })

  it('only accepts direct subdomains of the configured preview base domain', () => {
    const invalid = [
      'bifrost.vanillacake.cn',
      'nested.main.bifrost.vanillacake.cn',
      'main.vanillacake.cn',
      'main.example.com',
    ]
    const plan = planCertbotCommands({
      enabled: true,
      email: '',
      hostnames: ['main.bifrost.vanillacake.cn', ...invalid],
    })

    expect(plan.commands.map((command) => command.hostname)).toEqual([
      'main.bifrost.vanillacake.cn',
    ])
    expect(plan.rejectedHostnames).toEqual(invalid)
    expect(isDirectPreviewSubdomain('main.bifrost.vanillacake.cn', 'bifrost.vanillacake.cn')).toBe(
      true
    )
    expect(
      isDirectPreviewSubdomain('nested.main.bifrost.vanillacake.cn', 'bifrost.vanillacake.cn')
    ).toBe(false)
  })

  it('supports a deployment-specific preview base domain', () => {
    const plan = planCertbotCommands(
      {
        enabled: true,
        email: '',
        hostnames: ['main.preview.example.com', 'main.bifrost.vanillacake.cn'],
      },
      ' Preview.Example.COM. '
    )

    expect(plan.commands.map((command) => command.hostname)).toEqual(['main.preview.example.com'])
    expect(plan.rejectedHostnames).toEqual(['main.bifrost.vanillacake.cn'])
    expect(normalizePreviewBaseDomain(' Preview.Example.COM. ')).toBe('preview.example.com')
    expect(() => normalizePreviewBaseDomain('*.example.com')).toThrow(
      'Preview base domain is invalid'
    )
  })

  it('plans one DNS-01 certificate for the preview base and wildcard', () => {
    const plan = planCertbotCommands(
      {
        enabled: true,
        email: 'ops@example.com',
        hostnames: ['main.bifrost.vanillacake.cn'],
      },
      'bifrost.vanillacake.cn',
      'tencentcloud'
    )
    expect(plan.rejectedHostnames).toEqual([])
    expect(plan.commands).toHaveLength(1)
    expect(plan.commands[0]?.hostname).toBe('bifrost.vanillacake.cn')
    expect(plan.commands[0]?.args).toContain('--manual-auth-hook')
    expect(plan.commands[0]?.args).toContain('*.bifrost.vanillacake.cn')
  })
})
