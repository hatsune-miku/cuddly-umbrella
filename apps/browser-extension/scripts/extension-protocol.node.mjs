import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPLY_CONFIGURATION_GROUP_COMMAND,
  APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
  APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
  EXTENSION_CAPABILITIES_COMMAND,
  EXTENSION_RELOAD_REQUIRED,
  REMOVE_PREVIEW_TRANSACTION_COMMAND,
  extensionCommandErrorMessage,
  requireExtensionCapabilities,
  revokePreviewSession,
} from '../extension-protocol.js'

test('turns an unsupported command result into a reload instruction', () => {
  assert.equal(
    extensionCommandErrorMessage(
      { ok: false, message: 'Unsupported extension command' },
      '扩展规则应用失败'
    ),
    EXTENSION_RELOAD_REQUIRED
  )
  assert.equal(
    extensionCommandErrorMessage({ ok: false, message: 'Rule failed' }, 'fallback'),
    'Rule failed'
  )
  assert.equal(extensionCommandErrorMessage(null, 'fallback'), 'fallback')
})

test('accepts a service worker that supports site and in-place Remote previews', async () => {
  const capabilities = await requireExtensionCapabilities(async (message) => {
    assert.deepEqual(message, { type: EXTENSION_CAPABILITIES_COMMAND })
    return {
      ok: true,
      capabilities: {
        protocolVersion: 13,
        commands: [
          APPLY_CONFIGURATION_GROUP_COMMAND,
          APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
          APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
          REMOVE_PREVIEW_TRANSACTION_COMMAND,
        ],
      },
    }
  })

  assert.equal(capabilities.protocolVersion, 13)
})

test('turns the old worker unsupported-command response into a reload instruction', async () => {
  await assert.rejects(
    requireExtensionCapabilities(async () => ({
      ok: false,
      message: 'Unsupported extension command',
    })),
    new RegExp(EXTENSION_RELOAD_REQUIRED)
  )
})

test('turns a missing worker and incompatible protocol into a reload instruction', async () => {
  await assert.rejects(
    requireExtensionCapabilities(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    }),
    new RegExp(EXTENSION_RELOAD_REQUIRED)
  )
  await assert.rejects(
    requireExtensionCapabilities(async () => ({
      ok: true,
      capabilities: {
        protocolVersion: 2,
        commands: ['apply-site-preview', 'remove-preview'],
      },
    })),
    new RegExp(EXTENSION_RELOAD_REQUIRED)
  )
})

test('requires every command used by the popup', async () => {
  await assert.rejects(
    requireExtensionCapabilities(async () => ({
      ok: true,
      capabilities: {
        protocolVersion: 12,
        commands: [APPLY_SITE_PREVIEW_TRANSACTION_COMMAND],
      },
    })),
    new RegExp(EXTENSION_RELOAD_REQUIRED)
  )
})

test('revokes one exact encoded preview token through the ordinary QA API', async () => {
  const requests = []
  const revoked = await revokePreviewSession({
    controlOrigin: 'https://bifrost.vanillacake.cn/settings',
    token: 'preview/token?one',
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return { ok: true, status: 204 }
    },
  })

  assert.equal(revoked, true)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0].url,
    'https://bifrost.vanillacake.cn/api/v1/previews/preview%2Ftoken%3Fone'
  )
  assert.deepEqual(
    {
      ...requests[0].init,
      signal: requests[0].init.signal.constructor.name,
    },
    {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'omit',
      keepalive: true,
      signal: 'AbortSignal',
    }
  )
})

test('keeps preview revocation best-effort for invalid origins and network failures', async () => {
  await assert.doesNotReject(async () => {
    assert.equal(
      await revokePreviewSession({
        controlOrigin: 'not an origin',
        token: 'preview',
        fetchImpl: async () => {
          throw new Error('must not run')
        },
      }),
      false
    )
    assert.equal(
      await revokePreviewSession({
        controlOrigin: 'https://bifrost.vanillacake.cn',
        token: 'preview',
        fetchImpl: async () => {
          throw new Error('offline')
        },
      }),
      false
    )
  })
})
