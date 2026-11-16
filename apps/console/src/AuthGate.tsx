import { Button } from './ui'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, LoaderCircle, LogIn, ShieldCheck } from 'lucide-react'
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME } from '@cuddly/product'
import { defaultAuthorizationPolicy, hasPermission } from '@cuddly/contracts'

import {
  AUTH_REQUIRED_EVENT,
  PERMISSIONS_CHANGED_EVENT,
  ApiError,
  clearCachedAuthSession,
  currentReturnTo,
  feishuLoginUrl,
  getAuthSession,
  logout,
  type AuthSessionView,
} from './api'

type AuthState =
  | { status: 'checking' }
  | { status: 'authenticated'; session: AuthSessionView }
  | { status: 'unauthenticated' }
  | { status: 'error' }

export function authErrorMessage(code: string | null): string {
  if (code === 'access_denied') return '飞书登录已取消，请重新登录后继续。'
  if (code === 'invalid_state' || code === 'invalid_callback') {
    return '登录请求已经失效，请重新发起飞书登录。'
  }
  if (code === 'oauth_failed') return '飞书登录暂时未完成，请稍后重试。'
  return ''
}

function readAuthReturn(): { errorCode: string | null; returnTo: string } {
  const url = new URL(window.location.href)
  const errorCode = url.searchParams.get('auth_error')
  url.searchParams.delete('auth_error')
  return { errorCode, returnTo: currentReturnTo(url) }
}

function AuthScreen({
  checking,
  errorCode,
  loginHref,
  networkError,
  onRetry,
}: {
  checking: boolean
  errorCode: string | null
  loginHref: string
  networkError: boolean
  onRetry: () => void
}) {
  const message = authErrorMessage(errorCode)

  return (
    <main className="auth-page">
      <section className="auth-surface" aria-labelledby="auth-title">
        <div className="auth-brand-mark" aria-hidden="true">
          <ShieldCheck size={25} strokeWidth={1.8} />
        </div>
        <div className="auth-copy">
          <span className="eyebrow">{PRODUCT_DISPLAY_NAME}</span>
          <h1 id="auth-title">使用飞书身份进入</h1>
          <p>登录后，使用 Bifrost 名字参与构建和协作。</p>
        </div>

        {checking ? (
          <div className="auth-checking" role="status">
            <LoaderCircle className="spin" size={17} />
            正在确认登录状态
          </div>
        ) : (
          <>
            {message || networkError ? (
              <div className="auth-error" role="alert">
                <CircleAlert size={16} />
                <span>{message || `暂时无法连接 ${PRODUCT_NAME}，请检查网络后重试。`}</span>
              </div>
            ) : null}
            {networkError ? (
              <Button type="button" className="secondary-button auth-action" onClick={onRetry}>
                重新检查
              </Button>
            ) : (
              <a
                className="cake-button primary-button auth-action"
                data-variant="primary"
                data-size="medium"
                href={loginHref}
                target="_blank"
                rel="noreferrer"
              >
                <LogIn size={16} />
                使用飞书登录
              </a>
            )}
          </>
        )}
      </section>
    </main>
  )
}

export function AuthGate({
  children,
}: {
  children: (session: AuthSessionView, onLogout: () => Promise<void>) => ReactNode
}) {
  const authReturn = useMemo(readAuthReturn, [])
  const [state, setState] = useState<AuthState>({ status: 'checking' })

  useEffect(() => {
    if (authReturn.errorCode) window.history.replaceState(null, '', authReturn.returnTo)
  }, [authReturn])

  const checkSession = useCallback(async (silent = false) => {
    if (!silent) setState({ status: 'checking' })
    try {
      const session = await getAuthSession({ force: true })
      const requirement = (session.requirements || defaultAuthorizationPolicy().requirements)[
        window.location.pathname.startsWith('/s/') ? 'share.read' : 'catalog.read'
      ]
      if (!session.authenticated && !hasPermission(session, requirement)) {
        setState({ status: 'unauthenticated' })
        return
      }
      setState({ status: 'authenticated', session })
    } catch (error) {
      setState(
        error instanceof ApiError && error.status === 401
          ? { status: 'unauthenticated' }
          : { status: 'error' }
      )
    }
  }, [])

  useEffect(() => {
    void checkSession()
  }, [checkSession])

  useEffect(() => {
    const checkAfterReturn = () => void checkSession(state.status === 'authenticated')
    window.addEventListener('focus', checkAfterReturn)
    return () => window.removeEventListener('focus', checkAfterReturn)
  }, [checkSession, state.status])

  useEffect(() => {
    const refreshPermissions = () => void checkSession(true)
    window.addEventListener(PERMISSIONS_CHANGED_EVENT, refreshPermissions)
    return () => window.removeEventListener(PERMISSIONS_CHANGED_EVENT, refreshPermissions)
  }, [checkSession])

  useEffect(() => {
    const handleAuthRequired = () => {
      clearCachedAuthSession()
      setState({ status: 'unauthenticated' })
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired)
  }, [])

  const handleLogout = useCallback(async () => {
    await logout()
    setState({ status: 'unauthenticated' })
  }, [])

  if (state.status === 'authenticated') return children(state.session, handleLogout)

  return (
    <AuthScreen
      checking={state.status === 'checking'}
      errorCode={authReturn.errorCode}
      loginHref={feishuLoginUrl(authReturn.returnTo)}
      networkError={state.status === 'error'}
      onRetry={() => void checkSession()}
    />
  )
}
