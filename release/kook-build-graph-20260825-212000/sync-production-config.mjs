const baseUrl = (process.env.CUDDLY_CONTROL_URL || 'https://bifrost.vanillacake.cn').replace(
  /\/$/,
  ''
)
const actor = process.env.CUDDLY_ACTOR || 'guanzhen'
const pnpm = 'corepack pnpm@9.15.9'

const prebuildDirectories = {
  base: ['packages/kjsbridge', 'packages/utils'],
  discover: ['packages/kjsbridge', 'packages/utils'],
  gift: ['packages/kjsbridge', 'packages/utils'],
  guild: [
    'packages/kjsbridge',
    'packages/utils',
    'packages/virtual-layout-engine',
    'packages/virtual-layout-engine-react',
  ],
  help_center: [],
  mall: ['packages/virtual-layout-engine-react'],
  order_tracker: [],
  profile: ['packages/kjsbridge', 'packages/utils'],
  settings: [],
  thread: ['packages/kjsbridge', 'packages/utils'],
  tutorial: ['packages/kjsbridge', 'packages/utils'],
  voice_panel: [],
  voice_runtime: ['packages/logicModels'],
}

const remoteIds = new Set(Object.keys(prebuildDirectories))

function remoteInstallCommand(id) {
  return `${pnpm} --filter '{./apps/${id}}...' --fail-if-no-match install --frozen-lockfile`
}

function remoteBuildCommand(id, environment) {
  return [
    ...prebuildDirectories[id].map((directory) => `${pnpm} --dir ${directory} run build`),
    `${pnpm} --dir apps/${id} run build:${environment}`,
  ].join(' && ')
}

function commandsFor(target, environment) {
  const id = target.id || target.targetId
  if (remoteIds.has(id)) {
    return {
      installCommand: remoteInstallCommand(id),
      buildCommand: remoteBuildCommand(id, environment === 'tttt' ? 'ttt' : 'prod'),
      outputDirectory: `apps/${id}/dist`,
    }
  }
  if (id === 'online-h5') {
    return {
      installCommand: `${pnpm} install --frozen-lockfile`,
      buildCommand: `${pnpm} run ${environment === 'tttt' ? 'build:dev' : 'build'}`,
      outputDirectory: 'build',
    }
  }
  if (id === 'biz') {
    return {
      installCommand: 'npm install --legacy-peer-deps --verbose',
      buildCommand: 'npm run build',
      outputDirectory: 'build',
    }
  }
  return {
    installCommand: target.installCommand,
    buildCommand: target.buildCommand,
    outputDirectory: target.outputDirectory,
  }
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-cuddly-actor': actor,
      ...init?.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const queue = await request('/api/v1/build-queue')
if (queue.running.length || queue.queued.length) {
  throw new Error('Build queue is not empty; refusing to replace live command configuration')
}

const { items: targets } = await request('/api/v1/admin/build-targets')
for (const target of targets) {
  const commands = commandsFor(target, 'shared')
  await request(`/api/v1/admin/build-targets/${encodeURIComponent(target.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      id: target.id,
      name: target.name,
      kind: target.kind,
      repositoryUrl: target.repositoryUrl || '',
      defaultBranch: target.defaultBranch,
      ...commands,
      siteAdapter: target.siteAdapter,
      enabled: target.enabled,
      required: target.required,
    }),
  })
}

for (const environment of ['shared', 'tttt']) {
  const current = await request(`/api/v1/admin/environments/${environment}/projects`)
  const items = current.items.map((item) => ({
    targetId: item.targetId,
    enabled: item.enabled,
    required: item.required,
    ...commandsFor(item, environment),
  }))
  await request(`/api/v1/admin/environments/${environment}/projects`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  })
}

for (const environment of ['shared', 'tttt']) {
  const current = await request(`/api/v1/admin/environments/${environment}/projects`)
  for (const item of current.items) {
    const expected = commandsFor(item, environment)
    for (const key of ['installCommand', 'buildCommand', 'outputDirectory']) {
      if (item[key] !== expected[key]) {
        throw new Error(`${environment}/${item.targetId} did not persist ${key}`)
      }
    }
  }
}

console.log(`Updated ${targets.length} projects in global, shared, and tttt configuration`)
