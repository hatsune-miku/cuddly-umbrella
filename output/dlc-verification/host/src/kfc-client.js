const https = require('https')
const HUB = 'https://kfc-api.vanillacake.cn'

function kfcError(message, code) { return Object.assign(new Error(message), { code }) }

function requestBytes(route, token, { limit = 2 * 1024 * 1024, signal } = {}) {
  const initial = new URL(route, HUB)
  if (initial.origin !== HUB) throw new Error('KFC 请求地址无效')
  function request(url, remaining) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(kfcError('已取消检查', 'CANCELLED'))
      const headers = { 'X-KFC-Capabilities': 'dlc-v1', Accept: 'application/json, application/zip' }
      if (url.origin === HUB) headers.Authorization = `Bearer ${token}`
      const req = https.get(url, { headers }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          let next
          try { next = new URL(res.headers.location, url) } catch { return reject(new Error('KFC 下载重定向无效')) }
          if (!remaining || next.protocol !== 'https:' || next.username || next.password) return reject(new Error('KFC 下载重定向不受支持'))
          // Authorization is never forwarded to a different origin.
          return request(next, remaining - 1).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject([401, 403].includes(res.statusCode)
            ? kfcError('请连接 KFC，或更换有下载权限的令牌', 'KFC_AUTH_REQUIRED')
            : new Error(`KFC 请求失败（${res.statusCode}），请稍后重试`))
        }
        if (Number(res.headers['content-length']) > limit) { res.destroy(); return reject(new Error('KFC 安装包超过允许大小')) }
        let size = 0
        const chunks = []
        res.on('data', bytes => {
          size += bytes.length
          if (size > limit) { res.destroy(); reject(new Error('KFC 返回的数据过大')) } else chunks.push(bytes)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', () => reject(new Error('KFC 下载中断，请重试')))
      })
      const abort = () => req.destroy(kfcError('已取消检查', 'CANCELLED'))
      signal?.addEventListener('abort', abort, { once: true })
      req.setTimeout(30000, () => req.destroy(new Error('连接 KFC 超时，请检查网络后重试')))
      req.on('error', error => reject(error.code === 'CANCELLED' ? error : new Error('无法连接 KFC，请检查网络后重试')))
      req.on('close', () => signal?.removeEventListener('abort', abort))
    })
  }
  return request(initial, 4)
}

module.exports = { HUB, requestBytes, kfcError }
