;(() => {
  const CHANNEL = 'bifrost:in-place-hot-module:v1'

  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.channel !== CHANNEL ||
      event.data?.type !== 'request-context'
    ) {
      return
    }
    const app = event.data.app
    if (typeof app !== 'string' || !app || app.length > 160 || /[\u0000-\u001f\u007f]/.test(app)) {
      return
    }
    void chrome.runtime
      .sendMessage({ type: 'remember-hot-module-request-context', app })
      .catch(() => undefined)
  })

  chrome.runtime
    .sendMessage({ type: 'read-in-place-hot-module-config' })
    .then((response) => {
      const source = response?.ok && Array.isArray(response.config) ? response.config : []
      const modules = source.map((item) => ({
        moduleKey: item?.moduleKey,
        name: item?.name,
        entry: item?.entry,
        version: item?.version,
        restartRequired: item?.restartRequired,
      }))
      window.postMessage(
        { channel: CHANNEL, type: 'configuration', modules },
        window.location.origin
      )
    })
    .catch(() => {
      window.postMessage(
        { channel: CHANNEL, type: 'configuration', modules: [] },
        window.location.origin
      )
    })
})()
