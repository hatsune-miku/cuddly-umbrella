function observeAllImageSrcChanges(callback) {
  const observedImages = new WeakSet()

  // ========== 1. Hook src 属性的 setter ==========
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  const originalSrcSetter = srcDescriptor.set
  const originalSrcGetter = srcDescriptor.get

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get: originalSrcGetter,
    set(value) {
      const oldValue = originalSrcGetter.call(this)
      originalSrcSetter.call(this, value)
      const newValue = originalSrcGetter.call(this) // 获取规范化后的 URL
      if (newValue !== oldValue) {
        callback(this, newValue, oldValue)
      }
    },
    configurable: true,
    enumerable: true,
  })

  // ========== 2. Hook setAttribute ==========
  const originalSetAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    if (this.nodeName === 'IMG' && name.toLowerCase() === 'src') {
      const oldValue = this.getAttribute('src')
      originalSetAttribute.call(this, name, value)
      const newValue = this.src // 规范化后的 URL
      if (newValue !== oldValue) {
        callback(this, newValue, oldValue)
      }
    } else {
      originalSetAttribute.call(this, name, value)
    }
  }

  // ========== 3. 监听新 img 元素（处理带 src 的 HTML 插入）==========
  function processNewImage(img) {
    if (observedImages.has(img)) return
    observedImages.add(img)

    // 对于通过 innerHTML 等方式插入的带 src 的 img
    if (img.src) {
      callback(img, img.src, null)
    }
  }

  function processNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return

    if (node.nodeName === 'IMG') {
      processNewImage(node)
    }
    node.querySelectorAll?.('img').forEach(processNewImage)

    // 处理 Shadow DOM
    if (node.shadowRoot) {
      observeShadowRoot(node.shadowRoot)
    }
  }

  // ========== 4. 监听 Shadow DOM ==========
  function observeShadowRoot(shadowRoot) {
    shadowRoot.querySelectorAll('img').forEach(processNewImage)

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          processNode(node)
        }
      }
    })

    observer.observe(shadowRoot, { childList: true, subtree: true })
  }

  // Hook attachShadow 以捕获新的 Shadow DOM
  const originalAttachShadow = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (options) {
    const shadowRoot = originalAttachShadow.call(this, options)
    observeShadowRoot(shadowRoot)
    return shadowRoot
  }

  // ========== 5. DOM 变化监听（兜底 innerHTML 等场景）==========
  const domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        processNode(node)
      }
    }
  })

  // ========== 6. 初始化：处理已存在的元素 ==========
  document.querySelectorAll('img').forEach(processNewImage)

  // 处理已存在的 Shadow DOM
  document.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) {
      observeShadowRoot(el.shadowRoot)
    }
  })

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })

  // ========== 7. 返回清理函数 ==========
  return function cleanup() {
    domObserver.disconnect()
    Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor)
    Element.prototype.setAttribute = originalSetAttribute
    Element.prototype.attachShadow = originalAttachShadow
  }
}

function deflate(data) {
  return data
}

function filterUrl(s, isDeflate = false) {
  if (typeof s !== 'string') {
    return s
  }
  const map = {
    'static.kookapp.cn': 'bifrost-api.vanillacake.cn/static',
    'img.kookapp.cn': 'bifrost-api.vanillacake.cn/assets',
    'img.kaiheila.cn': 'bifrost-api.vanillacake.cn/kaiheila-assets',
    'static.kaiheila.cn': 'bifrost-api.vanillacake.cn/kaiheila-static',
  }
  const keys = Object.keys(map)
  return keys.reduce((acc, key) => acc.replaceAll(key, isDeflate ? map[key].replaceAll('/', '\\\\\\/') : map[key]), s)
}

function reverseFilterUrl(s) {
  if (!(typeof s === 'string')) {
    return s
  }
  return s
    .replaceAll('bifrost-api.vanillacake.cn/static', 'static.kookapp.cn')
    .replaceAll('bifrost-api.vanillacake.cn/assets', 'img.kookapp.cn')
    .replaceAll('bifrost-api.vanillacake.cn/kaiheila-assets', 'img.kaiheila.cn')
    .replaceAll('bifrost-api.vanillacake.cn/kaiheila-static', 'static.kaiheila.cn')
}

function scanAndFilterImages() {
  document.querySelectorAll('img').forEach((img) => {
    const filteredSrc = filterUrl(img.src)
    if (filteredSrc !== img.src) {
      img.src = filteredSrc
    }
  })
}

function injectImages() {
  if (window._kInjectImages) {
    return
  }
  const OriginalImageClass = window.Image
  const newImage = function (...args) {
    const img = new OriginalImageClass(...args)
    img.src = filterUrl(img.src)
    return img
  }
  window.Image = newImage
  scanAndFilterImages()
  window._kInjectImages = true
}

function injectTraceAnalytics() {
  if (window._kInjectTraceAnalytics) {
    return
  }
  const blockedPatterns = ['experience.kookapp.com.cn', 'log.kookapp.cn']
  const preprocessorsMap = {
    '/api/v3/message/create': messageCreatePreprocessor,
  }

  function messageCreatePreprocessor(payload) {
    const body = JSON.parse(payload.init.body)
    payload.init.body = JSON.stringify({
      ...body,
      content: reverseFilterUrl(body.content),
    })
  }

  const originalFetch = window.fetch
  const newFetch = (input, init) => {
    const payload = { input, init }

    if (typeof input === 'string') {
      if (blockedPatterns.some((pattern) => input.includes(pattern))) {
        return Promise.resolve(null)
      }
      const keys = Object.keys(preprocessorsMap)
      for (const key of keys) {
        if (input.includes(key)) {
          try {
            preprocessorsMap[key](payload)
          } catch {
            // ignored
          }
        }
      }
    }
    return originalFetch(payload.input, payload.init)
  }

  window.fetch = newFetch
  window._kInjectTraceAnalytics = true
}

function injectRawWebSocket() {
  if (window._kInjectRawWebSocket) {
    return
  }
  window._kInjectRawWebSocket = true
  console.log('xx', '[IMSOCKET::RAW] injecting raw WebSocket')
  try {
    const OriginalWebSocket = window.WebSocket
    const NewWebSocket = function (...args) {
      const socket = new OriginalWebSocket(...args)
      console.log('xx', '[IMSOCKET::RAW] creating WebSocket', socket)

      const proxiedSocket = new Proxy(socket, {
        get(target, prop) {
          if (prop in target) {
            const value = target[prop]
            return typeof value === 'function' ? value.bind(target) : value
          }
          return undefined
        },
        set(target, property, value) {
          if (property === 'onmessage') {
            const originalListener = value
            value = (event) => {
              if (typeof event?.data === 'string') {
                event.data = filterUrl(event.data)
              } else if (event?.type === 'message') {
                let decoded = pako.inflate(event.data, { to: 'string' })
                decoded = filterUrl(decoded, true)
                console.log('xx', '[PakoInflate] filtered message data', decoded)
                event.data = decoded
              }
              return originalListener(event)
            }
          }
          target[property] = value
          return true
        },
      })
      return proxiedSocket

      // const originalAddEventListener = socket.addEventListener.bind(socket)
      // socket.addEventListener = (type, listener) => {
      //   console.log('xx', '[IMSOCKET::RAW] adding event listener', type, listener)

      //   try {
      //     if (type === 'message') {
      //       const originalListener = listener
      //       listener = (event) => {
      //         console.log('xx', '[IMSOCKET::RAW] message event', event)
      //         return originalListener(event)
      //       }
      //     }
      //     originalAddEventListener(type, listener)
      //   } catch (e) {
      //     console.log('xx', '[IMSOCKET::RAW] error adding event listener', e)
      //     throw e
      //   }
      // }
      // return socket
    }
    window.WebSocket = NewWebSocket
    console.log('xx', '[IMSOCKET::RAW] WebSocket injected')
  } catch (e) {
    console.log('xx', '[IMSOCKET::RAW] error acquiring WebSocket', e)
  }
}

function injectIMSocket() {
  if (window._kInjectIMSocket) {
    return
  }
  window._kInjectIMSocket = true

  const hookProc = () => {
    console.log('xx', '[IMSOCKET] kaiheiSocket acquired')

    console.log('xx', '[IMSOCKET] hooking kaiheiSocket.messageHandler')
    try {
      const originalMessageHandler = window.kaiheiSocket.messageHandler
      window.kaiheiSocket.messageHandler = {
        ...originalMessageHandler,
        onReceive: (msg) => {
          console.log('xx', '[IMSOCKET] onReceive', msg)
          if (!msg) {
            return originalMessageHandler.onReceive(msg)
          }
          if (typeof msg.content === 'object') {
            const messageContent = msg.content
            msg.content = filterUrl(messageContent)
            return originalMessageHandler.onReceive(msg)
          }

          try {
            const messageContent = JSON.parse(msg.content)
            const messageContentFiltered = filterUrl(messageContent)
            msg.content = JSON.stringify(messageContentFiltered)
            return originalMessageHandler.onReceive(msg)
          } catch {
            return originalMessageHandler.onReceive(msg)
          }
        },
      }
      console.log('xx', '[IMSOCKET] kaiheiSocket.messageHandler hooked')
    } catch (e) {
      console.log('xx', '[IMSOCKET] error acquiring kaiheiSocket.messageHandler', e)
    }

    console.log('xx', '[IMSOCKET] hooking kaiheiSocket.session')
    try {
      const originalEmit = window.kaiheiSocket.session.safeEmit.bind(window.kaiheiSocket.session)
      window.kaiheiSocket.session.safeEmit = (...args) => {
        try {
          const [kind, options] = args
          if (kind !== 'message') {
            return originalEmit(...args)
          }
          if (typeof options.d?.content === 'string') {
            options.d.content = filterUrl(options.d.content)
          }
          return originalEmit(...args)
        } catch (e) {
          console.log('xx', '[IMSOCKET] error filtering message content', args, e)
        }
      }
      console.log('xx', '[IMSOCKET] kaiheiSocket.session hooked')
    } catch (e) {
      console.log('xx', '[IMSOCKET] error hooking kaiheiSocket.session', e)
    }
  }

  const promise = new Promise((resolve) => {
    const interval = setInterval(() => {
      if (window.kaiheiSocket?.session?.safeEmit) {
        clearInterval(interval)
        setTimeout(() => {
          resolve()
        }, 1000)
      }
    }, 500)
  })
  promise.then(hookProc)
  promise.catch((err) => {
    console.error('[IMSOCKET] error', err)
  })
}

function filterIframeSrc(src) {
  if (typeof src !== 'string') return src
  const prefix = 'https://m.kookapp.cn'
  if (src.startsWith(prefix)) {
    return 'https://m.dev.chuanyuapp.com' + src.slice(prefix.length)
  }
  const prefixNoProto = 'http://m.kookapp.cn'
  if (src.startsWith(prefixNoProto)) {
    return 'http://m.dev.chuanyuapp.com' + src.slice(prefixNoProto.length)
  }
  return src
}

function processIframe(iframe) {
  if (!iframe || !iframe.src) return
  const filtered = filterIframeSrc(iframe.src)
  if (filtered !== iframe.src) {
    iframe.src = filtered
  }
}

function installIframeObserver() {
  if (window._kInstallIframeObserver) {
    return
  }
  window._kInstallIframeObserver = true

  // Process existing iframes
  document.querySelectorAll('iframe').forEach(processIframe)

  // Hook iframe src setter
  const iframeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')
  if (iframeSrcDescriptor) {
    const originalIframeSrcSetter = iframeSrcDescriptor.set
    const originalIframeSrcGetter = iframeSrcDescriptor.get

    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      get: originalIframeSrcGetter,
      set(value) {
        originalIframeSrcSetter.call(this, filterIframeSrc(value))
      },
      configurable: true,
      enumerable: true,
    })
  }

  // Observe new iframes added to DOM
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        if (node.nodeName === 'IFRAME') {
          processIframe(node)
        }
        node.querySelectorAll?.('iframe').forEach(processIframe)
      }
    }
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

function installMutateObserver() {
  if (window._kInstallMutateObserver2) {
    return
  }
  window._kInstallMutateObserver2 = true
  observeAllImageSrcChanges((img, newSrc, oldSrc) => {
    if (!img) {
      return
    }
    img.src = filterUrl(newSrc)
  })
}

function main() {
  console.log('[BifrostApi] k-inject online')
  console.log('xx', '[BifrostApi] requirement met=', window._useConsole === undefined)
  // injectRawWebSocket()
  injectTraceAnalytics()
  injectIMSocket()

  document.addEventListener('DOMContentLoaded', () => {
    injectImages()
    installMutateObserver()
    installIframeObserver()
  })

  injectImages()
  installMutateObserver()
  installIframeObserver()
}

main()
