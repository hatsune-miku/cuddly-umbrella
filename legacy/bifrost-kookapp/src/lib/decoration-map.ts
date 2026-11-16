export const DECORATION_TPL_DEFAULT = 'default'
export const DECORATION_TPL_VCT = 'vct'
export const DECORATION_TPL_LUNAR_2026 = 'lunar2026'

export const DECORATION_MAP: Record<string, any> = {
  [DECORATION_TPL_DEFAULT]: {
    static: 'https://img.kookapp.cn/assets/item/resources/gacha-module-sprite.webp',
    spaceship_fire: 'https://img.kookapp.cn/assets/item/resources/gacha-red-shockwave.webp',
    hatch_exit: 'https://img.kookapp.cn/assets/item/resources/gacha_hatch-exit.webp',
    hatch_entrance: 'https://img.kookapp.cn/assets/item/resources/gacha-hatch-entrance.webp',
    red_particle: 'https://img.kookapp.cn/assets/item/resources/gacha-red-particle.webp',
    bonus_beam: 'https://img.kookapp.cn/assets/item/resources/bonus_beam.webp',
    bonus_overlay: 'https://img.kookapp.cn/assets/item/resources/down-vdWAXBHT0U07e01t.webp',
    button_2d: false,
    name: '默认',
    tpl: DECORATION_TPL_DEFAULT,
  },
  [DECORATION_TPL_VCT]: {
    static: 'https://img.kookapp.cn/assets/item/resources/gacha-module-sprite-0908v.webp',
    spaceship_fire: 'https://img.kookapp.cn/assets/item/resources/gacha-red-shockwave.webp',
    hatch_exit: 'https://img.kookapp.cn/assets/item/resources/hatch_exit_0908v.webp',
    hatch_entrance: 'https://img.kookapp.cn/assets/item/resources/hatch_entrance_0908v.webp',
    red_particle: 'https://img.kookapp.cn/assets/item/resources/gacha-red-particle.webp',
    bonus_beam: 'https://img.kookapp.cn/assets/item/resources/bonus_beam_0908v.webp',
    bonus_overlay: 'https://img.kookapp.cn/assets/item/resources/down-vdWAXBHT0U07e01t.webp',
    button_2d: true,
    name: 'vct',
    tpl: DECORATION_TPL_VCT,
  },
  [DECORATION_TPL_LUNAR_2026]: {
    static: 'https://img.kookapp.cn/assets/item/resources/sprite-MwNoQ4MCuh0u20lo.webp',
    spaceship_fire: 'https://img.kookapp.cn/assets/item/resources/gacha-red-shockwave.webp',
    hatch_exit: 'https://img.kookapp.cn/assets/item/resources/gacha_hatch-exit.webp',
    hatch_entrance: 'https://img.kookapp.cn/assets/item/resources/gacha-hatch-entrance.webp',
    red_particle: 'https://img.kookapp.cn/assets/item/resources/gacha-red-particle.webp',
    bonus_beam: 'https://img.kookapp.cn/assets/item/resources/up_2026-EUgR6UHmYn0rs089.webp',
    bonus_overlay: 'https://img.kookapp.cn/assets/item/resources/down_2026-Q9BYqBkqgu07e01t.webp',
    extra:
      '{"bonus_area_tint_color":"#e27124","tag_background_color":"rgba(71,1,140,0.8)","button_custom_amount_tint_color":"rgba(255,216,183,0.8)"}',
    button_2d: true,
    name: 'lunar2026',
    tpl: DECORATION_TPL_LUNAR_2026,
  },
}
