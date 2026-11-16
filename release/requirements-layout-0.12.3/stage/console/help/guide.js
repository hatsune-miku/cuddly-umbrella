const sectionLinks = [...document.querySelectorAll('.help-sidebar .chapter-link')]
const sections = [...document.querySelectorAll('.guide-section')]
const search = document.querySelector('#guide-search')
const searchStatus = document.querySelector('#search-status')
const mobileNavigation = document.querySelector('.mobile-navigation')
const searchText = sections.map((section) => section.textContent.toLocaleLowerCase())

search?.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase()
  let count = 0
  sectionLinks.forEach((link, index) => {
    link.hidden = Boolean(query && !searchText[index]?.includes(query))
    if (!link.hidden) count += 1
  })
  document.querySelectorAll('.help-sidebar .nav-group').forEach((group) => {
    group.hidden = ![...group.querySelectorAll('.chapter-link')].some((link) => !link.hidden)
  })
  searchStatus.textContent = query
    ? count
      ? `${count} 个相关章节，选择后前往`
      : '没有匹配章节，试试分支、分享或登录'
    : ''
})
search?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    search.value = ''
    search.dispatchEvent(new Event('input'))
  } else if (event.key === 'Enter') {
    const match = sectionLinks.find((link) => !link.hidden)
    if (match) {
      match.click()
      document.querySelector(match.getAttribute('href'))?.focus({ preventScroll: true })
    }
  }
})
document.querySelectorAll('.chapter-link').forEach((link) =>
  link.addEventListener('click', () => {
    if (mobileNavigation) mobileNavigation.open = false
  })
)
const allChapterLinks = [...document.querySelectorAll('.chapter-link')]
let navigationFrame = null
let activeChapter = null
function updateActiveChapter() {
  if (navigationFrame !== null) return
  navigationFrame = requestAnimationFrame(() => {
    navigationFrame = null
    const id =
      sections.findLast((section) => section.getBoundingClientRect().top <= 125)?.id ||
      sections[0]?.id
    if (id === activeChapter) return
    activeChapter = id
    allChapterLinks.forEach((link) => {
      if (link.getAttribute('href') === `#${id}`) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    })
  })
}
window.addEventListener('scroll', updateActiveChapter, { passive: true })
window.addEventListener('resize', updateActiveChapter, { passive: true })
updateActiveChapter()

document.querySelector('#print-guide')?.addEventListener('click', () => window.print())
const dialog = document.querySelector('#image-dialog')
let trigger = null
document.querySelectorAll('[data-zoom]').forEach((link) =>
  link.addEventListener('click', (event) => {
    if (!dialog?.showModal || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return
    event.preventDefault()
    trigger = link
    dialog.querySelector('img').src = link.href
    dialog.querySelector('img').alt = link.querySelector('img').alt
    dialog.querySelector('h2').textContent = link.dataset.zoom
    dialog.showModal()
    dialog.querySelector('button').focus()
  })
)
dialog?.querySelector('button').addEventListener('click', () => dialog.close())
dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close()
})
dialog?.addEventListener('close', () => trigger?.focus())
