#!/usr/bin/env node
// validate-manifest.mjs — sanity-check a kfc.manifest.json before packing/publishing.
// Usage: node validate-manifest.mjs <manifest> [--host <manifest>] [--payload <dlc.json>] [--version <v>]
// Exits 0 if valid, 1 with a list of problems otherwise.
import { readFileSync } from 'node:fs'

const KINDS = new Set(['archive', 'installer', 'web', 'portable', 'extension'])
const PLATFORMS = new Set(['windows-x64', 'windows-arm64', 'macos-x64', 'macos-arm64'])

const path = process.argv[2]
if (!path || path.startsWith('--')) {
  console.error(
    'usage: node validate-manifest.mjs <manifest> [--host <manifest>] [--payload <dlc.json>] [--version <v>]'
  )
  process.exit(2)
}
const options = {}
for (let index = 3; index < process.argv.length; index++) {
  const flag = process.argv[index]
  const value = process.argv[++index]
  if (
    !['--host', '--payload', '--version'].includes(flag) ||
    !value ||
    value.startsWith('--') ||
    options[flag] !== undefined
  ) {
    console.error(`invalid or repeated option: ${flag}`)
    process.exit(2)
  }
  options[flag] = value
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isResourceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}

function parseRelease(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

function compareReleases(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))
}

let m
let host
let payload
try {
  m = readJson(path)
  if (!isObject(m)) throw new Error('manifest must be an object')
  if (options['--host']) host = readJson(options['--host'])
  if (options['--payload']) payload = readJson(options['--payload'])
} catch (e) {
  console.error(`✗ not valid JSON: ${e.message}`)
  process.exit(1)
}

const problems = []
const isDlc = m.resourceType === 'dlc'
if (m.resourceType !== undefined && !['tool', 'dlc'].includes(m.resourceType)) {
  problems.push('resourceType must be "tool" or "dlc"')
}
if (isDlc) {
  if (!isResourceId(m.id) || !isObject(m.dlc) || !isResourceId(m.dlc.hostId) || m.dlc.hostId === m.id) {
    problems.push('DLC must declare one different, valid dlc.hostId')
  }
  if (m.dlcHost !== undefined) problems.push('DLC cannot host DLC (nested DLC is unsupported)')
  const dependency = isObject(m.dlc) ? m.dlc : {}
  const minimum = parseRelease(dependency.minHostVersion)
  const maximum = parseRelease(dependency.maxHostVersionExclusive)
  if (
    dependency.apiVersion !== 1 ||
    !minimum ||
    (dependency.maxHostVersionExclusive !== undefined &&
      (!maximum || (minimum && compareReleases(minimum, maximum) >= 0)))
  ) {
    problems.push('DLC requires API 1 and stable major.minor.patch bounds with minimum < exclusive maximum')
  }
  if (!Array.isArray(m.components) || m.components.length !== 1 || m.components[0]?.kind !== 'archive') {
    problems.push('DLC must have exactly one archive component')
  }
} else if (m.dlc !== undefined) {
  problems.push('only resourceType "dlc" may declare dlc')
}
if (m.dlcHost !== undefined) {
  const declaration = m.dlcHost
  if (!isResourceId(m.id) || !isObject(declaration) || declaration.apiVersion !== 1) {
    problems.push('dlcHost requires a valid resource id and apiVersion 1')
  } else if (declaration.defaultDlcIds !== undefined) {
    const defaults = declaration.defaultDlcIds
    if (
      !Array.isArray(defaults) ||
      defaults.some((id) => !isResourceId(id) || id === m.id) ||
      new Set(defaults).size !== defaults.length
    ) {
      problems.push('dlcHost.defaultDlcIds must contain unique valid IDs other than the host')
    }
  }
}
if ((isDlc || m.dlcHost) && options['--version'] !== undefined && !parseRelease(options['--version'])) {
  problems.push('DLC/host release version must use stable major.minor.patch')
}
if (options['--host']) {
  if (
    !isDlc ||
    !isObject(host) ||
    host.resourceType === 'dlc' ||
    !isObject(host.dlcHost) ||
    host.dlcHost.apiVersion !== 1 ||
    host.id !== m.dlc?.hostId ||
    host.author !== m.author
  ) {
    problems.push('DLC must match the supplied non-DLC host id, API and original author')
  }
}
if (options['--payload']) {
  if (
    !isDlc ||
    !isObject(payload) ||
    payload.format !== 1 ||
    payload.apiVersion !== 1 ||
    payload.id !== m.id ||
    payload.hostId !== m.dlc?.hostId ||
    payload.author !== m.author ||
    !parseRelease(payload.version) ||
    (options['--version'] !== undefined && payload.version !== options['--version'])
  ) {
    problems.push('dlc.json identity, version, format or author does not match the DLC release')
  }
}
for (const k of ['id', 'name', 'description', 'author', 'runtime', 'components']) {
  if (m[k] === undefined || m[k] === null || m[k] === '') problems.push(`missing/empty top-level "${k}"`)
}
if (m.id && !/^[a-z0-9][a-z0-9._-]*$/.test(m.id)) problems.push(`id "${m.id}" should be kebab-case (a-z0-9._-)`)
if (m.runtime !== undefined && m.runtime !== 'none')
  problems.push(`runtime must be "none" (got ${JSON.stringify(m.runtime)})`)
if (
  m.requires !== undefined &&
  (!Array.isArray(m.requires) ||
    m.requires.some((r) => r !== 'nodejs') ||
    new Set(m.requires).size !== m.requires.length)
) {
  problems.push('requires must be an array containing only "nodejs", without duplicates or version constraints')
}
if (m.assets !== undefined) {
  if (!m.assets || typeof m.assets !== 'object' || Array.isArray(m.assets)) {
    problems.push('assets must be an object')
  } else {
    for (const k of ['icon', 'background']) {
      if (m.assets[k] !== undefined && typeof m.assets[k] !== 'string')
        problems.push(`assets.${k} must be a string URL`)
    }
    for (const k of ['images', 'videos']) {
      if (
        m.assets[k] !== undefined &&
        (!Array.isArray(m.assets[k]) || m.assets[k].some((s) => typeof s !== 'string'))
      ) {
        problems.push(`assets.${k} must be an array of string URLs`)
      }
    }
  }
}
if (!Array.isArray(m.components) || m.components.length === 0) {
  problems.push('components must be a non-empty array')
} else {
  m.components.forEach((c, i) => {
    if (!isObject(c)) {
      problems.push(`components[${i}] must be an object`)
      return
    }
    const at = `components[${i}]${c.label ? ` (${c.label})` : ''}`
    if (isDlc && (c.entry || c.setup?.length || Object.values(c.platforms ?? {}).some((platform) => platform?.entry))) {
      problems.push(`${at}: DLC has no standalone entry or setup command`)
    }
    if (!KINDS.has(c.kind)) problems.push(`${at}: bad kind ${JSON.stringify(c.kind)} (want ${[...KINDS].join('|')})`)
    if (c.kind === 'web') {
      if (!c.entry || !/^https?:\/\//.test(c.entry)) problems.push(`${at}: web component needs an http(s) URL entry`)
    } else {
      if (!isObject(c.platforms)) problems.push(`${at}: platforms must be an object`)
      const keys = Object.keys(c.platforms ?? {})
      if (keys.length === 0) problems.push(`${at}: ${c.kind} needs at least one platform in "platforms"`)
      for (const k of keys) {
        if (!PLATFORMS.has(k)) problems.push(`${at}: bad platform key "${k}" (want ${[...PLATFORMS].join('|')})`)
        const a = c.platforms[k]?.artifact
        if (typeof a !== 'string' || !a) problems.push(`${at}: platform "${k}" missing string "artifact"`)
        else if (!a.includes('{version}'))
          console.warn(`  note: ${at} platform "${k}" artifact "${a}" has no {version} template`)
      }
      if (!isDlc && c.kind !== 'extension' && !c.entry && keys.some((key) => !c.platforms[key]?.entry)) {
        problems.push(`${at}: ${c.kind} needs a component entry or an entry for every platform`)
      }
    }
    if (c.setup !== undefined && (!Array.isArray(c.setup) || c.setup.some((s) => typeof s !== 'string'))) {
      problems.push(`${at}: setup must be a string array (e.g. ["npm","install"])`)
    }
  })
}

if (problems.length) {
  console.error(`✗ ${path}: ${problems.length} problem(s):`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
const kinds = m.components.map((c) => c.kind + (c.label ? `(${c.label})` : '')).join(' + ')
console.log(`✓ ${path} valid — id=${m.id}, name="${m.name}", components: ${kinds}`)
