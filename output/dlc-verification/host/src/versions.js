const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.match(VERSION)
  if (!match) return null
  const numbers = match.slice(1, 4).map(Number)
  if (!numbers.every(Number.isSafeInteger)) return null
  const prerelease = match[4]?.split('.') || []
  if (prerelease.some(part => /^\d+$/.test(part) && (part.length > 1 && part.startsWith('0') || !Number.isSafeInteger(Number(part))))) return null
  return { numbers, prerelease }
}

// Ascending SemVer precedence; build metadata does not change precedence.
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right)
  if (!a || !b) throw new Error('无法比较无效的版本号')
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return Math.sign(a.numbers[index] - b.numbers[index])
  }
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return Math.sign(Number(x) - Number(y))
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

module.exports = { parseVersion, compareVersions }
