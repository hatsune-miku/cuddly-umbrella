import { useEffect, useState, type FormEvent } from 'react'
import type { CreatedMcpPersonalToken, McpPersonalToken } from '@cuddly/contracts'
import { ApiError, createMcpToken, listMcpTokens, revokeMcpToken } from '../api'
import { Button, TextBox } from '../ui'
import './index.css'

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string }
    if (body?.message) return body.message
  }
  return '操作失败，请重试'
}

export function McpAccessPage() {
  const [tokens, setTokens] = useState<McpPersonalToken[]>([])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedMcpPersonalToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loginRequired, setLoginRequired] = useState(false)
  const [message, setMessage] = useState('')
  const [revoking, setRevoking] = useState<string | null>(null)
  const endpoint = `${window.location.origin}/api/v1/mcp`
  useEffect(() => {
    let active = true
    void listMcpTokens()
      .then((data) => {
        if (active) setTokens(data.items)
      })
      .catch((error) => {
        if (!active) return
        setMessage(errorText(error))
        setLoginRequired(error instanceof ApiError && [401, 403].includes(error.status))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    function clearSecret() {
      setCreated(null)
    }
    window.addEventListener('pagehide', clearSecret)
    return () => {
      active = false
      window.removeEventListener('pagehide', clearSecret)
    }
  }, [])
  async function generate(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    setCreated(null)
    try {
      const result = await createMcpToken(name)
      setCreated(result)
      setTokens((items) => [result.item, ...items])
      setName('')
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`已复制${label}`)
    } catch {
      setMessage('复制失败，请手动选中并复制')
    }
  }
  async function revoke(id: string) {
    setBusy(true)
    setMessage('')
    try {
      await revokeMcpToken(id)
      setTokens((items) => items.filter((item) => item.id !== id))
      setRevoking(null)
      if (created?.item.id === id) setCreated(null)
      setMessage('已撤销')
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="mcp-access-page">
      <section className="mcp-access-surface">
        <header className="mcp-access-header">
          <a className="mcp-access-back" href="/">
            返回控制台
          </a>
          <h1 className="mcp-access-title">MCP 接入</h1>
          <p className="mcp-access-note">
            Token 绑定你的 Bifrost 身份，长期有效，直到撤销。权限跟随你的账号。
          </p>
        </header>
        <section className="mcp-access-connection" aria-label="连接配置">
          <label className="mcp-access-field">
            <span className="mcp-access-label">服务地址</span>
            <TextBox aria-label="服务地址" value={endpoint} readOnly />
          </label>
          <p className="mcp-access-note">
            选择 Streamable HTTP，在 Authorization 请求头填入 Bearer 和 Token。
          </p>
        </section>
        {loginRequired ? (
          <div className="mcp-access-login">
            <a className="mcp-access-link" href="/api/v1/auth/feishu/start?return_to=/settings/mcp">
              使用飞书登录
            </a>
          </div>
        ) : (
          <>
            <form className="mcp-access-create" onSubmit={(event) => void generate(event)}>
              <label className="mcp-access-field">
                <span className="mcp-access-label">名称</span>
                <TextBox
                  aria-label="Token 名称"
                  placeholder="例如：工作电脑"
                  value={name}
                  maxLength={80}
                  required
                  disabled={busy || loading}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button variant="primary" type="submit" disabled={busy || loading || !name.trim()}>
                {busy ? '正在处理' : '生成 Token'}
              </Button>
            </form>
            {created && (
              <section className="mcp-access-secret" aria-label="新 Token">
                <h2 className="mcp-access-subtitle">保存 Token</h2>
                <p className="mcp-access-note">仅显示这一次，离开页面后无法再次查看。</p>
                <textarea
                  className="mcp-access-token"
                  aria-label="新生成的 Token"
                  readOnly
                  value={created.token}
                  rows={2}
                  spellCheck={false}
                />
                <div className="mcp-access-actions">
                  <Button type="button" onClick={() => void copy(created.token, ' Token')}>
                    复制 Token
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void copy(`Bearer ${created.token}`, '请求头')}
                  >
                    复制 Authorization 值
                  </Button>
                  <Button
                    type="button"
                    onClick={() =>
                      void copy(
                        JSON.stringify(
                          {
                            mcpServers: {
                              bifrost: {
                                url: endpoint,
                                headers: { Authorization: `Bearer ${created.token}` },
                              },
                            },
                          },
                          null,
                          2
                        ),
                        ' JSON 配置'
                      )
                    }
                  >
                    复制 JSON 配置
                  </Button>
                  <Button type="button" onClick={() => setCreated(null)}>
                    已保存
                  </Button>
                </div>
              </section>
            )}
            <section className="mcp-access-tokens" aria-label="已有 Token">
              <h2 className="mcp-access-subtitle">已有 Token</h2>
              {loading ? (
                <p className="mcp-access-note">正在读取</p>
              ) : !tokens.length ? (
                <p className="mcp-access-note">暂无 Token</p>
              ) : (
                <ul className="mcp-access-list">
                  {tokens.map((item) => (
                    <li className="mcp-access-item" key={item.id}>
                      <div className="mcp-access-item-info">
                        <strong className="mcp-access-item-name">{item.name}</strong>
                        <span className="mcp-access-prefix">{item.prefix}…</span>
                        <span className="mcp-access-meta">
                          创建于 {new Date(item.createdAt).toLocaleString()} ·{' '}
                          {item.lastUsedAt
                            ? `最近使用 ${new Date(item.lastUsedAt).toLocaleString()}`
                            : '尚未使用'}
                        </span>
                      </div>
                      {revoking === item.id ? (
                        <div className="mcp-access-confirm">
                          <p className="mcp-access-note">
                            撤销后，使用此 Token 的 MCP 连接将失效。
                          </p>
                          <div className="mcp-access-actions">
                            <Button
                              type="button"
                              disabled={busy}
                              onClick={() => void revoke(item.id)}
                            >
                              确认撤销
                            </Button>
                            <Button type="button" disabled={busy} onClick={() => setRevoking(null)}>
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button type="button" disabled={busy} onClick={() => setRevoking(item.id)}>
                          撤销
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        <p className="mcp-access-message" role="status">
          {message}
        </p>
      </section>
    </main>
  )
}
