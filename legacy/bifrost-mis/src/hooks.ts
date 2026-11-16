import { useTheme } from 'next-themes'

import { useEffect } from 'react'

export function useSystemDarkModeAware() {
  const theme = useTheme()

  useEffect(() => {
    if (!theme.systemTheme) {
      return
    }
    theme.setTheme(theme.systemTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.systemTheme])
}
