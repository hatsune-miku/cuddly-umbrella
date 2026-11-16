function init() {
  const downloadButton = document.getElementById('type-download-btn')
  if (downloadButton) {
    downloadButton.remove()
  }
  const quickStartButton = document.getElementById('btn-quick-start')
  if (quickStartButton) {
    quickStartButton.textContent = '进入 Web Overlay →'
  }
}

function main() {
  console.log('[BifrostApi] k-inject-home online')

  init()
  document.addEventListener('DOMContentLoaded', () => {
    init()
  })
  setTimeout(() => {
    init()
  }, 0)
}

main()
