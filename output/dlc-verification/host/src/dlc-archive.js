const { unzipSync } = require('fflate')
const crypto = require('crypto')
const { validateDlcManifest, safeRelative } = require('./dlc-provider')
const MAX_ARCHIVE = 16 * 1024 * 1024
const MAX_EXPANDED = 64 * 1024 * 1024

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  return value >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function readZip(input) {
  const bytes = Buffer.from(input)
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE) throw new Error('请选择有效的 DLC ZIP 安装包，文件大小不能超过 16 MB')
  // Inspect the central directory before allocating any expanded payload. Decode
  // with fflate; independently check paths, attributes, sizes and CRC afterwards.
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('ZIP 文件不完整或已损坏，请重新下载')
  const count = bytes.readUInt16LE(end + 10)
  let cursor = bytes.readUInt32LE(end + 16)
  const directoryEnd = cursor + bytes.readUInt32LE(end + 12)
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || !count || count > 256 || directoryEnd !== end) throw new Error('此 ZIP 格式不受支持，请使用 KFC 下载的 DLC 安装包')
  const index = []
  const names = new Set()
  let expanded = 0
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > directoryEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 目录已损坏')
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
    if (next > directoryEnd) throw new Error('ZIP 目录已损坏')
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const name = rawName.replace(/\\/g, '/')
    const directory = name.endsWith('/')
    const relative = directory ? name.slice(0, -1) : name
    if (!safeRelative(relative)) throw new Error('安装包包含不受支持的文件路径')
    if (names.has(name.toLowerCase())) throw new Error('安装包中存在重复文件路径')
    names.add(name.toLowerCase())
    const size = bytes.readUInt32LE(cursor + 24)
    const compressed = bytes.readUInt32LE(cursor + 20)
    expanded += size
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16
    const method = bytes.readUInt16LE(cursor + 10)
    if ((bytes.readUInt16LE(cursor + 8) & 1) || bytes.readUInt16LE(cursor + 34) || (mode & 0xf000) === 0xa000 || ![0, 8].includes(method) || size > MAX_ARCHIVE || expanded > MAX_EXPANDED || compressed > MAX_ARCHIVE) throw new Error('安装包格式或解压大小不受支持')
    const offset = bytes.readUInt32LE(cursor + 42)
    if (offset + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP 文件头已损坏')
    const localNameLength = bytes.readUInt16LE(offset + 26)
    const dataStart = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28)
    if (dataStart + compressed > bytes.readUInt32LE(end + 16) || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== rawName || bytes.readUInt16LE(offset + 8) !== method) throw new Error('ZIP 文件头与目录不一致')
    index.push({ rawName, name, size, compressed, method, directory, crc: bytes.readUInt32LE(cursor + 16) })
    cursor = next
  }
  if (cursor !== directoryEnd) throw new Error('ZIP 目录已损坏')
  let unpacked
  // Strip the comment so the decoder must use the directory inspected above.
  const normalized = Buffer.from(bytes.subarray(0, end + 22))
  normalized.writeUInt16LE(0, end + 20)
  const indexed = new Map(index.map(entry => [entry.rawName, entry]))
  let decoded = 0
  try {
    unpacked = unzipSync(normalized, { filter(entry) {
      const expected = indexed.get(entry.name)
      if (!expected || expected.compressed !== entry.size || expected.size !== entry.originalSize || expected.method !== entry.compression) throw new Error('ZIP directory mismatch')
      indexed.delete(entry.name)
      decoded++
      return true
    } })
  } catch { throw new Error('ZIP 解压失败，请重新下载安装包') }
  if (decoded !== index.length) throw new Error('ZIP 目录已损坏')
  const files = new Map()
  for (const entry of index) {
    const data = unpacked[entry.rawName]
    if (!data || data.length !== entry.size || crc32(data) !== entry.crc) throw new Error('安装包校验失败，请重新下载')
    if (!entry.directory) files.set(entry.name, Buffer.from(data))
  }
  return { files, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function readArchive(input) {
  const archive = readZip(input)
  const { files } = archive
  const metadata = files.get('dlc.json')
  if (!metadata || metadata.length > 128 * 1024) throw new Error('这不是 DLC 安装包：ZIP 根目录需要包含 dlc.json')
  let manifest
  try { manifest = JSON.parse(metadata.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('安装包的插件信息无法读取') }
  let contributions
  try {
    contributions = validateDlcManifest(manifest, source => {
      if (!files.has(source)) throw new Error('Missing payload')
      return { source, bytes: files.get(source) }
    })
  } catch (error) { throw new Error('安装包不适用于本注入器，或缺少必要文件：' + error.message) }
  if (!manifest.plugins.length || !contributions.length) throw new Error('安装包中没有可安装的插件')
  return { ...archive, manifest, contributions }
}

module.exports = { readArchive, readZip, MAX_ARCHIVE }
