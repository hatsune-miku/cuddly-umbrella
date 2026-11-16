import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalConfigurationGroupUrlPrefix,
  configurationGroupFingerprint,
  configurationGroupItems,
  configurationGroupShareDisplayUrl,
  configurationGroupShareUrl,
  configurationGroupUrlPrefixError,
  normalizedConfigurationGroupUrlPrefix,
} from '../config-share.js'

test('configuration groups explicitly snapshot every project as branch or official', () => {
  const items = configurationGroupItems([{ id: 'webapp' }, { id: 'base' }, { id: 'discover' }], {
    webapp: 'feature/site',
    base: '',
    discover: ' feature/discover ',
  })
  assert.deepEqual(items, [
    { targetId: 'webapp', mode: 'branch', branch: 'feature/site' },
    { targetId: 'base', mode: 'official' },
    { targetId: 'discover', mode: 'branch', branch: 'feature/discover' },
  ])
})

test('configuration fingerprints change with environment or branch intent', () => {
  const base = {
    bindingId: 'main',
    environmentSlug: 'online',
    items: [{ targetId: 'base', mode: 'branch', branch: 'feature/a' }],
  }
  assert.equal(configurationGroupFingerprint(base), configurationGroupFingerprint({ ...base }))
  assert.notEqual(
    configurationGroupFingerprint(base),
    configurationGroupFingerprint({ ...base, environmentSlug: 'test' })
  )
  assert.notEqual(
    configurationGroupFingerprint(base),
    configurationGroupFingerprint({
      ...base,
      items: [{ targetId: 'base', mode: 'branch', branch: 'feature/b' }],
    })
  )
})

test('share URLs stay on the configured control origin and ignore an untrusted path', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF'
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn/settings', {
      token,
      sharePath: `/s/${token}`,
    }),
    `https://bifrost.vanillacake.cn/s/${token}`
  )
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn', {
      token,
      sharePath: 'https://attacker.example/s/leak',
    }),
    `https://bifrost.vanillacake.cn/s/${token}`
  )
  assert.throws(
    () => configurationGroupShareUrl('https://bifrost.vanillacake.cn', { token: 'short' }),
    /令牌无效/
  )
})

test('share URLs prefer the DNS-isolated extension-free preview', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF'
  const previewSlug = '0123456789abcdef0123456789abcdef'
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn', {
      token,
      previewSlug,
      directPreviewUrl: `https://p-${previewSlug}.bifrost.vanillacake.cn/`,
      sharePath: `/s/${token}`,
    }),
    `https://p-${previewSlug}.bifrost.vanillacake.cn/`
  )
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn', {
      token,
      previewSlug,
      previewHostnamePrefix: 'party-week',
      directPreviewUrl: 'https://party-week.bifrost.vanillacake.cn/',
      sharePath: `/s/${token}`,
    }),
    'https://party-week.bifrost.vanillacake.cn/'
  )
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn', {
      token,
      previewSlug,
      directPreviewUrl: `https://p-${previewSlug}.attacker.example/`,
      sharePath: `/s/${token}`,
    }),
    `https://bifrost.vanillacake.cn/s/${token}`
  )
})

test('copied direct preview URLs keep a Chinese prefix instead of exposing punycode', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF'
  const group = {
    token,
    previewSlug: '0123456789abcdef0123456789abcdef',
    previewHostnamePrefix: 'xn--fiq228cyxerz3c',
    directPreviewUrl: 'https://xn--fiq228cyxerz3c.bifrost.vanillacake.cn/',
    sharePath: `/s/${token}`,
  }
  assert.equal(
    configurationGroupShareUrl('https://bifrost.vanillacake.cn', group),
    'https://xn--fiq228cyxerz3c.bifrost.vanillacake.cn/'
  )
  assert.equal(
    configurationGroupShareDisplayUrl('https://bifrost.vanillacake.cn', group),
    'https://中文需求.bifrost.vanillacake.cn/'
  )
  assert.equal(
    configurationGroupShareDisplayUrl('https://bifrost.vanillacake.cn', group, '中文需求'),
    'https://中文需求.bifrost.vanillacake.cn/'
  )
})

test('custom share URL prefixes normalize case, accept Chinese, and reject unsafe or reserved labels', () => {
  assert.equal(normalizedConfigurationGroupUrlPrefix(' Party-Week '), 'party-week')
  assert.equal(configurationGroupUrlPrefixError('party-week'), '')
  assert.equal(configurationGroupUrlPrefixError('中文需求'), '')
  assert.equal(canonicalConfigurationGroupUrlPrefix('中文需求'), 'xn--fiq228cyxerz3c')
  assert.match(configurationGroupUrlPrefixError('中文abc'), /不能中英文混排/)
  assert.match(configurationGroupUrlPrefixError('中'.repeat(60)), /长度限制/)
  assert.match(configurationGroupUrlPrefixError('-party'), /不能中英文混排/)
  assert.match(configurationGroupUrlPrefixError('p-private'), /系统自动链接保留/)
  assert.match(configurationGroupUrlPrefixError('main'), /保留地址/)
})
