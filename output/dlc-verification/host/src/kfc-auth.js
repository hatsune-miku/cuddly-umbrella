const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { writeJsonAtomic } = require('./dlc-provider')

// KFC_TOKEN is also used by the official publishing entry in this repository.
// Do not guess desktop-client paths or read browser session databases.
function protect(value, decrypt = false) {
  if (process.platform !== 'win32') return Promise.reject(new Error('此系统暂不支持保存 KFC 连接，请使用 KFC_TOKEN 环境变量'))
  const operation = decrypt ? 'Unprotect' : 'Protect'
  const script = `Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timeout = setTimeout(() => child.kill(), 15000)
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 65536) child.kill() })
    child.stderr.resume()
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法访问本机 KFC 连接存储')) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) return reject(new Error('KFC 连接无法解密，请重新连接'))
      resolve(Buffer.from(output, 'base64'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(value).toString('base64'))
  })
}

function createCredentialStore(options = {}) {
  const env = options.env || process.env
  const filename = options.filename || path.join(env.LOCALAPPDATA || env.APPDATA || require('os').homedir(), 'kook-plugin-tools', 'kfc-connection.json')
  const crypt = options.protect || protect
  let session = null
  return {
    async get() {
      if (session) return session
      if (env.KFC_TOKEN?.trim()) return env.KFC_TOKEN.trim()
      if (!fs.existsSync(filename)) return null
      try {
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
        if (data.format !== 1 || typeof data.protectedToken !== 'string') throw new Error()
        session = (await crypt(Buffer.from(data.protectedToken, 'base64'), true)).toString('utf8')
        return session
      } catch { throw new Error('本机 KFC 连接已失效，请重新连接') }
    },
    async save(token) {
      const encrypted = await crypt(Buffer.from(token, 'utf8'))
      writeJsonAtomic(filename, { format: 1, protectedToken: encrypted.toString('base64') })
      session = token
    },
    clear() { session = null; fs.rmSync(filename, { force: true }) }
  }
}

module.exports = { createCredentialStore }
