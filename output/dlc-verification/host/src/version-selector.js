const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { renderSelectorPage } = require('./version-selector-page')

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const CONNECTION_CLOSE_GRACE_MS = 1_000

function findEdgeInRegistry(options = {}) {
  const queryRegistry = options.queryRegistry || execFileSync
  const registryKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe'
  ]

  for (const key of registryKeys) {
    try {
      const output = queryRegistry('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        windowsHide: true
      })
      const match = String(output).match(/REG_SZ\s+([^\r\n]+)/i)
      if (match) {
        return match[1].trim().replace(/^"|"$/g, '')
      }
    } catch {}
  }
  return null
}

function findEdgeExecutable(options = {}) {
  const fsModule = options.fsModule || fs
  const env = options.env || process.env
  const candidates = options.edgeCandidates || [
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean)

  const standardPath = candidates.find(candidate => fsModule.existsSync(candidate))
  if (standardPath) return standardPath

  const registryPath = findEdgeInRegistry(options)
  return registryPath && fsModule.existsSync(registryPath) ? registryPath : null
}

function openSelectorWindow(url, options = {}) {
  const spawnProcess = options.spawn || spawn
  const edgePath = options.edgePath === undefined
    ? findEdgeExecutable(options)
    : options.edgePath
  const command = edgePath || 'rundll32.exe'
  const args = edgePath
    ? [`--app=${url}`, '--window-size=736,620', '--no-first-run']
    : ['url.dll,FileProtocolHandler', url]
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  return { mode: edgePath ? 'edge-app' : 'default-browser', command, args, child }
}

function sendResponse(response, statusCode, body = '', headers = {}) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  })
  response.end(body)
}

function readJsonBody(request, maxBytes = 8_192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0

    request.on('data', chunk => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

async function selectInstallation(installations, options = {}) {
  const usableInstallations = installations.filter(installation => installation.isUsable)
  if (usableInstallations.length === 0) {
    return null
  }

  const randomBytes = options.randomBytes || crypto.randomBytes
  const token = randomBytes(24).toString('hex')
  const nonce = randomBytes(18).toString('base64')
  const route = `/select/${token}`
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const openWindow = options.openWindow || openSelectorWindow
  const createServer = options.createServer || http.createServer
  const allowedIds = new Map(usableInstallations.map(installation => [installation.id, installation]))
  const page = renderSelectorPage(usableInstallations, {
    nonce, iconPath: options.iconPath, dlcs: options.dlcs, dlcSource: options.dlcSource, toolVersion: options.toolVersion
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let timeout
    let server
    let allowedOrigin
    const sockets = new Set()

    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (server.listening) {
        // Browser preconnections and unfinished requests can keep close() pending.
        // Give the response time to flush, then dispose of any remaining sockets.
        const shutdownTimeout = setTimeout(() => {
          for (const socket of sockets) socket.destroy()
        }, CONNECTION_CLOSE_GRACE_MS)
        shutdownTimeout.unref()
        server.close(() => clearTimeout(shutdownTimeout))
        server.closeIdleConnections?.()
      }
      // Continuing startup must never depend on the browser closing its connections.
      if (error) reject(error)
      else resolve(result)
    }

    server = createServer(async (request, response) => {
      if (settled) {
        sendResponse(response, 410, 'Selector closed', { connection: 'close' })
        return
      }
      let requestUrl
      try {
        requestUrl = new URL(request.url, `http://${LOOPBACK_HOST}`)
      } catch {
        sendResponse(response, 400, 'Invalid URL')
        return
      }

      if (request.method === 'POST' && request.headers.origin && request.headers.origin !== allowedOrigin) {
        sendResponse(response, 403, 'Forbidden origin')
        return
      }

      if (request.method === 'GET' && (requestUrl.pathname === route || requestUrl.pathname === `${route}/`)) {
        const csp = [
          "default-src 'none'",
          'img-src data:',
          "style-src 'unsafe-inline'",
          `script-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join('; ')
        sendResponse(response, 200, page, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': csp,
          'referrer-policy': 'no-referrer'
        })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === `${route}/cancel`) {
        sendResponse(response, 204)
        setImmediate(() => finish(null))
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === `${route}/select`) {
        try {
          if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            sendResponse(response, 415, 'Unsupported media type')
            return
          }
          const body = await readJsonBody(request)
          if (settled) {
            sendResponse(response, 410, 'Selector closed', { connection: 'close' })
            return
          }
          const selected = allowedIds.get(body.id)
          if (!selected) {
            sendResponse(response, 400, 'Unknown installation')
            return
          }
          sendResponse(response, 200, JSON.stringify({ ok: true }), {
            'content-type': 'application/json; charset=utf-8'
          })
          setImmediate(() => finish(selected))
        } catch {
          if (!response.headersSent && !response.destroyed) {
            sendResponse(response, 400, 'Invalid request')
          }
        }
        return
      }

      sendResponse(response, 404, 'Not found')
    })

    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      if (settled) socket.destroy()
    })
    server.on('error', error => finish(null, error))
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      const url = `http://${LOOPBACK_HOST}:${address.port}${route}`
      allowedOrigin = `http://${LOOPBACK_HOST}:${address.port}`
      timeout = setTimeout(() => finish(null), timeoutMs)
      try {
        const launch = openWindow(url, options)
        launch?.child?.once?.('error', error => finish(null, error))
      } catch (error) {
        finish(null, error)
      }
    })
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LOOPBACK_HOST,
  findEdgeExecutable,
  findEdgeInRegistry,
  openSelectorWindow,
  readJsonBody,
  selectInstallation
}
