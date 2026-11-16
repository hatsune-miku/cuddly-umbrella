import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPreviewRequest,
  ENVIRONMENT_REQUIRED,
  IN_PLACE_RULE_ENVIRONMENT_MISMATCH,
  IN_PLACE_RULE_ORIGIN_MISMATCH,
  IN_PLACE_RULE_SITE_FORBIDDEN,
  mergeSelectedBranches,
  originsShareEnvironment,
  pageEnvironmentClass,
  planPreviewApplication,
  previewDestinationUrl,
  resolveSelectedArtifacts,
  SITE_BINDING_REQUIRED,
} from '../preview-routing.js'

const binding = {
  id: 'main',
  hostname: 'main.bifrost.vanillacake.cn',
  officialOrigin: 'https://www.kookapp.cn',
  environmentSlug: 'online',
}

test('keeps a Remote-only selection on the matching environment page', () => {
  const plan = planPreviewApplication({
    binding,
    environmentSlug: 'online',
    previewOrigin: 'https://main.bifrost.vanillacake.cn/channels/1',
    currentUrl: 'https://www.kookapp.cn/channels/1?view=compact',
    siteArtifactId: null,
    selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
  })

  assert.deepEqual(plan, {
    canApply: true,
    mode: 'remote',
    requestedOrigin: 'https://main.bifrost.vanillacake.cn',
    pageOrigin: 'https://www.kookapp.cn',
    reason: null,
  })
})

test('treats localhost and every Chuanyu dev subdomain as the same test environment', () => {
  const testBinding = {
    ...binding,
    officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
    environmentSlug: 'tttt',
  }
  for (const currentUrl of [
    'http://localhost:5173/channels/1',
    'https://feature.dev.chuanyuapp.com/channels/1',
  ]) {
    const plan = planPreviewApplication({
      binding: testBinding,
      environmentSlug: 'tttt',
      previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
      currentUrl,
      selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
    })
    assert.equal(plan.mode, 'remote')
    assert.equal(plan.pageOrigin, new URL(currentUrl).origin)
  }
  assert.equal(pageEnvironmentClass('http://localhost:3000'), 'test')
  assert.equal(originsShareEnvironment('http://localhost:3000', testBinding.officialOrigin), true)
})

test('keeps an all-official localhost selection on the local devserver', () => {
  const plan = planPreviewApplication({
    binding: {
      ...binding,
      officialOrigin: 'https://tttt-www.dev.chuanyuapp.com',
      environmentSlug: 'tttt',
    },
    environmentSlug: 'tttt',
    previewOrigin: 'https://main-tttt.bifrost.vanillacake.cn',
    currentUrl: 'http://localhost:5173/channels/1',
    selections: [],
  })

  assert.deepEqual(plan, {
    canApply: true,
    mode: 'official',
    requestedOrigin: 'http://localhost:5173',
    pageOrigin: 'http://localhost:5173',
    reason: null,
  })
})

test('treats every Kook subdomain as the online environment without crossing families', () => {
  assert.equal(originsShareEnvironment('https://guild.kookapp.cn', 'https://www.kookapp.cn'), true)
  assert.equal(
    originsShareEnvironment('https://guild.kookapp.cn', 'https://tttt-www.dev.chuanyuapp.com'),
    false
  )
})

test('uses the site preview when the selected environment does not match the current page', () => {
  const plan = planPreviewApplication({
    binding,
    environmentSlug: 'tttt',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    currentUrl: 'https://www.kookapp.cn/channels/1',
    siteArtifactId: null,
    selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
  })

  assert.deepEqual(plan, {
    canApply: true,
    mode: 'site',
    requestedOrigin: 'https://main.bifrost.vanillacake.cn',
    reason: null,
  })
})

test('a matching URL rule can only produce an in-place plan or an explicit refusal', () => {
  const inPlaceRule = { pattern: 'www.kookapp.cn', environmentSlug: 'online' }
  const base = {
    binding,
    environmentSlug: 'online',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    currentUrl: 'https://www.kookapp.cn/channels/1',
    siteArtifactId: null,
    selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
    inPlaceRule,
  }
  const ready = planPreviewApplication(base)
  assert.equal(ready.canApply, true)
  assert.equal(ready.mode, 'remote')
  assert.deepEqual(ready.inPlaceRule, inPlaceRule)

  const cases = [
    [{ ...base, environmentSlug: 'tttt' }, IN_PLACE_RULE_ENVIRONMENT_MISMATCH],
    [{ ...base, siteArtifactId: 'artifact-webapp' }, IN_PLACE_RULE_SITE_FORBIDDEN],
    [
      { ...base, currentUrl: 'https://example.test/channels/1' },
      IN_PLACE_RULE_ENVIRONMENT_MISMATCH,
    ],
    [
      {
        ...base,
        currentUrl: 'https://www.kookapp.cn.evil.example/channels/1',
        inPlaceRule: { pattern: 'kookapp.cn', environmentSlug: 'online' },
      },
      IN_PLACE_RULE_ORIGIN_MISMATCH,
    ],
  ]
  for (const [input, reason] of cases) {
    const plan = planPreviewApplication(input)
    assert.equal(plan.canApply, false)
    assert.equal(plan.mode, 'remote')
    assert.notEqual(plan.mode, 'site')
    assert.equal(plan.reason, reason)
  }
})

test('a matching URL rule keeps an all-official selection applicable in place', () => {
  const inPlaceRule = { pattern: 'www.kookapp.cn', environmentSlug: 'online' }
  const plan = planPreviewApplication({
    binding,
    environmentSlug: 'online',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    currentUrl: 'https://www.kookapp.cn/channels/1',
    siteArtifactId: null,
    selections: [],
    inPlaceRule,
  })

  assert.deepEqual(plan, {
    canApply: true,
    mode: 'official',
    requestedOrigin: 'https://www.kookapp.cn',
    pageOrigin: 'https://www.kookapp.cn',
    reason: null,
    inPlaceRule,
  })
})

test('uses the site preview whenever a page Artifact is selected', () => {
  const plan = planPreviewApplication({
    binding,
    environmentSlug: 'online',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    currentUrl: 'https://www.kookapp.cn/channels/1',
    siteArtifactId: 'artifact-webapp',
    selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
  })

  assert.equal(plan.mode, 'site')
})

test('does not offer a Remote-only fallback without a site binding', () => {
  const plan = planPreviewApplication({
    binding: null,
    environmentSlug: 'online',
    previewOrigin: null,
    siteArtifactId: null,
    selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
  })

  assert.equal(plan.canApply, false)
  assert.equal(plan.mode, null)
  assert.equal(plan.requestedOrigin, null)
  assert.equal(plan.reason, SITE_BINDING_REQUIRED)
})

test('allows an all-official Preview so the selected backend environment is still isolated', () => {
  const plan = planPreviewApplication({
    binding,
    environmentSlug: 'test',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    siteArtifactId: null,
    selections: [],
  })

  assert.equal(plan.canApply, true)
  assert.equal(plan.mode, 'site')
  assert.equal(plan.reason, null)
})

test('requires an environment even when all projects use official artifacts', () => {
  const plan = planPreviewApplication({
    binding,
    environmentSlug: '',
    previewOrigin: 'https://main.bifrost.vanillacake.cn',
    siteArtifactId: null,
    selections: [],
  })

  assert.equal(plan.canApply, false)
  assert.equal(plan.reason, ENVIRONMENT_REQUIRED)
})

test('builds a site-bound Preview request and preserves the current tab route', () => {
  assert.deepEqual(
    createPreviewRequest({
      binding,
      environmentSlug: 'test',
      siteArtifactId: null,
      selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
    }),
    {
      ttlMinutes: 480,
      siteBindingId: 'main',
      environmentSlug: 'test',
      selections: [{ targetId: 'base', artifactId: 'artifact-base' }],
    }
  )
  assert.equal(
    previewDestinationUrl(
      'https://main.bifrost.vanillacake.cn',
      'https://www.kookapp.cn/channels/42?view=compact#messages'
    ),
    'https://main.bifrost.vanillacake.cn/channels/42?view=compact#messages'
  )
  assert.deepEqual(
    createPreviewRequest({
      binding,
      environmentSlug: 'test',
      siteArtifactId: null,
      selections: [],
    }),
    {
      ttlMinutes: 480,
      siteBindingId: 'main',
      environmentSlug: 'test',
      selections: [],
    }
  )
})

test('keeps draft branch choices while refreshing the same site', () => {
  assert.deepEqual(
    mergeSelectedBranches({
      sameBinding: true,
      previous: { webapp: '', base: 'feature/qa' },
      defaults: { webapp: 'master', base: '' },
    }),
    { webapp: '', base: 'feature/qa' }
  )
  assert.deepEqual(
    mergeSelectedBranches({
      sameBinding: false,
      previous: { base: 'feature/qa' },
      defaults: { webapp: 'master', base: '' },
    }),
    { webapp: 'master', base: '' }
  )
})

test('blocks a selected branch until every selected project has a successful artifact', () => {
  const result = resolveSelectedArtifacts({
    targets: [
      { id: 'webapp', name: '网页端' },
      { id: 'base', name: '基础热更' },
      { id: 'voice', name: '语音热更' },
    ],
    selectedBranches: {
      webapp: 'feature/page',
      base: 'feature/base',
      voice: '',
    },
    branchCatalogs: {
      webapp: {
        items: [
          {
            branch: 'feature/page',
            latestArtifact: { id: 'artifact-page', builtAt: '2026-08-25T08:00:00.000Z' },
          },
        ],
      },
      base: {
        items: [{ branch: 'feature/base', latestArtifact: null }],
      },
    },
    siteTargetId: 'webapp',
    siteOverrideEnabled: true,
  })

  assert.equal(result.siteArtifactId, 'artifact-page')
  assert.deepEqual(result.selections, [])
  assert.deepEqual(result.missing, [
    { targetId: 'base', targetName: '基础热更', branch: 'feature/base' },
  ])
})

test('keeps an official KOOK page in place when a legacy page draft and discover are selected', () => {
  const resolved = resolveSelectedArtifacts({
    targets: [
      { id: 'webapp', name: '网页端' },
      { id: 'discover', name: '发现页热更' },
    ],
    selectedBranches: {
      webapp: 'master',
      discover: 'feature/discover',
    },
    branchCatalogs: {
      webapp: {
        items: [
          {
            branch: 'master',
            latestArtifact: { id: 'artifact-webapp', builtAt: '2026-08-25T08:00:00.000Z' },
          },
        ],
      },
      discover: {
        items: [
          {
            branch: 'feature/discover',
            latestArtifact: { id: 'artifact-discover', builtAt: '2026-08-26T08:00:00.000Z' },
          },
        ],
      },
    },
    siteTargetId: 'webapp',
    siteOverrideEnabled: false,
  })

  assert.equal(resolved.siteArtifactId, null)
  assert.deepEqual(resolved.missing, [])
  assert.deepEqual(resolved.selections, [
    {
      targetId: 'discover',
      artifactId: 'artifact-discover',
      branch: 'feature/discover',
      builtAt: '2026-08-26T08:00:00.000Z',
    },
  ])
  assert.equal(
    planPreviewApplication({
      binding: {
        id: 'main',
        hostname: 'main.bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        environmentSlug: 'shared',
      },
      environmentSlug: 'shared',
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      currentUrl: 'https://www.kookapp.cn/channels/1',
      siteArtifactId: resolved.siteArtifactId,
      selections: resolved.selections,
    }).mode,
    'remote'
  )
})

test('uses a site Preview after the page branch is explicitly enabled', () => {
  const resolved = resolveSelectedArtifacts({
    targets: [
      { id: 'webapp', name: '网页端' },
      { id: 'discover', name: '发现页热更' },
    ],
    selectedBranches: { webapp: 'master', discover: 'feature/discover' },
    branchCatalogs: {
      webapp: {
        items: [{ branch: 'master', latestArtifact: { id: 'artifact-webapp' } }],
      },
      discover: {
        items: [{ branch: 'feature/discover', latestArtifact: { id: 'artifact-discover' } }],
      },
    },
    siteTargetId: 'webapp',
    siteOverrideEnabled: true,
  })

  assert.equal(resolved.siteArtifactId, 'artifact-webapp')
  assert.equal(
    planPreviewApplication({
      binding: {
        id: 'main',
        hostname: 'main.bifrost.vanillacake.cn',
        officialOrigin: 'https://www.kookapp.cn',
        environmentSlug: 'shared',
      },
      environmentSlug: 'shared',
      previewOrigin: 'https://main.bifrost.vanillacake.cn',
      currentUrl: 'https://www.kookapp.cn/channels/1',
      siteArtifactId: resolved.siteArtifactId,
      selections: resolved.selections,
    }).mode,
    'site'
  )
})
