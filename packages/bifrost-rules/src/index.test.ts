import { describe, expect, it } from 'vitest'

import { rewriteHosts, rewriteLocationHeader } from './index'

const rewrite = {
  upstreamHost: 'm.kookapp.cn',
  proxyHost: 'm.bifrost.vanillacake.cn',
}

describe('host rewriting', () => {
  it('rewrites the exact hostname in URLs, authorities, ports, and standalone text', () => {
    expect(
      rewriteHosts(
        [
          'https://m.kookapp.cn/index.htm',
          '//m.kookapp.cn/static/app.js',
          'm.kookapp.cn:443',
          'host=m.kookapp.cn',
        ].join('\n'),
        [rewrite]
      )
    ).toBe(
      [
        'https://m.bifrost.vanillacake.cn/index.htm',
        '//m.bifrost.vanillacake.cn/static/app.js',
        'm.bifrost.vanillacake.cn:443',
        'host=m.bifrost.vanillacake.cn',
      ].join('\n')
    )
  })

  it('does not rewrite the hostname when it is only a label suffix or prefix', () => {
    const source = [
      'https://static-m.kookapp.cn/static/app.js',
      'https://foo.m.kookapp.cn/static/app.js',
      'https://m.kookapp.cn.example.com/static/app.js',
      'not-m.kookapp.cn',
      'static_m.kookapp.cn',
    ].join('\n')

    expect(rewriteHosts(source, [rewrite])).toBe(source)
  })

  it('keeps Location rewrites boundary-aware', () => {
    expect(rewriteLocationHeader('https://m.kookapp.cn/login', [rewrite])).toBe(
      'https://m.bifrost.vanillacake.cn/login'
    )
    expect(rewriteLocationHeader('https://static-m.kookapp.cn/app.js', [rewrite])).toBe(
      'https://static-m.kookapp.cn/app.js'
    )
  })
})
