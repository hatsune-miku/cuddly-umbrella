// 新版热更入口选择性覆盖：覆盖 GET /api/v3/version/hot-module 的上游响应。
//
// 策略：不伪造整份响应、不设批次版本。只对「填了 entry 的模块」做覆盖，
//   - 填了 base   → 覆盖上游响应里所有批次/所有主版本下的 base 模块条目
//   - 没填 discover → 上游响应里的 discover 原样保留，不去动
//
// 契约对照 kook host（只读参考）：
//   apps/webapp/src/_core/hot-update-service/index.ts → parseHotModuleResponse
//   后端正式形态 data.modules 为「remote key → { name, entry, version, restartRequired } 」对象 map。

export interface HotModuleDependsOn {
  main?: string
  remotes?: Record<string, string>
}

export interface HotModuleItem {
  name?: string
  entry?: string
  version?: string
  restartRequired?: boolean
  dependsOn?: HotModuleDependsOn
}

export interface HotModuleConfig {
  modules?: Record<string, HotModuleItem>
}

// host 已知 remote key 全集（与 kook devPortMap / prodRemoteEntryMock 对齐）。
// 前端「热更配置」tab 据此列出可填模块。
export const KNOWN_REMOTE_KEYS = [
  'base',
  'discover',
  'gift',
  'guild',
  'help_center',
  'mall',
  'order_tracker',
  'profile',
  'settings',
  'thread',
  'tutorial',
  'voice_runtime',
  'voice_panel',
] as const

function hasEntry(item?: HotModuleItem): item is HotModuleItem {
  return !!(item && typeof item.entry === 'string' && item.entry.trim())
}

// 是否有可覆盖的模块（至少一个模块填了 entry）。无内容时调用方应原样放行上游响应。
export function hasHotModuleConfig(config?: HotModuleConfig): boolean {
  if (!config || !config.modules) {
    return false
  }
  return Object.values(config.modules).some(hasEntry)
}

// 把配置的模块覆盖进上游响应的 data（就地修改）。未配置的 key 保持上游原样。
// data 形如 { version, modules: { '<key>': {...} } }（host 首选解析形态）。
export function applyHotModuleOverlay(data: any, config: HotModuleConfig): void {
  if (!data || typeof data !== 'object') {
    return
  }
  const overrides = config.modules || {}
  const keys = Object.keys(overrides).filter((key) => hasEntry(overrides[key]))
  if (keys.length === 0) {
    return
  }
  if (!data.modules || typeof data.modules !== 'object') {
    data.modules = {}
  }
  for (const key of keys) {
    const item = overrides[key]
    data.modules[key] = {
      // name / version 缺省时 host 会从 entry 路径段推导，这里有就带上。
      ...(item.name ? { name: item.name } : {}),
      entry: item.entry!.trim(),
      ...(item.version ? { version: item.version } : {}),
      restartRequired: !!item.restartRequired,
      ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
    }
  }
}
