import { ThemeProvider } from 'next-themes'
import { createRoot } from 'react-dom/client'

import { StrictMode } from 'react'

import { HeroUIProvider, ToastProvider } from '@heroui/react'

import App from './App.tsx'
import './main.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark">
      <HeroUIProvider>
        <ToastProvider placement="top-center" />
        <div className="text-foreground bg-background app-wrapper">
          <App />
        </div>
      </HeroUIProvider>
    </ThemeProvider>
  </StrictMode>
)
