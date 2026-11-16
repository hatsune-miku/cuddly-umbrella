import { describe, expect, it } from 'vitest'

import { kookRemoteModuleKeys } from '@cuddly/contracts'

import {
  KOOK_PNPM_COMMAND,
  KOOK_REMOTE_PREBUILD_DIRECTORIES,
  PROJECT_TEMPLATES,
  kookRemoteBuildCommand,
  kookRemoteInstallCommand,
} from './project-templates.js'

describe('KOOK project command templates', () => {
  it('uses plain pnpm and installs each Remote dependency closure plus explicit prebuild packages', () => {
    expect(KOOK_PNPM_COMMAND).toBe('pnpm')
    for (const target of PROJECT_TEMPLATES) {
      expect(target.installCommand).not.toMatch(/corepack|pnpm@/)
      expect(target.buildCommand).not.toMatch(/corepack|pnpm@/)
    }
    for (const id of kookRemoteModuleKeys) {
      const prebuildFilters = KOOK_REMOTE_PREBUILD_DIRECTORIES[id]
        .map((directory) => ` --filter './${directory}'`)
        .join('')
      const extraInstallFilters = id === 'guild' ? " --filter './packages/logicModelsReact'" : ''
      expect(kookRemoteInstallCommand(id)).toBe(
        `${KOOK_PNPM_COMMAND} --filter '{./apps/${id}}...'${prebuildFilters}${extraInstallFilters} --fail-if-no-match install --frozen-lockfile`
      )
    }
    expect(kookRemoteInstallCommand('guild')).toContain("--filter './packages/logicModels'")
    expect(kookRemoteInstallCommand('guild')).toContain("--filter './packages/logicModelsReact'")
  })

  it('builds generated workspace entry points in dependency order before each Remote', () => {
    expect(KOOK_REMOTE_PREBUILD_DIRECTORIES.discover).toEqual([
      'packages/kjsbridge',
      'packages/utils',
    ])
    expect(KOOK_REMOTE_PREBUILD_DIRECTORIES.guild).toEqual([
      'packages/kjsbridge',
      'packages/utils',
      'packages/logicModels',
      'packages/virtual-layout-engine',
      'packages/virtual-layout-engine-react',
    ])
    expect(KOOK_REMOTE_PREBUILD_DIRECTORIES.help_center).toEqual([])
    expect(kookRemoteBuildCommand('guild', 'ttt')).toContain(
      'pnpm --dir packages/logicModels run build:js'
    )

    expect(kookRemoteBuildCommand('discover', 'ttt')).toBe(
      '( [ ! -f packages/kjsbridge/package.json ] || pnpm --dir packages/kjsbridge run build ) && ( [ ! -f packages/utils/package.json ] || pnpm --dir packages/utils run build ) && pnpm --dir apps/discover run build:ttt'
    )
  })

  it('skips generated workspace entry points that do not exist on older branches', () => {
    const command = kookRemoteBuildCommand('mall')
    expect(command).toContain(
      '( [ ! -f packages/virtual-layout-engine-react/package.json ] || pnpm --dir packages/virtual-layout-engine-react run build )'
    )
    expect(command).toContain('&& pnpm --dir apps/mall run build:prod')
  })

  it('uses only build scripts and keeps every configured command within the API limit', () => {
    for (const id of kookRemoteModuleKeys) {
      for (const environment of ['prod', 'ttt'] as const) {
        const command = kookRemoteBuildCommand(id, environment)
        expect(command).not.toMatch(/(?:release|upload):/)
        expect(command.length).toBeLessThanOrEqual(1000)
        const script = id === 'mini_game' ? 'build' : `build:${environment}`
        expect(command).toContain(`--dir apps/${id} run ${script}`)
      }
    }
  })

  it('supports the standalone mini_game production build without legacy environment scripts', () => {
    expect(KOOK_REMOTE_PREBUILD_DIRECTORIES.mini_game).toEqual([])
    expect(kookRemoteInstallCommand('mini_game')).toBe(
      "pnpm --filter '{./apps/mini_game}...' --fail-if-no-match install --frozen-lockfile"
    )
    for (const environment of ['prod', 'ttt'] as const) {
      expect(kookRemoteBuildCommand('mini_game', environment)).toBe(
        'pnpm --dir apps/mini_game run build'
      )
    }
    expect(PROJECT_TEMPLATES.find(({ id }) => id === 'mini_game')).toMatchObject({
      name: '小游戏',
      kind: 'remote',
      outputDirectory: 'apps/mini_game/dist',
      siteAdapter: 'kook-remote-v1',
      enabled: false,
    })
  })

  it('matches the package managers and output directories used by standalone site repos', () => {
    expect(PROJECT_TEMPLATES.find(({ id }) => id === 'online-h5')).toMatchObject({
      installCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm run build',
      outputDirectory: 'build',
    })
    expect(PROJECT_TEMPLATES.find(({ id }) => id === 'webapp')).toMatchObject({
      installCommand: 'npm run i',
      buildCommand: 'npm run build_fast',
      outputDirectory: 'build',
    })
    expect(PROJECT_TEMPLATES.find(({ id }) => id === 'biz')).toMatchObject({
      installCommand: 'npm install --legacy-peer-deps --verbose',
      buildCommand: 'npm run build',
      outputDirectory: 'build',
    })
  })
})
