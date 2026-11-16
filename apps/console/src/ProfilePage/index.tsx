import { useEffect, useState, type FormEvent } from 'react'
import type { UserAccount } from '@cuddly/contracts'
import { getOwnProfile, saveOwnProfile } from '../api'
import { Button, TextBox } from '../ui'
import { FeishuAccount } from './components/FeishuAccount'
import './index.css'

export function ProfilePage() {
  const [profile, setProfile] = useState<UserAccount | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const path = window.location.pathname.replace(/\/+$/, '')
  const detail = path === '/settings/account/feishu'
  const account = path.startsWith('/settings/account')
  useEffect(() => {
    let active = true
    void getOwnProfile()
      .then((user) => {
        if (active) {
          setProfile(user)
          setName(user.displayName)
        }
      })
      .catch(() => {
        if (active) setMessage('无法读取个人资料，请刷新重试')
      })
    return () => {
      active = false
    }
  }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const user = await saveOwnProfile(name)
      setProfile(user)
      setName(user.displayName)
      setMessage('已保存')
    } catch {
      setMessage('保存失败，名字需为 1 至 80 个字符')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="profile-page">
      <section className="profile-surface">
        <header className="profile-header">
          <a className="profile-back" href={detail ? '/settings/account' : '/'}>
            {detail ? '返回账号与登录' : '返回控制台'}
          </a>
          <h1 className="profile-title">{detail ? '飞书账号详情' : '个人设置'}</h1>
        </header>
        {!detail && (
          <nav className="profile-nav" aria-label="个人设置">
            <a
              className="profile-nav-link"
              aria-current={!account ? 'page' : undefined}
              href="/settings/profile"
            >
              个人资料
            </a>
            <a
              className="profile-nav-link"
              aria-current={account ? 'page' : undefined}
              href="/settings/account"
            >
              账号与登录
            </a>
          </nav>
        )}
        <div className="profile-content">
          {detail ? (
            <FeishuAccount />
          ) : account ? (
            <>
              <h2 className="profile-subtitle">已关联账号</h2>
              <a className="profile-account-link" href="/settings/account/feishu">
                飞书账号<span className="profile-link-label">账号详情</span>
              </a>
            </>
          ) : (
            <form className="profile-form" onSubmit={(event) => void save(event)}>
              <label className="profile-field">
                <span>名字</span>
                <TextBox
                  aria-label="名字"
                  value={name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                  disabled={!profile || busy}
                />
              </label>
              <p className="profile-hint">用于 Bifrost 中的显示和操作记录。</p>
              <dl className="profile-data">
                <dt className="profile-label">用户 ID</dt>
                <dd className="profile-value">{profile?.id || '正在读取'}</dd>
              </dl>
              <Button type="submit" variant="primary" disabled={!profile || busy || !name.trim()}>
                {busy ? '正在保存' : '保存'}
              </Button>
            </form>
          )}
          <p className="profile-message" role="status">
            {message}
          </p>
        </div>
      </section>
    </main>
  )
}
