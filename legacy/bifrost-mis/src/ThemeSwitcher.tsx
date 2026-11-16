import { useTheme } from 'next-themes'

import { useEffect, useState } from 'react'

import { Button } from '@heroui/react'

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <Button onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')} variant="flat" size="sm">
      {theme === 'dark' ? '🌙' : '🌞'}
    </Button>
  )
}
