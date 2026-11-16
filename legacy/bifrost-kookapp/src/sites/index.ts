import { createBizSite } from './biz'
import { createMirrorSites } from './mirrors'
import { createMobileSite } from './mobile'
import { createWebappSite } from './webapp'

import type { SiteDefinition } from '../core/site'

/**
 * 站点注册表。新增一个被代理的端 = 在这里加一条。
 *
 * 顺序不影响匹配（匹配优先级由 mountSites 按 Host > 路径前缀 > 兜底 决定），
 * 但兜底站点全表只能有一个。
 */
export function createSites(): SiteDefinition[] {
  return [createMobileSite(), createBizSite(), ...createMirrorSites(), createWebappSite()].filter(
    (site): site is SiteDefinition => site !== null
  )
}
