import { Button } from './ui'
import { useCallback, useEffect, useState } from 'react'
import { EXTENSION_NAME, PRODUCT_NAME } from '@cuddly/product'
import {
  Check,
  CircleAlert,
  ExternalLink,
  Layers3,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

import {
  ApiError,
  getConfigurationGroup,
  type ConfigurationGroupReadiness,
  type ConfigurationGroupResolvedItem,
  type ConfigurationGroupView,
} from './api'

const SHARE_PATH_PATTERN = /^\/s\/([A-Za-z0-9_-]{32})$/

interface ReadinessPresentation {
  label: string
  detail: string
  tone: 'official' | 'ready' | 'missing' | 'unavailable'
}

export function shareTokenFromPathname(pathname: string): string | null {
  return pathname.match(SHARE_PATH_PATTERN)?.[1] || null
}

export function readinessPresentation(
  readiness: ConfigurationGroupReadiness
): ReadinessPresentation {
  if (readiness === 'OFFICIAL') {
    return { label: '官方', detail: '不替换该项目', tone: 'official' }
  }
  if (readiness === 'READY') {
    return { label: '可用', detail: '已有成功打包产物', tone: 'ready' }
  }
  if (readiness === 'MISSING') {
    return { label: '未就绪', detail: '这个分支还没有可用产物', tone: 'missing' }
  }
  return { label: '不可用', detail: '项目或站点配置已经变化', tone: 'unavailable' }
}

export function configurationGroupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '这个配置组不存在，或分享链接已经失效。'
    if (error.status === 409)
      return `这个配置组当前不可用，请在 ${PRODUCT_NAME} 的“按需求”中检查环境与项目配置。`
    const body = error.body as { message?: unknown } | null
    if (typeof body?.message === 'string' && body.message.trim()) return body.message
  }
  return '暂时无法读取配置组，请检查网络后重试。'
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function environmentStatusLabel(status: ConfigurationGroupView['environment']['status']): string {
  if (status === 'ACTIVE') return '可用'
  if (status === 'FROZEN') return '冻结'
  return '归档'
}

function ItemStatusIcon({ readiness }: { readiness: ConfigurationGroupReadiness }) {
  return readiness === 'READY' || readiness === 'OFFICIAL' ? (
    <Check size={14} aria-hidden="true" />
  ) : (
    <CircleAlert size={14} aria-hidden="true" />
  )
}

function ConfigurationItem({ item }: { item: ConfigurationGroupResolvedItem }) {
  const presentation = readinessPresentation(item.readiness)
  const selection = item.mode === 'official' ? '官方版本' : item.branch || '未指定分支'
  const artifactHint =
    item.readiness === 'READY' && item.artifact
      ? `上次成功打包于 ${formatTime(item.artifact.builtAt)}`
      : presentation.detail

  return (
    <li className="share-project-row">
      <div className="share-project-main">
        <strong>{item.targetName || item.targetId}</strong>
        <span>{item.targetId}</span>
      </div>
      <div className="share-project-selection" title={selection}>
        {selection}
      </div>
      <div className={`share-readiness share-readiness-${presentation.tone}`} title={artifactHint}>
        <ItemStatusIcon readiness={item.readiness} />
        <span>{presentation.label}</span>
      </div>
    </li>
  )
}

export function ShareLanding({ token }: { token: string }) {
  const [configuration, setConfiguration] = useState<ConfigurationGroupView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setConfiguration(await getConfigurationGroup(token))
    } catch (nextError) {
      setConfiguration(null)
      setError(configurationGroupErrorMessage(nextError))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const unavailableCount =
    configuration?.items.filter(
      (item) => item.readiness === 'MISSING' || item.readiness === 'UNAVAILABLE'
    ).length || 0
  const configurationUnavailable = configuration ? !configuration.available : false

  return (
    <main className="share-page">
      <section className="share-surface" aria-labelledby="share-title">
        <header className="share-header">
          <div className="share-brand-mark" aria-hidden="true">
            <Layers3 size={22} />
          </div>
          <div>
            <span className="eyebrow">{PRODUCT_NAME.toUpperCase()} 配置组</span>
            <h1 id="share-title">{configuration?.name || '正在读取分享配置'}</h1>
            <p>这个持久链接始终读取需求最近保存的环境与项目分支，不会修改公共环境。</p>
          </div>
        </header>

        {loading ? (
          <div className="share-state" role="status">
            <LoaderCircle className="spin" size={22} />
            <div>
              <strong>正在加载配置</strong>
              <span>浏览器扩展会在配置就绪后自动打开隔离预览。</span>
            </div>
          </div>
        ) : error ? (
          <div className="share-state share-state-error" role="alert">
            <CircleAlert size={22} />
            <div>
              <strong>无法打开配置组</strong>
              <span>{error}</span>
            </div>
            <Button className="secondary-button" type="button" onClick={() => void load()}>
              <RefreshCw size={15} />
              重试
            </Button>
          </div>
        ) : configuration ? (
          <>
            <div className="share-context-grid">
              <div className="share-context-item">
                <span>环境</span>
                <strong>{configuration.environment.name}</strong>
                <small>
                  {configuration.environment.slug} ·{' '}
                  {environmentStatusLabel(configuration.environment.status)}
                </small>
              </div>
              <div className="share-context-item">
                <span>预览站点</span>
                <strong>{configuration.siteBinding.name}</strong>
                <small>{configuration.siteBinding.hostname}</small>
              </div>
            </div>

            <section className="share-projects" aria-labelledby="share-projects-title">
              <div className="share-section-heading">
                <div>
                  <span className="eyebrow">项目版本</span>
                  <h2 id="share-projects-title">{configuration.items.length} 个项目</h2>
                </div>
                <span
                  className={
                    unavailableCount || configurationUnavailable
                      ? 'share-summary warning'
                      : 'share-summary ready'
                  }
                >
                  {configurationUnavailable
                    ? '配置不可用'
                    : unavailableCount
                      ? `${unavailableCount} 项未就绪`
                      : '全部可用'}
                </span>
              </div>
              <ul className="share-project-list">
                {configuration.items.map((item) => (
                  <ConfigurationItem key={item.targetId} item={item} />
                ))}
              </ul>
            </section>

            <div
              className={`share-extension-note${unavailableCount || configurationUnavailable ? ' warning' : ''}`}
            >
              {unavailableCount || configurationUnavailable ? (
                <CircleAlert size={17} aria-hidden="true" />
              ) : (
                <ShieldCheck size={17} aria-hidden="true" />
              )}
              <div>
                <strong>
                  {configurationUnavailable
                    ? '配置组当前不能用于预览'
                    : unavailableCount
                      ? '请先完成未就绪分支的打包'
                      : '等待浏览器扩展打开预览'}
                </strong>
                <span>
                  {configurationUnavailable
                    ? `环境、站点或项目绑定已经发生变化，请在 ${PRODUCT_NAME} 的“按需求”中编辑或删除这条配置。`
                    : unavailableCount
                      ? `打开 ${PRODUCT_NAME} 扩展可查看分支状态并发起构建；配置组本身不会因此改变。`
                      : `如果页面停留在这里，请确认 ${EXTENSION_NAME} 扩展已安装并重新加载。`}
                </span>
              </div>
            </div>

            {configuration.directPreviewUrl && !unavailableCount && !configurationUnavailable ? (
              <a
                className="primary-button"
                href={configuration.directPreviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                无需扩展直接预览
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            ) : null}

            <div className="share-meta">
              <span>
                {configuration.createdBy || '未知操作人'} 创建 · 最近更新于{' '}
                {formatTime(configuration.updatedAt || configuration.createdAt)}
              </span>
              <a href="/">
                打开 {PRODUCT_NAME} 控制台
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
          </>
        ) : null}

        <footer className="share-footer">
          <span>{EXTENSION_NAME}</span>
          <span className="cakedesign-credit">Proudly Crafted With CakeDesign.</span>
        </footer>
      </section>
    </main>
  )
}
