import { inPlaceUrlRulesSchema, type SystemSettingsView } from '@cuddly/contracts'

import type { CuddlyStore } from './store'

export const SYSTEM_SETTING_KEYS = {
  mobileUpstream: 'system.mobile_upstream',
  publicMobileOrigin: 'system.public_mobile_origin',
  webappUpstream: 'system.webapp_upstream',
  publicPreviewOrigin: 'system.public_preview_origin',
  mobileHostnames: 'system.mobile_hostnames',
  cookieDomain: 'system.cookie_domain',
  buildMaxConcurrency: 'system.build_max_concurrency',
  runnerRequestTimeoutMinutes: 'system.runner_request_timeout_minutes',
  useChinaRegistry: 'system.use_china_registry',
  proxyRewriteMaxMegabytes: 'system.proxy_rewrite_max_megabytes',
  autoSslEnabled: 'system.auto_ssl_enabled',
  autoSslEmail: 'system.auto_ssl_email',
  inPlaceUrlRules: 'system.in_place_url_rules',
} as const

export const SYSTEM_SETTING_DEFAULTS: SystemSettingsView = {
  mobileUpstream: 'https://m.kookapp.cn',
  publicMobileOrigin: 'http://localhost:9872',
  webappUpstream: 'https://www.kookapp.cn',
  publicPreviewOrigin: 'http://localhost:9872',
  mobileHostnames: ['localhost'],
  cookieDomain: '',
  buildMaxConcurrency: 3,
  runnerRequestTimeoutMinutes: 30,
  useChinaRegistry: true,
  proxyRewriteMaxMegabytes: 2,
  autoSslEnabled: false,
  autoSslEmail: '',
  inPlaceUrlRules: [],
}

export async function resolveSystemSettings(store: CuddlyStore): Promise<SystemSettingsView> {
  const records = await store.getRuntimeSettings(Object.values(SYSTEM_SETTING_KEYS))
  const values = new Map(records.map((record) => [record.key, record.value]))
  const value = <T>(key: string, fallback: T): T => (values.get(key) as T | undefined) ?? fallback
  const inPlaceUrlRules = inPlaceUrlRulesSchema.safeParse(
    values.get(SYSTEM_SETTING_KEYS.inPlaceUrlRules)
  )
  return {
    mobileUpstream: value(
      SYSTEM_SETTING_KEYS.mobileUpstream,
      SYSTEM_SETTING_DEFAULTS.mobileUpstream
    ),
    publicMobileOrigin: value(
      SYSTEM_SETTING_KEYS.publicMobileOrigin,
      SYSTEM_SETTING_DEFAULTS.publicMobileOrigin
    ),
    webappUpstream: value(
      SYSTEM_SETTING_KEYS.webappUpstream,
      SYSTEM_SETTING_DEFAULTS.webappUpstream
    ),
    publicPreviewOrigin: value(
      SYSTEM_SETTING_KEYS.publicPreviewOrigin,
      SYSTEM_SETTING_DEFAULTS.publicPreviewOrigin
    ),
    mobileHostnames: value(
      SYSTEM_SETTING_KEYS.mobileHostnames,
      SYSTEM_SETTING_DEFAULTS.mobileHostnames
    ),
    cookieDomain: value(SYSTEM_SETTING_KEYS.cookieDomain, SYSTEM_SETTING_DEFAULTS.cookieDomain),
    buildMaxConcurrency: value(
      SYSTEM_SETTING_KEYS.buildMaxConcurrency,
      SYSTEM_SETTING_DEFAULTS.buildMaxConcurrency
    ),
    runnerRequestTimeoutMinutes: value(
      SYSTEM_SETTING_KEYS.runnerRequestTimeoutMinutes,
      SYSTEM_SETTING_DEFAULTS.runnerRequestTimeoutMinutes
    ),
    useChinaRegistry: value(
      SYSTEM_SETTING_KEYS.useChinaRegistry,
      SYSTEM_SETTING_DEFAULTS.useChinaRegistry
    ),
    proxyRewriteMaxMegabytes: value(
      SYSTEM_SETTING_KEYS.proxyRewriteMaxMegabytes,
      SYSTEM_SETTING_DEFAULTS.proxyRewriteMaxMegabytes
    ),
    autoSslEnabled: value(
      SYSTEM_SETTING_KEYS.autoSslEnabled,
      SYSTEM_SETTING_DEFAULTS.autoSslEnabled
    ),
    autoSslEmail: value(SYSTEM_SETTING_KEYS.autoSslEmail, SYSTEM_SETTING_DEFAULTS.autoSslEmail),
    inPlaceUrlRules: inPlaceUrlRules.success
      ? inPlaceUrlRules.data
      : SYSTEM_SETTING_DEFAULTS.inPlaceUrlRules,
  }
}
