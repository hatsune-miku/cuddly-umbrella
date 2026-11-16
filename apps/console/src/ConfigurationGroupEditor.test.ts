import { describe, expect, it } from 'vitest'
import type { SiteBinding } from '@cuddly/contracts'

import {
  canonicalConfigurationGroupUrlPrefix,
  configurationGroupHasBranchErrors,
  configurationGroupItemsFromSelections,
  configurationGroupSelections,
  configurationGroupTargetIds,
  configurationGroupUrlPrefixError,
  nextConfigurationGroupEnvironmentSlug,
  nextConfigurationGroupSiteBindingId,
  shouldCloseConfigurationGroupEditor,
} from './ConfigurationGroupEditor'

function binding(): SiteBinding {
  return {
    id: 'main',
    name: '网页端',
    hostname: 'main.bifrost.vanillacake.cn',
    targetId: 'webapp',
    environmentSlug: 'shared',
    fallbackOrigin: 'https://www.kookapp.cn',
    officialOrigin: 'https://www.kookapp.cn',
    enabled: true,
    remoteTargetIds: ['base', 'discover', 'base'],
    resourceProxyPrefixes: [],
  }
}

describe('configuration group editor model', () => {
  it('uses the page project followed by unique remote projects regardless of environment', () => {
    expect(configurationGroupTargetIds(binding())).toEqual(['webapp', 'base', 'discover'])
    expect(configurationGroupTargetIds(null)).toEqual([])
  })

  it('restores official selections as empty and branch selections verbatim', () => {
    expect(
      configurationGroupSelections([
        { targetId: 'webapp', mode: 'official' },
        { targetId: 'base', mode: 'branch', branch: 'feature/voice' },
      ])
    ).toEqual({ webapp: '', base: 'feature/voice' })
  })

  it('serializes every bound project explicitly while trimming branch names', () => {
    expect(
      configurationGroupItemsFromSelections(['webapp', 'base', 'discover'], {
        webapp: '',
        base: ' feature/voice ',
      })
    ).toEqual([
      { targetId: 'webapp', mode: 'official' },
      { targetId: 'base', mode: 'branch', branch: 'feature/voice' },
      { targetId: 'discover', mode: 'official' },
    ])
  })

  it('fills initially empty environment and site values after directory props arrive', () => {
    expect(
      nextConfigurationGroupEnvironmentSlug(
        '',
        [
          { slug: 'archived', status: 'ARCHIVED' },
          { slug: 'shared', status: 'ACTIVE' },
        ],
        'shared'
      )
    ).toBe('shared')
    expect(
      nextConfigurationGroupSiteBindingId(
        '',
        [
          { id: 'disabled', enabled: false },
          { id: 'main', enabled: true },
        ],
        'main'
      )
    ).toBe('main')
    expect(
      nextConfigurationGroupEnvironmentSlug(
        'tttt',
        [{ slug: 'shared', status: 'ACTIVE' }],
        'shared'
      )
    ).toBe('tttt')
  })

  it('blocks saving when any bound project branch request failed', () => {
    expect(
      configurationGroupHasBranchErrors(['webapp', 'base'], {
        webapp: { error: '' },
        base: { error: 'network unavailable' },
      })
    ).toBe(true)
    expect(
      configurationGroupHasBranchErrors(['webapp'], {
        webapp: { error: '' },
      })
    ).toBe(false)
  })

  it('keeps the editor open when Escape is pressed during save', () => {
    expect(shouldCloseConfigurationGroupEditor('Escape', false)).toBe(true)
    expect(shouldCloseConfigurationGroupEditor('Escape', true)).toBe(false)
    expect(shouldCloseConfigurationGroupEditor('Enter', false)).toBe(false)
  })

  it('accepts ASCII or Chinese hostname prefixes and rejects mixed-script, automatic, and reserved labels', () => {
    expect(configurationGroupUrlPrefixError('party-week')).toBe('')
    expect(configurationGroupUrlPrefixError('')).toBe('')
    expect(configurationGroupUrlPrefixError('中文需求')).toBe('')
    expect(canonicalConfigurationGroupUrlPrefix('中文需求')).toBe('xn--fiq228cyxerz3c')
    expect(configurationGroupUrlPrefixError('中文abc')).toContain('不能中英文混排')
    expect(configurationGroupUrlPrefixError('中'.repeat(60))).toContain('长度限制')
    expect(configurationGroupUrlPrefixError('p-private')).toContain('系统自动链接保留')
    expect(configurationGroupUrlPrefixError('main')).toContain('保留地址')
  })
})
