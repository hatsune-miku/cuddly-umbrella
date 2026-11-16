const fs = require('fs')
const path = require('path')

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getIconDataUri(iconPath) {
  try {
    return `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`
  } catch {
    return ''
  }
}

function renderInstallation(installation, index) {
  const inputId = `installation-${index}`
  const statusClass = ['current', 'outdated', 'newer', 'legacy'].includes(installation.injectionStatus)
    ? installation.injectionStatus
    : ['ready', 'extracted', 'packed'].includes(installation.status) ? installation.status : 'unavailable'
  const version = installation.targetInjectorVersion
  const feedback = installation.injectionStatus === 'newer'
    ? `将把注入器 v${installation.injectedVersion} 替换为 v${version}`
    : installation.injectionStatus === 'outdated'
      ? `将更新注入器 v${installation.injectedVersion} → v${version}`
      : installation.injectionStatus === 'legacy' ? `将把旧版注入更新至 v${version}` : '将检查注入文件并应用所选插件'

  return `
    <div class="installation">
      <input id="${inputId}" type="radio" name="installation" value="${escapeHtml(installation.id)}" data-action="${escapeHtml(installation.actionLabel || '应用并启动')}" data-feedback="${escapeHtml(feedback)}">
      <label for="${inputId}">
        <span class="choice-indicator" aria-hidden="true"></span>
        <span class="installation-content">
          <span class="installation-heading">
            <strong>KOOK ${escapeHtml(installation.label)}</strong>
            <span class="source">${escapeHtml(installation.sourceLabel)}</span>
            ${installation.isNewestLocalVersion ? '<span class="client-age">本机最新</span>' : installation.isOlderLocalVersion ? '<span class="client-age">较早版本</span>' : ''}
            <span class="status status-${statusClass}">${escapeHtml(installation.statusLabel)}</span>
          </span>
          ${installation.injectionDetail ? `<span class="injection-version">${escapeHtml(installation.injectionDetail)}</span>` : ''}
          <span class="installation-path" title="${escapeHtml(installation.appDir)}">${escapeHtml(installation.appDir)}</span>
        </span>
      </label>
    </div>`
}

function renderSelectorPage(installations, options = {}) {
  const toolVersion = options.toolVersion || require('../package.json').version
  const nonce = options.nonce || ''
  const iconDataUri = options.iconDataUri ?? getIconDataUri(
    options.iconPath || path.join(__dirname, '..', 'plugin-icon.png')
  )
  const items = installations.map(renderInstallation).join('')
  const dlcs = options.dlcs || []
  const dlcSummary = options.dlcSource === 'standalone'
    ? '<p class="dlc-summary feedback-note">更新注入器并保留已安装插件。新增插件可在 KOOK 插件中心导入 DLC ZIP。</p>'
    : options.dlcSource ? `
    <details class="dlc-summary">
      <summary class="dlc-summary-heading">注入器 DLC <span class="dlc-summary-count">${dlcs.length} 项</span><span class="dlc-summary-source">${options.dlcSource === 'kfc' ? 'KFC 已安装' : '本地开发'}</span></summary>
      <ul class="dlc-summary-list">${dlcs.map((dlc) => `<li class="dlc-summary-item"><span class="dlc-summary-name">${escapeHtml(dlc.name)}</span><span class="dlc-summary-meta">rin · v${escapeHtml(dlc.version)}</span></li>`).join('')}</ul>
    </details>` : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KOOK PC 注入工具</title>
  <style>
    :root {
      color-scheme: dark;
      --background: #191b1d;
      --surface: #272b2d;
      --surface-hover: #2d3133;
      --border: rgba(255,255,255,.075);
      --text: #edf0ed;
      --muted: #b1b9bd;
      --subtle: #a1aaaf;
      --primary: #7acc35;
      --primary-hover: #8cd845;
      --primary-text: #ffffff;
      --warning: #e2b76e;
    }

    * { box-sizing: border-box; }

    html, body { min-width: 320px; min-height: 100%; margin: 0; }

    body {
      height: 100vh;
      padding: 14px;
      overflow: hidden;
      background: var(--background);
      color: var(--text);
      font-family: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.5;
      letter-spacing: 0;
    }

    button, input, select { font: inherit; letter-spacing: 0; }

    .app {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      width: 100%;
      height: 100%;
      max-width: 960px;
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 18px;
      background: linear-gradient(180deg, #26282a, #1b1d1f);
      animation: arrive 200ms cubic-bezier(.29,0,0,1);
    }

    header {
      display: flex;
      align-items: center;
      min-height: 78px;
      gap: 12px;
      padding: 17px 22px;
      border-bottom: 1px solid var(--border);
    }

    .app-icon {
      width: 40px;
      height: 40px;
      flex: 0 0 40px;
      border-radius: 10px;
      object-fit: contain;
    }

    .title-block { min-width: 0; }

    h1 {
      margin: 0 0 4px;
      font-size: 20px;
      line-height: 1.35;
      font-weight: 600;
    }

    .subtitle { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }

    .list-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 17px 22px 11px;
    }

    h2 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
    .instance-count { margin-left: 8px; color: #b4cf9d; font-weight: 400; font-variant-numeric: tabular-nums; }
    .list-caption { color: var(--subtle); font-size: 12px; }

    main {
      min-height: 0;
      overflow: auto;
      padding: 2px 22px 16px;
      scrollbar-color: rgba(255,255,255,.18) transparent;
      scrollbar-width: thin;
      scrollbar-gutter: stable;
    }

    main::-webkit-scrollbar { width: 6px; }
    main::-webkit-scrollbar-thumb { border-radius: 6px; background: rgba(255,255,255,.18); }

    .installation-list {
      display: grid;
      gap: 8px;
      margin: 0 auto;
    }

    .dlc-summary { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
    .dlc-summary-heading { cursor: pointer; color: var(--text); padding: 4px 0; }
    .dlc-summary-heading:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
    .dlc-summary-count { color: #b4cf9d; margin-left: 6px; font-variant-numeric: tabular-nums; }
    .dlc-summary-source { margin-left: 12px; color: var(--muted); font-size: 12px; }
    .dlc-summary-list { display: grid; gap: 0; margin: 8px 0 0; padding: 0; list-style: none; }
    .dlc-summary-item { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0; }
    .dlc-summary-name { min-width: 0; overflow-wrap: anywhere; }
    .dlc-summary-meta { flex: 0 0 auto; color: var(--muted); font-size: 12px; }

    .installation { position: relative; }

    .installation input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .installation label {
      display: flex;
      align-items: center;
      min-height: 72px;
      gap: 12px;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      cursor: pointer;
      transition: background-color 150ms ease, border-color 150ms ease;
    }

    .installation label:hover { background: var(--surface-hover); border-color: rgba(255,255,255,.16); }

    .installation input:focus-visible + label {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }

    .installation input:checked + label {
      border-color: rgba(122,204,53,.38);
      background: #2a3027;
    }

    .choice-indicator {
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
      border: 1px solid #69716c;
      border-radius: 50%;
      box-shadow: inset 0 0 0 4px var(--surface);
      transition: background-color 150ms ease, border-color 150ms ease;
    }

    .installation input:checked + label .choice-indicator {
      background: var(--primary);
      border-color: var(--primary);
      box-shadow: inset 0 0 0 4px #2a3027;
    }

    .installation-content {
      display: grid;
      min-width: 0;
      flex: 1;
      gap: 5px;
    }

    .installation-heading {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .installation-heading strong { font-size: 14px; font-weight: 600; line-height: 1.5; font-variant-numeric: tabular-nums; }

    .source, .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 400;
      line-height: 1.35;
    }

    .source { background: rgba(255,255,255,.04); color: var(--muted); }
    .client-age { color: var(--subtle); font-size: 12px; }
    .injection-version { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .status { margin-left: auto; color: var(--muted); }
    .status::before { content: ''; width: 5px; height: 5px; flex: none; border-radius: 50%; background: currentColor; }
    .status-ready, .status-current { color: #b2cf9a; background: rgba(122,204,53,.055); }
    .status-extracted, .status-packed, .status-outdated, .status-legacy, .status-newer { color: var(--warning); background: rgba(226,183,110,.07); }

    .installation-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--subtle);
      font-size: 12px;
      line-height: 1.5;
    }

    footer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      min-height: 76px;
      gap: 10px;
      padding: 14px 22px;
      background: rgba(25,27,29,.7);
      border-top: 1px solid var(--border);
    }

    .feedback-block { min-width: 0; display: grid; gap: 3px; }
    .feedback-note { color: var(--subtle); font-size: 12px; line-height: 1.5; }

    #feedback {
      min-width: 0;
      color: var(--muted);
      line-height: 1.4;
    }

    button {
      min-height: 40px;
      padding: 0 16px;
      border-radius: 10px;
      border: 1px solid var(--border);
      cursor: pointer;
      font-weight: 600;
      transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease;
    }

    button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: 0.45; }
    .secondary { background: var(--surface); color: var(--text); }
    .secondary:hover:not(:disabled) { background: var(--surface-hover); }
    .primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 140px; border-color: var(--primary); background: var(--primary); color: var(--primary-text); }
    .primary:hover:not(:disabled) { border-color: var(--primary-hover); background: var(--primary-hover); }
    .primary svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    @keyframes arrive { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    @media (max-width: 560px) {
      body { padding: 8px; }
      header, main, footer, .list-heading { padding-left: 16px; padding-right: 16px; }
      header { padding-top: 16px; padding-bottom: 16px; }
      h1 { font-size: 19px; }
      .list-caption { display: none; }
      .installation label { padding: 12px; gap: 10px; }
      .status { margin-left: 0; }
      .installation-path { white-space: normal; overflow-wrap: anywhere; }
      footer { grid-template-columns: 1fr 1fr; }
      .feedback-block { grid-column: 1 / -1; }
      button { width: 100%; }
    }

    @media (max-height: 440px) {
      body { padding: 0; }
      .app { border-radius: 0; }
      header { min-height: 64px; padding-top: 10px; padding-bottom: 10px; }
      .app-icon { width: 36px; height: 36px; flex-basis: 36px; }
      .list-heading { padding-top: 10px; padding-bottom: 10px; }
      footer { min-height: 64px; padding-top: 10px; padding-bottom: 10px; }
      .feedback-note { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <form class="app" id="selector-form">
    <header>
      ${iconDataUri ? `<img class="app-icon" src="${iconDataUri}" alt="">` : ''}
      <div class="title-block">
        <h1>KOOK PC 注入工具</h1>
        <p class="subtitle">选择要加载插件的 KOOK 实例 · 本次注入器 v${escapeHtml(toolVersion)}</p>
      </div>
    </header>
    <div class="list-heading">
      <h2 id="versions-heading">选择 KOOK 版本<span class="instance-count">${installations.length}</span></h2>
      <span class="list-caption">已扫描本机安装实例</span>
    </div>
    <main aria-labelledby="versions-heading">
      <div class="installation-list">${items}</div>
      ${dlcSummary}
    </main>
    <footer>
      <div class="feedback-block">
        <span id="feedback" role="status" aria-live="polite">选择一个实例以继续</span>
        <span class="feedback-note">选定后将处理并启动该版本</span>
      </div>
      <button class="secondary" id="cancel-button" type="button">取消</button>
      <button class="primary" id="confirm-button" type="submit" disabled>${options.dlcSource ? '应用并启动' : '处理并启动'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </footer>
  </form>
  <script nonce="${escapeHtml(nonce)}">
    (() => {
      const form = document.getElementById('selector-form');
      const confirmButton = document.getElementById('confirm-button');
      const cancelButton = document.getElementById('cancel-button');
      const feedback = document.getElementById('feedback');
      const confirmLabel = document.createElement('span');
      confirmLabel.textContent = confirmButton.firstChild.textContent;
      confirmButton.replaceChild(confirmLabel, confirmButton.firstChild);
      let completed = false;

      const route = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) : location.pathname;
      const endpoint = (action) => route + '/' + action;
      const setBusy = (busy) => {
        confirmButton.disabled = busy || !form.elements.installation.value;
        cancelButton.disabled = busy;
      };

      form.addEventListener('change', () => {
        confirmButton.disabled = !form.elements.installation.value;
        const selected = form.querySelector('input[name="installation"]:checked');
        feedback.textContent = selected?.dataset.feedback || '准备处理所选实例';
        confirmLabel.textContent = selected?.dataset.action || '应用并启动';
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const id = form.elements.installation.value;
        if (!id || completed) return;
        setBusy(true);
        feedback.textContent = '正在提交选择...';
        try {
          const response = await fetch(endpoint('select'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id })
          });
          if (!response.ok) throw new Error('提交失败');
          completed = true;
          feedback.textContent = '已选择，正在处理 KOOK';
          window.setTimeout(() => window.close(), 120);
        } catch {
          feedback.textContent = '提交失败，请重试';
          setBusy(false);
        }
      });

      const cancel = async () => {
        if (completed) return;
        completed = true;
        setBusy(true);
        feedback.textContent = '正在取消...';
        try {
          await fetch(endpoint('cancel'), { method: 'POST', keepalive: true });
        } finally {
          feedback.textContent = '操作已取消';
          window.setTimeout(() => window.close(), 60);
        }
      };

      cancelButton.addEventListener('click', cancel);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') cancel();
      });
      window.addEventListener('pagehide', () => {
        if (!completed) navigator.sendBeacon(endpoint('cancel'));
      });
    })();
  </script>
</body>
</html>`
}

module.exports = { escapeHtml, renderSelectorPage }
