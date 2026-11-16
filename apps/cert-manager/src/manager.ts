import { spawn } from 'node:child_process'

import {
  DEFAULT_PREVIEW_BASE_DOMAIN,
  displayCertbotCommand,
  normalizePreviewBaseDomain,
  planCertbotCommands,
  type CertbotCommand,
  type CertificateConfig,
  type DnsCertificateProvider,
} from './commands'
import { inspectLocalCertificate, type CertificateInspection } from './certificate'
import { grantNginxCertificateAccess } from './permissions'

export interface CertificateManagerOptions {
  loadConfig: () => Promise<CertificateConfig>
  execute?: (command: CertbotCommand, signal: AbortSignal) => Promise<void>
  grantAccess?: (hostname: string) => Promise<void>
  inspectCertificate?: (
    hostname: string,
    options?: { requiredHostnames?: string[] }
  ) => Promise<CertificateInspection>
  pollIntervalMs: number
  configCheckIntervalMs?: number
  previewBaseDomain?: string
  dnsProvider?: DnsCertificateProvider
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

type ExecutionAbortReason = 'disabled' | 'stopped'
type ExecutionStatus = 'completed' | 'unavailable' | ExecutionAbortReason
type CommandConfiguration =
  | { status: 'active'; command: CertbotCommand }
  | { status: 'disabled' }
  | { status: 'removed' }
  | { status: 'unavailable' }

const DEFAULT_CONFIG_CHECK_INTERVAL_MS = 2_000
const CERTBOT_TERMINATE_GRACE_MS = 5_000

function executeCertbot(command: CertbotCommand, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('certbot execution was aborted before it started'))
      return
    }

    const child = spawn(command.executable, command.args, { stdio: 'inherit' })
    let forceKillTimer: NodeJS.Timeout | null = null
    let settled = false

    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, CERTBOT_TERMINATE_GRACE_MS)
      forceKillTimer.unref()
    }

    signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => finish(error))
    child.once('exit', (code, exitSignal) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          exitSignal || code === null
            ? `certbot was terminated by ${exitSignal ?? 'an unknown signal'}`
            : `certbot exited with code ${code ?? 'unknown'}`
        )
      )
    })
  })
}

export class CertificateManager {
  private readonly loadConfig: () => Promise<CertificateConfig>
  private readonly execute: (command: CertbotCommand, signal: AbortSignal) => Promise<void>
  private readonly grantAccess: (hostname: string) => Promise<void>
  private readonly inspectCertificate: (
    hostname: string,
    options?: { requiredHostnames?: string[] }
  ) => Promise<CertificateInspection>
  private readonly pollIntervalMs: number
  private readonly configCheckIntervalMs: number
  private readonly previewBaseDomain: string
  private readonly dnsProvider: DnsCertificateProvider
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>
  private running = false
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  private abortActiveExecution: ((reason: ExecutionAbortReason) => void) | null = null

  constructor(options: CertificateManagerOptions) {
    this.loadConfig = options.loadConfig
    this.execute = options.execute || executeCertbot
    this.grantAccess = options.grantAccess || grantNginxCertificateAccess
    this.inspectCertificate = options.inspectCertificate || inspectLocalCertificate
    this.pollIntervalMs = options.pollIntervalMs
    this.configCheckIntervalMs = options.configCheckIntervalMs ?? DEFAULT_CONFIG_CHECK_INTERVAL_MS
    if (this.configCheckIntervalMs <= 0) {
      throw new Error('Certificate config check interval must be greater than zero')
    }
    this.previewBaseDomain = normalizePreviewBaseDomain(
      options.previewBaseDomain ?? DEFAULT_PREVIEW_BASE_DOMAIN
    )
    this.dnsProvider = options.dnsProvider ?? null
    this.logger = options.logger || console
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.runLoop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abortActiveExecution?.('stopped')
  }

  async reconcile(): Promise<void> {
    if (this.running) {
      this.logger.warn('[cert-manager] reconciliation is already running; overlapping poll skipped')
      return
    }

    this.running = true
    try {
      const config = await this.loadConfig()
      if (!config.enabled) {
        this.logger.info('[cert-manager] automatic SSL is disabled; certbot was not started')
        return
      }

      const plan = planCertbotCommands(config, this.previewBaseDomain, this.dnsProvider)
      const loggedRejectedHostnames = new Set<string>()
      this.logRejectedHostnames(plan.rejectedHostnames, loggedRejectedHostnames)
      if (plan.commands.length === 0) {
        this.logger.info(
          '[cert-manager] automatic SSL is enabled, but no valid hostnames are configured'
        )
        return
      }

      const confirmCommand = async (
        currentCommand: CertbotCommand,
        phase: string
      ): Promise<CommandConfiguration> => {
        let refreshedConfig: CertificateConfig
        try {
          refreshedConfig = await this.loadConfig()
        } catch (error) {
          this.logger.warn(
            `[cert-manager] failed to confirm certificate configuration ${phase}; certificate operations deferred until the next reconciliation:`,
            error
          )
          return { status: 'unavailable' }
        }
        if (!refreshedConfig.enabled) return { status: 'disabled' }

        const refreshedPlan = planCertbotCommands(
          refreshedConfig,
          this.previewBaseDomain,
          this.dnsProvider
        )
        this.logRejectedHostnames(refreshedPlan.rejectedHostnames, loggedRejectedHostnames)
        const command = refreshedPlan.commands.find(
          (candidate) => candidate.hostname === currentCommand.hostname
        )
        return command ? { status: 'active', command } : { status: 'removed' }
      }

      hostnames: for (const plannedCommand of plan.commands) {
        let command = plannedCommand
        let confirmed = await confirmCommand(command, 'before certificate inspection')
        if (confirmed.status === 'disabled') {
          this.logger.info('[cert-manager] automatic SSL was disabled; remaining hostnames skipped')
          break
        }
        if (confirmed.status === 'unavailable') break
        if (confirmed.status === 'removed') {
          this.logger.warn(
            `[cert-manager] hostname is no longer configured or allowed; skipped: ${command.hostname}`
          )
          continue
        }
        command = confirmed.command

        try {
          let inspection: CertificateInspection
          try {
            inspection = await this.inspectCertificate(command.hostname, {
              requiredHostnames:
                this.dnsProvider === 'tencentcloud'
                  ? [`p-${'0'.repeat(32)}.${this.previewBaseDomain}`]
                  : undefined,
            })
          } catch (error) {
            this.logger.warn(
              `[cert-manager] certificate inspection failed for ${command.hostname}; Certbot will run:`,
              error
            )
            inspection = { runCertbot: true, reason: 'unreadable', expiresAt: null }
          }
          if (inspection.runCertbot) {
            confirmed = await confirmCommand(command, 'before Certbot start')
            if (confirmed.status === 'disabled') {
              this.logger.info(
                '[cert-manager] automatic SSL was disabled before Certbot started; current and remaining hostnames skipped'
              )
              break hostnames
            }
            if (confirmed.status === 'unavailable') break hostnames
            if (confirmed.status === 'removed') {
              this.logger.warn(
                `[cert-manager] hostname was removed before Certbot started; skipped: ${command.hostname}`
              )
              continue hostnames
            }
            command = confirmed.command
            this.logger.info(
              `[cert-manager] running (${inspection.reason}): ${displayCertbotCommand(command)}`
            )
            const executionStatus = await this.executeWhileEnabled(command)
            if (executionStatus !== 'completed') {
              this.logger.info(
                executionStatus === 'disabled'
                  ? '[cert-manager] automatic SSL was disabled; current Certbot process and remaining hostnames stopped'
                  : executionStatus === 'unavailable'
                    ? '[cert-manager] certificate configuration became unavailable; Certbot was not started and remaining hostnames were deferred'
                    : '[cert-manager] certificate manager stopped; current Certbot process terminated'
              )
              break
            }

            confirmed = await confirmCommand(command, 'after Certbot completion')
            if (confirmed.status === 'disabled') {
              this.logger.info(
                '[cert-manager] automatic SSL was disabled after Certbot completed; Nginx access update and remaining hostnames skipped'
              )
              break hostnames
            }
            if (confirmed.status === 'unavailable') break hostnames
            if (confirmed.status === 'removed') {
              this.logger.warn(
                `[cert-manager] hostname was removed after Certbot completed; Nginx access update skipped: ${command.hostname}`
              )
              continue hostnames
            }
            command = confirmed.command
          } else {
            this.logger.info(
              `[cert-manager] certificate is fresh for ${command.hostname}; Certbot skipped (expires ${inspection.expiresAt})`
            )
          }

          confirmed = await confirmCommand(command, 'before Nginx access update')
          if (confirmed.status === 'disabled') {
            this.logger.info(
              '[cert-manager] automatic SSL was disabled; Nginx access update and remaining hostnames skipped'
            )
            break hostnames
          }
          if (confirmed.status === 'unavailable') break hostnames
          if (confirmed.status === 'removed') {
            this.logger.warn(
              `[cert-manager] hostname was removed before its Nginx access update; skipped: ${command.hostname}`
            )
            continue hostnames
          }
          command = confirmed.command
          await this.grantAccess(command.hostname)
          this.logger.info(`[cert-manager] Nginx certificate access ready for ${command.hostname}`)
        } catch (error) {
          this.logger.error(
            `[cert-manager] certificate reconciliation failed for ${command.hostname}:`,
            error
          )
        }
      }
    } catch (error) {
      this.logger.error('[cert-manager] failed to load certificate configuration:', error)
    } finally {
      this.running = false
    }
  }

  private logRejectedHostnames(hostnames: string[], logged: Set<string>): void {
    for (const hostname of hostnames) {
      if (logged.has(hostname)) continue
      logged.add(hostname)
      this.logger.warn(
        `[cert-manager] ignored invalid or out-of-scope certificate hostname: ${hostname}`
      )
    }
  }

  private async executeWhileEnabled(command: CertbotCommand): Promise<ExecutionStatus> {
    try {
      if (!(await this.loadConfig()).enabled) return 'disabled'
    } catch (error) {
      this.logger.warn(
        '[cert-manager] failed to confirm automatic SSL state immediately before Certbot start; Certbot deferred:',
        error
      )
      return 'unavailable'
    }

    const controller = new AbortController()

    return new Promise((resolve, reject) => {
      let settled = false
      let abortReason: ExecutionAbortReason | null = null
      let timer: NodeJS.Timeout | null = null

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
        if (this.abortActiveExecution === abortExecution) this.abortActiveExecution = null
      }
      const finish = <T>(handler: (value: T) => void, value: T): void => {
        if (settled) return
        settled = true
        cleanup()
        handler(value)
      }
      const abortExecution = (reason: ExecutionAbortReason): void => {
        if (settled || abortReason) return
        abortReason = reason
        controller.abort(reason)
      }
      const scheduleCheck = (): void => {
        timer = setTimeout(() => void checkConfiguration(), this.configCheckIntervalMs)
      }
      const checkConfiguration = async (): Promise<void> => {
        timer = null
        if (settled) return
        try {
          const config = await this.loadConfig()
          if (settled) return
          if (!config.enabled) {
            abortExecution('disabled')
            return
          }
        } catch (error) {
          this.logger.warn(
            '[cert-manager] failed to check automatic SSL state while Certbot is running:',
            error
          )
        }
        if (!settled) scheduleCheck()
      }

      this.abortActiveExecution = abortExecution
      scheduleCheck()
      void this.execute(command, controller.signal).then(
        () => finish(resolve, abortReason ?? 'completed'),
        (error: unknown) => {
          if (abortReason || controller.signal.aborted) {
            finish(resolve, abortReason ?? 'stopped')
            return
          }
          finish(reject, error)
        }
      )
    })
  }

  private async runLoop(): Promise<void> {
    await this.reconcile()
    if (this.stopped) return
    this.timer = setTimeout(() => void this.runLoop(), this.pollIntervalMs)
  }
}
