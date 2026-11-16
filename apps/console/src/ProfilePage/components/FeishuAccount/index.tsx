import { useEffect, useState } from 'react'
import { privateProfileSchema, type PrivateProfile } from '@cuddly/contracts'

export function FeishuAccount() {
  const [profile, setProfile] = useState<PrivateProfile | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let controller: AbortController | null = null
    let active = true
    async function load() {
      controller?.abort()
      controller = new AbortController()
      const signal = controller.signal
      setProfile(null)
      setError('')
      if (document.hidden) return
      try {
        const response = await fetch('/api/v1/me/private-profile', {
          credentials: 'include',
          cache: 'no-store',
          signal,
        })
        if (!response.ok)
          throw new Error(
            response.status === 403 ? '请重新使用飞书登录后查看账号详情' : '无法读取账号详情'
          )
        const data = privateProfileSchema.parse(await response.json())
        if (active && !signal.aborted) setProfile(data)
      } catch (failure) {
        if (active && !signal.aborted)
          setError(failure instanceof Error ? failure.message : '无法读取账号详情')
      }
    }
    function clear() {
      controller?.abort()
      setProfile(null)
    }
    function refresh() {
      void load()
    }
    void load()
    window.addEventListener('pagehide', clear)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      controller?.abort()
      window.removeEventListener('pagehide', clear)
      window.removeEventListener('pageshow', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return (
    <section className="profile-private" aria-label="飞书账号详情">
      {profile ? (
        <dl className="profile-data">
          <dt className="profile-label">真实姓名</dt>
          <dd className="profile-value">{profile.feishu.realName || '暂无资料'}</dd>
          {profile.feishu.username && (
            <>
              <dt className="profile-label">飞书用户名</dt>
              <dd className="profile-value">{profile.feishu.username}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="profile-message" role="status">
          {error || '正在读取账号详情'}
        </p>
      )}
      {error && (
        <a
          className="profile-back"
          href="/api/v1/auth/feishu/start?return_to=/settings/account/feishu"
        >
          使用飞书登录
        </a>
      )}
    </section>
  )
}
