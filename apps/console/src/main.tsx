import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PRODUCT_DISPLAY_NAME } from '@cuddly/product'
import { CakeProvider } from '@a1knla/cakeui'
import '@a1knla/cakeui/style.css'
import '../../../packages/ui-theme/theme.css'
import './cake-layout.css'

import { App } from './App'
import { AuthGate } from './AuthGate'
import { ShareLanding, shareTokenFromPathname } from './ShareLanding'
import { PermissionsPage } from './PermissionsPage'
import { ProfilePage } from './ProfilePage'
import { McpAccessPage } from './McpAccessPage'
import './styles.css'

const shareToken = shareTokenFromPathname(window.location.pathname)
document.title = PRODUCT_DISPLAY_NAME

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CakeProvider theme="blue" mode="light" density="compact" className="bifrost-theme">
      <AuthGate>
        {(session, onLogout) =>
          window.location.pathname.replace(/\/+$/, '') === '/settings/mcp' ? (
            <McpAccessPage key={session.userId} />
          ) : window.location.pathname.startsWith('/settings/') ? (
            <ProfilePage key={session.userId} />
          ) : window.location.pathname.replace(/\/+$/, '') === '/permissions' ? (
            <PermissionsPage authorization={session} />
          ) : shareToken ? (
            <ShareLanding token={shareToken} />
          ) : (
            <App
              identity={session.identity}
              authorization={session}
              authenticated={session.authenticated}
              onLogout={onLogout}
            />
          )
        }
      </AuthGate>
    </CakeProvider>
  </StrictMode>
)
