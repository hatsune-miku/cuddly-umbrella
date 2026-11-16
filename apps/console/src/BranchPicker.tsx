import { Button, Dialog, TextBox } from './ui'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BranchCatalogItem, BuildQueueItem } from '@cuddly/contracts'
import { PRODUCT_NAME } from '@cuddly/product'
import { Check, ChevronDown, GitBranch, Search, X } from 'lucide-react'

import {
  branchOptionStatus,
  createBranchPickerOptions,
  filterBranchPickerOptions,
  type BranchPickerOption,
} from './branch-picker'

function formatTime(value: string | null | undefined): string {
  if (!value) return '无可用产物'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function connectedOptions(optionRefs: Array<HTMLButtonElement | null>): HTMLButtonElement[] {
  return optionRefs.filter((option): option is HTMLButtonElement => Boolean(option?.isConnected))
}

function focusOption(optionRefs: Array<HTMLButtonElement | null>, index: number): void {
  const options = connectedOptions(optionRefs)
  if (!options.length) return
  const normalized = (index + options.length) % options.length
  for (const option of options) option.tabIndex = -1
  const target = options[normalized]
  if (!target) return
  target.tabIndex = 0
  target.focus()
}

export function BranchPicker({
  targetId,
  targetName,
  items,
  queueItems,
  selectedBranch,
  fallbackBranch,
  officialLabel,
  onChange,
}: {
  targetId: string
  targetName: string
  items: BranchCatalogItem[]
  queueItems: BuildQueueItem[]
  selectedBranch: string
  fallbackBranch: string
  officialLabel?: string
  onChange: (branch: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const options = useMemo(
    () =>
      createBranchPickerOptions({
        items,
        queueItems,
        targetId,
        selectedBranch,
        fallbackBranch,
      }),
    [fallbackBranch, items, queueItems, selectedBranch, targetId]
  )
  const filtered = useMemo(() => filterBranchPickerOptions(options, query), [options, query])
  const selected = options.find((item) => item.branch === selectedBranch) || null
  const selectedStatus = selected ? branchOptionStatus(selected) : null
  const selectedStatusText =
    !selectedBranch && officialLabel
      ? '官方'
      : selectedStatus?.tone === 'failed' && selected?.latestArtifact
        ? '上次打包失败 · 已有可用包'
        : selectedStatus?.tone === 'success' && selected?.latestArtifact
          ? `已有可用包 · 上次打包 ${formatTime(selected.latestArtifact.builtAt)}`
          : selectedStatus?.text || '尚未打包'

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  function close(): void {
    setOpen(false)
    setQuery('')
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function choose(branch: string): void {
    onChange(branch)
    close()
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const options = connectedOptions(optionRefs.current)
    const index = options.indexOf(event.currentTarget)
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(optionRefs.current, index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(optionRefs.current, index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(optionRefs.current, 0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(optionRefs.current, connectedOptions(optionRefs.current).length - 1)
    }
  }

  const renderedOptions: Array<BranchPickerOption | null> = [
    ...(officialLabel ? [null] : []),
    ...filtered.items,
  ]
  const selectedOptionIndex = Math.max(
    0,
    renderedOptions.findIndex((option) =>
      option ? option.branch === selectedBranch : selectedBranch === ''
    )
  )

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        className="branch-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <GitBranch size={14} />
        <span className="branch-picker-trigger-copy">
          <strong title={selectedBranch || officialLabel}>
            {selectedBranch || officialLabel || fallbackBranch}
          </strong>
          <small className={selectedStatus ? `tone-${selectedStatus.tone}` : ''}>
            {selectedStatusText}
          </small>
        </span>
        <ChevronDown size={14} />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={`选择分支 · ${targetName}`}
        closeLabel="关闭分支选择"
        initialFocus={searchRef}
        className="branch-picker-dialog"
      >
        <label className="branch-picker-search">
          <Search size={15} />
          <span className="sr-only">搜索分支</span>
          <TextBox
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusOption(optionRefs.current, 0)
              }
            }}
            placeholder="搜索分支名称"
            autoComplete="off"
          />
          {query ? (
            <Button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
              <X size={14} />
            </Button>
          ) : null}
        </label>

        <div className="branch-picker-options" role="listbox" aria-label={`${targetName} 分支`}>
          {renderedOptions.map((option, index) => {
            if (!option) {
              const selectedOfficial = selectedBranch === ''
              return (
                <Button
                  key="official"
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  type="button"
                  role="option"
                  tabIndex={index === selectedOptionIndex ? 0 : -1}
                  aria-selected={selectedOfficial}
                  className={`branch-picker-option official-option ${selectedOfficial ? 'selected' : ''}`}
                  onClick={() => choose('')}
                  onKeyDown={handleOptionKeyDown}
                >
                  <span className="branch-option-main">
                    <strong>{officialLabel}</strong>
                    <small>不使用 {PRODUCT_NAME} 打包产物</small>
                  </span>
                  <span className="branch-option-status tone-idle">官方</span>
                  {selectedOfficial ? <Check size={16} /> : null}
                </Button>
              )
            }
            const status = branchOptionStatus(option)
            const isSelected = option.branch === selectedBranch
            return (
              <Button
                key={option.branch}
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                type="button"
                role="option"
                tabIndex={index === selectedOptionIndex ? 0 : -1}
                aria-selected={isSelected}
                className={`branch-picker-option ${isSelected ? 'selected' : ''}`}
                onClick={() => choose(option.branch)}
                onKeyDown={handleOptionKeyDown}
              >
                <span className="branch-option-main">
                  <strong title={option.branch}>{option.branch}</strong>
                  <small>上次打包 {formatTime(option.latestArtifact?.builtAt)}</small>
                </span>
                <span className={`branch-option-status tone-${status.tone}`}>{status.text}</span>
                {isSelected ? <Check size={16} /> : null}
              </Button>
            )
          })}
          {filtered.total === 0 ? (
            <div className="branch-picker-empty">没有匹配“{query.trim()}”的分支</div>
          ) : null}
        </div>

        <footer className="branch-picker-footer">
          <span>共 {filtered.total} 个匹配分支</span>
          {filtered.truncated ? <strong>仅显示前 100 条，请继续输入以缩小范围</strong> : null}
        </footer>
      </Dialog>
    </>
  )
}
