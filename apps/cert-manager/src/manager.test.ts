import { describe, expect, it, vi } from 'vitest'

import type { CertbotCommand } from './commands'
import { CertificateManager } from './manager'

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe('certificate reconciliation', () => {
  it('never invokes the executor while automatic SSL is disabled', async () => {
    const execute = vi.fn<(command: CertbotCommand) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled: false,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn'],
      }),
      execute,
      grantAccess: vi.fn(),
      inspectCertificate: vi.fn(),
      pollIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(execute).not.toHaveBeenCalled()
  })

  it('executes hostname commands sequentially', async () => {
    let active = 0
    let maximumActive = 0
    const completed: string[] = []
    const granted: string[] = []
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled: true,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn', 'voice.bifrost.vanillacake.cn'],
      }),
      execute: async (command) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        completed.push(command.hostname)
        active -= 1
      },
      grantAccess: async (hostname) => {
        granted.push(hostname)
      },
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(maximumActive).toBe(1)
    expect(completed).toEqual(['main.bifrost.vanillacake.cn', 'voice.bifrost.vanillacake.cn'])
    expect(granted).toEqual(['main.bifrost.vanillacake.cn', 'voice.bifrost.vanillacake.cn'])
  })

  it('skips an overlapping reconciliation', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started: (() => void) | undefined
    const executing = new Promise<void>((resolve) => {
      started = resolve
    })
    const loadConfig = vi.fn(async () => ({
      enabled: true,
      email: '',
      hostnames: ['main.bifrost.vanillacake.cn'],
    }))
    const manager = new CertificateManager({
      loadConfig,
      execute: async () => {
        started?.()
        await blocked
      },
      grantAccess: vi.fn(),
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      logger,
    })

    const first = manager.reconcile()
    await executing
    const readsBeforeOverlap = loadConfig.mock.calls.length
    await manager.reconcile()
    expect(loadConfig).toHaveBeenCalledTimes(readsBeforeOverlap)
    release?.()
    await first
  })

  it('does not grant Nginx access when Certbot fails', async () => {
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled: true,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn'],
      }),
      execute: async () => {
        throw new Error('issuance failed')
      },
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(grantAccess).not.toHaveBeenCalled()
  })

  it('skips Certbot for a fresh certificate but still repairs Nginx access', async () => {
    const execute = vi.fn<(command: CertbotCommand) => Promise<void>>()
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled: true,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn'],
      }),
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: false,
        reason: 'fresh',
        expiresAt: '2036-08-21T04:27:58.000Z',
      }),
      pollIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(execute).not.toHaveBeenCalled()
    expect(grantAccess).toHaveBeenCalledWith('main.bifrost.vanillacake.cn')
  })

  it('logs and ignores hostnames outside the configured preview base domain', async () => {
    const warn = vi.fn()
    const execute = vi.fn<(command: CertbotCommand, signal: AbortSignal) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled: true,
        email: '',
        hostnames: ['main.example.com', 'nested.main.bifrost.vanillacake.cn'],
      }),
      execute,
      grantAccess: vi.fn(),
      inspectCertificate: vi.fn(),
      pollIntervalMs: 60_000,
      previewBaseDomain: 'bifrost.vanillacake.cn',
      logger: { info: vi.fn(), warn, error: vi.fn() },
    })

    await manager.reconcile()

    expect(execute).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[cert-manager] ignored invalid or out-of-scope certificate hostname: main.example.com'
    )
    expect(warn).toHaveBeenCalledWith(
      '[cert-manager] ignored invalid or out-of-scope certificate hostname: nested.main.bifrost.vanillacake.cn'
    )
  })

  it('reloads configuration before every hostname and stops the remaining plan when disabled', async () => {
    let enabled = true
    const completed: string[] = []
    const granted: string[] = []
    const enabledConfig = {
      enabled: true,
      email: '',
      hostnames: ['main.bifrost.vanillacake.cn', 'voice.bifrost.vanillacake.cn'],
    }
    const loadConfig = vi.fn(async () => ({ ...enabledConfig, enabled }))
    const manager = new CertificateManager({
      loadConfig,
      execute: async (command) => {
        completed.push(command.hostname)
      },
      grantAccess: async (hostname) => {
        granted.push(hostname)
        enabled = false
      },
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(completed).toEqual(['main.bifrost.vanillacake.cn'])
    expect(granted).toEqual(['main.bifrost.vanillacake.cn'])
  })

  it('does not start Certbot when automatic SSL is disabled during certificate inspection', async () => {
    let enabled = true
    let inspectionStarted: (() => void) | undefined
    let releaseInspection: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      inspectionStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseInspection = resolve
    })
    const execute = vi.fn<(command: CertbotCommand, signal: AbortSignal) => Promise<void>>()
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn'],
      }),
      execute,
      grantAccess,
      inspectCertificate: async () => {
        inspectionStarted?.()
        await blocked
        return { runCertbot: true, reason: 'missing', expiresAt: null }
      },
      pollIntervalMs: 60_000,
      logger,
    })

    const reconciliation = manager.reconcile()
    await started
    enabled = false
    releaseInspection?.()
    await reconciliation

    expect(execute).not.toHaveBeenCalled()
    expect(grantAccess).not.toHaveBeenCalled()
  })

  it('does not grant Nginx access when automatic SSL is disabled after Certbot completes', async () => {
    let enabled = true
    const execute = vi.fn(async (): Promise<void> => {
      enabled = false
    })
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => ({
        enabled,
        email: '',
        hostnames: ['main.bifrost.vanillacake.cn'],
      }),
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(grantAccess).not.toHaveBeenCalled()
  })

  it('checks automatic SSL again immediately before granting Nginx access', async () => {
    let configRead = 0
    const execute = vi.fn(async (): Promise<void> => undefined)
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const manager = new CertificateManager({
      loadConfig: async () => {
        configRead += 1
        return {
          enabled: configRead < 6,
          email: '',
          hostnames: ['main.bifrost.vanillacake.cn'],
        }
      },
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 60_000,
      logger,
    })

    await manager.reconcile()

    expect(configRead).toBe(6)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(grantAccess).not.toHaveBeenCalled()
  })

  it('defers certificate work when a confirmation request fails briefly', async () => {
    let configRead = 0
    const execute = vi.fn(async (): Promise<void> => undefined)
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const localLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const manager = new CertificateManager({
      loadConfig: async () => {
        configRead += 1
        if (configRead === 3) throw new Error('temporary control API failure')
        return {
          enabled: true,
          email: '',
          hostnames: ['main.bifrost.vanillacake.cn'],
        }
      },
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 60_000,
      logger: localLogger,
    })

    await manager.reconcile()

    expect(execute).not.toHaveBeenCalled()
    expect(grantAccess).not.toHaveBeenCalled()
    expect(localLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('certificate operations deferred'),
      expect.any(Error)
    )
  })

  it('does not start Certbot when the final pre-start configuration check fails', async () => {
    let configRead = 0
    const execute = vi.fn(async (): Promise<void> => undefined)
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const localLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const manager = new CertificateManager({
      loadConfig: async () => {
        configRead += 1
        if (configRead === 4) throw new Error('temporary control API failure')
        return {
          enabled: true,
          email: '',
          hostnames: ['main.bifrost.vanillacake.cn'],
        }
      },
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 60_000,
      logger: localLogger,
    })

    await manager.reconcile()

    expect(configRead).toBe(4)
    expect(execute).not.toHaveBeenCalled()
    expect(grantAccess).not.toHaveBeenCalled()
    expect(localLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Certbot deferred'),
      expect.any(Error)
    )
  })

  it('aborts a running Certbot process when automatic SSL is disabled', async () => {
    let enabled = true
    let started: (() => void) | undefined
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let receivedAbort = false
    const loadConfig = vi.fn(async () => ({
      enabled,
      email: '',
      hostnames: ['main.bifrost.vanillacake.cn'],
    }))
    const execute = vi.fn(async (_command: CertbotCommand, signal: AbortSignal): Promise<void> => {
      started?.()
      enabled = false
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            receivedAbort = true
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
    })
    const grantAccess = vi.fn<(hostname: string) => Promise<void>>()
    const localLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const manager = new CertificateManager({
      loadConfig,
      execute,
      grantAccess,
      inspectCertificate: async () => ({
        runCertbot: true,
        reason: 'missing',
        expiresAt: null,
      }),
      pollIntervalMs: 60_000,
      configCheckIntervalMs: 1,
      logger: localLogger,
    })

    const reconciliation = manager.reconcile()
    await executionStarted
    await reconciliation

    expect(receivedAbort).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(grantAccess).not.toHaveBeenCalled()
    expect(localLogger.error).not.toHaveBeenCalled()
  })
})
