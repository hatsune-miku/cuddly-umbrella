module.exports = {
  name: 'example-plugin',
  description: '示例插件 - 展示如何开发 KOOK 插件的最佳实践',
  version: '1.0.0',
  icon: '👋',
  author: 'Your Name',

  async onActivate(context) {
    console.log('[示例插件] 插件已激活')
  },

  showExamplePanel(context) {
    try {
      this.createExamplePanel(context)
    } catch (e) {
      console.error('[示例插件] 创建面板失败:', e)
    }
  },

  createExamplePanel(context) {
    try {
      const existingPanel = document.getElementById('example-panel')
      if (existingPanel) {
        existingPanel.remove()
      }

      const panel = document.createElement('div')
      panel.id = 'example-panel'
      panel.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 480px;
        max-width: calc(100vw - 32px);
        max-height: min(80vh, 720px);
        background: #252629;
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        z-index: 100000;
        border: 1px solid rgba(122, 204, 53, 0.5);
        font-family: Whitney, Helvetica Neue, Helvetica, Arial, sans-serif;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      `

      panel.innerHTML = `
        <div style="display: flex; flex-direction: column; min-height: 0; height: 100%;">
          <div id="example-header" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 24px 24px 0; cursor: move; user-select: none;">
            <h2 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 12px;">
              👋 示例插件
            </h2>
            <button id="close-example-panel" class="example-btn" style="width: 36px; height: 36px; min-width: 36px; padding: 0; background: rgba(255,255,255,0.08); color: #ffffff; border: none; border-radius: 8px; font-size: 20px; line-height: 1; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center;">
              ×
            </button>
          </div>

          <div class="env-scrollable" style="padding: 20px 24px 24px; overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; box-sizing: border-box;">
            <div style="background: rgba(122, 204, 53, 0.1); padding: 16px; border-radius: 12px; margin-bottom: 20px; border-left: 4px solid #7acc35;">
              <div style="color: #ffffff; font-size: 14px; font-weight: 600; margin-bottom: 8px;">说明</div>
              <div style="color: #cccccc; font-size: 13px; line-height: 1.6;">
                这是插件面板的示例。你可以在这里放置任何自定义内容。
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 12px;">
              <button id="example-action-1" class="example-btn" style="padding: 14px 20px; background: rgba(255,255,255,0.08); color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;">
                👋 打个招呼
              </button>

              <button id="example-action-2" class="example-btn" style="padding: 14px 20px; background: rgba(255,255,255,0.08); color: #ffffff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;">
                ℹ️ 插件信息
              </button>
            </div>

            <div id="example-output" style="margin-top: 20px; background: #17181a; padding: 16px; border-radius: 8px; display: none;">
              <div style="color: #ffffff; font-size: 14px; font-weight: 600; margin-bottom: 8px;">输出</div>
              <pre id="example-output-content" style="color: #7ec699; font-size: 13px; font-family: monospace; white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 200px; overflow-y: auto;"></pre>
            </div>
          </div>
        </div>
      `

      document.body.appendChild(panel)

      const buttons = panel.querySelectorAll('.example-btn')
      buttons.forEach(btn => {
        btn.addEventListener('mouseover', () => {
          btn.style.transform = 'translateY(-2px)'
          btn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)'
        })
        btn.addEventListener('mouseout', () => {
          btn.style.transform = 'translateY(0)'
          btn.style.boxShadow = 'none'
        })
      })

      document.getElementById('close-example-panel').onclick = () => panel.remove()

      document.getElementById('example-action-1').onclick = () => this.handleHelloAction()
      document.getElementById('example-action-2').onclick = () => this.handleInfoAction()

      this.makePanelDraggable(panel)
    } catch (e) {
      console.error('[示例插件] createExamplePanel 错误:', e)
    }
  },

  makePanelDraggable(panel) {
    const header = panel.querySelector('#example-header')
    if (!header) return

    let isDragging = false
    let offsetX = 0
    let offsetY = 0

    const handleMouseMove = (e) => {
      if (!isDragging) return

      const maxLeft = Math.max(16, window.innerWidth - panel.offsetWidth - 16)
      const maxTop = Math.max(16, window.innerHeight - panel.offsetHeight - 16)
      const nextLeft = Math.min(Math.max(16, e.clientX - offsetX), maxLeft)
      const nextTop = Math.min(Math.max(16, e.clientY - offsetY), maxTop)

      panel.style.left = `${nextLeft}px`
      panel.style.top = `${nextTop}px`
      panel.style.transform = 'none'
    }

    const handleMouseUp = () => {
      if (!isDragging) return

      isDragging = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest('button')) return

      e.preventDefault()

      const rect = panel.getBoundingClientRect()
      isDragging = true
      offsetX = e.clientX - rect.left
      offsetY = e.clientY - rect.top

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    })
  },

  handleHelloAction() {
    console.log('[示例插件] 执行打招呼操作')

    const outputDiv = document.getElementById('example-output')
    const outputContent = document.getElementById('example-output-content')

    if (outputDiv && outputContent) {
      outputDiv.style.display = 'block'
      outputContent.textContent = '你好！这是来自示例插件的消息。\n\n你可以通过点击按钮来执行各种操作。'
    }
  },

  handleInfoAction() {
    console.log('[示例插件] 执行插件信息操作')

    const outputDiv = document.getElementById('example-output')
    const outputContent = document.getElementById('example-output-content')

    if (outputDiv && outputContent) {
      outputDiv.style.display = 'block'
      outputContent.textContent = '示例插件 v1.0.0\n作者: Your Name\n\n这是一个演示如何开发 KOOK 插件的示例。'
    }
  },

  async onExecute(context) {
    console.log('[示例插件] 执行')
    this.showExamplePanel(context)
  },

  async onDeactivate() {
    try {
      const panel = document.getElementById('example-panel')
      if (panel) {
        panel.remove()
      }
    } catch (e) {
      console.error('[示例插件] 停用插件错误:', e)
    }
    console.log('[示例插件] 插件已停用')
  }
}
