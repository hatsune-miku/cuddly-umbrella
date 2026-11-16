import { createHash } from 'node:crypto'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { createServer, type Server } from 'node:http'
import type { LookupFunction } from 'node:net'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

import type { SiteBinding } from '@cuddly/contracts'
import type { Request, Response } from 'express'
import express from 'express'
import { describe, expect, it, vi } from 'vitest'

import {
  createPinnedResourceLookup,
  decodeStableResourcePath,
  isPublicResourceAddress,
  proxyResourceRequest,
  RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
  resolvePublicResourceHost,
  resolveResourceRequest,
  resourceProxyBootstrap,
  resourceProxyRequestHeaders,
  resourceProxyResponseHeaders,
  resourceProxyTransformVersion,
  rewriteResourceProxyUrl,
} from './resource-proxy'

function binding(resourceProxyPrefixes: string[]): SiteBinding {
  return {
    id: 'main',
    name: 'Main',
    hostname: 'main.bifrost.vanillacake.cn',
    targetId: 'webapp',
    environmentSlug: 'shared',
    fallbackOrigin: 'https://www.kookapp.cn',
    upstreamOrigin: 'https://www.kookapp.cn',
    officialOrigin: 'https://www.kookapp.cn',
    enabled: true,
    remoteTargetIds: [],
    resourceProxyPrefixes,
  }
}

function ruleId(prefix: string): string {
  return createHash('sha256').update(new URL(prefix).href).digest('hex')
}

function resourcePath(prefix: string, suffix: string): string {
  return `/__cuddly/resource-proxy/${ruleId(prefix)}/${suffix}`
}

function installBootstrap(resourceProxyPrefixes: string[]) {
  const fetchCalls: Array<[unknown, unknown]> = []
  const constructorCalls: Record<'Worker' | 'SharedWorker' | 'EventSource', unknown[][]> = {
    Worker: [],
    SharedWorker: [],
    EventSource: [],
  }
  class FakeXmlHttpRequest {
    readonly calls: unknown[][] = []

    open(...args: unknown[]) {
      this.calls.push(args)
    }
  }
  class FakeCssStyleDeclaration {
    readonly properties = new Map<string, { value: string; priority: string }>()
    private text = ''

    setProperty(property: unknown, value: unknown, priority: unknown = '') {
      this.properties.set(String(property), {
        value: String(value),
        priority: String(priority),
      })
    }

    getPropertyValue(property: unknown) {
      return this.properties.get(String(property))?.value ?? ''
    }

    get cssText() {
      return this.text
    }

    set cssText(value: unknown) {
      this.text = String(value)
    }
  }
  class FakeElement {
    readonly attributes = new Map<string, string>()
    readonly propertyValues = new Map<string, string>()
    readonly style = new FakeCssStyleDeclaration()
    readonly tagName: string
    readonly baseURI = 'https://main.bifrost.vanillacake.cn/app/index.html'
    private innerMarkup = ''
    private outerMarkup = ''
    private text = ''
    readonly adjacentHtmlCalls: unknown[][] = []
    readonly animateCalls: unknown[][] = []

    constructor(readonly localName: string) {
      this.tagName = localName.toUpperCase()
    }

    setAttribute(name: unknown, value: unknown) {
      this.attributes.set(String(name).toLowerCase(), String(value))
    }

    setAttributeNS(_namespace: unknown, name: unknown, value: unknown) {
      this.setAttribute(name, value)
    }

    getAttribute(name: string) {
      return this.attributes.get(name.toLowerCase()) ?? null
    }

    get innerHTML() {
      return this.innerMarkup
    }

    set innerHTML(value: unknown) {
      this.innerMarkup = String(value)
    }

    get outerHTML() {
      return this.outerMarkup
    }

    set outerHTML(value: unknown) {
      this.outerMarkup = String(value)
    }

    get textContent() {
      return this.text
    }

    set textContent(value: unknown) {
      this.text = String(value)
    }

    get innerText() {
      return this.text
    }

    set innerText(value: unknown) {
      this.text = String(value)
    }

    insertAdjacentHTML(...args: unknown[]) {
      this.adjacentHtmlCalls.push(args)
    }

    animate(...args: unknown[]) {
      this.animateCalls.push(args)
      return { animation: true }
    }
  }
  const resourceProperties: Record<string, readonly string[]> = {
    script: ['src'],
    img: ['src', 'srcset'],
    link: ['href', 'imagesrcset'],
    source: ['src', 'srcset'],
    video: ['src', 'poster'],
    audio: ['src'],
    iframe: ['src', 'srcdoc'],
    object: ['data'],
    embed: ['src'],
    input: ['src'],
    track: ['src'],
  }
  const elementConstructors: Record<string, new () => FakeElement> = {}
  for (const [tag, properties] of Object.entries(resourceProperties)) {
    class FakeResourceElement extends FakeElement {
      constructor() {
        super(tag)
      }
    }
    for (const property of properties) {
      Object.defineProperty(FakeResourceElement.prototype, property, {
        configurable: true,
        enumerable: true,
        get(this: FakeElement) {
          return this.propertyValues.get(property) ?? ''
        },
        set(this: FakeElement, value: unknown) {
          this.propertyValues.set(property, String(value))
        },
      })
    }
    elementConstructors[tag] = FakeResourceElement
  }

  const constructorForTag: Record<string, string> = {
    script: 'HTMLScriptElement',
    img: 'HTMLImageElement',
    link: 'HTMLLinkElement',
    source: 'HTMLSourceElement',
    video: 'HTMLVideoElement',
    audio: 'HTMLAudioElement',
    iframe: 'HTMLIFrameElement',
    object: 'HTMLObjectElement',
    embed: 'HTMLEmbedElement',
    input: 'HTMLInputElement',
    track: 'HTMLTrackElement',
  }
  class FakeStyleElement extends FakeElement {
    constructor() {
      super('style')
    }
  }
  class FakeDocument {
    readonly baseURI = 'https://main.bifrost.vanillacake.cn/app/index.html'
    readonly writeCalls: unknown[][] = []

    createElement(tag: string) {
      if (tag.toLowerCase() === 'style') return new FakeStyleElement()
      const Constructor = elementConstructors[tag.toLowerCase()]
      return Constructor ? new Constructor() : new FakeElement(tag.toLowerCase())
    }

    write(...args: unknown[]) {
      this.writeCalls.push(args)
    }

    writeln(...args: unknown[]) {
      this.writeCalls.push(args)
    }
  }
  const documentObject = new FakeDocument()
  class FakeShadowRoot {
    private markup = ''

    get innerHTML() {
      return this.markup
    }

    set innerHTML(value: unknown) {
      this.markup = String(value)
    }
  }
  class FakeRange {
    readonly calls: unknown[][] = []

    createContextualFragment(...args: unknown[]) {
      this.calls.push(args)
      return { fragment: args[0] }
    }
  }
  class FakeDomParser {
    readonly calls: unknown[][] = []

    parseFromString(...args: unknown[]) {
      this.calls.push(args)
      return { document: args[0] }
    }
  }
  class FakeCssStyleSheet {
    readonly calls: Array<[string, unknown[]]> = []
    readonly href = 'https://main.bifrost.vanillacake.cn/app/main.css'

    insertRule(...args: unknown[]) {
      this.calls.push(['insertRule', args])
      return 7
    }

    addRule(...args: unknown[]) {
      this.calls.push(['addRule', args])
      return 8
    }

    replace(...args: unknown[]) {
      this.calls.push(['replace', args])
      return Promise.resolve(this)
    }

    replaceSync(...args: unknown[]) {
      this.calls.push(['replaceSync', args])
    }
  }
  class FakeStylePropertyMap {
    readonly calls: Array<[string, unknown[]]> = []

    set(...args: unknown[]) {
      this.calls.push(['set', args])
      return this
    }

    append(...args: unknown[]) {
      this.calls.push(['append', args])
      return undefined
    }
  }
  class FakeFontFace {
    constructor(...args: unknown[]) {
      ;(this as any).args = args
    }
  }
  class FakeServiceWorkerContainer {
    readonly calls: unknown[][] = []

    register(...args: unknown[]) {
      this.calls.push(args)
      return Promise.resolve({})
    }
  }
  class FakeWorklet {
    readonly calls: unknown[][] = []

    addModule(...args: unknown[]) {
      this.calls.push(args)
      return Promise.resolve()
    }
  }
  class FakeKeyframeEffect {
    constructor(...args: unknown[]) {
      ;(this as any).args = args
    }
  }

  class FakeWorker {
    constructor(...args: unknown[]) {
      constructorCalls.Worker.push(args)
    }
  }
  class FakeSharedWorker {
    constructor(...args: unknown[]) {
      constructorCalls.SharedWorker.push(args)
    }
  }
  class FakeEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2

    constructor(...args: unknown[]) {
      constructorCalls.EventSource.push(args)
    }
  }
  const audioCalls: unknown[][] = []
  class FakeAudio {
    constructor(...args: unknown[]) {
      audioCalls.push(args)
    }
  }
  const windowObject: Record<string, any> = {
    location: new URL('https://main.bifrost.vanillacake.cn/channels/1'),
    document: documentObject,
    Request,
    XMLHttpRequest: FakeXmlHttpRequest,
    Element: FakeElement,
    Document: FakeDocument,
    ShadowRoot: FakeShadowRoot,
    Range: FakeRange,
    DOMParser: FakeDomParser,
    CSSStyleDeclaration: FakeCssStyleDeclaration,
    CSSStyleSheet: FakeCssStyleSheet,
    StylePropertyMap: FakeStylePropertyMap,
    FontFace: FakeFontFace,
    ServiceWorkerContainer: FakeServiceWorkerContainer,
    Worklet: FakeWorklet,
    KeyframeEffect: FakeKeyframeEffect,
    HTMLStyleElement: FakeStyleElement,
    Worker: FakeWorker,
    SharedWorker: FakeSharedWorker,
    EventSource: FakeEventSource,
    Audio: FakeAudio,
    fetch(input: unknown, init: unknown) {
      fetchCalls.push([input, init])
      return Promise.resolve({ ok: true })
    },
  }
  for (const [tag, constructorName] of Object.entries(constructorForTag)) {
    windowObject[constructorName] = elementConstructors[tag]
  }
  const context = vm.createContext({
    window: windowObject,
    URL,
  })
  new vm.Script(resourceProxyBootstrap(binding(resourceProxyPrefixes))).runInContext(context)
  return {
    constructorCalls,
    audioCalls,
    documentObject,
    fetchCalls,
    FakeCssStyleDeclaration,
    FakeCssStyleSheet,
    FakeDomParser,
    FakeFontFace,
    FakeKeyframeEffect,
    FakeRange,
    FakeServiceWorkerContainer,
    FakeShadowRoot,
    FakeStyleElement,
    FakeStylePropertyMap,
    FakeWorklet,
    FakeXmlHttpRequest,
    windowObject,
  }
}

function callLookup(
  lookup: LookupFunction,
  hostname: string,
  options: LookupOptions
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP address'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('resource proxy bootstrap', () => {
  it('uses stable rule hashes and the longest matching prefix across rule reordering', async () => {
    const general = 'https://img.kookapp.cn/assets/'
    const specific = 'https://img.kookapp.cn/assets/special/'
    const first = installBootstrap([general, specific])
    const second = installBootstrap([specific, general])

    await first.windowObject.fetch('https://img.kookapp.cn/assets/saying.json?language=zh-CN')
    await second.windowObject.fetch('https://img.kookapp.cn/assets/saying.json?language=zh-CN')
    const expectedGeneral = `https://main.bifrost.vanillacake.cn${resourcePath(
      general,
      'saying.json?language=zh-CN'
    )}`
    expect(first.fetchCalls[0]).toEqual([expectedGeneral, { credentials: 'omit' }])
    expect(second.fetchCalls[0]).toEqual([expectedGeneral, { credentials: 'omit' }])

    await first.windowObject.fetch('https://img.kookapp.cn/assets/special/config.json')
    expect(first.fetchCalls[1]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(specific, 'config.json')}`,
      { credentials: 'omit' },
    ])

    const root = installBootstrap(['https://img.kookapp.cn/'])
    await root.windowObject.fetch('https://img.kookapp.cn//icons/2026-01/icon.png')
    expect(root.fetchCalls[0]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(
        'https://img.kookapp.cn/',
        'icons/2026-01/icon.png'
      )}`,
      { credentials: 'omit' },
    ])
  })

  it('rewrites allowlisted fetch and XHR reads while preserving unrelated requests', async () => {
    const prefix = 'https://img.kookapp.cn/assets/'
    const { fetchCalls, FakeXmlHttpRequest, windowObject } = installBootstrap([prefix])

    await windowObject.fetch(new URL('https://img.kookapp.cn/assets/emoji.json'))
    expect(fetchCalls[0]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'emoji.json')}`,
      { credentials: 'omit' },
    ])

    const request = new Request('https://img.kookapp.cn/assets/saying.json')
    await windowObject.fetch(request)
    expect(fetchCalls[1]![0]).toBeInstanceOf(Request)
    expect((fetchCalls[1]![0] as Request).url).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'saying.json')}`
    )
    expect(fetchCalls[1]![1]).toEqual({ credentials: 'omit' })

    await windowObject.fetch('https://img.kookapp.cn/avatars/user.png')
    expect(fetchCalls[2]).toEqual(['https://img.kookapp.cn/avatars/user.png', undefined])
    await windowObject.fetch('https://img.kookapp.cn/assets/write.json', { method: 'POST' })
    expect(fetchCalls[3]).toEqual(['https://img.kookapp.cn/assets/write.json', { method: 'POST' }])

    const xhr = new FakeXmlHttpRequest()
    xhr.open('GET', 'https://img.kookapp.cn/assets/saying.json', true)
    expect(xhr.calls[0]).toEqual([
      'GET',
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'saying.json')}`,
      true,
    ])
    xhr.open('POST', 'https://img.kookapp.cn/assets/write.json', true)
    expect(xhr.calls[1]).toEqual(['POST', 'https://img.kookapp.cn/assets/write.json', true])
  })

  it('rewrites dynamic resource properties and setAttribute calls from a root prefix', () => {
    const prefix = 'https://img.kookapp.cn/'
    const { documentObject } = installBootstrap([prefix])
    const script = documentObject.createElement('script') as any
    script.src = 'https://img.kookapp.cn/cuddly_base/remoteEntry.js?version=latest'
    expect(script.propertyValues.get('src')).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(
        prefix,
        'cuddly_base/remoteEntry.js?version=latest'
      )}`
    )

    const image = documentObject.createElement('img')
    image.setAttribute('src', 'https://img.kookapp.cn/assets/banner.png')
    expect(image.getAttribute('src')).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'assets/banner.png')}`
    )

    for (const [tag, attribute] of [
      ['link', 'href'],
      ['source', 'src'],
      ['video', 'poster'],
      ['audio', 'src'],
      ['iframe', 'src'],
      ['object', 'data'],
      ['embed', 'src'],
      ['input', 'src'],
      ['track', 'src'],
    ] as const) {
      const element = documentObject.createElement(tag)
      element.setAttribute(attribute, `https://img.kookapp.cn/runtime/${tag}.bin`)
      expect(element.getAttribute(attribute), `${tag}.${attribute}`).toBe(
        `https://main.bifrost.vanillacake.cn${resourcePath(prefix, `runtime/${tag}.bin`)}`
      )
    }

    const anchor = documentObject.createElement('a')
    anchor.setAttribute('href', 'https://img.kookapp.cn/channels/1')
    expect(anchor.getAttribute('href')).toBe('https://img.kookapp.cn/channels/1')

    const body = documentObject.createElement('body')
    body.setAttribute('background', 'https://img.kookapp.cn/legacy/page.png')
    expect(body.getAttribute('background')).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'legacy/page.png')}`
    )
    const svgImage = documentObject.createElement('image')
    svgImage.setAttributeNS(
      'http://www.w3.org/1999/xlink',
      'xlink:href',
      'https://img.kookapp.cn/svg/prize.png'
    )
    expect(svgImage.getAttribute('xlink:href')).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'svg/prize.png')}`
    )
  })

  it('rewrites each srcset URL while preserving descriptors, data URLs, and non-matches', () => {
    const prefix = 'https://img.kookapp.cn/'
    const { documentObject } = installBootstrap([prefix])
    const source = documentObject.createElement('source') as any
    source.srcset = [
      'https://img.kookapp.cn/assets/avatar.png 1x',
      'data:image/png;base64,AAAA 2x',
      'https://static.example.com/avatar.png 3x',
      'https://img.kookapp.cn/assets/avatar-large.png 640w',
    ].join(', ')

    expect(source.propertyValues.get('srcset')).toBe(
      [
        `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'assets/avatar.png')} 1x`,
        'data:image/png;base64,AAAA 2x',
        'https://static.example.com/avatar.png 3x',
        `https://main.bifrost.vanillacake.cn${resourcePath(
          prefix,
          'assets/avatar-large.png'
        )} 640w`,
      ].join(', ')
    )
  })

  it('rewrites dynamic CSS values without touching comments, strings, or unrelated URLs', () => {
    const prefix = 'https://img.kookapp.cn/'
    const { documentObject, FakeCssStyleDeclaration } = installBootstrap([prefix])
    const style = new FakeCssStyleDeclaration()
    style.setProperty(
      'background-image',
      'url("https://img.kookapp.cn/assets/background.png"), url(data:image/png;base64,AAAA)'
    )
    expect(style.properties.get('background-image')?.value).toBe(
      `url("https://main.bifrost.vanillacake.cn${resourcePath(
        prefix,
        'assets/background.png'
      )}"), url(data:image/png;base64,AAAA)`
    )

    style.cssText =
      'mask:url(https://img.kookapp.cn/assets/mask.svg);content:"url(https://img.kookapp.cn/no.png)";/* url(https://img.kookapp.cn/no-2.png) */'
    expect(style.cssText).toBe(
      `mask:url(https://main.bifrost.vanillacake.cn${resourcePath(
        prefix,
        'assets/mask.svg'
      )});content:"url(https://img.kookapp.cn/no.png)";/* url(https://img.kookapp.cn/no-2.png) */`
    )

    const element = documentObject.createElement('div')
    element.setAttribute(
      'style',
      'background: url(https://img.kookapp.cn/assets/inline.png) center/cover'
    )
    expect(element.getAttribute('style')).toBe(
      `background: url(https://main.bifrost.vanillacake.cn${resourcePath(
        prefix,
        'assets/inline.png'
      )}) center/cover`
    )
  })

  it('rewrites React-style direct CSS properties and CSSOM mutation APIs', async () => {
    const prefix = 'https://img.kookapp.cn/'
    const { FakeCssStyleDeclaration, FakeCssStyleSheet, FakeStylePropertyMap, windowObject } =
      installBootstrap([prefix])
    const proxied = (suffix: string) =>
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, suffix)}`
    const style = new FakeCssStyleDeclaration() as any

    style.backgroundImage = 'url(https://img.kookapp.cn//gift-gacha/background.png)'
    style.maskImage = 'url("https://img.kookapp.cn/gift-gacha/mask.svg")'
    style.cursor = 'url(https://img.kookapp.cn/cursors/pointer.cur), pointer'
    expect(style.getPropertyValue('background-image')).toBe(
      `url(${proxied('gift-gacha/background.png')})`
    )
    expect(style.getPropertyValue('mask-image')).toBe(`url("${proxied('gift-gacha/mask.svg')}")`)
    expect(style.getPropertyValue('cursor')).toBe(`url(${proxied('cursors/pointer.cur')}), pointer`)

    const sheet = new FakeCssStyleSheet()
    expect(
      sheet.insertRule('@import "https://img.kookapp.cn/theme/base.css" layer(base);', 0)
    ).toBe(7)
    sheet.addRule('.gift', 'background:url(https://img.kookapp.cn/gift-gacha/card.png)', 1)
    await sheet.replace('.avatar{mask-image:url(https://img.kookapp.cn/gift-gacha/avatar.svg)}')
    sheet.replaceSync('.badge{background:url(https://img.kookapp.cn/gift-gacha/badge.png)}')
    const importedTheme = new URL(proxied('theme/base.css'))
    importedTheme.searchParams.set(
      RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
      resourceProxyTransformVersion(binding([prefix]))
    )
    expect(sheet.calls[0]).toEqual([
      'insertRule',
      [`@import "${importedTheme.href}" layer(base);`, 0],
    ])
    expect(sheet.calls[1]?.[1]?.[1]).toBe(`background:url(${proxied('gift-gacha/card.png')})`)
    expect(sheet.calls[2]?.[1]?.[0]).toBe(
      `.avatar{mask-image:url(${proxied('gift-gacha/avatar.svg')})}`
    )
    expect(sheet.calls[3]?.[1]?.[0]).toBe(
      `.badge{background:url(${proxied('gift-gacha/badge.png')})}`
    )

    const font = new windowObject.FontFace(
      'GiftFont',
      'url(https://img.kookapp.cn/fonts/gift.woff2) format("woff2")'
    )
    expect(font.args[1]).toBe(`url(${proxied('fonts/gift.woff2')}) format("woff2")`)

    const propertyMap = new FakeStylePropertyMap()
    const objectValue = { cssValue: true }
    expect(
      propertyMap.set(
        'background-image',
        'url(https://img.kookapp.cn/gift-gacha/typed.png)',
        objectValue
      )
    ).toBe(propertyMap)
    expect(propertyMap.calls[0]).toEqual([
      'set',
      ['background-image', `url(${proxied('gift-gacha/typed.png')})`, objectValue],
    ])
  })

  it('rewrites dynamic markup sinks, style text, iframe srcdoc, and URL module APIs', async () => {
    const prefix = 'https://img.kookapp.cn/'
    const {
      audioCalls,
      documentObject,
      FakeDomParser,
      FakeRange,
      FakeServiceWorkerContainer,
      FakeShadowRoot,
      FakeStyleElement,
      FakeWorklet,
      windowObject,
    } = installBootstrap([prefix])
    const proxied = (suffix: string) =>
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, suffix)}`
    const sourceMarkup = '<img src="https://img.kookapp.cn//gift-gacha/prize.png">'
    const expectedMarkup = `<img src="${proxied('gift-gacha/prize.png')}">`

    const element = documentObject.createElement('div')
    element.innerHTML = sourceMarkup
    element.outerHTML = sourceMarkup
    element.insertAdjacentHTML('beforeend', sourceMarkup)
    expect(element.innerHTML).toBe(expectedMarkup)
    expect(element.outerHTML).toBe(expectedMarkup)
    expect(element.adjacentHtmlCalls[0]).toEqual(['beforeend', expectedMarkup])

    const shadow = new FakeShadowRoot()
    shadow.innerHTML = sourceMarkup
    expect(shadow.innerHTML).toBe(expectedMarkup)
    const range = new FakeRange()
    expect(range.createContextualFragment(sourceMarkup)).toEqual({ fragment: expectedMarkup })
    const parser = new FakeDomParser()
    expect(parser.parseFromString(sourceMarkup, 'text/html')).toEqual({
      document: expectedMarkup,
    })
    documentObject.write(sourceMarkup, 42)
    documentObject.writeln(sourceMarkup)
    expect(documentObject.writeCalls).toEqual([[expectedMarkup, 42], [expectedMarkup]])

    const iframe = documentObject.createElement('iframe') as any
    iframe.srcdoc = sourceMarkup
    expect(iframe.propertyValues.get('srcdoc')).toBe(expectedMarkup)
    const styleElement = new FakeStyleElement()
    styleElement.textContent =
      '.gift{background:url(https://img.kookapp.cn/gift-gacha/inline-style.png)}'
    expect(styleElement.textContent).toBe(
      `.gift{background:url(${proxied('gift-gacha/inline-style.png')})}`
    )

    new windowObject.Audio('https://img.kookapp.cn/audio/win.mp3')
    expect(audioCalls[0]).toEqual([proxied('audio/win.mp3')])
    const serviceWorker = new FakeServiceWorkerContainer()
    await serviceWorker.register('https://img.kookapp.cn/workers/sw.js', { scope: '/' })
    expect(serviceWorker.calls[0]).toEqual([proxied('workers/sw.js'), { scope: '/' }])
    const worklet = new FakeWorklet()
    await worklet.addModule('https://img.kookapp.cn/worklets/paint.js')
    expect(worklet.calls[0]).toEqual([proxied('worklets/paint.js')])

    element.animate([{ backgroundImage: 'url(https://img.kookapp.cn/gift-gacha/frame.png)' }], 300)
    expect(element.animateCalls[0]?.[0]).toEqual([
      { backgroundImage: `url(${proxied('gift-gacha/frame.png')})` },
    ])
    const effect = new windowObject.KeyframeEffect(element, [
      { maskImage: 'url(https://img.kookapp.cn/gift-gacha/effect.svg)' },
    ])
    expect(effect.args[1]).toEqual([{ maskImage: `url(${proxied('gift-gacha/effect.svg')})` }])
  })

  it('rewrites Worker, SharedWorker, and EventSource constructors and preserves options', () => {
    const prefix = 'https://img.kookapp.cn/'
    const { constructorCalls, windowObject } = installBootstrap([prefix])
    const workerOptions = { type: 'module', name: 'preview-worker' }
    const eventOptions = { withCredentials: false }

    new windowObject.Worker('https://img.kookapp.cn/workers/runtime.js', workerOptions)
    new windowObject.SharedWorker('https://img.kookapp.cn/workers/shared.js', 'shared-preview')
    new windowObject.EventSource(
      'https://img.kookapp.cn/events/stream?channel=preview',
      eventOptions
    )

    expect(constructorCalls.Worker[0]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'workers/runtime.js')}`,
      workerOptions,
    ])
    expect(constructorCalls.SharedWorker[0]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'workers/shared.js')}`,
      'shared-preview',
    ])
    expect(constructorCalls.EventSource[0]).toEqual([
      `https://main.bifrost.vanillacake.cn${resourcePath(prefix, 'events/stream?channel=preview')}`,
      eventOptions,
    ])
    expect(windowObject.EventSource.OPEN).toBe(1)

    new windowObject.Worker('/app/local-worker.js')
    expect(constructorCalls.Worker[1]).toEqual(['/app/local-worker.js'])
  })

  it('versions only same-origin stylesheet links with the stable transform version', () => {
    const prefixes = ['https://img.kookapp.cn/assets/', 'https://img.kookapp.cn/']
    const { documentObject } = installBootstrap(prefixes)
    const expectedVersion = resourceProxyTransformVersion(binding(prefixes))
    const link = documentObject.createElement('link') as any
    link.href = '/app/main.css?theme=dark#tokens'
    const stylesheet = new URL(link.propertyValues.get('href'))
    expect(stylesheet.pathname).toBe('/app/main.css')
    expect(stylesheet.searchParams.get('theme')).toBe('dark')
    expect(stylesheet.searchParams.get(RESOURCE_PROXY_TRANSFORM_VERSION_PARAM)).toBe(
      expectedVersion
    )
    expect(stylesheet.hash).toBe('#tokens')

    const script = documentObject.createElement('script') as any
    script.src = '/app/main.js'
    expect(script.propertyValues.get('src')).toBe('/app/main.js')

    const externalLink = documentObject.createElement('link') as any
    externalLink.href = 'https://static.example.com/app.css'
    expect(externalLink.propertyValues.get('href')).toBe('https://static.example.com/app.css')

    const proxiedLink = documentObject.createElement('link') as any
    proxiedLink.href = 'https://img.kookapp.cn/assets/theme.css?mode=dark'
    const proxiedStylesheet = new URL(proxiedLink.propertyValues.get('href'))
    expect(proxiedStylesheet.pathname).toBe(
      resourcePath('https://img.kookapp.cn/assets/', 'theme.css')
    )
    expect(proxiedStylesheet.searchParams.get('mode')).toBe('dark')
    expect(proxiedStylesheet.searchParams.get(RESOURCE_PROXY_TRANSFORM_VERSION_PARAM)).toBe(
      expectedVersion
    )
  })

  it('does not install rules for literal non-public targets', () => {
    const { windowObject } = installBootstrap([
      'http://127.0.0.1/assets/',
      'http://[::1]/assets/',
      'http://169.254.169.254/latest/',
    ])
    expect(windowObject.__CUDDLY_RESOURCE_PROXY_INSTALLED__).toBeUndefined()
  })
})

describe('resource proxy route parsing', () => {
  it('rewrites text URLs with root-prefix matching and a stable ordered rules version', () => {
    const root = 'https://img.kookapp.cn/'
    const specific = 'https://img.kookapp.cn/assets/special/'
    const configured = binding([root, specific])
    const reversed = binding([specific, root])

    expect(
      rewriteResourceProxyUrl(
        '../remoteEntry.js?channel=qa#module',
        'https://img.kookapp.cn/packages/base/index.html',
        'https://main.bifrost.vanillacake.cn/ignored/path',
        configured
      )
    ).toBe(
      `https://main.bifrost.vanillacake.cn${resourcePath(
        root,
        'packages/remoteEntry.js?channel=qa#module'
      )}`
    )
    expect(
      rewriteResourceProxyUrl(
        'https://img.kookapp.cn/assets/special/config.json',
        'https://www.kookapp.cn/',
        'https://main.bifrost.vanillacake.cn',
        configured
      )
    ).toBe(`https://main.bifrost.vanillacake.cn${resourcePath(specific, 'config.json')}`)
    expect(
      rewriteResourceProxyUrl(
        'https://img.kookapp.cn.evil.example/assets/file.js',
        'https://www.kookapp.cn/',
        'https://main.bifrost.vanillacake.cn',
        configured
      )
    ).toBeNull()
    expect(
      rewriteResourceProxyUrl(
        'https://img.kookapp.cn//icons/2026-01/icon.png',
        'https://www.kookapp.cn/',
        'https://main.bifrost.vanillacake.cn',
        configured
      )
    ).toBe(`https://main.bifrost.vanillacake.cn${resourcePath(root, 'icons/2026-01/icon.png')}`)
    expect(resourceProxyTransformVersion(configured)).toBe(resourceProxyTransformVersion(reversed))
    expect(resourceProxyTransformVersion(configured)).not.toBe(
      resourceProxyTransformVersion(binding([root]))
    )
  })

  it('resolves stable rule paths and preserves the resource query', () => {
    const prefix = 'https://img.kookapp.cn/assets/'
    const resolved = resolveResourceRequest(
      `${resourcePath(prefix, 'saying.json')}?language=zh-CN`,
      binding([prefix])
    )
    expect(resolved?.target.href).toBe('https://img.kookapp.cn/assets/saying.json?language=zh-CN')

    const redundantSlash = resolveResourceRequest(
      `${resourcePath(prefix, '/icons/2026-01/icon.png')}?x-oss-process=style/icon`,
      binding([prefix])
    )
    expect(redundantSlash).toBeNull()
  })

  it('rejects traversal, ambiguous separators, malformed escapes, and excessive decoding', () => {
    const prefix = 'https://img.kookapp.cn/assets/'
    let deeplyEncodedTraversal = '%2e%2e'
    for (let index = 0; index < 8; index += 1) {
      deeplyEncodedTraversal = deeplyEncodedTraversal.replaceAll('%', '%25')
    }

    for (const suffix of [
      '../private.json',
      '%2e%2e/private.json',
      '%252e%252e/private.json',
      '%5cprivate.json',
      '%255cprivate.json',
      '%2fprivate.json',
      '%25/private.json',
      '%zz/private.json',
      '/icons/2026-01/icon.png',
      `${deeplyEncodedTraversal}/private.json`,
    ]) {
      expect(resolveResourceRequest(resourcePath(prefix, suffix), binding([prefix]))).toBeNull()
    }
  })

  it('decodes ordinary encoded paths to a stable value', () => {
    expect(decodeStableResourcePath('/emoji/%E4%B8%AD%E6%96%87.json')).toBe('/emoji/中文.json')
    expect(decodeStableResourcePath('/emoji/%252525252525252541.json')).toBeNull()
  })
})

describe('resource proxy network boundary', () => {
  it('uses the host resolver supplied by the gateway', async () => {
    const prefix = 'https://img.kookapp.cn/assets/'
    const resolverError = new Error('resolver failed')
    const resolveHost = vi.fn(async () => {
      throw resolverError
    })
    let finish: (() => void) | undefined
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    const next = vi.fn((error: unknown) => {
      expect(error).toBe(resolverError)
      finish?.()
    })

    proxyResourceRequest(
      {
        method: 'GET',
        originalUrl: resourcePath(prefix, 'saying.json'),
        headers: {},
      } as Request,
      { headersSent: false } as Response,
      next,
      binding([prefix]),
      resolveHost
    )
    await completed

    expect(resolveHost).toHaveBeenCalledOnce()
    expect(resolveHost).toHaveBeenCalledWith('img.kookapp.cn')
    expect(next).toHaveBeenCalledOnce()
  })

  it('classifies public and non-public IPv4 and IPv6 address ranges', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.31.255.255',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.2',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2002:7f00:1::',
      '3fff::1',
    ]) {
      expect(isPublicResourceAddress(address), address).toBe(false)
    }
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPublicResourceAddress(address), address).toBe(true)
    }
  })

  it('rejects any DNS answer set containing a non-public address', async () => {
    await expect(
      resolvePublicResourceHost('cdn.example.com', async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])
    ).rejects.toThrow('non-public address')
    await expect(resolvePublicResourceHost('127.0.0.1')).rejects.toThrow('non-public address')
    await expect(resolvePublicResourceHost('localhost')).rejects.toThrow('hostname is not public')
  })

  it('pins the validated address set and never performs DNS during connection lookup', async () => {
    let dnsCalls = 0
    const resolution = await resolvePublicResourceHost('cdn.example.com', async () => {
      dnsCalls += 1
      return [
        { address: '1.1.1.1', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ]
    })
    expect(dnsCalls).toBe(1)
    expect(await callLookup(resolution.lookup, 'cdn.example.com', { all: false })).toEqual({
      address: '1.1.1.1',
      family: 4,
    })
    expect(await callLookup(resolution.lookup, 'cdn.example.com', { all: true })).toEqual({
      address: [
        { address: '1.1.1.1', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
      family: undefined,
    })
    expect(dnsCalls).toBe(1)
    await expect(
      callLookup(resolution.lookup, 'attacker.example.com', { all: false })
    ).rejects.toThrow('hostname changed')
  })

  it('refuses to create a pinned lookup from an unsafe address set', () => {
    expect(() =>
      createPinnedResourceLookup('cdn.example.com', [
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ])
    ).toThrow('not public')
  })
})

describe('resource proxy browser text responses', () => {
  it('rewrites compressed CSS, SVG, and manifests while enforcing representation boundaries', async () => {
    const upstreamRequests: Array<{ method?: string; range?: string; url?: string }> = []
    let prefix = ''
    const upstream = createServer((req, res) => {
      upstreamRequests.push({
        method: req.method,
        range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
        url: req.url,
      })
      const absolute = (suffix: string) => `${prefix}${suffix}`
      if (req.url === '/theme.css') {
        const protocolRelative = prefix.replace(/^https?:/, '')
        const body = Buffer.from(
          `@import "./nested.css";@import "${absolute(
            '/base.css'
          )}";.gift{background:url(${protocolRelative}/gift-gacha/background.png)}`
        )
        const compressed = gzipSync(body)
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
          ETag: '"upstream-css"',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          Vary: 'Accept-Encoding, Origin',
        })
        res.end(compressed)
        return
      }
      if (req.url === '/vector.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(`<image href="${absolute('gift-gacha/vector.png')}"/>`)
        return
      }
      if (req.url === '/app.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json' })
        res.end(JSON.stringify({ icons: [{ src: absolute('icons/app.png') }] }))
        return
      }
      if (req.url === '/module.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(`window.asset = "${absolute('gift-gacha/not-rewritten.png')}"`)
        return
      }
      if (req.url === '/script.css') {
        const body = `window.asset = "${absolute('gift-gacha/script.png')}"`
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
        return
      }
      if (req.url === '/detected') {
        const body = `.detected{background:url(${absolute('gift-gacha/detected.png')})}`
        res.writeHead(200, {
          'Content-Type': 'text/css',
          'Content-Length': Buffer.byteLength(body),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: '"detected"',
        })
        res.end(body)
        return
      }
      if (req.url === '/unknown.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css',
          'Content-Encoding': 'zstd',
        })
        res.end(`.bad{background:url(${absolute('bad.png')})}`)
        return
      }
      if (req.url === '/partial.css') {
        res.writeHead(206, {
          'Content-Type': 'text/css',
          'Content-Range': 'bytes 0-9/100',
        })
        res.end('.partial{}')
        return
      }
      res.writeHead(404).end()
    })
    const upstreamOrigin = await listen(upstream)
    prefix = `http://cdn.example.com:${new URL(upstreamOrigin).port}/`
    const siteBinding = binding([prefix])
    const lookup: LookupFunction = (_hostname, options, callback) => {
      queueMicrotask(() => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
        else callback(null, '127.0.0.1', 4)
      })
    }
    const resolveHost = vi.fn(async (hostname: string) => ({
      hostname,
      addresses: [{ address: '127.0.0.1', family: 4 as const }],
      lookup,
    }))
    const gatewayApp = express()
    gatewayApp.use((req, res, next) =>
      proxyResourceRequest(req, res, next, siteBinding, resolveHost)
    )
    const gateway = createServer(gatewayApp)
    const gatewayOrigin = await listen(gateway)
    const proxyUrl = (suffix: string) => `${gatewayOrigin}${resourcePath(prefix, suffix)}`
    const proxiedAsset = (suffix: string) => `${gatewayOrigin}${resourcePath(prefix, suffix)}`

    try {
      const cssResponse = await fetch(proxyUrl('theme.css'))
      const css = await cssResponse.text()
      const importedStylesheet = new URL(proxiedAsset('base.css'))
      importedStylesheet.searchParams.set(
        RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
        resourceProxyTransformVersion(siteBinding)
      )
      const nestedStylesheet = new URL(proxiedAsset('nested.css'))
      nestedStylesheet.searchParams.set(
        RESOURCE_PROXY_TRANSFORM_VERSION_PARAM,
        resourceProxyTransformVersion(siteBinding)
      )
      const expectedCss = `@import "${nestedStylesheet.href}";@import "${
        importedStylesheet.href
      }";.gift{background:url(${proxiedAsset('gift-gacha/background.png')})}`
      expect(cssResponse.status).toBe(200)
      expect(css).toBe(expectedCss)
      expect(cssResponse.headers.get('content-encoding')).toBeNull()
      expect(cssResponse.headers.get('content-range')).toBeNull()
      expect(cssResponse.headers.get('accept-ranges')).toBeNull()
      expect(cssResponse.headers.get('content-length')).toBe(String(Buffer.byteLength(expectedCss)))
      expect(cssResponse.headers.get('cache-control')).toBe('no-store')
      expect(cssResponse.headers.get('vary')).toBe('Origin')
      expect(cssResponse.headers.get('etag')).toBe(
        `"sha256:${createHash('sha256').update(expectedCss).digest('hex')}"`
      )

      const headResponse = await fetch(proxyUrl('theme.css'), { method: 'HEAD' })
      expect(headResponse.status).toBe(200)
      expect(await headResponse.text()).toBe('')
      expect(headResponse.headers.get('content-length')).toBe(
        String(Buffer.byteLength(expectedCss))
      )

      const rangeResponse = await fetch(proxyUrl('theme.css'), {
        headers: { Range: 'bytes=0-9' },
      })
      expect(rangeResponse.status).toBe(200)
      expect(await rangeResponse.text()).toBe(expectedCss)
      expect(upstreamRequests.at(-1)?.range).toBeUndefined()

      const svgResponse = await fetch(proxyUrl('vector.svg'))
      expect(await svgResponse.text()).toBe(
        `<image href="${proxiedAsset('gift-gacha/vector.png')}"/>`
      )
      const manifestResponse = await fetch(proxyUrl('app.webmanifest'))
      expect(await manifestResponse.json()).toEqual({
        icons: [{ src: proxiedAsset('icons/app.png') }],
      })

      const javascriptResponse = await fetch(proxyUrl('module.js'))
      expect(await javascriptResponse.text()).toBe(
        `window.asset = "${prefix}gift-gacha/not-rewritten.png"`
      )
      expect(javascriptResponse.headers.get('cache-control')).not.toBe('no-store')

      const scriptHead = await fetch(proxyUrl('script.css'), { method: 'HEAD' })
      expect(scriptHead.status).toBe(200)
      expect(await scriptHead.text()).toBe('')
      expect(scriptHead.headers.get('content-length')).toBe(
        String(Buffer.byteLength(`window.asset = "${prefix}gift-gacha/script.png"`))
      )
      expect(
        upstreamRequests.some(
          (request) => request.url === '/script.css' && request.method === 'GET'
        )
      ).toBe(true)

      const detectedHead = await fetch(proxyUrl('detected'), { method: 'HEAD' })
      expect(detectedHead.status).toBe(200)
      expect(await detectedHead.text()).toBe('')
      expect(detectedHead.headers.get('content-length')).toBeNull()
      expect(detectedHead.headers.get('accept-ranges')).toBeNull()
      expect(detectedHead.headers.get('etag')).toBeNull()
      expect(detectedHead.headers.get('cache-control')).toBe('no-store')

      const unknownEncoding = await fetch(proxyUrl('unknown.css'))
      expect(unknownEncoding.status).toBe(502)
      expect(await unknownEncoding.json()).toEqual({
        code: 'RESOURCE_PROXY_TEXT_ENCODING_UNSUPPORTED',
      })
      const partial = await fetch(proxyUrl('partial.css'))
      expect(partial.status).toBe(502)
      expect(await partial.json()).toEqual({ code: 'RESOURCE_PROXY_TEXT_PARTIAL_RESPONSE' })

      expect(upstreamRequests[1]?.method).toBe('GET')
      expect(resolveHost).toHaveBeenCalledWith('cdn.example.com')
    } finally {
      await close(gateway)
      await close(upstream)
    }
  })
})

describe('resource proxy headers', () => {
  it('forwards only resource read request headers and generates upstream authority headers', () => {
    const headers = resourceProxyRequestHeaders(
      {
        headers: {
          accept: 'application/json',
          range: 'bytes=0-99',
          'if-none-match': '"asset"',
          'last-event-id': 'event-42',
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-api-key': 'secret',
          'x-client-version': 'private-version',
          'sec-fetch-site': 'same-origin',
          traceparent: '00-secret',
        },
      } as Pick<Request, 'headers'>,
      new URL('https://img.kookapp.cn/assets/saying.json')
    )
    expect(headers).toEqual({
      accept: 'application/json',
      range: 'bytes=0-99',
      'if-none-match': '"asset"',
      'last-event-id': 'event-42',
      host: 'img.kookapp.cn',
      origin: 'https://img.kookapp.cn',
      referer: 'https://img.kookapp.cn/',
      'accept-encoding': 'identity',
    })
  })

  it('replaces a Bifrost Referer with the KOOK static CDN authority', () => {
    const headers = resourceProxyRequestHeaders(
      {
        headers: {
          referer: 'https://main.bifrost.vanillacake.cn/app/login',
          origin: 'https://main.bifrost.vanillacake.cn',
          authorization: 'Bearer secret',
          cookie: 'session=secret',
        },
      } as Pick<Request, 'headers'>,
      new URL('https://static.kookapp.cn/app/static/js/runtime-index.js')
    )

    expect(headers).toEqual({
      host: 'static.kookapp.cn',
      origin: 'https://static.kookapp.cn',
      referer: 'https://static.kookapp.cn/',
      'accept-encoding': 'identity',
    })
  })

  it('copies only inert resource response headers, including upstream content encoding', () => {
    const copied = new Map<string, string | number | readonly string[]>()
    const response = {
      setHeader(name: string, value: string | number | readonly string[]) {
        copied.set(name.toLowerCase(), value)
        return this
      },
    } as Pick<Response, 'setHeader'>
    resourceProxyResponseHeaders(
      {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': '577',
        'content-language': 'zh-CN',
        'content-range': 'bytes 0-576/1024',
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=3600',
        expires: 'Tue, 25 Aug 2026 00:00:00 GMT',
        'last-modified': 'Mon, 24 Aug 2026 00:00:00 GMT',
        etag: '"asset"',
        'clear-site-data': '"cookies"',
        'www-authenticate': 'Bearer realm="private"',
        'set-cookie': ['upstream-secret=1'],
        'access-control-allow-origin': '*',
        'x-upstream-secret': 'private',
      },
      response
    )
    expect(Object.fromEntries(copied)).toEqual({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '577',
      'content-language': 'zh-CN',
      'content-range': 'bytes 0-576/1024',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
      expires: 'Tue, 25 Aug 2026 00:00:00 GMT',
      'last-modified': 'Mon, 24 Aug 2026 00:00:00 GMT',
      etag: '"asset"',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    })
  })
})
