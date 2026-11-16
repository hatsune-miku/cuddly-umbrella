import type { Rule } from '../../core/interceptor'
import { getMisData } from '../../store/mis-data'

/** 在官方发现页 tab 列表后追加自定义 tab */
export const discoverTabListOverride: Rule = {
  name: 'discover-tab-list-override',
  kind: 'json',
  match: '/api/v3/discover/tab-list',
  apply(ctx) {
    if (!ctx.data) {
      return
    }
    const extraItems = getMisData().discoverTabListItemsOverlay || []
    ctx.data.data.items = [...ctx.data.data.items, ...extraItems]
  },
}

/** 按 tab id 整体替换发现页内容，未配置的 id 走官方数据 */
export const discoverViewOverride: Rule = {
  name: 'discover-view-override',
  kind: 'json',
  match: '/api/v3/discover/view',
  apply(ctx) {
    const data = (getMisData().discoverViewIdToData || {})[ctx.req.query.id]
    if (!data) {
      return
    }
    ctx.data.data = data
  },
}
