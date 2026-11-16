module.exports = {
  name: 'bifrost',
  description: 'Bifrost PC 原地热更、需求配置与打包嘟嘟构建队列',
  version: '0.2.0',
  icon: '🌉',
  permissions: ['network', 'storage'],
  panel: null,
  frame: null,
  context: null,
  messageHandler: null,
  resizeCleanup: null,
  controlOrigin: 'https://bifrost.vanillacake.cn',
  configKey: 'bifrost.pc.in-place-preview.v1',
  channel: 'bifrost:pc-plugin:v1',

  onActivate(context) {
    this.context = context
    this.ensureMessageBridge()
  },

  onExecute(context) {
    this.context = context || this.context
    this.openPanel()
  },

  onDeactivate() {
    this.closePanel()
    if (this.messageHandler) window.removeEventListener('message', this.messageHandler)
    this.messageHandler = null
    this.context = null
    localStorage.removeItem(this.configKey)
  },

  ensureMessageBridge() {
    if (this.messageHandler) return
    this.messageHandler = (event) => {
      if (
        event.origin !== this.controlOrigin ||
        event.source !== this.frame?.contentWindow ||
        event.data?.channel !== this.channel
      ) {
        return
      }
      if (event.data.type === 'ready') {
        this.sendContext()
        return
      }
      if (typeof event.data.requestId !== 'string') return
      void this.handleFrameRequest(event.data)
    }
    window.addEventListener('message', this.messageHandler)
  },

  readActive() {
    try {
      const active = JSON.parse(localStorage.getItem(this.configKey) || 'null')
      if (!active || Date.parse(active.preview?.expiresAt || '') <= Date.now()) {
        localStorage.removeItem(this.configKey)
        return null
      }
      return active
    } catch {
      localStorage.removeItem(this.configKey)
      return null
    }
  },

  currentAppOrigin() {
    const configOrigin = window.Kaiheila?.config?.appServer
    let backupOrigin = ''
    try {
      const raw = localStorage.getItem('kaiheila_backup_domain')
      const backup = raw ? JSON.parse(raw) : null
      backupOrigin = backup?.api_url || ''
    } catch {
      backupOrigin = ''
    }
    for (const candidate of [configOrigin, backupOrigin]) {
      try {
        const url = new URL(candidate)
        if (['http:', 'https:'].includes(url.protocol)) return url.origin
      } catch {
        // Try the next environment source.
      }
    }
    return ''
  },

  currentLogicalUrl() {
    const origin = this.currentAppOrigin()
    if (!origin) return ''
    const pathname = /^https?:$/.test(window.location.protocol) ? window.location.pathname : '/'
    return new URL(pathname || '/', `${origin}/`).href
  },

  sendContext() {
    this.frame?.contentWindow?.postMessage(
      {
        channel: this.channel,
        type: 'context',
        context: {
          title: document.title || 'KOOK PC 客户端',
          url: this.currentLogicalUrl(),
          active: this.readActive(),
        },
      },
      this.controlOrigin
    )
  },

  respond(requestId, ok, result, message) {
    this.frame?.contentWindow?.postMessage(
      {
        channel: this.channel,
        type: 'response',
        requestId,
        ok,
        ...(ok ? { result } : { message }),
      },
      this.controlOrigin
    )
  },

  validateActive(active) {
    if (
      !active ||
      active.mode !== 'remote' ||
      active.preview?.siteArtifactId ||
      !Array.isArray(active.preview?.selections) ||
      !active.preview.selections.length ||
      Date.parse(active.preview?.expiresAt || '') <= Date.now()
    ) {
      throw new Error('Bifrost Preview 无效或已经过期')
    }
    if (new URL(active.officialOrigin).origin !== this.currentAppOrigin()) {
      throw new Error('所选环境与当前 KOOK PC 环境不一致')
    }
    return active
  },

  async handleFrameRequest(message) {
    try {
      if (message.type === 'apply') {
        const active = this.validateActive(message.active)
        localStorage.setItem(this.configKey, JSON.stringify(active))
        this.respond(message.requestId, true, { active })
        this.context?.showToast?.('热更配置已保存，正在刷新 KOOK')
        window.setTimeout(() => window.location.reload(), 120)
        return
      }
      if (message.type === 'remove') {
        localStorage.removeItem(this.configKey)
        this.respond(message.requestId, true, { active: null })
        this.context?.showToast?.('已恢复官方热更，正在刷新 KOOK')
        window.setTimeout(() => window.location.reload(), 120)
        return
      }
      throw new Error('PC 客户端只支持原地应用，不支持页面跳转')
    } catch (error) {
      this.respond(
        message.requestId,
        false,
        null,
        error instanceof Error ? error.message : String(error)
      )
    }
  },

  openPanel() {
    this.ensureMessageBridge()
    if (this.panel) {
      this.frame?.focus()
      return
    }
    const overlay = document.createElement('div')
    overlay.id = 'bifrost-pc-panel'
    overlay.style.cssText = [
      'position:fixed',
      'top:0',
      'right:0',
      'bottom:0',
      'width:min(520px,100vw)',
      'max-width:100vw',
      'z-index:100060',
      'display:flex',
      'font-family:Whitney,"PingFang SC",system-ui,sans-serif',
    ].join(';')
    overlay.innerHTML = `
      <div id="bifrost-pc-resize" role="separator" tabindex="0" aria-label="调整 Bifrost 侧栏宽度" aria-orientation="vertical" style="position:absolute;inset:0 auto 0 -4px;width:8px;cursor:ew-resize;touch-action:none;z-index:1;"></div>
      <section role="complementary" aria-labelledby="bifrost-pc-title" style="width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid rgba(255,255,255,.12);background:#252629;box-shadow:-8px 0 32px rgba(0,0,0,.24);">
        <header style="height:44px;flex:0 0 44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 8px 0 14px;border-bottom:1px solid rgba(255,255,255,.08);color:#fff;">
          <div style="min-width:0;display:flex;align-items:baseline;gap:8px;">
            <strong id="bifrost-pc-title" style="font-size:14px;font-weight:650;">Bifrost</strong>
            <span style="font-size:11px;color:#9aa09c;">PC 原地热更</span>
          </div>
          <button id="bifrost-pc-close" type="button" aria-label="关闭 Bifrost" style="width:32px;height:32px;border:0;border-radius:8px;background:rgba(255,255,255,.07);color:#dfe3df;font-size:20px;line-height:1;cursor:pointer;">×</button>
        </header>
        <iframe id="bifrost-pc-frame" title="Bifrost PC 原地热更" src="${this.controlOrigin}/pc-plugin/" allow="clipboard-write" style="width:100%;min-height:0;flex:1;border:0;background:#fbfcfa;"></iframe>
      </section>`
    document.body.appendChild(overlay)
    this.panel = overlay
    this.frame = overlay.querySelector('#bifrost-pc-frame')
    overlay.querySelector('#bifrost-pc-close').onclick = () => this.closePanel()
    const handle = overlay.querySelector('#bifrost-pc-resize')
    const setWidth = (width) => {
      const next = Math.min(window.innerWidth, Math.max(320, Math.min(860, width)))
      overlay.style.width = `${next}px`
      handle.setAttribute('aria-valuenow', String(Math.round(next)))
      return next
    }
    const rememberWidth = () => {
      try {
        localStorage.setItem(
          'bifrost.pc.panel-width.v1',
          String(overlay.getBoundingClientRect().width)
        )
      } catch {}
    }
    let savedWidth = 520
    try {
      savedWidth = Number(localStorage.getItem('bifrost.pc.panel-width.v1')) || 520
    } catch {}
    setWidth(savedWidth)
    const stopResize = () => {
      this.frame && (this.frame.style.pointerEvents = '')
      window.removeEventListener('pointermove', moveResize)
      window.removeEventListener('pointerup', endResize)
      window.removeEventListener('pointercancel', endResize)
    }
    const moveResize = (event) => setWidth(window.innerWidth - event.clientX)
    const endResize = () => {
      stopResize()
      rememberWidth()
    }
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      this.frame.style.pointerEvents = 'none'
      window.addEventListener('pointermove', moveResize)
      window.addEventListener('pointerup', endResize)
      window.addEventListener('pointercancel', endResize)
    }
    handle.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = overlay.getBoundingClientRect().width
      setWidth(
        event.key === 'Home'
          ? 320
          : event.key === 'End'
            ? 860
            : current + (event.key === 'ArrowLeft' ? 24 : -24)
      )
      rememberWidth()
    }
    handle.setAttribute('aria-valuemin', '320')
    handle.setAttribute('aria-valuemax', '860')
    this.resizeCleanup = stopResize
  },

  closePanel() {
    this.resizeCleanup?.()
    this.resizeCleanup = null
    this.panel?.remove()
    this.panel = null
    this.frame = null
  },
}
