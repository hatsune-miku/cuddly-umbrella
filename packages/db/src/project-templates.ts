import { kookRemoteModuleKeys, type BuildTarget } from '@cuddly/contracts'

export type KookRemoteModuleKey = (typeof kookRemoteModuleKeys)[number]
export type KookRemoteBuildEnvironment = 'prod' | 'ttt'

export const KOOK_PNPM_COMMAND = 'pnpm'

const REMOTE_PROJECT_NAMES: Record<KookRemoteModuleKey, string> = {
  base: '基础模块',
  discover: '发现页',
  gift: '礼物系统',
  guild: '服务器模块',
  help_center: '帮助中心',
  mall: '商城',
  mini_game: '小游戏',
  order_tracker: '听单器',
  profile: '个人卡片',
  settings: '设置',
  thread: '帖子',
  tutorial: '新手引导',
  voice_panel: '语音面板',
  voice_runtime: '语音运行时',
}

/**
 * KOOK workspace packages whose published entry points are generated into dist/.
 *
 * Keep this list deliberately smaller than the full workspace dependency graph:
 * several workspace packages are compiled from source through Rspack aliases, while
 * recursively building every dependency also pulls unrelated Rust/wasm projects into
 * otherwise ordinary Remote builds.
 */
export const KOOK_REMOTE_PREBUILD_DIRECTORIES: Record<KookRemoteModuleKey, readonly string[]> = {
  base: ['packages/kjsbridge', 'packages/utils'],
  discover: ['packages/kjsbridge', 'packages/utils'],
  gift: ['packages/kjsbridge', 'packages/utils'],
  guild: [
    'packages/kjsbridge',
    'packages/utils',
    'packages/logicModels',
    'packages/virtual-layout-engine',
    'packages/virtual-layout-engine-react',
  ],
  help_center: [],
  mall: ['packages/virtual-layout-engine-react'],
  mini_game: [],
  order_tracker: [],
  profile: ['packages/kjsbridge', 'packages/utils'],
  settings: [],
  thread: ['packages/kjsbridge', 'packages/utils'],
  tutorial: ['packages/kjsbridge', 'packages/utils'],
  voice_panel: [],
  voice_runtime: ['packages/logicModels'],
}

const KOOK_REMOTE_EXTRA_INSTALL_DIRECTORIES: Partial<
  Record<KookRemoteModuleKey, readonly string[]>
> = {
  guild: ['packages/logicModelsReact'],
}

export function kookRemoteInstallCommand(id: KookRemoteModuleKey): string {
  const installDirectories = [
    ...new Set([
      ...KOOK_REMOTE_PREBUILD_DIRECTORIES[id],
      ...(KOOK_REMOTE_EXTRA_INSTALL_DIRECTORIES[id] || []),
    ]),
  ]
  const filters = [
    `--filter '{./apps/${id}}...'`,
    ...installDirectories.map((directory) => `--filter './${directory}'`),
  ]
  return `${KOOK_PNPM_COMMAND} ${filters.join(' ')} --fail-if-no-match install --frozen-lockfile`
}

export function kookRemoteBuildCommand(
  id: KookRemoteModuleKey,
  environment: KookRemoteBuildEnvironment = 'prod'
): string {
  return [
    ...KOOK_REMOTE_PREBUILD_DIRECTORIES[id].map((directory) => {
      const script = directory === 'packages/logicModels' ? 'build:js' : 'build'
      return `( [ ! -f ${directory}/package.json ] || ${KOOK_PNPM_COMMAND} --dir ${directory} run ${script} )`
    }),
    `${KOOK_PNPM_COMMAND} --dir apps/${id} run ${id === 'mini_game' ? 'build' : `build:${environment}`}`,
  ].join(' && ')
}

const REMOTE_PROJECT_TEMPLATES: BuildTarget[] = kookRemoteModuleKeys.map((id) => ({
  id,
  name: REMOTE_PROJECT_NAMES[id],
  kind: 'remote',
  repositoryUrl: null,
  defaultBranch: 'master',
  installCommand: kookRemoteInstallCommand(id),
  buildCommand: kookRemoteBuildCommand(id),
  outputDirectory: `apps/${id}/dist`,
  siteAdapter: 'kook-remote-v1',
  enabled: false,
  required: false,
  configurationSource: 'template',
}))

export const PROJECT_TEMPLATES: BuildTarget[] = [
  {
    id: 'online-h5',
    name: '在线 H5',
    kind: 'h5-site',
    repositoryUrl: null,
    defaultBranch: 'master',
    installCommand: `${KOOK_PNPM_COMMAND} install --frozen-lockfile`,
    buildCommand: `${KOOK_PNPM_COMMAND} run build`,
    outputDirectory: 'build',
    siteAdapter: 'kook-online-h5-v1',
    enabled: false,
    required: false,
    configurationSource: 'template',
  },
  {
    id: 'webapp',
    name: '网页端',
    kind: 'webapp',
    repositoryUrl: null,
    defaultBranch: 'master',
    installCommand: 'npm run i',
    buildCommand: 'npm run build_fast',
    outputDirectory: 'build',
    siteAdapter: 'generic-static-v1',
    enabled: false,
    required: false,
    configurationSource: 'template',
  },
  {
    id: 'biz',
    name: '商户后台',
    kind: 'spa-site',
    repositoryUrl: null,
    defaultBranch: 'master',
    installCommand: 'npm install --legacy-peer-deps --verbose',
    buildCommand: 'npm run build',
    outputDirectory: 'build',
    siteAdapter: 'generic-static-v1',
    enabled: false,
    required: false,
    configurationSource: 'template',
  },
  ...REMOTE_PROJECT_TEMPLATES,
]
