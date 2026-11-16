import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, RefreshCw, Search } from 'lucide-react'
import {
  hasPermission,
  PERMISSION_MANAGEMENT,
  USER_MANAGEMENT,
  type AuthorizationPolicy,
  type PermissionContext,
  type UserAccount,
} from '@cuddly/contracts'
import { getPermissionPolicy, getUsers } from '../api'
import { Button, TextBox } from '../ui'
import { UserRow } from './components/UserRow'
import { PolicyEditor } from './components/PolicyEditor'
import { permissionError } from './helpers'
import './index.css'

export function PermissionsPage({ authorization }: { authorization: PermissionContext }) {
  const allowed = hasPermission(authorization, PERMISSION_MANAGEMENT)
  const canManageUsers = hasPermission(authorization, USER_MANAGEMENT)
  const [selectedTab, setTab] = useState<'users' | 'policy'>(canManageUsers ? 'users' : 'policy')
  const tab = selectedTab === 'users' && !canManageUsers ? 'policy' : selectedTab
  const [users, setUsers] = useState<UserAccount[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [policy, setPolicy] = useState<AuthorizationPolicy | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    if (!allowed) return
    const id = ++requestId.current
    setBusy(true)
    setError('')
    try {
      if (tab === 'users') {
        const result = await getUsers(search, page)
        if (id !== requestId.current) return
        setUsers(result.items)
        setTotal(result.total)
      } else {
        const result = await getPermissionPolicy()
        if (id !== requestId.current) return
        setPolicy(result)
      }
    } catch (failure) {
      if (id === requestId.current) setError(permissionError(failure))
    } finally {
      if (id === requestId.current) setBusy(false)
    }
  }, [allowed, page, search, tab, refresh])

  useEffect(() => {
    void load()
    return () => {
      requestId.current++
    }
  }, [load])

  function submitSearch(event: FormEvent): void {
    event.preventDefault()
    setPage(1)
    setSearch(query.trim())
  }
  function savedUser(user: UserAccount): void {
    setUsers((items) => items.map((item) => (item.id === user.id ? user : item)))
  }

  return (
    <main className="permissions-page">
      <section className="permissions-surface">
        <header className="permissions-header">
          <div className="permissions-title-group">
            <a className="permissions-back" href="/" aria-label="返回控制台">
              <ArrowLeft size={18} />
            </a>
            <h1 className="permissions-title">权限与用户</h1>
          </div>
          <span className="permissions-current-level">
            当前权限：{authorization.permissionLevel} 级
          </span>
        </header>
        {!allowed ? (
          <div className="permissions-empty" role="alert">
            此页面需要 {PERMISSION_MANAGEMENT.permissionLevel} 级权限。
          </div>
        ) : (
          <>
            <p className="permissions-intro">
              鼓励通过 permissionLevel 实现权限拦截，通过 roles
              优化使用体验。大多数功能的角色要求保持为空。
            </p>
            <p className="permissions-hint permissions-rules">
              所需角色必须同时具备；owner 或 administrator 豁免角色检查，但仍需满足权限等级。0
              级且角色为空的功能对游客开放。
            </p>
            <nav className="permissions-tabs" aria-label="权限管理">
              {canManageUsers ? (
                <Button
                  type="button"
                  aria-pressed={tab === 'users'}
                  className={tab === 'users' ? 'primary-button' : ''}
                  onClick={() => setTab('users')}
                >
                  用户
                </Button>
              ) : null}
              <Button
                type="button"
                aria-pressed={tab === 'policy'}
                className={tab === 'policy' ? 'primary-button' : ''}
                onClick={() => setTab('policy')}
              >
                功能权限
              </Button>
              <Button
                type="button"
                className="permissions-refresh"
                disabled={busy}
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw size={15} />
                刷新
              </Button>
            </nav>
            {error ? (
              <div className="permissions-error" role="alert">
                {error}
              </div>
            ) : null}
            {tab === 'users' ? (
              <>
                <form className="permissions-search" onSubmit={submitSearch}>
                  <TextBox
                    aria-label="搜索用户"
                    placeholder="搜索名字、用户名或 ID"
                    value={query}
                    maxLength={120}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    <Search size={15} />
                    搜索
                  </Button>
                  <span className="permissions-hint">{total} 位用户</span>
                </form>
                <p className="permissions-hint permissions-role-example">
                  角色填写字符串数组，例如 ["new-user"]；没有角色时填写 []。
                </p>
                {busy ? (
                  <div className="permissions-empty" role="status">
                    正在读取用户
                  </div>
                ) : (
                  <>
                    <div className="permissions-table-scroll">
                      <table className="permissions-table">
                        <thead className="permissions-table-head">
                          <tr className="permissions-row">
                            <th className="permissions-cell">用户</th>
                            <th className="permissions-cell">权限等级</th>
                            <th className="permissions-cell">角色</th>
                            <th className="permissions-cell">操作</th>
                          </tr>
                        </thead>
                        <tbody className="permissions-table-body">
                          {users.map((user) => (
                            <UserRow
                              key={user.id}
                              user={user}
                              actorLevel={authorization.permissionLevel}
                              onSaved={savedUser}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!users.length ? <div className="permissions-empty">没有匹配的用户</div> : null}
                    <div className="permissions-pagination">
                      <Button
                        type="button"
                        disabled={page === 1}
                        onClick={() => setPage((value) => value - 1)}
                      >
                        上一页
                      </Button>
                      <span className="permissions-hint">第 {page} 页</span>
                      <Button
                        type="button"
                        disabled={page * 20 >= total}
                        onClick={() => setPage((value) => value + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </>
                )}
              </>
            ) : busy ? (
              <div className="permissions-empty" role="status">
                正在读取功能权限
              </div>
            ) : policy ? (
              <PolicyEditor
                key={refresh}
                policy={policy}
                actorLevel={authorization.permissionLevel}
                onSaved={setPolicy}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}
