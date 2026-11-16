// hero.ts
import { heroui } from '@heroui/react'

// 设计语言取自 anydrop（apps/desktop-tauri/src/styles.scss）：
//   主强调色 = 玫瑰粉 rgb(213,82,118)，次强调 = 钢蓝 rgb(81,131,178)，冷白底，紧凑 13px 排版。
export default heroui({
  layout: {
    radius: { small: '6px', medium: '8px', large: '10px' },
    fontSize: { tiny: '11px', small: '12px', medium: '13px', large: '15px' },
  },
  themes: {
    light: {
      colors: {
        background: 'rgb(242, 245, 250)',
        foreground: '#1f2933',
        focus: 'rgb(213, 82, 118)',
        divider: 'rgba(31, 41, 51, 0.1)',
        primary: { DEFAULT: 'rgb(213, 82, 118)', foreground: '#ffffff' },
        secondary: { DEFAULT: 'rgb(81, 131, 178)', foreground: '#ffffff' },
      },
    },
    dark: {
      colors: {
        background: 'rgb(20, 22, 28)',
        foreground: '#dce3ea',
        focus: 'rgb(213, 82, 118)',
        divider: 'rgba(255, 255, 255, 0.08)',
        primary: { DEFAULT: 'rgb(213, 82, 118)', foreground: '#ffffff' },
        secondary: { DEFAULT: 'rgb(81, 131, 178)', foreground: '#ffffff' },
      },
    },
  },
}) as any
