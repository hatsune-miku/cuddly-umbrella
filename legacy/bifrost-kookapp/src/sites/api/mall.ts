import type { Rule } from '../../core/interceptor'
import { DECORATION_MAP, DECORATION_TPL_DEFAULT } from '../../lib/decoration-map'
import { getMisData } from '../../store/mis-data'

/**
 * 商城响应里 group 的嵌套深度不固定（可能是 T[]、T[][] 或 T[][][]），
 * 靠 content 字段的存在性判断是不是叶子节点。
 */
function replaceDecoration(node: any, decoration: any) {
  if (Array.isArray(node)) {
    for (const item of node) {
      replaceDecoration(item, decoration)
    }
    return
  }
  if (node && typeof node === 'object' && node.content?.pool?.decoration) {
    node.content.pool.decoration = decoration
  }
}

/** 盲盒换肤：把商城所有盲盒的贴图整体换成选定皮肤 */
export const mallDecorationOverride: Rule = {
  name: 'mall-decoration-override',
  kind: 'json',
  match: '/api/v3/mall/index',
  apply(ctx) {
    if (!ctx.data) {
      return
    }
    const tpl = getMisData().mallConfig?.decoration_tpl || DECORATION_TPL_DEFAULT
    const decoration = DECORATION_MAP[tpl]
    const group = ctx.data.data?.group
    if (decoration && group) {
      replaceDecoration(group, decoration)
    }
  },
}
