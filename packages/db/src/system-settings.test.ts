import { describe, expect, it } from 'vitest'

import { MemoryStore } from './memory-store'
import { resolveSystemSettings, SYSTEM_SETTING_KEYS } from './system-settings'

describe('system settings', () => {
  it('enables the China package registry by default and persists an override', async () => {
    const store = new MemoryStore()

    expect((await resolveSystemSettings(store)).useChinaRegistry).toBe(true)

    await store.updateRuntimeSettings(
      [{ key: SYSTEM_SETTING_KEYS.useChinaRegistry, value: false }],
      'gz'
    )

    expect((await resolveSystemSettings(store)).useChinaRegistry).toBe(false)
  })

  it('stores URL rules as one JSON setting and falls back safely from malformed data', async () => {
    const store = new MemoryStore()
    expect((await resolveSystemSettings(store)).inPlaceUrlRules).toEqual([])

    const rules = [{ pattern: 'www.kookapp.cn', environmentSlug: 'shared' }]
    await store.updateRuntimeSettings(
      [{ key: SYSTEM_SETTING_KEYS.inPlaceUrlRules, value: rules }],
      'gz'
    )
    expect((await resolveSystemSettings(store)).inPlaceUrlRules).toEqual(rules)

    await store.updateRuntimeSettings(
      [{ key: SYSTEM_SETTING_KEYS.inPlaceUrlRules, value: [{ pattern: '', environmentSlug: 7 }] }],
      'gz'
    )
    expect((await resolveSystemSettings(store)).inPlaceUrlRules).toEqual([])
  })
})
