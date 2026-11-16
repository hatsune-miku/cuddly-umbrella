import type { Rule } from '../../../core/interceptor'
import { applyHotModuleOverlay, hasHotModuleConfig } from '../../../lib/hot-module'
import { getMisData } from '../../../store/mis-data'

/**
 * 新版热更入口的选择性覆盖：填了 entry 的模块用配置版本，没填的保留上游原值。
 * 不伪造整份响应、不设批次版本，客户端的热更状态机完全按官方协议走。
 */
export const hotModuleOverride: Rule = {
  name: 'hot-module-override',
  kind: 'json',
  match: '/api/v3/version/hot-module',
  apply(ctx) {
    if (!ctx.data) {
      return
    }
    const overrideConfig = getMisData().hotModuleConfig
    if (!hasHotModuleConfig(overrideConfig)) {
      return
    }
    // 与 host 的 parseHotModuleResponse 一致地取 data，无信封时退回响应体本身
    const target = ctx.data.data && typeof ctx.data.data === 'object' ? ctx.data.data : ctx.data
    applyHotModuleOverlay(target, overrideConfig)
  },
}
