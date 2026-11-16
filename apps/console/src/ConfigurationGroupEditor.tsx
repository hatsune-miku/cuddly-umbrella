import { Button, ComboBox, TextBox } from './ui'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type {
  BranchCatalogItem,
  BuildQueueItem,
  EnvironmentMatrix,
  EnvironmentRecord,
  MatrixRow,
  SiteBinding,
} from '@cuddly/contracts'
import {
  configurationGroupReservedUrlPrefixes,
  configurationGroupUrlPrefixPattern,
  isConfigurationGroupUrlPrefixInput,
  normalizeConfigurationGroupUrlPrefixInput,
} from '@cuddly/contracts'
import { CircleAlert, Layers3, LoaderCircle, Save, X } from 'lucide-react'

import {
  ApiError,
  createConfigurationGroup,
  getBranches,
  getMatrix,
  updateConfigurationGroup,
  type ConfigurationGroupItem,
  type ConfigurationGroupRecord,
} from './api'
import { BranchPicker } from './BranchPicker'

interface BranchState {
  items: BranchCatalogItem[]
  remoteAvailable: boolean
  error: string
}

export interface ConfigurationGroupEditorDefaults {
  environmentSlug: string
  siteBindingId: string
  selectedBranches: Record<string, string>
}

export function configurationGroupTargetIds(binding: SiteBinding | null): string[] {
  if (!binding) return []
  return [...new Set([binding.targetId, ...binding.remoteTargetIds])]
}

export function configurationGroupSelections(
  items: ConfigurationGroupItem[] | undefined,
  defaults: Record<string, string> = {}
): Record<string, string> {
  if (!items) return { ...defaults }
  return Object.fromEntries(
    items.map((item) => [item.targetId, item.mode === 'branch' ? item.branch : ''])
  )
}

export function configurationGroupItemsFromSelections(
  targetIds: string[],
  selections: Record<string, string>
): ConfigurationGroupItem[] {
  return targetIds.map((targetId) => {
    const branch = selections[targetId]?.trim() || ''
    return branch
      ? { targetId, mode: 'branch' as const, branch }
      : { targetId, mode: 'official' as const }
  })
}

export function nextConfigurationGroupEnvironmentSlug(
  current: string,
  environments: Array<Pick<EnvironmentRecord, 'slug' | 'status'>>,
  preferred: string
): string {
  if (current) return current
  const enabled = environments.filter((environment) => environment.status !== 'ARCHIVED')
  return (
    enabled.find((environment) => environment.slug === preferred)?.slug || enabled[0]?.slug || ''
  )
}

export function nextConfigurationGroupSiteBindingId(
  current: string,
  bindings: Array<Pick<SiteBinding, 'id' | 'enabled'>>,
  preferred: string
): string {
  if (current) return current
  const enabled = bindings.filter((binding) => binding.enabled)
  return enabled.find((binding) => binding.id === preferred)?.id || enabled[0]?.id || ''
}

export function configurationGroupHasBranchErrors(
  targetIds: string[],
  branches: Record<string, Pick<BranchState, 'error'> | undefined>
): boolean {
  return targetIds.some((targetId) => Boolean(branches[targetId]?.error))
}

export function shouldCloseConfigurationGroupEditor(key: string, saving: boolean): boolean {
  return key === 'Escape' && !saving
}

const reservedUrlPrefixes = new Set<string>(configurationGroupReservedUrlPrefixes)

export function canonicalConfigurationGroupUrlPrefix(value: string): string {
  const prefix = normalizeConfigurationGroupUrlPrefixInput(value)
  if (!prefix || !isConfigurationGroupUrlPrefixInput(prefix)) return ''
  try {
    const suffix = '.preview.invalid'
    const hostname = new URL(`https://${prefix}${suffix}`).hostname
    if (!hostname.endsWith(suffix)) return ''
    const canonical = hostname.slice(0, -suffix.length)
    return configurationGroupUrlPrefixPattern.test(canonical) ? canonical : ''
  } catch {
    return ''
  }
}

export function configurationGroupUrlPrefixError(value: string): string {
  const prefix = normalizeConfigurationGroupUrlPrefixInput(value)
  if (!prefix) return ''
  if (!isConfigurationGroupUrlPrefixInput(prefix)) {
    return '支持英文、数字和连字符，或中文搭配数字、连字符；不能中英文混排或以连字符开头、结尾'
  }
  const canonical = canonicalConfigurationGroupUrlPrefix(prefix)
  if (!canonical) return '中文前缀转换后的域名超过长度限制，请缩短'
  if (canonical.startsWith('p-')) return 'p- 开头的地址由系统自动链接保留'
  if (reservedUrlPrefixes.has(canonical)) return `${canonical} 是系统或预览站点保留地址`
  return ''
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null
    if (error.status === 409) {
      return typeof body?.message === 'string' && body.message.trim()
        ? `${body.message}，请刷新配置组后重试。`
        : '配置组已被其他人更新，请刷新后重试。'
    }
    if (typeof body?.message === 'string' && body.message.trim()) return body.message
  }
  return error instanceof Error ? error.message : '保存配置组失败'
}

function siteLabel(binding: SiteBinding): string {
  return `${binding.name} · ${binding.hostname}`
}

function officialLabel(row: MatrixRow | undefined): string {
  return row?.target.kind === 'remote' ? '官方热更' : '官网页面'
}

const dialogFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(dialogFocusableSelector)].filter(
    (element) =>
      element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement
  )
}

export function ConfigurationGroupEditor({
  group,
  defaults,
  environments,
  siteBindings,
  queueItems,
  previewBaseDomain,
  onClose,
  onSaved,
}: {
  group: ConfigurationGroupRecord | null
  defaults: ConfigurationGroupEditorDefaults
  environments: EnvironmentRecord[]
  siteBindings: SiteBinding[]
  queueItems: BuildQueueItem[]
  previewBaseDomain: string
  onClose: () => void
  onSaved: (group: ConfigurationGroupRecord) => void
}) {
  const enabledEnvironments = environments.filter(
    (environment) => environment.status !== 'ARCHIVED'
  )
  const enabledSites = siteBindings.filter((binding) => binding.enabled)
  const initialEnvironmentSlug =
    group?.environmentSlug ||
    (enabledEnvironments.some((environment) => environment.slug === defaults.environmentSlug)
      ? defaults.environmentSlug
      : enabledEnvironments[0]?.slug || '')
  const initialSiteBindingId =
    group?.siteBindingId ||
    (enabledSites.some((binding) => binding.id === defaults.siteBindingId)
      ? defaults.siteBindingId
      : enabledSites[0]?.id || '')

  const [name, setName] = useState(group?.name || '')
  const [urlPrefix, setUrlPrefix] = useState('')
  const [environmentSlug, setEnvironmentSlug] = useState(initialEnvironmentSlug)
  const [siteBindingId, setSiteBindingId] = useState(initialSiteBindingId)
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    configurationGroupSelections(group?.items, defaults.selectedBranches)
  )
  const [matrix, setMatrix] = useState<EnvironmentMatrix | null>(null)
  const [branches, setBranches] = useState<Record<string, BranchState>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const selectedBinding = siteBindings.find((binding) => binding.id === siteBindingId) || null
  const targetIds = useMemo(() => configurationGroupTargetIds(selectedBinding), [selectedBinding])
  const rowsById = useMemo(
    () => new Map(matrix?.rows.map((row) => [row.target.id, row]) || []),
    [matrix]
  )
  const selectedEnvironment = environments.find(
    (environment) => environment.slug === environmentSlug
  )
  const hasBranchErrors = configurationGroupHasBranchErrors(targetIds, branches)
  const urlPrefixError = group ? '' : configurationGroupUrlPrefixError(urlPrefix)
  const normalizedUrlPrefix = normalizeConfigurationGroupUrlPrefixInput(urlPrefix)
  const canonicalUrlPrefix = canonicalConfigurationGroupUrlPrefix(urlPrefix)

  useEffect(() => {
    const nextSlug = nextConfigurationGroupEnvironmentSlug(
      environmentSlug,
      environments,
      defaults.environmentSlug
    )
    if (nextSlug !== environmentSlug) setEnvironmentSlug(nextSlug)
  }, [defaults.environmentSlug, environmentSlug, environments])

  useEffect(() => {
    const nextSiteId = nextConfigurationGroupSiteBindingId(
      siteBindingId,
      siteBindings,
      defaults.siteBindingId
    )
    if (nextSiteId !== siteBindingId) setSiteBindingId(nextSiteId)
  }, [defaults.siteBindingId, siteBindingId, siteBindings])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => nameRef.current?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    let stopped = false
    if (!environmentSlug) {
      setMatrix(null)
      setBranches({})
      setLoading(false)
      return () => {
        stopped = true
      }
    }

    setLoading(true)
    setError('')
    setMatrix(null)
    setBranches({})
    void getMatrix(environmentSlug)
      .then((nextMatrix) => {
        if (!stopped) setMatrix(nextMatrix)
      })
      .catch((nextError) => {
        if (!stopped) {
          setMatrix(null)
          setError(apiErrorMessage(nextError))
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [environmentSlug])

  useEffect(() => {
    let stopped = false
    if (!matrix || !targetIds.length) {
      setBranches({})
      return () => {
        stopped = true
      }
    }

    setLoading(true)
    void Promise.all(
      targetIds.map(async (targetId) => {
        try {
          const catalog = await getBranches(targetId, environmentSlug)
          return [targetId, { ...catalog, error: '' }] as const
        } catch (nextError) {
          return [
            targetId,
            {
              items: [],
              remoteAvailable: false,
              error: apiErrorMessage(nextError),
            },
          ] as const
        }
      })
    )
      .then((catalogs) => {
        if (!stopped) setBranches(Object.fromEntries(catalogs))
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [environmentSlug, matrix, targetIds])

  async function retryBranches(targetId: string) {
    if (loading) return
    setLoading(true)
    setBranches((current) => ({
      ...current,
      [targetId]: { items: [], remoteAvailable: false, error: '' },
    }))
    try {
      const catalog = await getBranches(targetId, environmentSlug)
      setBranches((current) => ({
        ...current,
        [targetId]: { ...catalog, error: '' },
      }))
    } catch (nextError) {
      setBranches((current) => ({
        ...current,
        [targetId]: {
          items: [],
          remoteAvailable: false,
          error: apiErrorMessage(nextError),
        },
      }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSelections((current) => {
      const next: Record<string, string> = {}
      for (const targetId of targetIds) {
        if (Object.prototype.hasOwnProperty.call(current, targetId)) {
          next[targetId] = current[targetId] || ''
        } else {
          next[targetId] = ''
        }
      }
      return next
    })
  }, [targetIds])

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (shouldCloseConfigurationGroupEditor(event.key, saving)) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = focusableElements(dialogRef.current)
    if (!focusable.length) return
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const normalizedName = name.trim()
    if (!normalizedName) {
      setError('请填写配置组名称')
      return
    }
    if (urlPrefixError) {
      setError(urlPrefixError)
      return
    }
    if (!selectedEnvironment || selectedEnvironment.status === 'ARCHIVED') {
      setError('请选择可用环境')
      return
    }
    if (!selectedBinding?.enabled || !targetIds.length) {
      setError('请选择可用预览站点')
      return
    }
    if (targetIds.some((targetId) => !rowsById.has(targetId))) {
      setError('站点项目与当前环境不匹配，请刷新项目配置后重试')
      return
    }
    if (hasBranchErrors) {
      setError('部分项目的分支读取失败，请重试成功后再保存')
      return
    }

    setSaving(true)
    setError('')
    const input = {
      name: normalizedName,
      environmentSlug,
      siteBindingId,
      items: configurationGroupItemsFromSelections(targetIds, selections),
    }
    try {
      const saved = group
        ? await updateConfigurationGroup(group.token, {
            ...input,
            expectedRevision: group.revision,
          })
        : await createConfigurationGroup({
            ...input,
            ...(normalizedUrlPrefix ? { urlPrefix: normalizedUrlPrefix } : {}),
          })
      onSaved(saved)
    } catch (nextError) {
      setError(apiErrorMessage(nextError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="configuration-editor-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="configuration-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="configuration-editor-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="configuration-editor-header">
          <div className="configuration-editor-title">
            <Layers3 size={18} aria-hidden="true" />
            <div>
              <span>{group ? '编辑提测需求' : '新建提测需求'}</span>
              <h2 id="configuration-editor-title">{group?.name || '配置环境与项目版本'}</h2>
            </div>
          </div>
          <Button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            title="关闭配置组编辑"
          >
            <X size={17} />
          </Button>
        </header>

        <form className="configuration-editor-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="configuration-editor-context">
            <label className="field">
              <span>需求名称</span>
              <TextBox
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="例如：频道权限重构"
                autoComplete="off"
              />
            </label>
            {!group ? (
              <label className="field">
                <span>URL 前缀（可选）</span>
                <TextBox
                  value={urlPrefix}
                  onChange={(event) => setUrlPrefix(event.target.value.toLowerCase())}
                  maxLength={63}
                  placeholder="例如：party-week 或 中文需求"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(urlPrefixError)}
                  aria-describedby="configuration-group-url-prefix-hint"
                />
                <small
                  id="configuration-group-url-prefix-hint"
                  className={urlPrefixError ? 'field-error-hint' : undefined}
                  aria-live="polite"
                >
                  {urlPrefixError ||
                    (normalizedUrlPrefix
                      ? canonicalUrlPrefix === normalizedUrlPrefix
                        ? `https://${canonicalUrlPrefix}.${previewBaseDomain}`
                        : `显示地址：https://${normalizedUrlPrefix}.${previewBaseDomain} · 实际地址：https://${canonicalUrlPrefix}.${previewBaseDomain}`
                      : '留空时由系统生成不可猜测的独立地址')}
                </small>
              </label>
            ) : null}
            <label className="field">
              <span>环境</span>
              <ComboBox
                value={environmentSlug}
                onChange={(event) => setEnvironmentSlug(event.target.value)}
              >
                {environments.map((environment) => (
                  <option
                    key={environment.id}
                    value={environment.slug}
                    disabled={environment.status === 'ARCHIVED'}
                  >
                    {environment.name}
                    {environment.status === 'FROZEN' ? ' · 冻结' : ''}
                    {environment.status === 'ARCHIVED' ? ' · 归档' : ''}
                  </option>
                ))}
              </ComboBox>
            </label>
            <label className={`field ${group ? 'field-wide' : ''}`}>
              <span>预览站点</span>
              <ComboBox
                value={siteBindingId}
                onChange={(event) => setSiteBindingId(event.target.value)}
              >
                {siteBindings.map((binding) => (
                  <option key={binding.id} value={binding.id} disabled={!binding.enabled}>
                    {siteLabel(binding)}
                    {!binding.enabled ? ' · 已停用' : ''}
                  </option>
                ))}
              </ComboBox>
              <small>站点可以跨环境预览；这里只改变这条需求使用的后端环境。</small>
            </label>
          </div>

          <section className="configuration-editor-projects" aria-label="项目版本">
            <div className="configuration-editor-project-heading">
              <div>
                <strong>项目版本</strong>
                <span>未选择分支时跟随 KOOK 官方版本</span>
              </div>
              {loading ? (
                <LoaderCircle className="spin" size={16} aria-label="正在读取项目分支" />
              ) : null}
            </div>

            {!targetIds.length ? (
              <div className="configuration-editor-state">当前站点没有可配置项目</div>
            ) : (
              <div className="configuration-editor-project-list">
                {targetIds.map((targetId) => {
                  const row = rowsById.get(targetId)
                  const branchState = branches[targetId] || {
                    items: [],
                    remoteAvailable: false,
                    error: '',
                  }
                  return (
                    <div className="configuration-editor-project" key={targetId}>
                      <div className="configuration-editor-project-name">
                        <strong>{row?.target.name || targetId}</strong>
                        <span>{row?.target.kind === 'remote' ? '热更模块' : '页面项目'}</span>
                      </div>
                      {branchState.error ? (
                        <div className="configuration-editor-branch-error" role="alert">
                          <div>
                            <CircleAlert size={14} />
                            <span>
                              分支读取失败：{branchState.error}
                              {selections[targetId]
                                ? `；已保留 ${selections[targetId]}，重试成功后方可保存`
                                : '；重试成功后方可保存'}
                            </span>
                          </div>
                          <Button
                            type="button"
                            onClick={() => void retryBranches(targetId)}
                            disabled={loading}
                          >
                            重试
                          </Button>
                        </div>
                      ) : row ? (
                        <BranchPicker
                          targetId={`configuration-${targetId}`}
                          targetName={row.target.name}
                          items={branchState.items}
                          queueItems={queueItems.filter(
                            (item) =>
                              item.environmentSlug === environmentSlug && item.targetId === targetId
                          )}
                          selectedBranch={selections[targetId] || ''}
                          fallbackBranch={row.target.defaultBranch}
                          officialLabel={officialLabel(row)}
                          onChange={(branch) =>
                            setSelections((current) => ({ ...current, [targetId]: branch }))
                          }
                        />
                      ) : (
                        <span className="configuration-editor-unavailable">项目配置不可用</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {error ? (
            <div className="configuration-editor-error" role="alert">
              <CircleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          <footer className="configuration-editor-actions">
            <Button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button
              type="submit"
              className="primary-button"
              disabled={
                saving ||
                loading ||
                hasBranchErrors ||
                Boolean(urlPrefixError) ||
                !enabledEnvironments.length ||
                !enabledSites.length
              }
              title={hasBranchErrors ? '请先重试读取失败的项目分支' : undefined}
            >
              {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              {saving ? '正在保存' : group ? '保存修改' : '创建并保存'}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  )
}
