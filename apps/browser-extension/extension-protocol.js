export const EXTENSION_PROTOCOL_VERSION = 13
export const EXTENSION_CAPABILITIES_COMMAND = 'get-extension-capabilities'
export const APPLY_CONFIGURATION_GROUP_COMMAND = 'apply-configuration-group'
export const APPLY_SITE_PREVIEW_TRANSACTION_COMMAND = 'apply-site-preview-transaction'
export const APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND = 'apply-remote-preview-transaction'
export const REMOVE_PREVIEW_TRANSACTION_COMMAND = 'remove-preview-transaction'
export const EXTENSION_RELOAD_REQUIRED =
  '扩展后台仍在运行旧版本，请打开 chrome://extensions，重新加载浏览器扩展后再试'
const REQUIRED_EXTENSION_COMMANDS = [
  APPLY_CONFIGURATION_GROUP_COMMAND,
  APPLY_SITE_PREVIEW_TRANSACTION_COMMAND,
  APPLY_REMOTE_PREVIEW_TRANSACTION_COMMAND,
  REMOVE_PREVIEW_TRANSACTION_COMMAND,
]
const PREVIEW_REVOKE_TIMEOUT_MS = 3_000

export function extensionCommandErrorMessage(response, fallback) {
  const message = typeof response?.message === 'string' ? response.message.trim() : ''
  return /unsupported extension command/i.test(message)
    ? EXTENSION_RELOAD_REQUIRED
    : message || fallback
}

export async function requireExtensionCapabilities(sendMessage) {
  let response
  try {
    response = await sendMessage({ type: EXTENSION_CAPABILITIES_COMMAND })
  } catch {
    throw new Error(EXTENSION_RELOAD_REQUIRED)
  }

  const capabilities = response?.capabilities
  if (
    !response?.ok ||
    capabilities?.protocolVersion !== EXTENSION_PROTOCOL_VERSION ||
    !REQUIRED_EXTENSION_COMMANDS.every((command) => capabilities.commands?.includes(command))
  ) {
    throw new Error(EXTENSION_RELOAD_REQUIRED)
  }
  return capabilities
}

export async function revokePreviewSession({ controlOrigin, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PREVIEW_REVOKE_TIMEOUT_MS)
  try {
    const origin = new URL(controlOrigin).origin
    const response = await fetchImpl(`${origin}/api/v1/previews/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'omit',
      keepalive: true,
      signal: controller.signal,
    })
    return response.ok || response.status === 404
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
