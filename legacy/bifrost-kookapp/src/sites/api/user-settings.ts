import type { Rule } from '../../core/interceptor'
import { mergeDeep } from '../../lib/merge-deep'
import { getMisData } from '../../store/mis-data'

/**
 * 用户设置覆盖。管理端「全局」和「旧热更配置」两个 tab 都写进 settingsOverlay，
 * 靠字段不重叠共存；旧热更机制的 summary_tpl 版本表也在这里下发。
 */
export const userSettingsOverride: Rule = {
  name: 'user-settings-override',
  kind: 'json',
  match: '/api/v3/user/settings',
  apply(ctx) {
    if (!ctx.data) {
      return
    }
    mergeDeep(ctx.data.data, getMisData().settingsOverlay || {})
  },
}
