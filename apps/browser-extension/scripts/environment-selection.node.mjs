import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseEnvironment,
  environmentClassForUrl,
  environmentForUrl,
  environmentOptionLabel,
  normalizeEnvironments,
  readTabEnvironmentPreference,
  removeTabEnvironmentPreference,
  retainTabEnvironmentPreferences,
  writeTabEnvironmentPreference,
} from '../environment-selection.js'

const online = {
  id: 'environment-online',
  slug: 'online',
  name: '线上环境',
  status: 'ACTIVE',
  backendOrigin: 'https://www.kookapp.cn',
}
const testEnvironment = {
  id: 'environment-test',
  slug: 'test',
  name: '测试环境',
  status: 'FROZEN',
  backendOrigin: 'https://tttt-www.dev.chuanyuapp.com',
}

test('normalizes non-archived environments and labels frozen choices', () => {
  assert.deepEqual(
    normalizeEnvironments({
      items: [
        online,
        testEnvironment,
        { ...testEnvironment, id: 'duplicate' },
        { ...online, id: 'archived', slug: 'archived', status: 'ARCHIVED' },
        null,
      ],
    }),
    [online, testEnvironment]
  )
  assert.equal(environmentOptionLabel(online), '线上环境 · online')
  assert.equal(environmentOptionLabel(testEnvironment), '测试环境 · test · 冻结')
})

test('keeps a tab choice ahead of an active Preview and uses active only as a fallback', () => {
  assert.equal(
    chooseEnvironment({
      environments: [online, testEnvironment],
      tabEnvironmentSlug: 'test',
      activeEnvironmentSlug: 'online',
      rememberedEnvironmentSlug: 'online',
    }),
    testEnvironment
  )
  assert.equal(
    chooseEnvironment({
      environments: [online, testEnvironment],
      activeEnvironmentSlug: 'test',
      rememberedEnvironmentSlug: 'online',
    }),
    testEnvironment
  )
  assert.equal(
    chooseEnvironment({
      environments: [online, testEnvironment],
      rememberedEnvironmentSlug: 'test',
    }),
    testEnvironment
  )
})

test('classifies localhost and Chuanyu/Kook domains by their environment family', () => {
  assert.equal(environmentClassForUrl('http://localhost:3000/channel'), 'test')
  assert.equal(environmentClassForUrl('https://preview.dev.chuanyuapp.com'), 'test')
  assert.equal(environmentClassForUrl('http://feature.dev.chuanyuapp.com:8080'), 'test')
  assert.equal(environmentClassForUrl('https://m.kookapp.cn'), 'online')
  assert.equal(environmentClassForUrl('https://example.com'), '')
  assert.equal(
    environmentForUrl([online, testEnvironment], 'http://localhost:5173'),
    testEnvironment
  )
  assert.equal(
    chooseEnvironment({
      environments: [online, testEnvironment],
      tabUrl: 'http://localhost:5173',
      rememberedEnvironmentSlug: 'online',
    }),
    testEnvironment
  )
})

test('persists environment choices per tab and official origin', () => {
  let store = writeTabEnvironmentPreference(null, {
    tabId: 7,
    officialOrigin: 'https://www.kookapp.cn/path',
    environmentSlug: 'test',
    updatedAt: 1,
  })
  store = writeTabEnvironmentPreference(store, {
    tabId: 8,
    officialOrigin: 'https://m.kookapp.cn',
    environmentSlug: 'online',
    updatedAt: 2,
  })

  assert.equal(
    readTabEnvironmentPreference(store, {
      tabId: 7,
      officialOrigin: 'https://www.kookapp.cn',
    }),
    'test'
  )
  assert.equal(
    readTabEnvironmentPreference(store, {
      tabId: 7,
      officialOrigin: 'https://m.kookapp.cn',
    }),
    ''
  )
  assert.deepEqual(retainTabEnvironmentPreferences(store, [7]), { 7: store['7'] })
  assert.deepEqual(removeTabEnvironmentPreference(store, 7), { 8: store['8'] })
})
