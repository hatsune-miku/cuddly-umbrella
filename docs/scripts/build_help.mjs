import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cakePrimitives } from '../../apps/browser-extension/cakeui-primitives.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'apps/console/public/help')
const { name: productName } = JSON.parse(
  await fs.readFile(path.join(root, 'product.config.json'), 'utf8')
)
const { version } = JSON.parse(
  await fs.readFile(path.join(root, 'apps/browser-extension/manifest.json'), 'utf8')
)
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
const inline = (s) =>
  esc(s.replaceAll('Bifrost', productName))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/https:\/\/bifrost\.vanillacake\.cn\//g, '<a href="/">bifrost.vanillacake.cn</a>')
const ids = [
  'start',
  'install',
  'branches',
  'environments',
  'builds',
  'sharing',
  'isolation',
  'settings',
  'troubleshooting',
  'checklist',
]
const navTitles = [
  '快速开始',
  '安装与登录',
  '选择分支并应用',
  '环境与页面来源',
  '构建队列与记录',
  '创建提测分享',
  '更新与隔离边界',
  '环境与项目设置',
  '常见问题',
  '提测检查清单',
]
const figures = {
  start: [
    {
      file: 'console-projects.png',
      title: '主站的项目与分支总览',
      wide: true,
      notes: [
        '顶部先确认环境，页面与热更项目按行列出。',
        '队列展示全局任务与发起人；项目行负责选择分支和发起构建。',
      ],
    },
  ],
  branches: [
    {
      file: 'extension-projects.png',
      title: '为当前标签页组合版本',
      notes: [
        '先看环境：它决定后端和可用产物。',
        '项目独立选择：保留官方来源，或选择已构建分支。',
        '最后应用：下拉框是草稿，底部按钮才让选择生效。',
      ],
    },
    {
      file: 'extension-branches.png',
      title: '搜索分支并确认构建状态',
      notes: [
        '在搜索框输入分支关键词，列表仍保留构建状态。',
        '正在打包、上次失败、已有可用包，都可以在选择时看清。',
      ],
    },
  ],
  builds: [
    {
      file: 'extension-queue.png',
      title: '构建队列',
      notes: ['当前队列显示谁在打包、谁在等待。', '切到构建记录，可查失败和取消的历史任务。'],
    },
    {
      file: 'extension-job.png',
      title: '构建任务详情',
      notes: ['从任务进入时间线、命令和日志。', '中断按钮仅在可中断状态显示；失败后可重试。'],
    },
  ],
  sharing: [
    {
      file: 'extension-share.png',
      title: '命名需求并生成分享地址',
      notes: [
        '配置组名称用于按需求查找。',
        'URL 前缀可留空，也可以填写中文名称。',
        '创建并复制后，把预览链接放进提测单。',
      ],
    },
    {
      file: 'console-requirements.png',
      title: '主站按需求查看和管理',
      wide: true,
      notes: [
        '同一处列出所有人创建的需求，按创建时间排序。',
        '使用需求、复制链接、编辑和删除都在对应条目上完成。',
      ],
    },
  ],
}

function figure(item) {
  const popup = item.file.startsWith('extension-')
  const img = `<a class="screen-frame" href="images/${item.file}" data-zoom="${esc(item.title)}" target="_blank" rel="noreferrer" aria-label="放大查看${esc(item.title)}"><img src="images/${item.file}" alt="${esc(item.title)}，当前界面使用演示账号和分支数据" width="${popup ? 1120 : 2360}" height="${popup ? 1200 : 1600}" loading="lazy" decoding="async"><span class="zoom-hint" aria-hidden="true">放大查看</span></a>`
  const notes = `<figcaption><ol class="figure-notes">${item.notes.map((note, i) => `<li><b>${String(i + 1).padStart(2, '0')}</b><span>${esc(note)}</span></li>`).join('')}</ol><p class="figure-caption">真实界面 · 演示数据，不代表当前部署配置。</p></figcaption>`
  return `<figure class="guide-figure"><div class="figure-heading"><strong>${esc(item.title)}</strong><span>支持查看大图</span></div>${item.wide ? img + notes : `<div class="figure-side">${img}${notes}</div>`}</figure>`
}

function content(source, index) {
  const lines = source.trim().split(/\r?\n/)
  let result = '',
    list = null
  const closeList = () => {
    if (list) {
      result += `</${list}>`
      list = null
    }
  }
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].trim()
    if (!s) {
      closeList()
      continue
    }
    if (s.startsWith('# ')) continue
    if (s.startsWith('2026 年')) continue
    if (s === '## 按任务查阅') break
    if (s.startsWith('## ')) {
      closeList()
      result += `<h3>${inline(s.slice(3))}</h3>`
      continue
    }
    if (s === ':::flow') {
      closeList()
      const labels = lines[++i].split('|')
      result += `<ol class="guide-flow" aria-label="操作顺序">${labels.map((text, k) => `<li><b aria-hidden="true">${k + 1}</b>${esc(text)}</li>`).join('')}</ol>`
      i++
      continue
    }
    if (s === ':::timeline') {
      closeList()
      result += '<ol class="timeline" aria-label="新旧包切换示例">'
      while (lines[++i]?.trim() !== ':::') {
        const [time, title, detail] = lines[i].split('|')
        result += `<li><time>${esc(time)}</time><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div></li>`
      }
      result += '</ol>'
      continue
    }
    if (s.startsWith('|')) {
      closeList()
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i]
          .trim()
          .slice(1, -1)
          .split('|')
          .map((x) => x.trim())
        if (!cells.every((x) => /^:?-+:?$/.test(x))) rows.push(cells)
        i++
      }
      i--
      result += `<div class="table-scroll" role="region" tabindex="0" aria-label="${esc(navTitles[index])}对照表"><table><thead><tr>${rows[0].map((x) => `<th scope="col">${inline(x)}</th>`).join('')}</tr></thead><tbody>${rows
        .slice(1)
        .map((row) => `<tr>${row.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
      continue
    }
    const type = /^\d+\. /.test(s) ? 'ol' : s.startsWith('- ') ? 'ul' : null
    if (type) {
      if (list !== type) {
        closeList()
        list = type
        result += `<${type}>`
      }
      result += `<li>${inline(s.replace(/^\d+\. |^- /, ''))}</li>`
    } else {
      closeList()
      result += `<p${s.startsWith('面向 QA') ? ' class="subtitle"' : ''}>${inline(s)}</p>`
    }
  }
  closeList()
  return result
}

await fs.mkdir(output, { recursive: true })
for (const item of Object.values(figures).flat()) {
  await fs.access(path.join(output, 'images', item.file))
}
const source = await fs.readFile(path.join(root, 'docs/BIFROST_USER_GUIDE.md'), 'utf8')
const chapters = source.split('<!-- sources -->')[0].split('<!-- page -->')
if (chapters.length !== ids.length)
  throw new Error('Update help chapter metadata when changing the source structure')
const groupedNav = (mobile = false) =>
  [
    [0, 2, '开始使用'],
    [2, 7, '日常工作'],
    [7, 10, '设置与排障'],
  ]
    .map(
      ([start, end, label]) =>
        `<div class="nav-group"><p class="nav-group-title">${label}</p>${ids
          .slice(start, end)
          .map(
            (id, offset) =>
              `<a class="chapter-link" href="#${id}"><span>${String(start + offset + 1).padStart(2, '0')}</span>${navTitles[start + offset]}</a>`
          )
          .join('')}</div>`
    )
    .join('')
const sections = chapters
  .map((chapter, i) => {
    const title = chapter.trim().split('\n')[0].slice(2).trim()
    const heading =
      i === 0
        ? `<p class="section-kicker">面向 QA 与研发 · 图文指南</p><h1>使用教程</h1>`
        : `<div class="section-heading"><span class="section-number">${String(i + 1).padStart(2, '0')}</span><h2>${esc(title)}</h2></div>`
    let body = content(chapter, i)
    const images = (figures[ids[i]] || []).map(figure).join('')
    // Keep instructions and their illustrations together before deeper reference material.
    if (images) {
      if (i === 0) body += images
      else {
        const insertAt = body.indexOf('<h3>')
        body =
          insertAt < 0 ? body + images : body.slice(0, insertAt) + images + body.slice(insertAt)
      }
    }
    return `<section id="${ids[i]}" class="guide-section" tabindex="-1" aria-label="${esc(navTitles[i])}">${heading}${body}</section>`
  })
  .join('\n')
const document = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="description" content="${esc(productName)} 图文使用教程，介绍分支选择、构建队列、热更替换与需求分享。"><title>使用教程 · ${esc(productName)}</title><link rel="stylesheet" href="guide.css"><script src="guide.js" defer></script></head>
<body><a class="skip-link" href="#help-content">跳到教程正文</a>
<header class="help-header"><div class="help-header-inner"><a class="help-brand" href="#start"><span>${esc(productName)}</span><strong>使用教程</strong></a><nav class="header-actions" aria-label="教程操作"><a href="/">返回控制台</a><a href="guide.pdf" download="${esc(productName)}_使用教程.pdf">PDF 版</a><button type="button" id="print-guide">打印图文版</button></nav></div></header>
<div class="help-layout"><aside class="help-sidebar"><label for="guide-search" class="search-label">查找操作</label><input class="help-search" id="guide-search" type="search" placeholder="搜索分支、分享、登录…" aria-describedby="search-status"><p id="search-status" class="search-status" role="status"></p><nav aria-label="教程章节">${groupedNav()}</nav><p class="sidebar-meta">更新于 2026-09-16<br>适用扩展 ${esc(version)}<br>阅读无需登录</p></aside>
<details class="mobile-navigation"><summary>浏览教程目录</summary><nav aria-label="移动端教程章节">${groupedNav(true)}</nav></details>
<main class="help-content" id="help-content" tabindex="-1">${sections}<footer class="help-end"><p>教程中的截图由当前界面使用演示数据生成，不包含真实账号、仓库凭据或登录令牌。业务操作仍需登录。</p><p><a href="guide.md" download>下载 Markdown 源稿</a><a href="#start">回到开头</a></p><p>Proudly Crafted With CakeDesign.</p></footer></main></div>
<dialog class="image-dialog" id="image-dialog" aria-labelledby="image-dialog-title"><div class="image-dialog-header"><h2 id="image-dialog-title">界面大图</h2><button type="button">关闭</button></div><img alt=""><p>真实界面 · 演示数据。按 Esc 可关闭。</p></dialog>
</body></html>`
const cakeDocument = document
  .replace(
    '<body>',
    '<body class="cake-theme" data-theme="blue" data-mode="light" data-density="compact">'
  )
  .replace(
    '<link rel="stylesheet" href="guide.css">',
    '<link rel="stylesheet" href="guide.css"><link rel="stylesheet" href="cakeui.css"><link rel="stylesheet" href="cakeui-theme.css">'
  )
  .replace('class="help-search"', `class="help-search ${cakePrimitives.text.attributes.class}"`)
  .replaceAll(
    '<button type="button"',
    `<button class="${cakePrimitives.button.attributes.class}" data-variant="ghost" data-size="small" type="button"`
  )
await fs.writeFile(path.join(output, 'index.html'), cakeDocument)
await fs.copyFile(path.join(root, 'docs/help/guide.css'), path.join(output, 'guide.css'))
await fs.copyFile(path.join(root, 'docs/help/guide.js'), path.join(output, 'guide.js'))
await fs.writeFile(path.join(output, 'guide.md'), source.split('<!-- sources -->')[0])
await fs
  .copyFile(path.join(root, 'output/pdf/Bifrost_使用教程.pdf'), path.join(output, 'guide.pdf'))
  .catch(async (error) => {
    if (error.code !== 'ENOENT') throw error
    await fs.access(path.join(output, 'guide.pdf'))
  })
console.log(`[help] Built ${ids.length} chapters at ${output}`)
