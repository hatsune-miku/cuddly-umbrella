// KOOK Plugin UI - 鎻掍欢绠＄悊鐣岄潰

if (window.KOOKPluginUI) {
  console.log('[KOOK Plugin UI] Already loaded, skipping...');
} else if (typeof document === 'undefined') {
  console.log('[KOOK Plugin UI] Running in Node.js environment, skipping UI code');
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {};
  }
} else {
  console.log('[KOOK Plugin UI] ====== Plugin UI script loaded ======');

const PLUGIN_CONFIG = {
  paths: {
    pluginIcon: '/app/plugin-icon.png',
    pluginList: '/app/plugins/manifest.json',
    pluginFile: '/app/plugins/'
  },
  validation: {
    urlPattern: /^https?:\/\/.+\.(js|json)$/i,
    allowedFileTypes: ['.js', '.json'],
    maxFileSize: 1024 * 1024,
    maxCodeLength: 500000,
    whitelist: [
      'environment-switcher'
    ]
  },
  retry: {
    maxAttempts: 3,
    delay: 1000
  },
  observer: {
    entryButtonPollInterval: 1500,
    dragThreshold: 5
  },
  storage: {
    positionKey: 'kook-plugin-btn-position',
    stateKey: 'kook-plugin-state',
    importedKey: 'kook-imported-plugins',
    panelHeightKey: 'kook-plugin-panel-height',
    sortModeKey: 'kook-plugin-sort-mode',
    sortDirectionKey: 'kook-plugin-sort-direction',
    customOrderKey: 'kook-plugin-custom-order',
    addedAtKey: 'kook-plugin-added-at',
    pinnedPluginsKey: 'kook-plugin-pinned-ids'
  }
};

const URL_PATTERN = PLUGIN_CONFIG.validation.urlPattern;
const ALLOWED_FILE_TYPES = PLUGIN_CONFIG.validation.allowedFileTypes;
const MAX_FILE_SIZE = PLUGIN_CONFIG.validation.maxFileSize;

function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL 不能为空' };
  }
  
  if (!PLUGIN_CONFIG.validation.urlPattern.test(url)) {
    return { valid: false, error: 'URL 格式不正确，必须以 .js 或 .json 结尾' };
  }
  
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return { valid: false, error: '只支持 HTTP 和 HTTPS 协议' };
    }
    
    const hostname = urlObj.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
    if (blockedHosts.includes(hostname)) {
      return { valid: false, error: '不允许访问本地地址' };
    }
    
    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'URL 格式无效' };
  }
}

function validateFile(file) {
  if (!file) {
    return { valid: false, error: '请选择文件' };
  }
  
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (!PLUGIN_CONFIG.validation.allowedFileTypes.includes(ext)) {
    return { valid: false, error: `只支持 ${PLUGIN_CONFIG.validation.allowedFileTypes.join(', ')} 文件` };
  }
  
  if (file.size > PLUGIN_CONFIG.validation.maxFileSize) {
    return { valid: false, error: `文件大小不能超过 ${PLUGIN_CONFIG.validation.maxFileSize / 1024}KB` };
  }
  
  return { valid: true };
}

function extractPluginName(code) {
  const nameMatch = code.match(/name:\s*['"]([^'"]+)['"]/);
  if (nameMatch && nameMatch[1]) {
    return nameMatch[1];
  }
  return null;
}

function validatePluginCode(code, pluginName) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: '插件代码不能为空' };
  }

  if (code.length > PLUGIN_CONFIG.validation.maxCodeLength) {
    return { valid: false, error: '插件代码过长' };
  }

  if (pluginName && PLUGIN_CONFIG.validation.whitelist.includes(pluginName)) {
    return { valid: true };
  }

  const dangerousPatterns = [
    /eval\s*\(/,
    /Function\s*\(/,
    /require\s*\(['"]child_process['"]\)/,
    /require\s*\(['"]fs['"]\)/,
    /\.exec\s*\(/,
    /\.spawn\s*\(/,
    /import\s*\(/
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(code)) {
      return { valid: false, error: '插件代码包含不安全的操作' };
    }
  }

  return { valid: true };
}

async function fetchWithRetry(url, options = {}, retries = PLUGIN_CONFIG.retry.maxAttempts) {
  try {
    const response = await fetch(url, options);
    
    if (response.ok) {
      return response;
    }
    
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  } catch (error) {
    if (retries <= 1) {
      throw error;
    }
    
    console.log(`[Plugin UI] Fetch failed, retrying... (${retries - 1} attempts left)`);
    await new Promise(resolve => setTimeout(resolve, PLUGIN_CONFIG.retry.delay));
    return fetchWithRetry(url, options, retries - 1);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const KOOK_THEME = {
  colors: {
    bg: '#252629',
    bgDark: '#17181a',
    bgLight: 'rgba(255,255, 255, 0.08)',
    bgLighter: 'rgba(255, 255, 255, 0.12)',
    text: '#fff',
    textSecondary: '#ccc',
    textTertiary: '#999',
    primary: '#7acc35',        // KOOK 涓婚鑹?    primaryHover: '#6ab52f',    // 绋嶆繁涓€鐐圭殑缁胯壊锛坔over 鐘舵€侊級
    border: 'rgba(255, 255, 255, 0.1)',
    divider: 'rgba(255, 255, 255, 0.06)',
    success: '#7ec699',
    warning: '#f08d49',
    error: '#e2777a'
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32
  },
  borderRadius: {
    sm: 6,
    md: 8,
    lg: 12,
    xl: 16
  },
  fontSize: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 20
  },
  boxShadow: {
    sm: '0 2px 4px rgba(0, 0, 0, 0.32)',
    md: '0 4px 12px rgba(0, 0, 0, 0.4)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.5)'
  },
  transition: '0.2s cubic-bezier(0.215, 0.61, 0.355, 1)'
};

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .plugin-panel {
      font-family: Whitney, Helvetica Neue, Helvetica, Arial, sans-serif;
      background: linear-gradient(180deg, rgba(37, 38, 41, 0.98), rgba(28, 29, 32, 0.98));
      border-radius: ${KOOK_THEME.borderRadius.xl}px;
      box-shadow: ${KOOK_THEME.boxShadow.lg};
      color: ${KOOK_THEME.colors.text};
      backdrop-filter: blur(18px);
    }
    
    .plugin-item:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(122, 204, 53, 0.3);
      transform: translateY(-1px);
    }

    .plugin-item.is-enabled {
      border-color: rgba(122, 204, 53, 0.28);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16), inset 0 0 0 1px rgba(122, 204, 53, 0.08);
    }

    .plugin-item.is-sortable {
      cursor: grab;
    }

    #kook-plugin-panel .plugin-pin-star {color:#7acc35;font-size:11px;line-height:1;flex-shrink:0;}
    .plugin-panel-menu {box-sizing:border-box;min-width:158px;padding:5px;background:#303638;border:1px solid rgba(255,255,255,.08);border-radius:8px;box-shadow:0 12px 28px #0005;color:#e5e9e6;font:13px/1.5 Whitney,"Helvetica Neue",Helvetica,Arial,sans-serif;}
    .plugin-panel-menu button {display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:7px 10px;background:transparent;border:0;border-radius:5px;text-align:left;color:inherit;font:inherit;cursor:pointer;}
    .plugin-panel-menu button:hover,.plugin-panel-menu button:focus-visible {background:rgba(255,255,255,.08);color:#fff;outline:none;}
    .plugin-panel-menu button:focus-visible {box-shadow:inset 0 0 0 1px rgba(255,255,255,.2);}
    .plugin-panel-menu svg {width:15px;height:15px;flex-shrink:0;color:#aeb7b1;}
    .plugin-pin-menu {position:fixed;z-index:100001;max-width:224px;}
    #kook-plugin-panel .plugin-toolbar-host[hidden] {display:none;}
    #kook-plugin-panel .plugin-item:focus-visible {outline:2px solid #7acc35;outline-offset:2px;}

    .plugin-item.is-sortable:active {
      cursor: grabbing;
    }

    .plugin-item.is-drag-origin {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.025));
      border: 1px solid rgba(122, 204, 53, 0.24);
      box-shadow: inset 0 0 0 1px rgba(122, 204, 53, 0.08);
    }

    .plugin-item.is-drag-origin > * {
      opacity: 0.36;
    }

    .plugin-item.is-dragging {
      opacity: 0.78;
      transform: scale(0.992) translateY(-2px);
      box-shadow: 0 18px 34px rgba(0, 0, 0, 0.26), inset 0 0 0 1px rgba(122, 204, 53, 0.08);
    }

    .plugin-item.drop-before {
      box-shadow: inset 0 3px 0 rgba(122, 204, 53, 0.9);
    }

    .plugin-item.drop-after {
      box-shadow: inset 0 -3px 0 rgba(122, 204, 53, 0.9);
    }

    .plugin-list.is-drag-active {
      border-radius: 18px;
      outline: 2px solid rgba(122, 204, 53, 0.72);
      outline-offset: 6px;
      box-shadow: 0 0 0 1px rgba(122, 204, 53, 0.12);
    }

    .plugin-switch {
      position: relative;
      width: 48px;
      height: 28px;
      background: ${KOOK_THEME.colors.bgDark};
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      cursor: pointer;
      transition: all ${KOOK_THEME.transition};
      flex-shrink: 0;
    }
    
    .plugin-switch.active {
      background: linear-gradient(180deg, rgba(122, 204, 53, 0.95), rgba(106, 181, 47, 0.95));
      border-color: rgba(122, 204, 53, 0.6);
    }

    .plugin-switch[data-busy="true"] {
      opacity: 0.65;
      cursor: wait;
    }
    
    .plugin-switch-handle {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      background: #fff;
      border-radius: 50%;
      transition: all ${KOOK_THEME.transition};
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
    }
    
    .plugin-switch.active .plugin-switch-handle {
      transform: translateX(20px);
    }

    .plugin-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
    }

    .plugin-badge.status-enabled {
      background: rgba(122, 204, 53, 0.16);
      color: #b9f58a;
      border: 1px solid rgba(122, 204, 53, 0.24);
    }

    .plugin-badge.status-disabled {
      background: rgba(255, 255, 255, 0.06);
      color: ${KOOK_THEME.colors.textSecondary};
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .plugin-badge.meta {
      background: rgba(255, 255, 255, 0.05);
      color: ${KOOK_THEME.colors.textTertiary};
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-weight: 500;
    }
    
    .plugin-empty-icon {
      width: 64px;
      height: 64px;
      border-radius: ${KOOK_THEME.borderRadius.lg}px;
      background: linear-gradient(135deg, ${KOOK_THEME.colors.primary}, ${KOOK_THEME.colors.primaryHover});
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: 600;
      color: #fff;
      margin: 0 auto ${KOOK_THEME.spacing.lg}px;
    }
    
    .plugin-empty-title {
      font-size: ${KOOK_THEME.fontSize.lg}px;
      font-weight: 600;
      color: ${KOOK_THEME.colors.text};
      margin-bottom: ${KOOK_THEME.spacing.sm}px;
    }
    
    .plugin-empty-desc {
      font-size: ${KOOK_THEME.fontSize.sm}px;
      color: ${KOOK_THEME.colors.textSecondary};
      line-height: 1.6;
    }
    
    .plugin-dialog-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100001;
    }
    
    .plugin-dialog {
      background: ${KOOK_THEME.colors.bg};
      border-radius: ${KOOK_THEME.borderRadius.xl}px;
      padding: ${KOOK_THEME.spacing.xxxl}px;
      min-width: 400px;
      max-width: 90%;
      box-shadow: ${KOOK_THEME.boxShadow.lg};
    }
    
    .plugin-dialog h3 {
      margin: 0 0 ${KOOK_THEME.spacing.lg}px;
      font-size: ${KOOK_THEME.fontSize.lg}px;
      font-weight: 600;
      color: ${KOOK_THEME.colors.text};
    }
    
    .plugin-dialog p {
      margin: 0 0 ${KOOK_THEME.spacing.xl}px;
      font-size: ${KOOK_THEME.fontSize.sm}px;
      color: ${KOOK_THEME.colors.textSecondary};
    }
    
    .plugin-file-input {
      width: 100%;
      padding: ${KOOK_THEME.spacing.md}px;
      background: ${KOOK_THEME.colors.bgLight};
      border: 2px dashed ${KOOK_THEME.colors.border};
      border-radius: ${KOOK_THEME.borderRadius.md}px;
      color: ${KOOK_THEME.colors.text};
      font-size: ${KOOK_THEME.fontSize.sm}px;
      cursor: pointer;
      transition: all ${KOOK_THEME.transition};
    }
    
    .plugin-file-input:hover {
      border-color: ${KOOK_THEME.colors.primary};
      background: ${KOOK_THEME.colors.bgLighter};
    }
    
    .plugin-dialog-actions {
      display: flex;
      gap: ${KOOK_THEME.spacing.md}px;
      justify-content: flex-end;
      margin-top: ${KOOK_THEME.spacing.xl}px;
    }
    .plugin-dialog-overlay.plugin-import-overlay{z-index:1000100;padding:16px;box-sizing:border-box;background:transparent;pointer-events:none}
    .plugin-dialog-overlay.plugin-delete-overlay{background:rgba(0,0,0,.36);pointer-events:auto}
    .plugin-import-dialog{width:480px;min-width:0;max-width:calc(100vw - 32px);padding:24px;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;border:1px solid #7acc353d;border-radius:20px;background:linear-gradient(145deg,#26282a,#191b1d);box-shadow:none;color:#e5e9e6;font-family:inherit;font-size:14px;line-height:1.5;font-variant-ligatures:none;text-align:left;pointer-events:auto}
    .plugin-import-dialog *{box-sizing:border-box}
    .plugin-import-dialog :is(h3,p,label,input,button,a,summary,small,strong){font-family:inherit}
    .plugin-import-dialog h3{margin:0 0 8px;font-size:18px;line-height:1.4;font-weight:600;color:#f1f3f2}
    .plugin-import-dialog p{font-size:13px;line-height:1.6;overflow-wrap:anywhere;color:#aeb4b9}
    .plugin-import-dialog button{font:inherit;cursor:pointer;border:1px solid #ffffff14;border-radius:8px;min-height:34px;padding:7px 14px;background:#ffffff0a;color:#e5e9e6;transition:background .15s,border-color .15s,color .15s;-webkit-app-region:no-drag}
    .plugin-import-dialog button:hover:not(:disabled){background:#ffffff12;border-color:#ffffff20}
    .plugin-import-dialog button:disabled{opacity:.45;cursor:default}
    .plugin-import-dialog button:focus-visible,.plugin-import-dialog summary:focus-visible,.plugin-import-dialog input:focus-visible{outline:2px solid #7acc35;outline-offset:3px}
    .plugin-import-dialog .plugin-import-primary{background:#7acc35;border-color:transparent;color:#fff;font-weight:600}
    .plugin-import-dialog .plugin-import-primary:hover:not(:disabled){background:#8cd845;border-color:transparent}
    .plugin-panel-menu .plugin-delete-action{color:#ffc1b8}
    .plugin-import-dialog .plugin-delete-primary{background:#b34f48;border-color:transparent;color:#fff;font-weight:600}
    .plugin-import-dialog .plugin-delete-primary:hover:not(:disabled){background:#bf5b54;border-color:transparent}
    .plugin-import-dialog.plugin-package-dialog{display:flex;flex-direction:column;padding:0;overflow:hidden;scrollbar-gutter:auto}
    .plugin-import-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid #ffffff0e;flex-shrink:0;cursor:grab;user-select:none;touch-action:none}
    .plugin-import-dialog[data-dragging] .plugin-import-header{cursor:grabbing}
    .plugin-import-header>div{min-width:0}
    .plugin-import-dialog .plugin-import-header h3{margin:0;font-size:18px;line-height:1.4;font-weight:600}
    .plugin-import-dialog .plugin-import-header p{margin:5px 0 0;font-size:12px}
    .plugin-import-dialog .plugin-import-close{display:flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;min-height:34px;padding:8px;margin-top:1px;border-radius:10px;color:#e5e9e6}
    .plugin-import-close svg{width:16px;height:16px}
    .plugin-import-body{padding:18px;overflow:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#ffffff24 transparent}
    .plugin-import-dialog .plugin-package-pick{display:flex;align-items:center;gap:12px;width:100%;margin:0;padding:18px 16px;background:#ffffff04;border:1px dashed #ffffff26;border-radius:12px;text-align:left}
    .plugin-import-dialog .plugin-package-pick:hover:not(:disabled){background:#ffffff08;border-color:#7acc3566}
    .plugin-import-dialog .plugin-package-pick[data-selected=true]{border-style:solid;border-color:#7acc3545}
    .plugin-import-dialog .plugin-package-icon{display:flex;align-items:center;justify-content:center;flex:0 0 38px;width:38px;height:38px;border-radius:10px;background:#7acc3512;color:#b9df9d}
    .plugin-import-dialog .plugin-package-icon svg{width:22px;height:22px}
    .plugin-import-dialog .plugin-package-copy{flex:1;font-size:14px;font-weight:500}
    .plugin-import-dialog .plugin-package-arrow{width:16px;height:16px;flex:0 0 16px;color:#87908c}
    .plugin-import-dialog .plugin-package-pick span{min-width:0;overflow-wrap:anywhere}
    .plugin-import-dialog .plugin-package-pick small{display:block;margin-top:4px;color:#949da3;font-size:12px;font-weight:400}
    .plugin-import-dialog .plugin-package-preview{margin-top:12px;padding:12px 14px;background:#ffffff04;border:1px solid #ffffff0e;border-radius:10px}
    .plugin-import-dialog .plugin-package-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;overflow-wrap:anywhere}
    .plugin-import-dialog .plugin-package-title strong{font-weight:600}
    .plugin-import-dialog .plugin-package-title span{padding:2px 6px;border-radius:5px;background:#7acc3512;font-size:11px;color:#c3eaa8}
    .plugin-import-dialog .plugin-package-note{margin:6px 0 0;color:#aeb4b9;font-size:12px}
    .plugin-import-dialog .plugin-import-feedback{margin:12px 0 0;padding:10px 12px;border:1px solid #ffffff0e;border-radius:8px;background:#ffffff04;color:#aeb4b9;font-size:12px}
    .plugin-import-dialog .plugin-import-feedback[data-state=error]{color:#ffc1b8;background:#e2777a0a;border-color:#e2777a26}
    .plugin-import-dialog .plugin-import-feedback[data-state=success]{color:#c3eaa8;background:#7acc350a;border-color:#7acc3526}
    .plugin-import-dialog details{margin-top:16px;color:#aeb4b9;font-size:12px}
    .plugin-import-dialog summary{display:flex;align-items:center;gap:5px;width:fit-content;padding:2px 0;cursor:pointer;list-style:none}
    .plugin-import-dialog summary::-webkit-details-marker{display:none}
    .plugin-import-dialog summary svg{width:14px;height:14px;transition:transform .15s}
    .plugin-import-dialog details[open] summary svg{transform:rotate(90deg)}
    .plugin-import-dialog .plugin-import-extra{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .plugin-import-dialog .plugin-import-extra button{min-height:30px;padding:5px 10px;font-size:12px}
    .plugin-package-dialog>.plugin-dialog-actions{align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;margin:0;padding:12px 18px;border-top:1px solid #ffffff0e}
    .plugin-import-dialog .plugin-import-footer-note{flex:1;margin:0 8px 0 0;color:#949da3;font-size:12px}
    .plugin-package-dialog .plugin-url-input{margin:0;font:inherit}
    @media(max-width:420px){.plugin-import-header{padding:16px}.plugin-import-body{padding:16px}.plugin-package-dialog>.plugin-dialog-actions{padding:12px 16px}.plugin-import-dialog .plugin-package-pick{padding:16px 12px;gap:10px}}
    .plugin-import-dialog.plugin-package-dialog:not(.plugin-update-dialog){border:1px solid #7acc3580;border-radius:14px;background:#252629;color:#eceeee;color-scheme:dark}
    .plugin-package-dialog:not(.plugin-update-dialog):focus{outline:none}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-header{align-items:center;padding:20px;border-bottom-color:#ffffff0d}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-header h3{font-size:18px;font-weight:600}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-header p{margin-top:6px;font-size:13px;color:#aeb4b9}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-close{border-color:transparent;border-radius:8px;background:#ffffff0a;color:#fff}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-body{padding:20px}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-pick{padding:16px;gap:12px;border:1px solid #ffffff1f;border-radius:10px;background:#ffffff06}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-pick:hover:not(:disabled){border-color:#7acc3570;background:#7acc350a}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-pick[data-selected=true]{border-color:#7acc3560;background:#7acc350a}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-icon{width:40px;height:40px;flex-basis:40px;border-radius:8px;background:#7acc351c;color:#b6e795}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-copy{font-size:14px;font-weight:500;color:#f1f3f2}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-arrow{color:#b6c3b2}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-package-preview{padding:14px;background:#ffffff05;border-color:#ffffff0f;border-radius:8px}
    .plugin-package-dialog:not(.plugin-update-dialog) details{margin-top:18px;font-size:13px}
    .plugin-package-dialog:not(.plugin-update-dialog) summary{padding:4px 0;color:#aeb4b9}
    .plugin-package-dialog:not(.plugin-update-dialog) summary svg{color:#7acc35}
    .plugin-package-dialog:not(.plugin-update-dialog)>.plugin-dialog-actions{padding:14px 20px;gap:8px;border-top-color:#ffffff0d;background:#222427}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-dialog-actions button{min-height:36px;padding:7px 18px;border-radius:8px}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-footer-note{font-size:12px;line-height:1.5;color:#aeb4b9}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-primary:disabled{opacity:1;background:#3b4f2e;color:#b8c3b1;border-color:transparent}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-url-input{padding:11px 12px;background:#1e2023;border:1px solid #ffffff1f;border-radius:8px;color:#eceeee}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-url-input:focus{border-color:#87908c;outline:none;box-shadow:none}
    .plugin-package-dialog:not(.plugin-update-dialog) .plugin-url-input:focus-visible{outline:1px solid #aeb4b9;outline-offset:2px}
    @media(max-width:420px){.plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-header,.plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-body{padding:16px}.plugin-package-dialog:not(.plugin-update-dialog)>.plugin-dialog-actions{padding:12px 16px}.plugin-package-dialog:not(.plugin-update-dialog) .plugin-import-footer-note{flex-basis:100%;margin:0 0 4px}}
    .plugin-import-dialog [hidden]{display:none!important}
    .plugin-import-dialog.plugin-update-dialog{width:520px;border:2px solid #7acc35a6;border-radius:16px;background:#292c30;box-shadow:inset 0 0 0 1px #ffffff08,0 0 80px 24px #00000018;font-family:inherit}
    .plugin-update-dialog :is(h3,p,label,input,button,a){font-family:inherit}
    .plugin-update-dialog:focus{outline:none}
    .plugin-update-dialog .plugin-import-header{align-items:center;padding:20px;background:linear-gradient(110deg,#303b2d,#303438);border-bottom:1px solid #ffffff14}
    .plugin-update-heading{display:flex;align-items:center;gap:12px}
    .plugin-update-icon{display:flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;border-radius:10px;background:#7acc351a;color:#a4e374}
    .plugin-update-icon svg{width:22px;height:22px}
    .plugin-update-dialog .plugin-import-header h3{color:#fff;font-weight:700}
    .plugin-update-dialog .plugin-import-header p{color:#c0c7c3}
    .plugin-update-dialog .plugin-import-close{background:#ffffff0a;border-color:transparent}
    .plugin-update-dialog .plugin-import-body{padding:20px}
    .plugin-update-dialog .plugin-import-body:empty{display:none}
    .plugin-update-dialog>.plugin-dialog-actions{padding:14px 20px;background:#24272a;border-top-color:#ffffff14}
    .plugin-update-dialog .plugin-import-footer-note{color:#aeb8b1}
    .plugin-update-dialog button{min-height:36px}
    .plugin-update-dialog .plugin-import-primary{padding-left:18px;padding-right:18px;color:#fff}
    .plugin-update-dialog .plugin-url-input{padding:12px;background:#1e2124;border-color:#ffffff1a;border-radius:8px;color:#f1f3f2}
    .plugin-update-dialog .plugin-url-input:focus{border-color:#87908c;outline:none;box-shadow:none}
    .plugin-update-dialog .plugin-url-input:focus-visible{outline:1px solid #aeb4b9;outline-offset:2px}
    .plugin-update-dialog .plugin-update-admin{display:inline-flex;align-items:center;gap:5px;color:#b8c1bc;text-decoration:none;border-radius:4px}
    .plugin-update-dialog .plugin-update-admin:hover{color:#c3eaa8}
    .plugin-update-admin svg{width:14px;height:14px;flex:none}
    .plugin-update-dialog .plugin-update-admin:focus-visible{outline:1px solid #aeb4b9;outline-offset:3px}
    .plugin-update-field-label{display:block;margin-bottom:10px;font-weight:600;color:#e5e9e6}
    .plugin-update-dialog .plugin-package-note{margin-top:10px}
    .plugin-update-item{padding:14px 0;border-bottom:1px solid #ffffff12}
    .plugin-update-item:first-child{padding-top:0}
    .plugin-update-item:last-child{padding-bottom:0;border-bottom:0}
    .plugin-update-item-heading{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
    .plugin-update-item-heading strong{font-size:14px;font-weight:600;color:#f1f3f2;overflow-wrap:anywhere}
    .plugin-update-versions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#aeb4b9;font-size:12px}
    .plugin-update-version-new{padding:2px 7px;border-radius:5px;background:#7acc351a;color:#b6e795}
    .plugin-update-dialog .plugin-update-item details{margin-top:8px}
    .plugin-update-item summary:before{content:'';width:5px;height:5px;margin-right:4px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg)}
    .plugin-update-item details[open] summary:before{transform:rotate(45deg)}
    .plugin-update-item details p{margin:8px 0 0;white-space:pre-wrap}
    @media(max-width:420px){.plugin-update-dialog .plugin-import-header,.plugin-update-dialog .plugin-import-body{padding:16px}.plugin-update-dialog>.plugin-dialog-actions{padding:12px 16px}.plugin-update-heading{gap:10px}.plugin-update-dialog .plugin-import-footer-note{flex-basis:100%;margin:0}}
    
    .plugin-url-input {
      width: 100%;
      padding: ${KOOK_THEME.spacing.md}px ${KOOK_THEME.spacing.lg}px;
      background: ${KOOK_THEME.colors.bgDark};
      border: 1px solid ${KOOK_THEME.colors.border};
      border-radius: ${KOOK_THEME.borderRadius.md}px;
      color: ${KOOK_THEME.colors.text};
      font-size: ${KOOK_THEME.fontSize.sm}px;
      transition: all ${KOOK_THEME.transition};
      margin-bottom: ${KOOK_THEME.spacing.md}px;
    }
    
    .plugin-url-input:focus {
      outline: none;
      border-color: ${KOOK_THEME.colors.primary};
    }
    
    .plugin-url-input::placeholder {
      color: ${KOOK_THEME.colors.textTertiary};
    }

    .plugin-content,
    .plugin-detail-content,
    .plugin-dialog,
    .plugin-scrollable,
    #env-switcher-panel,
    #env-switcher-panel .env-scrollable,
    #env-switcher-panel .env-command-output,
    #playwright-test-panel,
    #playwright-test-panel .env-scrollable,
    #playwright-test-panel #output-content,
    #example-panel,
    #example-panel .env-scrollable,
    #example-panel #example-output-content {
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      scrollbar-gutter: stable both-edges;
    }

    .scrollbar-active {
      scrollbar-color: rgba(122, 204, 53, 0.55) rgba(255, 255, 255, 0.04);
    }

    .plugin-content::-webkit-scrollbar,
    .plugin-detail-content::-webkit-scrollbar,
    .plugin-dialog::-webkit-scrollbar,
    .plugin-scrollable::-webkit-scrollbar,
    #env-switcher-panel::-webkit-scrollbar,
    #env-switcher-panel .env-scrollable::-webkit-scrollbar,
    #env-switcher-panel .env-command-output::-webkit-scrollbar,
    #playwright-test-panel::-webkit-scrollbar,
    #playwright-test-panel .env-scrollable::-webkit-scrollbar,
    #playwright-test-panel #output-content::-webkit-scrollbar,
    #example-panel::-webkit-scrollbar,
    #example-panel .env-scrollable::-webkit-scrollbar,
    #example-panel #example-output-content::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }

    .plugin-content::-webkit-scrollbar-track,
    .plugin-detail-content::-webkit-scrollbar-track,
    .plugin-dialog::-webkit-scrollbar-track,
    .plugin-scrollable::-webkit-scrollbar-track,
    #env-switcher-panel::-webkit-scrollbar-track,
    #env-switcher-panel .env-scrollable::-webkit-scrollbar-track,
    #env-switcher-panel .env-command-output::-webkit-scrollbar-track,
    #playwright-test-panel::-webkit-scrollbar-track,
    #playwright-test-panel .env-scrollable::-webkit-scrollbar-track,
    #playwright-test-panel #output-content::-webkit-scrollbar-track,
    #example-panel::-webkit-scrollbar-track,
    #example-panel .env-scrollable::-webkit-scrollbar-track,
    #example-panel #example-output-content::-webkit-scrollbar-track {
      background: transparent;
      border-radius: 999px;
      transition: background-color 0.2s ease, opacity 0.2s ease;
      opacity: 0;
    }

    .plugin-content::-webkit-scrollbar-thumb,
    .plugin-detail-content::-webkit-scrollbar-thumb,
    .plugin-dialog::-webkit-scrollbar-thumb,
    .plugin-scrollable::-webkit-scrollbar-thumb,
    #env-switcher-panel::-webkit-scrollbar-thumb,
    #env-switcher-panel .env-scrollable::-webkit-scrollbar-thumb,
    #env-switcher-panel .env-command-output::-webkit-scrollbar-thumb,
    #playwright-test-panel::-webkit-scrollbar-thumb,
    #playwright-test-panel .env-scrollable::-webkit-scrollbar-thumb,
    #playwright-test-panel #output-content::-webkit-scrollbar-thumb,
    #example-panel::-webkit-scrollbar-thumb,
    #example-panel .env-scrollable::-webkit-scrollbar-thumb,
    #example-panel #example-output-content::-webkit-scrollbar-thumb {
      background: rgba(122, 204, 53, 0);
      border: 2px solid transparent;
      border-radius: 999px;
      background-clip: padding-box;
      min-height: 32px;
      transition: background-color 0.22s ease, opacity 0.22s ease;
      opacity: 0;
    }

    .scrollbar-active::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.04);
      opacity: 1;
    }

    .scrollbar-active::-webkit-scrollbar-thumb {
      background: rgba(122, 204, 53, 0.88);
      opacity: 1;
    }

    .plugin-content::-webkit-scrollbar-thumb:hover,
    .plugin-detail-content::-webkit-scrollbar-thumb:hover,
    .plugin-dialog::-webkit-scrollbar-thumb:hover,
    .plugin-scrollable::-webkit-scrollbar-thumb:hover,
    #env-switcher-panel::-webkit-scrollbar-thumb:hover,
    #env-switcher-panel .env-scrollable::-webkit-scrollbar-thumb:hover,
    #env-switcher-panel .env-command-output::-webkit-scrollbar-thumb:hover,
    #playwright-test-panel::-webkit-scrollbar-thumb:hover,
    #playwright-test-panel .env-scrollable::-webkit-scrollbar-thumb:hover,
    #playwright-test-panel #output-content::-webkit-scrollbar-thumb:hover,
    #example-panel::-webkit-scrollbar-thumb:hover,
    #example-panel .env-scrollable::-webkit-scrollbar-thumb:hover,
    #example-panel #example-output-content::-webkit-scrollbar-thumb:hover {
      background: rgba(122, 204, 53, 1);
      background-clip: padding-box;
    }

    .plugin-content::-webkit-scrollbar-corner,
    .plugin-detail-content::-webkit-scrollbar-corner,
    .plugin-dialog::-webkit-scrollbar-corner,
    .plugin-scrollable::-webkit-scrollbar-corner,
    #env-switcher-panel::-webkit-scrollbar-corner,
    #env-switcher-panel .env-scrollable::-webkit-scrollbar-corner,
    #env-switcher-panel .env-command-output::-webkit-scrollbar-corner,
    #playwright-test-panel::-webkit-scrollbar-corner,
    #playwright-test-panel .env-scrollable::-webkit-scrollbar-corner,
    #playwright-test-panel #output-content::-webkit-scrollbar-corner,
    #example-panel::-webkit-scrollbar-corner,
    #example-panel .env-scrollable::-webkit-scrollbar-corner,
    #example-panel #example-output-content::-webkit-scrollbar-corner {
      background: transparent;
    }
  `;
  document.head.appendChild(style);
}

class DraggableButton {
  constructor() {
    this.btn = null;
    this.isDragging = false;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dragThreshold = 5;
    this.startX = 0;
    this.startY = 0;
    this.minimized = true;
    this.contextMenu = null;
    this.boundMouseDown = null;
    this.boundMouseMove = null;
    this.boundMouseUp = null;
    this.boundTouchStart = null;
    this.boundTouchMove = null;
    this.boundTouchEnd = null;
    this.boundContextMenu = null;
    this.boundClickOutside = null;
    this.boundResize = null;
  }

  init(btnElement) {
    this.btn = btnElement;
    console.log('[DraggableButton] Initializing...');
    
    this.loadMinimizedState();
    this.applyStyles();
    this.loadPosition();
    this.constrainToViewport();
    
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundTouchStart = this.handleTouchStart.bind(this);
    this.boundTouchMove = this.handleTouchMove.bind(this);
    this.boundTouchEnd = this.handleTouchEnd.bind(this);
    this.boundContextMenu = this.handleContextMenu.bind(this);
    this.boundClickOutside = this.handleClickOutside.bind(this);
    this.boundResize = this.constrainToViewport.bind(this);
    
    this.btn.addEventListener('mousedown', this.boundMouseDown, { passive: false, capture: true });
    this.btn.addEventListener('touchstart', this.boundTouchStart, { passive: false, capture: true });
    this.btn.addEventListener('contextmenu', this.boundContextMenu);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
    document.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    document.addEventListener('touchend', this.boundTouchEnd);
    document.addEventListener('click', this.boundClickOutside);
    window.addEventListener('resize', this.boundResize);
    
    console.log('[DraggableButton] Initialized');
  }
  
  destroy() {
    if (this.btn && this.boundMouseDown) {
      this.btn.removeEventListener('mousedown', this.boundMouseDown, true);
      this.btn.removeEventListener('touchstart', this.boundTouchStart, true);
      this.btn.removeEventListener('contextmenu', this.boundContextMenu);
      document.removeEventListener('mousemove', this.boundMouseMove);
      document.removeEventListener('mouseup', this.boundMouseUp);
      document.removeEventListener('touchmove', this.boundTouchMove);
      document.removeEventListener('touchend', this.boundTouchEnd);
      document.removeEventListener('click', this.boundClickOutside);
      window.removeEventListener('resize', this.boundResize);
    }
    
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }
  
  applyStyles() {
    this.btn.style.cssText = `
      position: fixed;
      left: 20px;
      top: 20px;
      background: rgba(37, 38, 41, 0.95);
      border: 2px solid rgba(122, 204, 53, 0.5);
      border-radius: 12px;
      cursor: move;
      z-index: 999999;
      padding: ${this.minimized ? '10px' : '12px 16px'};
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      -webkit-app-region: no-drag;
      width: max-content;
      white-space: nowrap;
    `;
    
    const contentDiv = this.btn.querySelector('.kook-plugin-btn-content');
    if (contentDiv) {
      contentDiv.style.cssText = 'display: flex; align-items: center; gap: 10px; pointer-events: none;';
    }
    
    const icon = this.btn.querySelector('img');
    if (icon) {
      icon.style.cssText = 'border-radius: 4px; width: 24px; height: 24px; pointer-events: none;';
    }
    
    const text = this.btn.querySelector('span');
    if (text) {
      text.style.cssText = 'font-size: 14px; font-weight: 500; color: #f4f5f6; pointer-events: none;';
      text.style.display = this.minimized ? 'none' : 'inline';
    }
  }

  handleContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    
    this.showContextMenu(e.clientX, e.clientY);
  }

  showContextMenu(x, y) {
    if (this.contextMenu) {
      this.contextMenu.remove();
    }

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      background: ${KOOK_THEME.colors.bgDark};
      border: 1px solid ${KOOK_THEME.colors.border};
      border-radius: ${KOOK_THEME.borderRadius.md}px;
      box-shadow: ${KOOK_THEME.boxShadow.lg};
      z-index: 1000000;
      min-width: 150px;
      overflow: hidden;
    `;

    const minimizeItem = document.createElement('div');
    minimizeItem.textContent = this.minimized ? '还原' : '最小化';
    minimizeItem.style.cssText = `
      padding: 10px 16px;
      cursor: pointer;
      color: ${KOOK_THEME.colors.text};
      font-size: ${KOOK_THEME.fontSize.sm}px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    minimizeItem.onmouseover = () => {
      minimizeItem.style.background = KOOK_THEME.colors.bgLighter;
    };
    minimizeItem.onmouseout = () => {
      minimizeItem.style.background = 'transparent';
    };
    minimizeItem.onclick = (e) => {
      e.stopPropagation();
      this.toggleMinimize();
      this.hideContextMenu();
    };

    menu.appendChild(minimizeItem);
    document.body.appendChild(menu);
    this.contextMenu = menu;

    setTimeout(() => {
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.right > window.innerWidth) {
        menu.style.left = (x - menuRect.width) + 'px';
      }
      if (menuRect.bottom > window.innerHeight) {
        menu.style.top = (y - menuRect.height) + 'px';
      }
    }, 0);
  }

  hideContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  handleClickOutside(e) {
    if (this.contextMenu && !this.contextMenu.contains(e.target) && e.target !== this.btn) {
      this.hideContextMenu();
    }
  }

  toggleMinimize() {
    this.minimized = !this.minimized;
    
    const text = this.btn.querySelector('span');
    if (text) {
      text.style.display = this.minimized ? 'none' : 'inline';
    }

    if (this.minimized) {
      this.btn.style.padding = '10px';
      console.log('[DraggableButton] Button minimized');
    } else {
      this.btn.style.padding = '12px 16px';
      console.log('[DraggableButton] Button restored');
    }

    this.saveMinimizedState();
    this.constrainToViewport();
  }

  saveMinimizedState() {
    try {
      localStorage.setItem('kook-plugin-btn-minimized', JSON.stringify({ minimized: this.minimized }));
    } catch (e) {
      console.warn('[DraggableButton] Failed to save minimized state:', e);
    }
  }

  loadMinimizedState() {
    try {
      const saved = localStorage.getItem('kook-plugin-btn-minimized');
      if (saved) {
        const { minimized } = JSON.parse(saved);
        if (typeof minimized === 'boolean') {
          this.minimized = minimized;
          console.log('[DraggableButton] Loaded minimized state:', minimized);
        }
      }
    } catch (e) {
      console.warn('[DraggableButton] Failed to load minimized state:', e);
    }
  }

  handleMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    
    this.isDragging = false;
    this.startX = e.clientX;
    this.startY = e.clientY;
    
    const rect = this.btn.getBoundingClientRect();
    this.offsetX = e.clientX - rect.left;
    this.offsetY = e.clientY - rect.top;
    
    this.btn.style.cursor = 'grabbing';
    
    console.log('[DraggableButton] Mouse down at:', e.clientX, e.clientY);
  }

  handleMouseMove(e) {
    if (this.btn.style.cursor !== 'grabbing') return;
    
    const deltaX = e.clientX - this.startX;
    const deltaY = e.clientY - this.startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    if (distance > this.dragThreshold) {
      this.isDragging = true;
      
      if (!this.btn.classList.contains('dragging')) {
        this.btn.classList.add('dragging');
        console.log('[DraggableButton] Started dragging');
      }
    }
    
    if (this.isDragging) {
      const x = e.clientX - this.offsetX;
      const y = e.clientY - this.offsetY;
      
      const winWidth = window.innerWidth;
      const winHeight = window.innerHeight;
      
      const clampedX = Math.max(0, Math.min(x, winWidth - this.btn.offsetWidth));
      const clampedY = Math.max(0, Math.min(y, winHeight - this.btn.offsetHeight));
      
      this.btn.style.left = clampedX + 'px';
      this.btn.style.top = clampedY + 'px';
    }
  }

  handleMouseUp(e) {
    if (this.btn.style.cursor !== 'grabbing') return;
    
    this.btn.style.cursor = 'move';
    
    if (this.isDragging) {
      const rect = this.btn.getBoundingClientRect();
      this.savePosition(rect.left, rect.top);
      console.log('[DraggableButton] Dropped at:', rect.left, rect.top);
    } else {
      console.log('[DraggableButton] Click detected, opening panel');
      this.openPluginPanel();
    }
    
    this.isDragging = false;
  }
  
  handleTouchStart(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    
    const touch = e.touches[0];
    this.isDragging = false;
    this.startX = touch.clientX;
    this.startY = touch.clientY;
    
    const rect = this.btn.getBoundingClientRect();
    this.offsetX = touch.clientX - rect.left;
    this.offsetY = touch.clientY - rect.top;
    
    this.btn.style.cursor = 'grabbing';
  }

  handleTouchMove(e) {
    if (e.touches.length !== 1 || this.btn.style.cursor !== 'grabbing') return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.startX;
    const deltaY = touch.clientY - this.startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    if (distance > this.dragThreshold) {
      this.isDragging = true;
      
      if (!this.btn.classList.contains('dragging')) {
        this.btn.classList.add('dragging');
      }
    }
    
    if (this.isDragging) {
      const x = touch.clientX - this.offsetX;
      const y = touch.clientY - this.offsetY;
      
      const winWidth = window.innerWidth;
      const winHeight = window.innerHeight;
      
      const clampedX = Math.max(0, Math.min(x, winWidth - this.btn.offsetWidth));
      const clampedY = Math.max(0, Math.min(y, winHeight - this.btn.offsetHeight));
      
      this.btn.style.left = clampedX + 'px';
      this.btn.style.top = clampedY + 'px';
    }
  }

  handleTouchEnd(e) {
    if (this.btn.style.cursor !== 'grabbing') return;
    
    this.btn.style.cursor = 'move';
    
    if (this.isDragging) {
      const rect = this.btn.getBoundingClientRect();
      this.savePosition(rect.left, rect.top);
    } else if (e.changedTouches && e.changedTouches.length === 1) {
      const rect = this.btn.getBoundingClientRect();
      const touch = e.changedTouches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        this.openPluginPanel();
      }
    }
    
    this.isDragging = false;
  }
  
  openPluginPanel() {
    if (window.KOOKPluginUI && window.KOOKPluginUI.toggle) {
      window.KOOKPluginUI.toggle();
    }
  }

  savePosition(x, y) {
    try {
      localStorage.setItem('kook-plugin-btn-position', JSON.stringify({ x, y }));
    } catch (e) {
      console.warn('[DraggableButton] Failed to save position:', e);
    }
  }

  loadPosition() {
    try {
      const saved = localStorage.getItem('kook-plugin-btn-position');
      if (saved) {
        const { x, y } = JSON.parse(saved);
        
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.btn.style.left = x + 'px';
          this.btn.style.top = y + 'px';
          console.log('[DraggableButton] Loaded saved position:', x, y);
          return;
        }
      }
    } catch (e) {
      console.warn('[DraggableButton] Failed to load position:', e);
    }
    
    this.btn.style.left = '20px';
    this.btn.style.top = '20px';
    console.log('[DraggableButton] Using default position: 20, 20');
  }

  constrainToViewport() {
    if (!this.btn || window.innerWidth <= 0 || window.innerHeight <= 0) return;

    const rect = this.btn.getBoundingClientRect();
    this.btn.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - rect.width)) + 'px';
    this.btn.style.top = Math.max(0, Math.min(rect.top, window.innerHeight - rect.height)) + 'px';
  }
}

class PluginPanel {
  constructor() {
    this.panel = null;
    this.currentView = 'list';
    this.currentPluginId = null;
    this.importDialog = null;
    this.panelPosition = null;
    this.panelHeight = null;
    this.hasRenderedInitialList = false;
    this.isDragging = false;
    this.isResizing = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.resizeStartY = 0;
    this.resizeStartHeight = 0;
    this.searchQuery = '';
    this.sortMode = 'default';
    this.sortDirection = 'desc';
    this.customOrder = [];
    this.pinnedPluginIds = [];
    this.pluginContextMenu = null;
    this.pluginAddedAt = {};
    this.cachedPlugins = [];
    this.draggedPluginId = null;
    this.toolbarRefs = null;
    this.toolbarHost = null;
    this.toolbarExpanded = false;
    this.toolbarToggle = null;
    this.listHost = null;
    this.currentListElement = null;
    this.suppressClickUntil = 0;
    this.boundPanelMouseMove = this.handlePanelMouseMove.bind(this);
    this.boundPanelMouseUp = this.handlePanelMouseUp.bind(this);
    this.boundDocumentMouseDown = this.handleDocumentMouseDown.bind(this);

    this.loadPanelPosition();
    this.loadPanelHeight();
    this.loadSortMode();
    this.loadSortDirection();
    this.loadCustomOrder();
    this.loadPinnedPlugins();
    this.loadPluginAddedAt();
    this.installGlobalScrollbarAnimations();
    document.addEventListener('mousemove', this.boundPanelMouseMove);
    document.addEventListener('mouseup', this.boundPanelMouseUp);
    document.addEventListener('mousedown', this.boundDocumentMouseDown);
  }

  loadPanelPosition() {
    try {
      const saved = localStorage.getItem('kook-plugin-panel-position');
      if (!saved) return;

      const { left, top } = JSON.parse(saved);
      if (typeof left === 'number' && typeof top === 'number') {
        this.panelPosition = { left, top };
      }
    } catch (e) {
      console.error('[PluginPanel] Failed to load panel position:', e);
    }
  }

  savePanelPosition() {
    if (!this.panelPosition) return;

    try {
      localStorage.setItem('kook-plugin-panel-position', JSON.stringify(this.panelPosition));
    } catch (e) {
      console.error('[PluginPanel] Failed to save panel position:', e);
    }
  }

  loadPanelHeight() {
    try {
      const saved = localStorage.getItem(PLUGIN_CONFIG.storage.panelHeightKey);
      if (!saved) return;

      const parsed = Number(saved);
      if (Number.isFinite(parsed)) {
        this.panelHeight = parsed;
      }
    } catch (e) {
      console.error('[PluginPanel] Failed to load panel height:', e);
    }
  }

  savePanelHeight() {
    if (!Number.isFinite(this.panelHeight)) return;

    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.panelHeightKey, String(this.panelHeight));
    } catch (e) {
      console.error('[PluginPanel] Failed to save panel height:', e);
    }
  }

  loadSortMode() {
    try {
      const saved = localStorage.getItem(PLUGIN_CONFIG.storage.sortModeKey);
      if (saved === 'default' || saved === 'name' || saved === 'added') {
        this.sortMode = saved;
      }
    } catch (e) {
      console.error('[PluginPanel] Failed to load sort mode:', e);
    }
  }

  saveSortMode() {
    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.sortModeKey, this.sortMode);
    } catch (e) {
      console.error('[PluginPanel] Failed to save sort mode:', e);
    }
  }

  loadSortDirection() {
    try {
      const saved = localStorage.getItem(PLUGIN_CONFIG.storage.sortDirectionKey);
      if (saved === 'asc' || saved === 'desc') {
        this.sortDirection = saved;
      }
    } catch (e) {
      console.error('[PluginPanel] Failed to load sort direction:', e);
    }
  }

  saveSortDirection() {
    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.sortDirectionKey, this.sortDirection);
    } catch (e) {
      console.error('[PluginPanel] Failed to save sort direction:', e);
    }
  }

  loadCustomOrder() {
    try {
      const saved = localStorage.getItem(PLUGIN_CONFIG.storage.customOrderKey);
      const parsed = saved ? JSON.parse(saved) : [];
      this.customOrder = Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch (e) {
      console.error('[PluginPanel] Failed to load custom order:', e);
      this.customOrder = [];
    }
  }

  saveCustomOrder() {
    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.customOrderKey, JSON.stringify(this.customOrder));
    } catch (e) {
      console.error('[PluginPanel] Failed to save custom order:', e);
    }
  }

  loadPinnedPlugins() {
    try {
      const saved = JSON.parse(localStorage.getItem(PLUGIN_CONFIG.storage.pinnedPluginsKey) || '[]');
      this.pinnedPluginIds = Array.isArray(saved) ? [...new Set(saved.filter(id => typeof id === 'string' && id))] : [];
    } catch (e) {
      this.pinnedPluginIds = [];
    }
  }

  togglePluginPin(pluginId) {
    if (!this.cachedPlugins.some(plugin => plugin.id === pluginId)) return false;
    const next = this.pinnedPluginIds.includes(pluginId)
      ? this.pinnedPluginIds.filter(id => id !== pluginId)
      : [...this.pinnedPluginIds, pluginId];
    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.pinnedPluginsKey, JSON.stringify(next));
    } catch (e) {
      this.showNotification('无法保存置顶状态，请稍后重试', 'error');
      return false;
    }
    this.pinnedPluginIds = next;
    this.renderPluginListView();
    return true;
  }

  closePluginContextMenu(restoreFocus = false) {
    if (!this.pluginContextMenu) return;
    this.cleanupPluginContextMenu?.();
    this.cleanupPluginContextMenu = null;
    this.pluginContextMenu.remove();
    this.pluginContextMenu = null;
    if (restoreFocus && this.pinMenuTrigger?.isConnected) this.pinMenuTrigger.focus();
    this.pinMenuTrigger = null;
  }

  showPluginContextMenu(pluginId, x, y, trigger) {
    this.closePluginContextMenu();
    this.closeSortMenu();
    const menu = document.createElement('div');
    menu.className = 'plugin-panel-menu plugin-pin-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '插件操作');
    const action = document.createElement('button');
    action.type = 'button';
    action.setAttribute('role', 'menuitem');
    action.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';
    const label = document.createElement('span');
    label.textContent = this.pinnedPluginIds.includes(pluginId) ? '取消置顶' : '置顶插件';
    action.appendChild(label);
    action.onclick = event => {
      event.stopPropagation();
      this.closePluginContextMenu(true);
      if (this.togglePluginPin(pluginId)) {
        Array.from(this.currentListElement?.children || []).find(item => item.dataset.pluginId === pluginId)?.focus();
      }
    };
    menu.appendChild(action);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'plugin-delete-action';
    remove.setAttribute('role', 'menuitem');
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg><span>删除插件</span>';
    remove.onclick = event => {
      event.stopPropagation();
      this.closePluginContextMenu(true);
      this.showPluginDeleteDialog(pluginId);
    };
    menu.appendChild(remove);
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    this.pluginContextMenu = menu;
    this.pinMenuTrigger = trigger;
    const dismiss = () => this.closePluginContextMenu();
    const outside = event => { if (!menu.contains(event.target)) dismiss(); };
    const keydown = event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
        this.closePluginContextMenu(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const actions = [action, remove];
        const index = actions.indexOf(document.activeElement);
        actions[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + actions.length) % actions.length].focus();
      }
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    this.cleanupPluginContextMenu = () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
    action.focus();
  }

  async showPluginDeleteDialog(pluginId) {
    if (this.importBusy) return;
    this.showImportDialog();
    const overlay = this.importDialog;
    const generation = this.importReadGeneration;
    const dialog = overlay.querySelector('.plugin-dialog');
    this.cleanupImportDrag?.();
    this.cleanupImportDrag = null;
    overlay.classList.add('plugin-delete-overlay');
    dialog.classList.remove('plugin-package-dialog');
    dialog.classList.add('plugin-delete-dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-describedby', 'plugin-delete-description');
    dialog.innerHTML = `<h3 id="plugin-import-title">删除插件</h3><p id="plugin-delete-description">正在读取插件安装信息…</p><p class="plugin-import-feedback" id="plugin-import-feedback" role="status" aria-live="polite" hidden></p><div class="plugin-dialog-actions"><button type="button" id="plugin-delete-cancel">取消</button><button type="button" id="plugin-delete-confirm" class="plugin-delete-primary" disabled>删除</button></div>`;
    const cancel = dialog.querySelector('#plugin-delete-cancel');
    const confirm = dialog.querySelector('#plugin-delete-confirm');
    cancel.onclick = () => this.closeImportDialog();
    cancel.focus();
    try {
      const preview = await window.KOOKPluginLoader.inspectRemoval(pluginId);
      if (overlay !== this.importDialog || generation !== this.importReadGeneration) return;
      const description = dialog.querySelector('#plugin-delete-description');
      description.textContent = preview.names.length > 1 ? `将从当前 KOOK 移除同一安装包中的 ${preview.names.join('、')}，并停止运行。插件配置会保留。` : `确定删除「${preview.name}」吗？将停止运行并从当前 KOOK 移除插件及其文件，插件配置会保留。`;
      if (window.KOOKPluginLoader.getPlugin(pluginId)?.info?.dlcId) description.textContent += ' 以后重新应用 KFC 中的此 DLC 会再次安装。';
      confirm.disabled = false;
      confirm.onclick = async () => {
        if (this.importBusy) return;
        this.importBusy = true;
        cancel.disabled = confirm.disabled = true;
        this.importFeedback('正在停止并删除插件…');
        try {
          const result = await window.KOOKPluginLoader.removePlugin(pluginId, preview);
          this.pinnedPluginIds = this.pinnedPluginIds.filter(id => !result.pluginIds.includes(id));
          this.customOrder = this.customOrder.filter(id => !result.pluginIds.includes(id));
          for (const id of result.pluginIds) delete this.pluginAddedAt[id];
          try { localStorage.setItem(PLUGIN_CONFIG.storage.pinnedPluginsKey, JSON.stringify(this.pinnedPluginIds)); } catch (error) { console.error('[PluginPanel] Failed to save pin cleanup:', error); }
          this.saveCustomOrder();
          this.savePluginAddedAt();
          this.currentView = 'list';
          this.currentPluginId = null;
          this.cachedPlugins = window.KOOKPluginLoader.getPluginList();
          this.importBusy = false;
          this.closeImportDialog();
          await this.renderPluginList();
          this.showNotification('已删除 ' + preview.name, 'success');
        } catch (error) {
          this.importFeedback(error.message || '删除失败，请重新确认', 'error');
          cancel.disabled = false;
          confirm.disabled = true;
          cancel.focus();
        } finally { this.importBusy = false; }
      };
    } catch (error) {
      if (overlay === this.importDialog && generation === this.importReadGeneration) {
        dialog.querySelector('#plugin-delete-description').textContent = '无法读取插件安装信息，插件未删除。';
        this.importFeedback(error.message || '无法读取插件安装信息', 'error');
      }
    }
  }

  loadPluginAddedAt() {
    try {
      const saved = localStorage.getItem(PLUGIN_CONFIG.storage.addedAtKey);
      const parsed = saved ? JSON.parse(saved) : {};
      this.pluginAddedAt = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      console.error('[PluginPanel] Failed to load plugin added time:', e);
      this.pluginAddedAt = {};
    }
  }

  savePluginAddedAt() {
    try {
      localStorage.setItem(PLUGIN_CONFIG.storage.addedAtKey, JSON.stringify(this.pluginAddedAt));
    } catch (e) {
      console.error('[PluginPanel] Failed to save plugin added time:', e);
    }
  }

  getMaxPanelHeight() {
    return Math.min(712, window.innerHeight - 48);
  }

  getMinPanelHeight() {
    return Math.round(this.getMaxPanelHeight() * (2 / 3));
  }

  getClampedPanelHeight(nextHeight = this.panelHeight) {
    const maxHeight = this.getMaxPanelHeight();
    const minHeight = this.getMinPanelHeight();
    const fallbackHeight = maxHeight;
    const numericHeight = Number.isFinite(nextHeight) ? nextHeight : fallbackHeight;
    return Math.min(maxHeight, Math.max(minHeight, numericHeight));
  }

  handleDocumentMouseDown(event) {
    if (!this.toolbarRefs?.sortWrap) {
      return;
    }

    if (!this.toolbarRefs.sortWrap.contains(event.target)) {
      this.closeSortMenu();
    }
  }

  getSortOptions() {
    return [
      { value: 'default', label: '默认排序' },
      { value: 'name', label: '按名称排序' },
      { value: 'added', label: '按添加时间排序' }
    ];
  }

  getSortLabel(sortMode = this.sortMode) {
    const match = this.getSortOptions().find(option => option.value === sortMode);
    return match ? match.label : '默认排序';
  }

  getSortDirectionLabel() {
    return this.sortDirection === 'asc' ? '升序' : '降序';
  }

  syncPluginMetadata(plugins) {
    const pluginIds = plugins.map(plugin => plugin.id).filter(Boolean);
    const nextOrder = Array.isArray(this.customOrder)
      ? this.customOrder.filter(id => pluginIds.includes(id))
      : [];
    let orderChanged = nextOrder.length !== this.customOrder.length;

    pluginIds.forEach((id) => {
      if (!nextOrder.includes(id)) {
        nextOrder.push(id);
        orderChanged = true;
      }
    });

    const nextAddedAt = { ...this.pluginAddedAt };
    let addedAtChanged = false;
    const seedTime = Date.now() - (pluginIds.length * 1000);

    pluginIds.forEach((id, index) => {
      const currentValue = Number(nextAddedAt[id]);
      if (!Number.isFinite(currentValue)) {
        nextAddedAt[id] = seedTime + index;
        addedAtChanged = true;
      }
    });

    Object.keys(nextAddedAt).forEach((id) => {
      if (!pluginIds.includes(id)) {
        delete nextAddedAt[id];
        addedAtChanged = true;
      }
    });

    this.customOrder = nextOrder;
    this.pluginAddedAt = nextAddedAt;

    if (orderChanged) {
      this.saveCustomOrder();
    }

    if (addedAtChanged) {
      this.savePluginAddedAt();
    }
  }

  getVisiblePlugins(plugins = this.cachedPlugins) {
    this.syncPluginMetadata(plugins);

    const query = this.searchQuery.trim().toLowerCase();
    const filteredPlugins = query
      ? plugins.filter((plugin) => {
          const haystack = [
            plugin.name,
            plugin.id,
            plugin.description
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : [...plugins];

    const pinnedIds = new Set(this.pinnedPluginIds);
    const orderIndex = new Map(this.customOrder.map((id, index) => [id, index]));
    return filteredPlugins.sort((a, b) => {
      const pinComparison = Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id));
      if (pinComparison) return pinComparison;
      if (this.sortMode === 'name') {
        const comparison = a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
        return this.sortDirection === 'asc' ? comparison : -comparison;
      }
      if (this.sortMode === 'added') {
        const comparison = Number(this.pluginAddedAt[a.id] || 0) - Number(this.pluginAddedAt[b.id] || 0);
        return this.sortDirection === 'asc' ? comparison : -comparison;
      }
      return (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  closeSortMenu() {
    if (!this.toolbarRefs?.sortMenu || !this.toolbarRefs?.sortButton) {
      return;
    }

    this.toolbarRefs.sortMenu.style.display = 'none';
    this.toolbarRefs.sortButton.setAttribute('aria-expanded', 'false');
  }

  toggleSortMenu() {
    this.closePluginContextMenu();
    if (!this.toolbarRefs?.sortMenu || !this.toolbarRefs?.sortButton) {
      return;
    }

    const isOpen = this.toolbarRefs.sortMenu.style.display === 'block';
    if (isOpen) {
      this.closeSortMenu();
      return;
    }

    this.toolbarRefs.sortMenu.style.display = 'block';
    this.toolbarRefs.sortButton.setAttribute('aria-expanded', 'true');
  }

  setSortMode(nextSortMode) {
    if (!['default', 'name', 'added'].includes(nextSortMode)) {
      return;
    }

    this.sortMode = nextSortMode;
    this.saveSortMode();
    this.closeSortMenu();
    this.renderPluginListView();
  }

  toggleSortDirection() {
    if (this.sortMode === 'default') {
      return;
    }

    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    this.saveSortDirection();
    this.renderPluginListView();
  }

  syncToolbarVisibility() {
    if (this.toolbarHost) this.toolbarHost.hidden = !this.toolbarExpanded;
    if (this.toolbarToggle) {
      this.toolbarToggle.setAttribute('aria-expanded', String(this.toolbarExpanded));
      this.toolbarToggle.title = this.toolbarExpanded ? '收起搜索与排序' : '展开搜索与排序';
    }
  }

  setToolbarExpanded(expanded) {
    this.closePluginContextMenu();
    this.toolbarExpanded = Boolean(expanded);
    if (!this.toolbarExpanded) {
      this.closeSortMenu();
      if (this.searchQuery) {
        this.searchQuery = '';
        if (this.toolbarRefs) this.toolbarRefs.searchInput.value = '';
        this.renderPluginListView();
      }
    }
    this.syncToolbarVisibility();
    if (this.toolbarExpanded) this.toolbarRefs?.searchInput.focus();
    else this.toolbarToggle?.focus();
  }

  updateToolbarState(totalCount = this.cachedPlugins.length, visibleCount = this.getVisiblePlugins().length) {
    if (!this.toolbarRefs) {
      return;
    }

    const isSearching = this.searchQuery.trim().length > 0;
    const currentSortLabel = this.getSortLabel();
    const isDirectionalSort = this.sortMode !== 'default';

    this.toolbarRefs.sortValue.textContent = currentSortLabel;
    this.toolbarRefs.clearButton.style.display = isSearching ? 'inline-flex' : 'none';
    this.toolbarRefs.searchInput.title = isSearching ? `找到 ${visibleCount} / ${totalCount}` : '';
    this.toolbarRefs.directionToggle.disabled = !isDirectionalSort;
    this.toolbarRefs.directionToggle.style.opacity = isDirectionalSort ? '1' : '0.45';
    this.toolbarRefs.directionToggle.style.cursor = isDirectionalSort ? 'pointer' : 'not-allowed';
    this.toolbarRefs.directionToggle.title = isDirectionalSort
      ? `切换为${this.sortDirection === 'asc' ? '降序' : '升序'}`
      : '默认排序使用拖拽顺序';
    this.toolbarRefs.directionIcon.textContent = isDirectionalSort
      ? (this.sortDirection === 'asc' ? '↑' : '↓')
      : '↕';
    this.toolbarRefs.directionIcon.style.color = isDirectionalSort ? '#d5ffae' : KOOK_THEME.colors.textTertiary;
    this.toolbarRefs.directionIcon.style.transform = this.sortDirection === 'asc' ? 'translateY(-1px)' : 'translateY(1px)';

    Array.from(this.toolbarRefs.sortMenu.querySelectorAll('[data-sort-option]')).forEach((button) => {
      const isActive = button.dataset.sortOption === this.sortMode;
      button.style.background = isActive ? 'rgba(122, 204, 53, 0.14)' : 'transparent';
      button.style.color = isActive ? '#d5ffae' : KOOK_THEME.colors.text;
    });
  }

  renderPluginListView() {
    const content = document.getElementById('plugin-content');
    if (!content || !Array.isArray(this.cachedPlugins) || this.cachedPlugins.length === 0) {
      return;
    }

    const visiblePlugins = this.getVisiblePlugins(this.cachedPlugins);
    this.renderPluginListItems(visiblePlugins);
    this.updateToolbarState(this.cachedPlugins.length, visiblePlugins.length);
  }

  isAutoHideScrollbarTarget(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    return element.matches(
      '.plugin-content, .plugin-detail-content, .plugin-dialog, .plugin-scrollable, ' +
      '#env-switcher-panel, #env-switcher-panel .env-scrollable, #env-switcher-panel .env-command-output, ' +
      '#playwright-test-panel, #playwright-test-panel .env-scrollable, #playwright-test-panel #output-content, ' +
      '#example-panel, #example-panel .env-scrollable, #example-panel #example-output-content'
    );
  }

  enableAutoHideScrollbar(element) {
    if (!element || element.dataset.scrollbarEnhancerBound === 'true') {
      return;
    }

    let hideTimer = null;

    const showScrollbar = () => {
      element.classList.add('scrollbar-active');
      if (hideTimer) {
        clearTimeout(hideTimer);
      }
      hideTimer = window.setTimeout(() => {
        element.classList.remove('scrollbar-active');
      }, 720);
    };

    element.dataset.scrollbarEnhancerBound = 'true';
    element.addEventListener('scroll', showScrollbar, { passive: true });
  }

  installGlobalScrollbarAnimations() {
    if (PluginPanel.globalScrollbarAnimationsInstalled) {
      return;
    }

    PluginPanel.globalScrollbarAnimationsInstalled = true;

    document.addEventListener('scroll', (event) => {
      const target = event.target;
      if (this.isAutoHideScrollbarTarget(target)) {
        this.enableAutoHideScrollbar(target);
        target.classList.add('scrollbar-active');

        if (target.__scrollbarHideTimer) {
          clearTimeout(target.__scrollbarHideTimer);
        }

        target.__scrollbarHideTimer = window.setTimeout(() => {
          target.classList.remove('scrollbar-active');
        }, 720);
      }
    }, true);
  }

  createButton(text, variant = 'default', onClick) {
    const button = document.createElement('button');
    button.textContent = text;
    
    const styles = {
      default: {
        padding: '9px 14px',
        border: 'none',
        borderRadius: `${KOOK_THEME.borderRadius.md}px`,
        fontSize: `${KOOK_THEME.fontSize.sm}px`,
        fontWeight: '500',
        cursor: 'pointer',
        background: KOOK_THEME.colors.primary,
        color: '#fff'
      },
      secondary: {
        padding: '9px 14px',
        border: 'none',
        borderRadius: `${KOOK_THEME.borderRadius.md}px`,
        fontSize: `${KOOK_THEME.fontSize.sm}px`,
        fontWeight: '500',
        cursor: 'pointer',
        background: KOOK_THEME.colors.bgLight,
        color: KOOK_THEME.colors.text
      },
      ghost: {
        padding: '9px 14px',
        border: 'none',
        borderRadius: `${KOOK_THEME.borderRadius.md}px`,
        fontSize: `${KOOK_THEME.fontSize.sm}px`,
        fontWeight: '500',
        cursor: 'pointer',
        background: KOOK_THEME.colors.bgLight,
        color: KOOK_THEME.colors.text
      }
    };
    
    Object.assign(button.style, styles[variant] || styles.default);
    
    if (onClick) {
      button.onclick = onClick;
    }
    
    return button;
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 30px;
      left: 50%;
      transform: translateX(-50%);
      background: #252629;
      border: 1px solid ${KOOK_THEME.colors.primary};
      border-radius: ${KOOK_THEME.borderRadius.lg}px;
      box-shadow: ${KOOK_THEME.boxShadow.lg};
      z-index: 1000100;
      animation: slideIn 0.3s ease-out;
      min-width: 300px;
      max-width: 400px;
    `;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 16px 20px;';

    const messageEl = document.createElement('div');
    messageEl.style.cssText = `flex: 1; color: ${KOOK_THEME.colors.text}; font-size: 14px; line-height: 1.5;`;
    messageEl.textContent = String(message ?? '');

    wrapper.appendChild(messageEl);
    notification.appendChild(wrapper);
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  async ensurePluginsLoaded(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const loader = window.KOOKPluginLoader;

    if (!loader) {
      return [];
    }

    if (forceRefresh && typeof loader.refreshPluginSources === 'function') {
      await loader.refreshPluginSources({
        maxAttempts: 4,
        retryDelay: 800
      });
    } else if (!this.hasRenderedInitialList) {
      if (typeof loader.loadPlugins === 'function') {
        await loader.loadPlugins();
      } else if (typeof loader.refreshPluginSources === 'function') {
        await loader.refreshPluginSources({
          maxAttempts: 4,
          retryDelay: 800
        });
      }
    }

    this.hasRenderedInitialList = true;
    return this.getPluginRecords();
  }

  getPluginRecords() {
    const loader = window.KOOKPluginLoader;
    const plugins = loader?.getPluginList?.() || [];

    return plugins
      .map(plugin => loader?.getPlugin?.(plugin.id) || plugin)
      .filter(Boolean);
  }

  getPluginActionLabel(plugin) {
    if (typeof plugin?.showTestPanel === 'function') {
      return '\u6253\u5f00';
    }

    if (typeof plugin?.onExecute === 'function') {
      return '\u6253\u5f00';
    }

    return '\u6253\u5f00';
  }

  getPluginModeLabel(plugin) {
    if (typeof plugin?.onActivate === 'function' || typeof plugin?.onDeactivate === 'function') {
      return '\u652f\u6301\u5e38\u9a7b';
    }

    return '\u6309\u9700\u8fd0\u884c';
  }

  getPluginBadgeLabel(plugin) {
    if (plugin.id !== 'environment-switcher') return plugin.id;
    try {
      const instance = window.KOOKPluginLoader?.getPlugin?.(plugin.id) || plugin;
      const current = instance.detectCurrentEnvironmentInfo?.();
      if (current?.source === 'runtime') {
        if (current.environment === 'testing') return '测试环境';
        if (current.environment === 'production') return '正式环境';
      }
    } catch {}
    return '环境未确认';
  }

  async updatePluginBadge(badge, plugin) {
    badge.textContent = this.getPluginBadgeLabel(plugin);
    if (plugin.id !== 'environment-switcher' || badge.textContent !== '环境未确认') return;
    try {
      await window.Kaiheila?.waitForActiveDomainSelection?.();
      badge.textContent = this.getPluginBadgeLabel(plugin);
    } catch {}
  }

  renderPluginSummary(container, plugin) {
    container.innerHTML = '';
    const instance = window.KOOKPluginLoader?.getPlugin?.(plugin.id) || plugin;
    let summaries;
    try { summaries = instance.getStatusBadges?.(); } catch {}
    if (Array.isArray(summaries) && summaries.length) {
      summaries.slice(0, 2).forEach(summary => {
        if (typeof summary?.label !== 'string') return;
        const badge = document.createElement('div');
        badge.className = 'plugin-badge meta';
        badge.textContent = summary.label;
        badge.title = summary.title || summary.label;
        badge.style.cssText = 'display:block; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box;';
        container.appendChild(badge);
      });
    } else {
      const badge = document.createElement('div');
      badge.className = 'plugin-badge meta';
      badge.title = plugin.id;
      this.updatePluginBadge(badge, plugin);
      container.appendChild(badge);
    }
  }

  updatePluginSummary(id) {
    const plugin = window.KOOKPluginLoader?.getPlugin?.(id);
    if (!plugin || !this.currentListElement) return;
    for (const card of this.currentListElement.children) {
      if (card.dataset.pluginId !== id) continue;
      const container = card.querySelector('.plugin-summary');
      if (container) this.renderPluginSummary(container, plugin);
    }
  }

  renderToolbar(content, totalCount) {
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'margin-bottom: 12px;';
    toolbar.onkeydown = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (this.toolbarRefs?.sortMenu.style.display === 'block') {
        this.closeSortMenu();
        this.toolbarRefs.sortButton.focus();
      } else this.setToolbarExpanded(false);
    };

    const shell = document.createElement('div');
    shell.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-radius: 14px;
      background:
        radial-gradient(circle at top right, rgba(122, 204, 53, 0.16), transparent 42%),
        linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03));
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    `;

    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'display:flex; align-items:center; gap:8px; flex:2 1 220px; min-width:0;';

    const searchBox = document.createElement('div');
    searchBox.style.cssText = `
      display:flex;
      align-items:center;
      gap:10px;
      flex:1;
      min-width:0;
      height: 42px;
      padding: 0 12px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    `;

    const searchIcon = document.createElement('span');
    searchIcon.textContent = '⌕';
    searchIcon.style.cssText = `font-size: 14px; color: ${KOOK_THEME.colors.textTertiary};`;

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.value = this.searchQuery;
    searchInput.placeholder = '搜索插件名称、ID 或描述';
    searchInput.style.cssText = `
      flex: 1;
      min-width: 0;
      height: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: ${KOOK_THEME.colors.text};
      font-size: 14px;
    `;
    searchInput.oninput = (event) => {
      this.searchQuery = event.target.value;
      this.renderPluginListView();
    };

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = '清空';
    clearButton.style.cssText = `
      display: none;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 10px;
      border: none;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      color: ${KOOK_THEME.colors.textSecondary};
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
    `;
    clearButton.onclick = () => {
      this.searchQuery = '';
      searchInput.value = '';
      this.renderPluginListView();
      searchInput.focus();
    };

    searchBox.appendChild(searchIcon);
    searchBox.appendChild(searchInput);
    searchBox.appendChild(clearButton);
    searchWrap.appendChild(searchBox);

    const sortWrap = document.createElement('div');
    sortWrap.style.cssText = 'position:relative;flex:1 1 240px;min-width:0;';

    const sortControl = document.createElement('div');
    sortControl.style.cssText = `
      display:flex;
      align-items:center;
      min-width: 0;
      height: 42px;
      padding: 0 8px 0 13px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.18);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
      overflow: hidden;
    `;

    const sortButton = document.createElement('button');
    sortButton.type = 'button';
    sortButton.setAttribute('aria-expanded', 'false');
    sortButton.style.cssText = `
      display:flex;
      align-items:center;
      gap:10px;
      flex:1;
      min-width: 0;
      height: 42px;
      padding: 0 0 0 0;
      border: none;
      background: transparent;
      color: ${KOOK_THEME.colors.text};
      cursor: pointer;
    `;
    sortButton.onclick = (event) => {
      event.stopPropagation();
      this.toggleSortMenu();
    };

    const sortLabel = document.createElement('span');
    sortLabel.textContent = '排序';
    sortLabel.style.cssText = `font-size: 12px; color: ${KOOK_THEME.colors.textTertiary}; letter-spacing: 0.3px;`;

    const divider = document.createElement('span');
    divider.style.cssText = 'width:1px; height:16px; background: rgba(255,255,255,0.08);';

    const sortValue = document.createElement('span');
    sortValue.style.cssText = `
      flex: 1;
      text-align: left;
      font-size: 14px;
      font-weight: 400;
      color: ${KOOK_THEME.colors.text};
    `;

    const sortArrow = document.createElement('span');
    sortArrow.textContent = '▾';
    sortArrow.style.cssText = `font-size: 12px; color: ${KOOK_THEME.colors.textTertiary};`;

    const directionDivider = document.createElement('span');
    directionDivider.style.cssText = 'width:1px; height:16px; margin: 0 10px 0 8px; background: rgba(255,255,255,0.08);';

    const directionToggle = document.createElement('button');
    directionToggle.type = 'button';
    directionToggle.style.cssText = `
      display:flex;
      align-items:center;
      justify-content:center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      color: ${KOOK_THEME.colors.text};
      cursor: pointer;
    `;
    directionToggle.onclick = (event) => {
      event.stopPropagation();
      this.toggleSortDirection();
    };

    const directionIcon = document.createElement('span');
    directionIcon.style.cssText = `
      width: 16px;
      min-width: 16px;
      text-align: center;
      font-size: 14px;
      color: #d5ffae;
      transition: transform 0.18s ease;
    `;

    directionToggle.appendChild(directionIcon);

    sortButton.appendChild(sortLabel);
    sortButton.appendChild(divider);
    sortButton.appendChild(sortValue);
    sortButton.appendChild(sortArrow);

    sortControl.appendChild(sortButton);
    sortControl.appendChild(directionDivider);
    sortControl.appendChild(directionToggle);

    const sortMenu = document.createElement('div');
    sortMenu.className = 'plugin-panel-menu plugin-sort-menu';
    sortMenu.style.cssText = `
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      display: none;
      min-width: 184px;
      z-index: 4;
    `;

    this.getSortOptions().forEach((option) => {
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.dataset.sortOption = option.value;
      optionButton.textContent = option.label;
      optionButton.onclick = () => this.setSortMode(option.value);
      sortMenu.appendChild(optionButton);
    });

    sortWrap.appendChild(sortControl);
    sortWrap.appendChild(sortMenu);

    shell.appendChild(searchWrap);
    shell.appendChild(sortWrap);
    toolbar.appendChild(shell);
    content.appendChild(toolbar);

    this.toolbarRefs = {
      totalCount,
      searchInput,
      clearButton,
      sortWrap,
      directionToggle,
      directionIcon,
      sortButton,
      sortValue,
      sortMenu
    };

    this.updateToolbarState(totalCount, this.getVisiblePlugins(this.cachedPlugins).length);
    this.syncToolbarVisibility();
  }

  renderPluginListItems(plugins) {
    this.closePluginContextMenu();
    if (!this.listHost) {
      return;
    }

    this.listHost.innerHTML = '';
    this.currentListElement = null;

    if (plugins.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'plugin-empty-state';
      emptyState.style.cssText = 'text-align:center; padding: 36px 20px;';
      emptyState.innerHTML = `
        <div class="plugin-empty-icon">🔎</div>
        <div class="plugin-empty-title">没有找到匹配的插件</div>
        <div class="plugin-empty-desc">试试搜索插件名称、ID，或者清空搜索词后再看一眼。</div>
      `;
      this.listHost.appendChild(emptyState);
      return;
    }

    const list = document.createElement('div');
    list.className = 'plugin-list';
    list.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    this.currentListElement = list;

    plugins.forEach(plugin => {
      list.appendChild(this.createPluginItem(plugin));
    });

    this.listHost.appendChild(list);
  }

  create() {
    this.closePluginContextMenu();
    this.toolbarExpanded = false;
    this.searchQuery = '';
    this.toolbarRefs = null;
    this.toolbarHost = null;
    this.currentView = 'list';
    this.currentPluginId = null;
    const existingPanel = document.getElementById('kook-plugin-panel');
    if (existingPanel) {
      console.log('[PluginPanel] Removing existing panel...');
      existingPanel.remove();
    }
    
    console.log('[PluginPanel] Creating new panel...');
    
    this.panel = document.createElement('div');
    this.panel.id = 'kook-plugin-panel';
    this.panel.className = 'plugin-panel';
    this.applyPanelPosition();
    
    this.renderHeader();
    this.renderContent();
    this.renderFooter();
    
    document.body.appendChild(this.panel);
    
    console.log('[PluginPanel] New panel created and appended');
  }

  renderHeader() {
    const header = document.createElement('div');
    header.className = 'plugin-panel-header';
    header.style.cssText = `
      padding: 18px 20px 16px;
      border-bottom: 1px solid ${KOOK_THEME.colors.divider};
      display: flex;
      flex-shrink: 0;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      user-select: none;
      cursor: move;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02)),
        radial-gradient(circle at top left, rgba(122, 204, 53, 0.12), transparent 40%);
    `;
    header.onmousedown = (e) => this.handlePanelMouseDown(e);
    
    const title = document.createElement('div');
    title.className = 'plugin-panel-title';
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = `${KOOK_THEME.spacing.md}px`;
    
    const titleIcon = document.createElement('img');
    titleIcon.src = PLUGIN_CONFIG.paths.pluginIcon;
    titleIcon.width = 32;
    titleIcon.height = 32;
    titleIcon.style.cssText = 'border-radius: 8px;';
    
    const titleText = document.createElement('h2');
    titleText.textContent = '插件中心';
    titleText.style.margin = '0';
    titleText.style.fontSize = `${KOOK_THEME.fontSize.xl}px`;
    titleText.style.fontWeight = '700';
    titleText.style.color = KOOK_THEME.colors.text;

    const subtitle = document.createElement('div');
    subtitle.textContent = '\u96c6\u4e2d\u7ba1\u7406\u5df2\u6ce8\u5165\u63d2\u4ef6\u3001\u5e38\u9a7b\u72b6\u6001\u4e0e\u9762\u677f\u5165\u53e3';
    subtitle.style.cssText = `
      font-size: 12px;
      color: ${KOOK_THEME.colors.textTertiary};
      margin-top: 4px;
    `;

    const titleMeta = document.createElement('div');
    titleMeta.style.display = 'flex';
    titleMeta.style.flexDirection = 'column';
    titleMeta.appendChild(titleText);
    titleMeta.appendChild(subtitle);
    
    title.appendChild(titleIcon);
    title.appendChild(titleMeta);
    
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.alignItems = 'center';

    const toolbarToggle = this.createButton('排序', 'secondary', async () => {
      const fromDetail = this.currentView !== 'list';
      if (fromDetail) {
        this.currentView = 'list';
        this.currentPluginId = null;
        await this.renderPluginList();
      }
      this.setToolbarExpanded(fromDetail || !this.toolbarExpanded);
    });
    toolbarToggle.type = 'button';
    toolbarToggle.setAttribute('aria-expanded', 'false');
    toolbarToggle.setAttribute('aria-controls', 'plugin-list-tools');
    toolbarToggle.title = '展开搜索与排序';
    this.toolbarToggle = toolbarToggle;
    
    const importBtn = this.createButton('+ 导入插件', 'default', () => {
      console.log('[PluginPanel] Import button clicked');
      this.showImportDialog();
    });
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = `
      width: 32px;
      height: 32px;
      padding: 0;
      border: none;
      border-radius: ${KOOK_THEME.borderRadius.md}px;
      font-size: 20px;
      font-weight: 600;
      cursor: pointer;
      background: ${KOOK_THEME.colors.bgLight};
      color: ${KOOK_THEME.colors.text};
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    closeBtn.onclick = () => {
      console.log('[PluginPanel] Close button clicked');
      this.closePluginContextMenu();
      this.panel.style.display = 'none';
    };
    
    actions.appendChild(toolbarToggle);
    actions.appendChild(importBtn);
    actions.appendChild(closeBtn);
    
    header.appendChild(title);
    header.appendChild(actions);
    
    this.panel.appendChild(header);
    
    console.log('[PluginPanel] Header rendered, import button added');
  }

  applyPanelPosition() {
    const isCustomPosition = this.panelPosition && typeof this.panelPosition.left === 'number' && typeof this.panelPosition.top === 'number';
    const left = isCustomPosition ? `${this.panelPosition.left}px` : '50%';
    const top = isCustomPosition ? `${this.panelPosition.top}px` : '50%';
    const transform = isCustomPosition ? 'none' : 'translate(-50%, -50%)';
    const maxHeight = this.getMaxPanelHeight();
    const minHeight = this.getMinPanelHeight();
    const panelHeight = this.getClampedPanelHeight();

    this.panelHeight = panelHeight;

    this.panel.style.cssText = `
      position: fixed;
      top: ${top};
      left: ${left};
      transform: ${transform};
      box-sizing: border-box;
      width: 604px;
      max-width: calc(100vw - 48px);
      height: ${panelHeight}px;
      min-height: min(${minHeight}px, calc(100vh - 48px));
      max-height: min(${maxHeight}px, calc(100vh - 48px));
      z-index: 100000;
      display: flex;
      flex-direction: column;
      background: linear-gradient(180deg, rgba(37, 38, 41, 0.98), rgba(28, 29, 32, 0.98));
      border: 2px solid rgba(122, 204, 53, 0.5);
      border-radius: ${KOOK_THEME.borderRadius.xl}px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(122, 204, 53, 0.12);
      font-family: Whitney, Helvetica Neue, Helvetica, Arial, sans-serif;
      color: ${KOOK_THEME.colors.text};
      overflow: hidden;
      backdrop-filter: blur(18px);
    `;
  }

  handlePanelMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (!this.panel) return;
    if (this.isResizing) return;

    e.preventDefault();

    const rect = this.panel.getBoundingClientRect();
    this.isDragging = true;
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;
    this.panel.style.transition = 'none';
  }

  handleResizeMouseDown(e) {
    if (e.button !== 0) return;
    if (!this.panel) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = this.panel.getBoundingClientRect();
    this.isResizing = true;
    this.isDragging = false;
    this.resizeStartY = e.clientY;
    this.resizeStartHeight = rect.height;
    this.panelPosition = { left: rect.left, top: rect.top };
    this.panel.style.left = `${rect.left}px`;
    this.panel.style.top = `${rect.top}px`;
    this.panel.style.transform = 'none';
    this.panel.style.transition = 'none';
    document.body.style.cursor = 'ns-resize';
  }

  handlePanelMouseMove(e) {
    if (!this.panel) return;

    if (this.isResizing) {
      const nextHeight = this.getClampedPanelHeight(this.resizeStartHeight + (e.clientY - this.resizeStartY));
      this.panelHeight = nextHeight;
      this.panel.style.height = `${nextHeight}px`;
      return;
    }

    if (!this.isDragging) return;

    const maxLeft = Math.max(16, window.innerWidth - this.panel.offsetWidth - 16);
    const maxTop = Math.max(16, window.innerHeight - this.panel.offsetHeight - 16);
    const nextLeft = Math.min(Math.max(16, e.clientX - this.dragOffsetX), maxLeft);
    const nextTop = Math.min(Math.max(16, e.clientY - this.dragOffsetY), maxTop);

    this.panelPosition = { left: nextLeft, top: nextTop };
    this.panel.style.left = `${nextLeft}px`;
    this.panel.style.top = `${nextTop}px`;
    this.panel.style.transform = 'none';
  }

  handlePanelMouseUp() {
    if (!this.panel) return;

    if (this.isResizing) {
      this.isResizing = false;
      this.panel.style.transition = '';
      document.body.style.cursor = '';
      this.savePanelHeight();
      return;
    }

    if (!this.isDragging) return;

    this.isDragging = false;
    this.panel.style.transition = '';
    this.savePanelPosition();
  }

  renderContent() {
    const content = document.createElement('div');
    content.className = 'plugin-content';
    content.id = 'plugin-content';
    content.style.cssText = `
      padding: 16px 18px 18px;
      overflow-y: auto;
      overflow-x: hidden;
      flex: 1;
      min-height: 0;
    `;
    
    this.panel.appendChild(content);
    this.enableAutoHideScrollbar(content);
    
    this.renderPluginList(content);
    
    console.log('[PluginPanel] Content rendered');
  }

  async renderPluginList(contentElement = null, options = {}) {
    const content = contentElement || document.getElementById('plugin-content');
    if (!content) return;

    this.closeSortMenu();
    this.closePluginContextMenu();
    this.toolbarRefs = null;
    this.toolbarHost = null;
    this.listHost = null;

    content.innerHTML = `
      <div class="plugin-empty-state" style="text-align: center; padding: 32px 20px;">
        <div class="plugin-empty-icon">⚙️</div>
        <div class="plugin-empty-title">正在同步插件列表</div>
        <div class="plugin-empty-desc">
          正在读取默认插件、已导入插件和当前启用状态...
        </div>
      </div>
    `;

    let plugins = [];

    try {
      plugins = await this.ensurePluginsLoaded(options);
    } catch (e) {
      console.error('[PluginPanel] Failed to load plugins for list:', e);
    }

    if (plugins.length === 0) {
      this.cachedPlugins = [];
      content.innerHTML = `
        <div class="plugin-empty-state" style="text-align: center; padding: 36px 20px;">
          <div class="plugin-empty-icon">🧩</div>
          <div class="plugin-empty-title">还没有可管理的插件</div>
          <div class="plugin-empty-desc">
            通过上方“导入插件”选择从 KFC 下载的 DLC ZIP 安装包。
          </div>
        </div>
      `;
      return;
    }

    this.cachedPlugins = plugins;
    this.syncPluginMetadata(plugins);
    content.innerHTML = '';

    const toolbarHost = document.createElement('div');
    toolbarHost.className = 'plugin-toolbar-host';
    toolbarHost.id = 'plugin-list-tools';
    toolbarHost.hidden = !this.toolbarExpanded;
    this.toolbarHost = toolbarHost;
    const listHost = document.createElement('div');
    listHost.className = 'plugin-list-host';
    this.listHost = listHost;

    content.appendChild(toolbarHost);
    content.appendChild(listHost);

    this.renderToolbar(toolbarHost, plugins.length);
    this.renderPluginListItems(this.getVisiblePlugins(plugins));
  }

  createPluginItem(plugin) {
    const item = document.createElement('div');
    item.className = `plugin-item ${plugin.enabled ? 'is-enabled' : ''} ${this.sortMode === 'default' ? 'is-sortable' : ''}`;
    item.dataset.pluginId = plugin.id;
    item.tabIndex = 0;
    item.oncontextmenu = event => {
      event.preventDefault();
      event.stopPropagation();
      this.showPluginContextMenu(plugin.id, event.clientX, event.clientY, item);
    };
    item.onkeydown = event => {
      if (event.target === item && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        event.stopPropagation();
        const rect = item.getBoundingClientRect();
        this.showPluginContextMenu(plugin.id, rect.left + 24, rect.top + 24, item);
      } else if (event.target === item && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        this.openPlugin(plugin.id);
      }
    };
    item.style.cssText = `
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.04));
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      cursor: pointer;
      transition: all ${KOOK_THEME.transition};
    `;

    if (this.sortMode === 'default') {
      item.draggable = true;
      item.ondragstart = (e) => this.handlePluginDragStart(e, plugin.id);
      item.ondragend = () => this.handlePluginDragEnd();
      item.ondragover = (e) => this.handlePluginDragOver(e, plugin.id);
      item.ondragleave = (e) => this.handlePluginDragLeave(e);
      item.ondrop = (e) => this.handlePluginDrop(e, plugin.id);
    }

    const icon = document.createElement('div');
    icon.className = 'plugin-icon';
    icon.style.cssText = `
      width: 52px;
      height: 52px;
      min-width: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, ${KOOK_THEME.colors.primary}, ${KOOK_THEME.colors.primaryHover});
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: 600;
      color: #fff;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
    `;
    this.renderPluginIcon(icon, plugin.icon || '🧩');

    const body = document.createElement('div');
    body.style.cssText = 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px;';

    const head = document.createElement('div');
    head.style.cssText = 'display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;';

    const info = document.createElement('div');
    info.className = 'plugin-info';
    info.style.cssText = 'flex: 1; min-width: 0;';

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;';

    const name = document.createElement('div');
    name.className = 'plugin-name';
    name.style.cssText = `
      font-size: 17px;
      font-weight: 700;
      color: ${KOOK_THEME.colors.text};
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `;
    name.textContent = plugin.name;

    const version = document.createElement('div');
    version.className = 'plugin-badge meta';
    version.textContent = `v${plugin.version || '1.0.0'}`;

    const nameGroup = document.createElement('div');
    nameGroup.style.cssText = 'display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;';
    nameGroup.appendChild(name);
    if (this.pinnedPluginIds.includes(plugin.id)) {
      const star = document.createElement('span');
      star.className = 'plugin-pin-star';
      star.textContent = '★';
      star.title = '已置顶';
      star.setAttribute('role', 'img');
      star.setAttribute('aria-label', '已置顶');
      nameGroup.appendChild(star);
    }
    titleRow.appendChild(nameGroup);
    titleRow.appendChild(version);

    const desc = document.createElement('div');
    desc.className = 'plugin-desc';
    desc.style.cssText = `
      font-size: 13px;
      color: ${KOOK_THEME.colors.textSecondary};
      line-height: 1.6;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    `;
    desc.textContent = plugin.description || '暂无描述';

    info.appendChild(titleRow);
    info.appendChild(desc);

    const toggleGroup = document.createElement('div');
    toggleGroup.style.cssText = 'display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;';

    const toggleLabel = document.createElement('div');
    toggleLabel.style.cssText = `
      font-size: 12px;
      color: ${KOOK_THEME.colors.textTertiary};
      user-select: none;
    `;
    toggleLabel.textContent = plugin.enabled ? '常驻中' : '常驻启用';

    const switchEl = this.createSwitch(plugin.enabled, async (enabled) => {
      const success = await this.handlePluginToggle(plugin.id, enabled, 'list');
      if (success) {
        toggleLabel.textContent = enabled ? '常驻中' : '常驻已关闭';
      }
      return success;
    });
    switchEl.draggable = false;

    toggleGroup.appendChild(toggleLabel);
    toggleGroup.appendChild(switchEl);

    head.appendChild(info);
    head.appendChild(toggleGroup);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;';

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap; flex:1; min-width:0;';

    const summary = document.createElement('div');
    summary.className = 'plugin-summary';
    summary.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; min-width:0; max-width:100%;';
    this.renderPluginSummary(summary, plugin);

    const modeBadge = document.createElement('div');
    modeBadge.className = 'plugin-badge meta';
    modeBadge.textContent = this.getPluginModeLabel(plugin);

    meta.appendChild(summary);
    meta.appendChild(modeBadge);

    const actions = document.createElement('div');
    actions.className = 'plugin-actions';
    actions.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-left: auto;';

    const openBtn = document.createElement('button');
    openBtn.className = 'plugin-btn';
    openBtn.textContent = this.getPluginActionLabel(plugin);
    openBtn.draggable = false;
    openBtn.style.cssText = `
      min-width: 112px;
      padding: 10px 18px;
      border: none;
      border-radius: 10px;
      font-size: ${KOOK_THEME.fontSize.sm}px;
      font-weight: 600;
      cursor: pointer;
      background: rgba(122, 204, 53, 0.16);
      color: #d5ffae;
    `;
    openBtn.onclick = async (e) => {
      e.stopPropagation();
      await this.openPlugin(plugin.id);
    };

    actions.appendChild(openBtn);
    footer.appendChild(meta);
    footer.appendChild(actions);

    body.appendChild(head);
    body.appendChild(footer);

    item.appendChild(icon);
    item.appendChild(body);

    item.onclick = async (e) => {
      if (Date.now() < this.suppressClickUntil) {
        return;
      }

      if (!e.target.closest('.plugin-switch') && !e.target.closest('button')) {
        await this.openPlugin(plugin.id);
      }
    };

    return item;
  }

  isImageIcon(icon) {
    const value = String(icon || '').trim();
    return /^\/app\/user-plugins\/[^?#]+\.(png|jpe?g|webp|gif)([?#].*)?$/i.test(value) ||
      /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value);
  }

  renderPluginIcon(container, iconValue) {
    container.textContent = '';
    const icon = String(iconValue || '🧩').trim();
    if (!this.isImageIcon(icon)) {
      container.textContent = icon || '🧩';
      return;
    }

    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
    img.onerror = () => {
      container.textContent = '🧩';
    };
    container.appendChild(img);
  }

  renderPluginIconHtml(iconValue) {
    const icon = String(iconValue || '🧩').trim();
    if (!this.isImageIcon(icon)) {
      return escapeHtml(icon || '🧩');
    }
    return `<img src="${escapeHtml(icon)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;">`;
  }

  createSwitch(enabled, onChange) {
    const switchEl = document.createElement('div');
    const handle = document.createElement('div');
    let currentEnabled = Boolean(enabled);

    const syncState = () => {
      switchEl.className = `plugin-switch ${currentEnabled ? 'active' : ''}`;
      switchEl.setAttribute('role', 'switch');
      switchEl.setAttribute('aria-checked', currentEnabled ? 'true' : 'false');
    };

    handle.className = 'plugin-switch-handle';
    switchEl.appendChild(handle);
    syncState();

    switchEl.onclick = async (e) => {
      e.stopPropagation();

      if (switchEl.dataset.busy === 'true') {
        return;
      }

      const previousEnabled = currentEnabled;
      const nextEnabled = !currentEnabled;
      currentEnabled = nextEnabled;
      syncState();
      switchEl.dataset.busy = 'true';

      let success = true;

      try {
        if (typeof onChange === 'function') {
          const result = await onChange(nextEnabled);
          success = result !== false;
        }
      } catch (err) {
        success = false;
      } finally {
        delete switchEl.dataset.busy;
      }

      if (!success) {
        currentEnabled = previousEnabled;
        syncState();
      }
    };

    return switchEl;
  }

  clearDropIndicators() {
    document.querySelectorAll('.plugin-item.drop-before, .plugin-item.drop-after')
      .forEach((element) => {
        element.classList.remove('drop-before', 'drop-after');
      });
  }

  handlePluginDragStart(event, pluginId) {
    this.closePluginContextMenu();
    if (this.sortMode !== 'default') {
      event.preventDefault();
      return;
    }

    if (event.target.closest('.plugin-switch') || event.target.closest('button')) {
      event.preventDefault();
      return;
    }

    this.draggedPluginId = pluginId;
    const item = event.currentTarget?.closest('.plugin-item');
    if (item) {
      item.classList.add('is-drag-origin');
      item.classList.add('is-dragging');
    }

    if (this.currentListElement) {
      this.currentListElement.classList.add('is-drag-active');
    }

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', pluginId);
      } catch (e) {
        console.warn('[PluginPanel] Failed to attach drag payload:', e);
      }
    }
  }

  handlePluginDragOver(event, targetPluginId) {
    if (this.sortMode !== 'default' || !this.draggedPluginId || this.draggedPluginId === targetPluginId) {
      return;
    }

    if (this.pinnedPluginIds.includes(this.draggedPluginId) !== this.pinnedPluginIds.includes(targetPluginId)) {
      this.clearDropIndicators();
      return;
    }

    event.preventDefault();
    const item = event.currentTarget;
    const rect = item.getBoundingClientRect();
    const shouldPlaceAfter = event.clientY > rect.top + (rect.height / 2);

    this.clearDropIndicators();
    item.classList.add(shouldPlaceAfter ? 'drop-after' : 'drop-before');
  }

  handlePluginDragLeave(event) {
    const item = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget && item.contains(relatedTarget)) {
      return;
    }
    item.classList.remove('drop-before', 'drop-after');
  }

  movePluginInCustomOrder(sourcePluginId, targetPluginId, shouldPlaceAfter) {
    if (this.pinnedPluginIds.includes(sourcePluginId) !== this.pinnedPluginIds.includes(targetPluginId)) return false;
    const nextOrder = [...this.customOrder];
    const sourceIndex = nextOrder.indexOf(sourcePluginId);
    const targetIndex = nextOrder.indexOf(targetPluginId);

    if (sourceIndex === -1 || targetIndex === -1 || sourcePluginId === targetPluginId) {
      return false;
    }

    nextOrder.splice(sourceIndex, 1);
    const adjustedTargetIndex = nextOrder.indexOf(targetPluginId);
    const insertIndex = adjustedTargetIndex + (shouldPlaceAfter ? 1 : 0);
    nextOrder.splice(insertIndex, 0, sourcePluginId);

    this.customOrder = nextOrder;
    this.saveCustomOrder();
    return true;
  }

  handlePluginDrop(event, targetPluginId) {
    if (this.sortMode !== 'default' || !this.draggedPluginId || this.draggedPluginId === targetPluginId) {
      this.handlePluginDragEnd();
      return;
    }

    event.preventDefault();
    const item = event.currentTarget;
    const rect = item.getBoundingClientRect();
    const shouldPlaceAfter = event.clientY > rect.top + (rect.height / 2);

    if (this.movePluginInCustomOrder(this.draggedPluginId, targetPluginId, shouldPlaceAfter)) {
      this.renderPluginListView();
    }

    this.handlePluginDragEnd();
  }

  handlePluginDragEnd() {
    this.draggedPluginId = null;
    this.suppressClickUntil = Date.now() + 180;
    this.clearDropIndicators();
    document.querySelectorAll('.plugin-item.is-dragging, .plugin-item.is-drag-origin').forEach((element) => {
      element.classList.remove('is-dragging', 'is-drag-origin');
    });
    if (this.currentListElement) {
      this.currentListElement.classList.remove('is-drag-active');
    }
  }

  async handlePluginToggle(pluginId, shouldEnable, source = 'list') {
    const plugin = window.KOOKPluginLoader?.getPlugin(pluginId);
    if (!plugin) {
      console.error('[PluginPanel] Plugin not found:', pluginId);
      return false;
    }

    try {
      if (Boolean(plugin.enabled) === Boolean(shouldEnable)) {
        return true;
      }

      if (shouldEnable) {
        await window.KOOKPluginLoader.enablePlugin(pluginId, { suppressToast: true, source: 'panel-toggle' });
      } else {
        await window.KOOKPluginLoader.disablePlugin(pluginId, { suppressToast: true, source: 'panel-toggle' });
      }

      this.showNotification(`${plugin.name} 已${shouldEnable ? '启用' : '停用'}`);
    } catch (e) {
      console.error('[PluginPanel] Failed to toggle plugin state:', e);
      this.showNotification(`${plugin.name} ${shouldEnable ? '启用' : '停用'}失败`, 'error');
      return false;
    }

    if (source === 'detail') {
      this.showPluginDetail(pluginId);
      return true;
    }

    await this.renderPluginList();
    return true;
  }

  tryOpenPluginPanel(plugin) {
    if (!plugin) {
      return false;
    }

    const context = plugin.enabled && plugin.context ? plugin.context : undefined;
    const explicitPanelMethods = ['showSwitchPanel', 'showTestPanel', 'showExamplePanel'];

    for (const methodName of explicitPanelMethods) {
      if (typeof plugin[methodName] === 'function') {
        plugin[methodName](context);
        return true;
      }
    }

    const dynamicMethodName = Object.keys(plugin).find((key) => {
      return /^show.+Panel$/.test(key) && typeof plugin[key] === 'function';
    });

    if (dynamicMethodName) {
      plugin[dynamicMethodName](context);
      return true;
    }

    return false;
  }

  async openPlugin(pluginId) {
    const plugin = window.KOOKPluginLoader?.getPlugin(pluginId);
    if (!plugin) {
      return;
    }

    try {
      if (this.tryOpenPluginPanel(plugin)) {
        return;
      }

      const result = await window.KOOKPluginLoader.executePlugin(plugin.id);
      if (result?.success === false) {
        this.showNotification(result.error || `${plugin.name} 打开失败`, 'error');
      }
    } catch (err) {
      console.error('[Plugin UI] Failed to open plugin:', err);
      this.showNotification(`${plugin.name} 打开失败`, 'error');
    }
  }

  restartKook() {
    try {
      let electron = null;

      if (typeof window !== 'undefined' && typeof window.require === 'function') {
        electron = window.require('electron');
      } else if (typeof require === 'function') {
        electron = require('electron');
      }

      const app = electron?.remote?.app;
      if (app?.relaunch && app?.exit) {
        app.relaunch();
        app.exit(0);
        return;
      }

      if (app?.relaunch && app?.quit) {
        app.relaunch();
        app.quit();
        return;
      }

      throw new Error('当前环境不支持应用级重启');
    } catch (e) {
      console.error('[PluginPanel] 重启 KOOK 失败，回退为页面刷新', e);
      location.reload();
    }
  }

  renderFooter() {
    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 10px 18px 14px;
      border-top: 1px solid ${KOOK_THEME.colors.divider};
      display: flex;
      flex-shrink: 0;
      flex-direction: column;
      gap: 10px;
      user-select: none;
    `;

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'plugin-panel-resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-orientation', 'horizontal');
    resizeHandle.title = `拖拽调整高度（最小 ${this.getMinPanelHeight()}px，最大 ${this.getMaxPanelHeight()}px）`;
    resizeHandle.style.cssText = `
      align-self: center;
      width: 72px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(122, 204, 53, 0.28), rgba(122, 204, 53, 0.14));
      border: 1px solid rgba(122, 204, 53, 0.2);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      cursor: ns-resize;
      flex-shrink: 0;
    `;
    resizeHandle.onmousedown = (e) => this.handleResizeMouseDown(e);

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;align-items:center;';

    const refreshBtn = this.createButton('更新', 'secondary', async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      try { this.showUpdateDialog(); }
      finally { refreshBtn.disabled = false; }
    });

    const reloadBtn = this.createButton('重启 KOOK', 'secondary', () => {
      console.log('[PluginPanel] Restart KOOK button clicked');
      this.restartKook();
    });
    
    const okBtn = this.createButton('关闭', 'default', () => {
      console.log('[PluginPanel] OK button clicked');
      this.closePluginContextMenu();
      this.panel.style.display = 'none';
    });
    
    actionsRow.appendChild(refreshBtn);
    actionsRow.appendChild(reloadBtn);
    actionsRow.appendChild(okBtn);
    footer.appendChild(resizeHandle);
    footer.appendChild(actionsRow);
    
    this.panel.appendChild(footer);
    
    console.log('[PluginPanel] Footer rendered');
  }

  showPluginDetail(pluginId) {
    this.closePluginContextMenu();
    const plugin = window.KOOKPluginLoader?.getPlugin(pluginId);
    if (!plugin) return;
    
    const content = document.getElementById('plugin-content');
    if (!content) return;

    this.toolbarRefs = null;
    this.toolbarHost = null;

    const safeName = escapeHtml(plugin.name);
    const safeDescription = escapeHtml(plugin.description || '暂无描述');
    const safeIcon = this.renderPluginIconHtml(plugin.icon || '🧩');
    const safeVersion = escapeHtml(`v${plugin.version || '1.0.0'}`);
    const safePluginId = JSON.stringify(plugin.id);
    const modeLabel = escapeHtml(this.getPluginModeLabel(plugin));
    const openLabel = escapeHtml(this.getPluginActionLabel(plugin));

    content.innerHTML = `
      <div class="plugin-detail-content" style="display:flex; flex-direction:column; gap:16px; max-height:100%; overflow-y:auto; overflow-x:hidden; box-sizing:border-box; padding: 4px 0 16px;">
        <div style="padding: 24px; border-radius: 18px; background: radial-gradient(circle at top right, rgba(122, 204, 53, 0.18), transparent 38%), linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03)); border: 1px solid rgba(255,255,255,0.06);">
          <div style="display:flex; gap:16px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap;">
            <div style="display:flex; gap:16px; align-items:flex-start; min-width:0; flex:1;">
              <div class="plugin-icon-large" style="width: 72px; height: 72px; min-width:72px; border-radius: 18px; background: linear-gradient(135deg, ${KOOK_THEME.colors.primary}, ${KOOK_THEME.colors.primaryHover}); display:flex; align-items:center; justify-content:center; font-size:36px; font-weight:700; color:#fff;">${safeIcon}</div>
              <div style="min-width:0; flex:1;">
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
                  <div style="font-size:22px; font-weight:700; color:${KOOK_THEME.colors.text};">${safeName}</div>
                  <div class="plugin-badge ${plugin.enabled ? 'status-enabled' : 'status-disabled'}">${plugin.enabled ? '已启用' : '未启用'}</div>
                  <div class="plugin-badge meta">${safeVersion}</div>
                </div>
                <div style="font-size:14px; color:${KOOK_THEME.colors.textSecondary}; line-height:1.7; word-break:break-word; white-space:pre-wrap;">${safeDescription}</div>
              </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end; min-width:120px;">
              <div class="plugin-badge meta">${escapeHtml(plugin.id)}</div>
              <div class="plugin-badge meta">${modeLabel}</div>
            </div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
          <div style="padding: 16px; border-radius: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size:12px; color:${KOOK_THEME.colors.textTertiary}; margin-bottom:6px;">常驻状态</div>
            <div style="font-size:16px; color:${KOOK_THEME.colors.text}; font-weight:700;">${plugin.enabled ? '当前已启用' : '当前未启用'}</div>
          </div>
          <div style="padding: 16px; border-radius: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size:12px; color:${KOOK_THEME.colors.textTertiary}; margin-bottom:6px;">打开方式</div>
            <div style="font-size:16px; color:${KOOK_THEME.colors.text}; font-weight:700;">${openLabel}</div>
          </div>
        </div>

        <div class="plugin-detail-actions" style="display: flex; gap: 12px; flex-wrap: wrap; justify-content: flex-start; width: 100%;">
          <button class="plugin-btn plugin-toggle" style="padding: 12px 18px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; background: ${plugin.enabled ? KOOK_THEME.colors.bgLight : KOOK_THEME.colors.primary}; color: #fff;" onclick='window.KOOKPluginUI.togglePluginFromDetail(${safePluginId})'>${plugin.enabled ? '停用常驻' : '启用常驻'}</button>
          <button class="plugin-btn" style="padding: 12px 18px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; background: rgba(122, 204, 53, 0.16); color: #d5ffae;" onclick='window.KOOKPluginUI.openPluginFromDetail(${safePluginId})'>${openLabel}</button>
          <button class="plugin-btn" style="padding: 12px 18px; border: none; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; background: ${KOOK_THEME.colors.bgLight}; color: ${KOOK_THEME.colors.text};" onclick="window.KOOKPluginUI.backToList()">返回列表</button>
        </div>
      </div>
    `;

    const detailScrollable = content.querySelector('.plugin-detail-content');
    this.enableAutoHideScrollbar(detailScrollable);
    
    this.currentView = 'detail';
    this.currentPluginId = pluginId;
  }

  async togglePluginFromDetail(pluginId) {
    const plugin = window.KOOKPluginLoader?.getPlugin(pluginId);
    if (!plugin) return;

    await this.handlePluginToggle(pluginId, !plugin.enabled, 'detail');
  }

  async refreshCurrentView() {
    try {
      await this.renderPluginList(null, { forceRefresh: true });

      if (this.currentView === 'detail' && this.currentPluginId) {
        const plugin = window.KOOKPluginLoader?.getPlugin(this.currentPluginId);
        if (plugin) {
          this.showPluginDetail(this.currentPluginId);
          return;
        }
      }

      this.currentView = 'list';
      this.currentPluginId = null;
    } catch (e) {
      console.error('[PluginPanel] Refresh plugin panel failed:', e);
    }
  }

  backToList() {
    this.renderPluginList();
    this.currentView = 'list';
    this.currentPluginId = null;
  }

  showImportDialog(mode = 'import') {
    if (this.importBusy) return;
    this.closeImportDialog();
    this.importPreviousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'plugin-dialog-overlay plugin-import-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'plugin-dialog plugin-import-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-labelledby', 'plugin-import-title');
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this.importDialog = overlay;
    overlay.onclick = event => { if (event.target === overlay) this.closeImportDialog(); };
    this.importKeyHandler = event => {
      const modal = dialog.getAttribute('aria-modal') === 'true';
      if (event.key === 'Escape' && (modal || dialog.contains(event.target))) { event.preventDefault(); event.stopImmediatePropagation(); this.closeImportDialog(); }
      if (event.key === 'Tab' && modal) {
        const controls = [...dialog.querySelectorAll('button,input,summary')].filter(element => !element.disabled && element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', this.importKeyHandler, true);
    if (mode === 'update') {
      this.updateDialog = true;
      this.runUpdateCheck();
    } else this.showFileImport();
  }

  showUpdateDialog() {
    if (this.importBusy || this.updateDialog) return;
    this.showImportDialog('update');
  }

  renderUpdateDialog({ title, description, body = '', primary, secondary }) {
    if (!this.updateDialog || !this.importDialog) return;
    const dialog = this.importDialog.querySelector('.plugin-dialog');
    dialog.classList.add('plugin-package-dialog', 'plugin-update-dialog');
    dialog.innerHTML = `
      <header class="plugin-import-header"><div class="plugin-update-heading"><span class="plugin-update-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/></svg></span><div><h3 id="plugin-import-title">${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div></div><button type="button" class="plugin-import-close" id="plugin-update-close" aria-label="关闭更新弹窗" ${this.importBusy ? 'disabled' : ''}>×</button></header>
      <div class="plugin-import-body" aria-live="polite">${body}</div>
      <footer class="plugin-dialog-actions"><p class="plugin-import-footer-note"><a class="plugin-update-admin" href="https://kfc-api.vanillacake.cn/admin" target="_blank" rel="noopener noreferrer" title="在浏览器打开 KFC 管理后台">KFC 管理后台<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg></a></p><button type="button" id="plugin-update-secondary">${escapeHtml(secondary?.label || '关闭')}</button>${primary ? `<button type="button" id="plugin-update-primary" class="plugin-import-primary">${escapeHtml(primary.label)}</button>` : ''}</footer>`;
    dialog.querySelector('.plugin-update-admin').onclick = async event => {
      if (!window.Kaiheila?.System?.openExternal) return;
      event.preventDefault();
      try { await window.Kaiheila.System.openExternal('https://kfc-api.vanillacake.cn/admin'); }
      catch { this.showNotification('无法打开 KFC 管理后台，请右键复制链接到浏览器打开', 'error'); }
    };
    dialog.querySelector('#plugin-update-close').onclick = () => this.closeImportDialog();
    const cancel = dialog.querySelector('#plugin-update-secondary');
    cancel.disabled = !!this.importBusy;
    cancel.onclick = secondary?.action || (() => this.closeImportDialog());
    if (primary) dialog.querySelector('#plugin-update-primary').onclick = primary.action;
    this.bindImportDialogDrag();
    dialog.tabIndex = -1;
    dialog.focus();
  }

  async runUpdateCheck() {
    const overlay = this.importDialog;
    this.renderUpdateDialog({ title: '检查更新', description: '正在从 KFC 获取注入器和已安装插件的最新版本…', secondary: { label: '取消' } });
    try {
      if (!window.KOOKDlcInstaller?.checkUpdates) throw new Error('当前实例尚不支持在线更新，请先使用新版注入器应用一次');
      const result = await window.KOOKDlcInstaller.checkUpdates();
      if (this.importDialog !== overlay || !this.updateDialog) return;
      const notes = (result.notes || []).map(note => `<p class="plugin-package-note">${escapeHtml(note)}</p>`).join('');
      if (!result.changes.length) {
        this.renderUpdateDialog({ title: result.notes?.length ? '暂无可安装更新' : '已是最新版本', description: `当前注入器 v${result.hostVersion}，已安装插件没有可用更新。`, body: notes });
        return;
      }
      const rows = result.changes.map(item => `<div class="plugin-update-item"><div class="plugin-update-item-heading"><strong>${escapeHtml(item.name)}</strong><span class="plugin-update-versions"><span>v${escapeHtml(item.currentVersion)}</span><span aria-label="更新至">→</span><span class="plugin-update-version-new">v${escapeHtml(item.version)}</span></span></div>${item.changelog ? `<details><summary>更新内容</summary><p>${escapeHtml(item.changelog)}</p></details>` : ''}</div>`).join('');
      this.renderUpdateDialog({ title: '发现可用更新', description: '安装后重新加载生效，保留插件配置和自定义插件。', body: rows + notes, secondary: { label: '稍后' }, primary: { label: `安装 ${result.changes.length} 项更新`, action: () => this.installKfcUpdates(result.id) } });
    } catch (error) {
      if (this.importDialog !== overlay || !this.updateDialog) return;
      if (error.code === 'KFC_AUTH_REQUIRED') this.showKfcConnection(error.message);
      else this.renderUpdateDialog({ title: '暂时无法检查更新', description: error.message || '连接失败，请稍后重试', primary: { label: '重试', action: () => this.runUpdateCheck() } });
    }
  }

  showKfcConnection(message = '') {
    this.renderUpdateDialog({ title: '连接 KFC', description: message || '连接后即可检查和安装更新。', body: '<label for="plugin-kfc-token" class="plugin-update-field-label">KFC 访问令牌</label><input id="plugin-kfc-token" class="plugin-url-input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴你的 KFC 令牌"><p class="plugin-package-note">连接信息仅保存在当前电脑，并由 Windows 加密。</p>', primary: { label: '连接并检查', action: async () => {
      const overlay = this.importDialog;
      const input = overlay.querySelector('#plugin-kfc-token');
      const value = input.value.trim();
      input.value = '';
      this.renderUpdateDialog({ title: '正在连接 KFC', description: '正在验证连接…', secondary: { label: '取消' } });
      try {
        await window.KOOKDlcInstaller.connectKfc(value);
        if (overlay === this.importDialog && this.updateDialog) await this.runUpdateCheck();
      } catch (error) {
        if (overlay === this.importDialog && this.updateDialog) this.showKfcConnection(error.message || '连接失败，请重试');
      }
    } } });
  }

  async installKfcUpdates(id) {
    if (this.importBusy || !this.updateDialog) return;
    const overlay = this.importDialog;
    this.importBusy = true;
    this.renderUpdateDialog({ title: '正在安装更新', description: '正在下载并校验安装包，请保持 KOOK 打开。', body: '<p role="status">安装完成后可选择何时重新加载。</p>' });
    try {
      const result = await window.KOOKDlcInstaller.installUpdates(id);
      if (overlay !== this.importDialog) return;
      this.importBusy = false;
      this.renderUpdateDialog({ title: '更新已安装', description: `${result.installed.length} 项更新已完成，重新加载后生效。`, secondary: { label: '稍后' }, primary: { label: '重新加载并生效', action: () => { this.closeImportDialog(); window.location.reload(); } } });
    } catch (error) {
      if (overlay !== this.importDialog) return;
      this.importBusy = false;
      if (error.code === 'KFC_AUTH_REQUIRED') this.showKfcConnection(error.message);
      else this.renderUpdateDialog({ title: '更新未完成', description: error.message || '安装失败，请重新检查更新', primary: { label: '重新检查', action: () => this.runUpdateCheck() } });
    } finally { this.importBusy = false; }
  }

  bindImportDialogDrag() {
    this.cleanupImportDrag?.();
    const dialog = this.importDialog.querySelector('.plugin-dialog');
    const header = dialog.querySelector('.plugin-import-header');
    let drag = null;
    const position = (x, y) => {
      const rect = dialog.getBoundingClientRect();
      dialog.style.position = 'fixed';
      dialog.style.left = Math.max(16, Math.min(x, window.innerWidth - rect.width - 16)) + 'px';
      dialog.style.top = Math.max(16, Math.min(y, window.innerHeight - rect.height - 16)) + 'px';
    };
    const fit = () => {
      if (!dialog.style.position) return;
      const rect = dialog.getBoundingClientRect();
      position(rect.left, rect.top);
    };
    const finish = () => {
      const pointerId = drag?.id;
      drag = null;
      delete dialog.dataset.dragging;
      if (pointerId !== undefined && header.hasPointerCapture?.(pointerId)) header.releasePointerCapture(pointerId);
    };
    const start = event => {
      if (event.button !== 0 || event.target.closest('button,input,a,summary')) return;
      const rect = dialog.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      dialog.dataset.dragging = 'true';
      event.preventDefault();
      header.setPointerCapture(event.pointerId);
    };
    const move = event => {
      if (event.pointerId !== drag?.id) return;
      position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    };
    header.addEventListener('pointerdown', start);
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
    header.addEventListener('lostpointercapture', finish);
    window.addEventListener('resize', fit);
    window.addEventListener('blur', finish);
    const observer = new ResizeObserver(fit);
    observer.observe(dialog);
    this.cleanupImportDrag = () => {
      finish();
      observer.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('blur', finish);
      header.removeEventListener('pointerdown', start);
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', finish);
      header.removeEventListener('pointercancel', finish);
      header.removeEventListener('lostpointercapture', finish);
    };
  }

  showFileImport(mode = 'package') {
    if (this.importBusy) return;
    this.importMode = mode;
    this.importSelection = null;
    this.importReadGeneration = (this.importReadGeneration || 0) + 1;
    const dialog = this.importDialog.querySelector('.plugin-dialog');
    dialog.classList.add('plugin-package-dialog');
    dialog.setAttribute('aria-describedby', 'plugin-import-description');
    dialog.innerHTML = `
      <header class="plugin-import-header"><div><h3 id="plugin-import-title">${mode === 'package' ? '导入插件' : '导入单文件脚本'}</h3><p id="plugin-import-description">${mode === 'package' ? '将 KFC 的 DLC 安装到当前 KOOK' : '选择适用于本插件中心的 JavaScript 插件'}</p></div><button type="button" class="plugin-import-close" id="plugin-import-close" aria-label="关闭导入弹窗"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div class="plugin-import-body">
      <input type="file" accept="${mode === 'package' ? '.zip' : '.js'}" id="plugin-file-input" hidden>
      <button type="button" class="plugin-package-pick" id="plugin-package-pick"><span class="plugin-package-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v8 M7.5 5.5l9 5"/></svg></span><span class="plugin-package-copy"><span id="plugin-package-filename">${mode === 'package' ? '选择 DLC 安装包' : '选择 JS 脚本'}</span><small>${mode === 'package' ? 'ZIP 格式，无需解压' : '单文件 .js 格式'}</small></span><svg class="plugin-package-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>
      <div class="plugin-package-preview" id="plugin-import-preview" hidden><div class="plugin-package-title"><strong data-package-name></strong><span data-package-version></span></div><p class="plugin-package-note" data-package-description></p><p class="plugin-package-note" data-package-current></p></div>
      <p class="plugin-import-feedback" id="plugin-import-feedback" role="status" aria-live="polite" hidden></p>
      ${mode === 'package' ? '<details><summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>导入其他格式</summary><div class="plugin-import-extra"><button type="button" id="plugin-import-script">JS 脚本</button><button type="button" id="plugin-import-url">脚本链接</button></div></details>' : ''}
      </div>
      <footer class="plugin-dialog-actions">
        <p class="plugin-import-footer-note">${mode === 'package' ? '安装后重新加载生效' : '导入后在列表中启用'}</p>
        <button type="button" id="plugin-import-back">${mode === 'package' ? '取消' : '返回'}</button>
        <button type="button" id="plugin-import-submit" class="plugin-import-primary" ${mode === 'package' ? 'disabled' : ''}>${mode === 'package' ? '安装' : '导入'}</button>
      </footer>
    `;
    const input = dialog.querySelector('#plugin-file-input');
    dialog.querySelector('#plugin-import-close').onclick = () => this.closeImportDialog();
    dialog.querySelector('#plugin-package-pick').onclick = () => input.click();
    input.onchange = () => this.prepareFileImport(input.files[0]);
    dialog.querySelector('#plugin-import-back').onclick = () => mode === 'package' ? this.closeImportDialog() : this.showFileImport();
    dialog.querySelector('#plugin-import-submit').onclick = () => this.importFromFile();
    if (mode === 'package') {
      dialog.querySelector('#plugin-import-script').onclick = () => this.showFileImport('script');
      dialog.querySelector('#plugin-import-url').onclick = () => this.showUrlImport();
    }
    this.bindImportDialogDrag();
    dialog.tabIndex = -1;
    dialog.focus();
  }

  importFeedback(message, state = 'info') {
    const feedback = this.importDialog?.querySelector('#plugin-import-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = state;
    feedback.hidden = !message;
  }

  async prepareFileImport(file) {
    const generation = this.importReadGeneration = (this.importReadGeneration || 0) + 1;
    const overlay = this.importDialog;
    this.importSelection = null;
    const submit = overlay.querySelector('#plugin-import-submit');
    const previewElement = overlay.querySelector('#plugin-import-preview');
    previewElement.hidden = true;
    overlay.querySelector('#plugin-package-pick').dataset.selected = 'false';
    this.importFeedback('');
    overlay.querySelector('#plugin-package-filename').textContent = file?.name || (this.importMode === 'package' ? '选择 DLC 安装包' : '选择 JS 脚本');
    if (this.importMode !== 'package') return;
    submit.disabled = true;
    if (!file) { this.importFeedback('请选择 DLC ZIP 安装包'); return; }
    if (!/\.zip$/i.test(file.name)) { this.importFeedback('请选择从 KFC 下载的 DLC ZIP 安装包', 'error'); return; }
    if (file.size > 16 * 1024 * 1024) { this.importFeedback('安装包大小不能超过 16 MB', 'error'); return; }
    this.importFeedback('正在读取安装包…');
    try {
      if (!window.KOOKDlcInstaller) throw new Error('ZIP 安装组件尚未就绪，请先用新版注入器更新此 KOOK 实例');
      const bytes = await file.arrayBuffer();
      if (generation !== this.importReadGeneration || overlay !== this.importDialog) return;
      const preview = await window.KOOKDlcInstaller.inspect(bytes);
      if (generation !== this.importReadGeneration || overlay !== this.importDialog) return;
      this.importSelection = { bytes, preview };
      overlay.querySelector('[data-package-name]').textContent = preview.name;
      overlay.querySelector('[data-package-version]').textContent = 'v' + preview.version;
      overlay.querySelector('[data-package-description]').textContent = preview.description;
      overlay.querySelector('[data-package-current]').textContent = preview.currentVersion ? '当前已安装 v' + preview.currentVersion + ' · 原有配置与开关选择会保留' : '作者 ' + preview.author;
      previewElement.hidden = false;
      overlay.querySelector('#plugin-package-pick').dataset.selected = 'true';
      submit.disabled = false;
      submit.textContent = preview.currentVersion === preview.version ? '重新安装' : '安装';
      this.importFeedback('');
    } catch (error) {
      if (generation === this.importReadGeneration && overlay === this.importDialog) this.importFeedback(error.message || '安装包读取失败', 'error');
    }
  }

  async importDlcPackage() {
    if (this.importBusy || !this.importSelection) return;
    const { bytes, preview } = this.importSelection;
    const overlay = this.importDialog;
    this.importBusy = true;
    const controls = [...overlay.querySelectorAll('button,input,summary')];
    for (const control of controls) { if ('disabled' in control) control.disabled = true; }
    this.importFeedback('正在安装 ' + preview.name + '…');
    // Allow the pending state to paint before the local installation begins.
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      await window.KOOKDlcInstaller.install(bytes, preview);
      this.importSelection = null;
      overlay.querySelector('details')?.remove();
      this.importFeedback(preview.name + ' 已安装。重新加载 KOOK 后生效。', 'success');
      const actions = overlay.querySelector('.plugin-dialog-actions');
      actions.replaceChildren();
      const later = document.createElement('button');
      later.textContent = '稍后';
      later.onclick = () => this.closeImportDialog();
      const reload = document.createElement('button');
      reload.className = 'plugin-import-primary';
      reload.textContent = '重新加载并生效';
      reload.onclick = () => location.reload();
      actions.append(later, reload);
      overlay.querySelector('#plugin-import-close').disabled = false;
      reload.focus();
    } catch (error) {
      this.importFeedback(error.message || '安装失败，请重新选择安装包', 'error');
      for (const control of controls) { if ('disabled' in control) control.disabled = false; }
      this.importSelection = null;
      overlay.querySelector('#plugin-import-submit').disabled = true;
    } finally { this.importBusy = false; }
  }

  showUrlImport() {
    if (this.importBusy) return;
    this.importMode = 'url';
    this.importReadGeneration = (this.importReadGeneration || 0) + 1;
    this.importSelection = null;
    const dialog = this.importDialog.querySelector('.plugin-dialog');
    dialog.classList.add('plugin-package-dialog');
    dialog.setAttribute('aria-describedby', 'plugin-import-description');
    
    dialog.innerHTML = `
      <header class="plugin-import-header"><div><h3 id="plugin-import-title">从链接导入脚本</h3><p id="plugin-import-description">输入可直接下载插件脚本的链接</p></div><button type="button" class="plugin-import-close" id="plugin-import-close" aria-label="关闭导入弹窗"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div class="plugin-import-body">
      <input type="url" class="plugin-url-input" id="plugin-url-input" aria-label="插件脚本链接" placeholder="https://example.com/plugin.js">
      <p class="plugin-import-feedback" id="plugin-import-feedback" role="status" aria-live="polite" hidden></p>
      </div>
      <footer class="plugin-dialog-actions">
        <p class="plugin-import-footer-note">导入后在列表中启用</p>
        <button type="button" id="plugin-import-back">返回</button>
        <button type="button" id="plugin-import-submit" class="plugin-import-primary">导入</button>
      </footer>
    `;
    
    dialog.querySelector('#plugin-import-close').onclick = () => this.closeImportDialog();
    dialog.querySelector('#plugin-import-back').onclick = () => this.showFileImport();
    dialog.querySelector('#plugin-import-submit').onclick = () => this.importFromUrl();
    this.bindImportDialogDrag();
    dialog.tabIndex = -1;
    dialog.focus();
  }

  async importFromFile() {
    if (this.importMode === 'package') return this.importDlcPackage();
    const fileInput = document.getElementById('plugin-file-input');
    const file = fileInput.files[0];

    if (!file) {
      this.importFeedback('请选择 JS 脚本文件', 'error');
      return;
    }

    const fileValidation = validateFile(file);
    if (!fileValidation.valid) {
      this.importFeedback(fileValidation.error, 'error');
      return;
    }

    try {
      const overlay = this.importDialog;
      const generation = this.importReadGeneration;
      const content = await file.text();
      if (overlay !== this.importDialog || generation !== this.importReadGeneration) return;

      const pluginName = extractPluginName(content);
      const codeValidation = validatePluginCode(content, pluginName);
      if (!codeValidation.valid) {
        this.importFeedback(codeValidation.error, 'error');
        return;
      }

      const filename = file.name;
      const result = await window.KOOKPluginLoader.addPlugin(content, filename);
      if (overlay !== this.importDialog || generation !== this.importReadGeneration) return;

      if (result.success) {
        this.closeImportDialog();
        this.renderPluginList();
      } else {
        this.importFeedback(result.error || '导入失败', 'error');
      }
    } catch (e) {
      this.importFeedback(e.message || '导入失败', 'error');
    }
  }

  async importFromUrl() {
    const urlInput = document.getElementById('plugin-url-input');
    const url = urlInput.value.trim();

    if (!url) {
      this.importFeedback('请输入脚本链接', 'error');
      return;
    }

    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      this.importFeedback(urlValidation.error, 'error');
      return;
    }

    try {
      const overlay = this.importDialog;
      const generation = this.importReadGeneration;
      const response = await fetchWithRetry(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Accept': 'text/javascript, application/json'
        },
        redirect: 'error'
      });

      const content = await response.text();
      if (overlay !== this.importDialog || generation !== this.importReadGeneration) return;

      const pluginName = extractPluginName(content);
      const codeValidation = validatePluginCode(content, pluginName);
      if (!codeValidation.valid) {
        this.importFeedback(codeValidation.error, 'error');
        return;
      }

      const filename = url.split('/').pop() || 'plugin.js';
      const result = await window.KOOKPluginLoader.addPlugin(content, filename);
      if (overlay !== this.importDialog || generation !== this.importReadGeneration) return;

      if (result.success) {
        this.closeImportDialog();
        this.renderPluginList();
      } else {
        this.importFeedback(result.error || '导入失败', 'error');
      }
    } catch (e) {
      this.importFeedback(e.message || '导入失败', 'error');
    }
  }

  closeImportDialog() {
    if (this.importBusy) return;
    if (this.updateDialog) window.KOOKDlcInstaller?.cancelUpdates?.();
    this.updateDialog = false;
    this.cleanupImportDrag?.();
    this.cleanupImportDrag = null;
    this.importReadGeneration = (this.importReadGeneration || 0) + 1;
    this.importSelection = null;
    if (this.importKeyHandler) document.removeEventListener('keydown', this.importKeyHandler, true);
    this.importKeyHandler = null;
    if (this.importDialog) {
      this.importDialog.remove();
      this.importDialog = null;
    }
    this.importPreviousFocus?.focus();
    this.importPreviousFocus = null;
  }

  toggle() {
    console.log('[PluginPanel] Toggle called');
    console.log('[PluginPanel] Current timestamp:', Date.now());
    
    const existingPanel = document.getElementById('kook-plugin-panel');
    if (existingPanel) {
      console.log('[PluginPanel] Found existing panel, removing...');
      existingPanel.remove();
    }
    
    this.panel = null;
    
    console.log('[PluginPanel] About to create new panel...');
    this.create();
    
    setTimeout(() => {
      const panel = document.getElementById('kook-plugin-panel');
      if (panel) {
        console.log('[PluginPanel] Panel verified to exist in DOM');
        const importBtn = panel.textContent.includes('瀵煎叆鎻掍欢');
        console.log('[PluginPanel] Panel contains "瀵煎叆鎻掍欢":', importBtn);
        
        const allButtons = panel.querySelectorAll('button');
        console.log('[PluginPanel] Total buttons in panel:', allButtons.length);
        allButtons.forEach((btn, i) => {
          console.log(`[PluginPanel] Button ${i}:`, btn.textContent.trim());
        });
      } else {
        console.error('[PluginPanel] ERROR: Panel not found in DOM after creation!');
      }
    }, 100);
  }
}

let draggableButton = null;
let entryButtonPollTimer = null;

function addPluginEntryButton() {
  const existingButton = document.getElementById('kook-plugin-entry-btn');
  if (existingButton && draggableButton?.btn === existingButton) {
    return true;
  }

  // The floating entry belongs to the document, not KOOK's React root.
  if (!document.body) {
    return false;
  }

  if (draggableButton) {
    draggableButton.destroy();
    draggableButton = null;
  }
  if (existingButton) existingButton.remove();
  let btn;
  try {
    btn = document.createElement('div');
    btn.id = 'kook-plugin-entry-btn';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'kook-plugin-btn-content';

    const icon = document.createElement('img');
    icon.src = PLUGIN_CONFIG.paths.pluginIcon;
    icon.width = 24;
    icon.height = 24;
    icon.onerror = () => {
      console.error('[KOOK Plugin] Failed to load icon:', PLUGIN_CONFIG.paths.pluginIcon);
      icon.style.display = 'none';
    };

    const text = document.createElement('span');
    text.textContent = '\u63d2\u4ef6';

    contentDiv.appendChild(icon);
    contentDiv.appendChild(text);
    btn.appendChild(contentDiv);
    document.body.appendChild(btn);

    draggableButton = new DraggableButton();
    draggableButton.init(btn);

    console.log('[KOOK Plugin] Entry button added successfully!');
    return true;
  } catch (e) {
    // Do not leave a half-initialized node that subsequent polls mistake for success.
    if (draggableButton) draggableButton.destroy();
    draggableButton = null;
    if (btn) btn.remove();
    console.error('[KOOK Plugin] Failed to create button:', e);
    return false;
  }
}

function startEntryButtonPolling() {
  addPluginEntryButton();
  if (entryButtonPollTimer) return;

  entryButtonPollTimer = window.setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      addPluginEntryButton();
    }
  }, PLUGIN_CONFIG.observer.entryButtonPollInterval);
}

function cleanupEntryButton() {
  if (entryButtonPollTimer) {
    window.clearInterval(entryButtonPollTimer);
    entryButtonPollTimer = null;
  }
  
  if (draggableButton) {
    draggableButton.destroy();
    draggableButton = null;
  }
  
  const btn = document.getElementById('kook-plugin-entry-btn');
  if (btn) {
    btn.remove();
  }
}

console.log('[KOOK Plugin UI] ====== Plugin UI script loaded ======');

injectStyles();

const pluginPanel = new PluginPanel();

window.KOOKPluginUI = {
  toggle: () => pluginPanel.toggle(),
  showNotification: (message, type) => pluginPanel.showNotification(message, type),
  updatePluginSummary: (id) => pluginPanel.updatePluginSummary(id),
  refreshPluginList: () => pluginPanel.renderPluginList(),
  showImportDialog: () => pluginPanel.showImportDialog(),
  showFileImport: () => pluginPanel.showFileImport(),
  showUrlImport: () => pluginPanel.showUrlImport(),
  importFromFile: () => pluginPanel.importFromFile(),
  importFromUrl: () => pluginPanel.importFromUrl(),
  closeImportDialog: () => pluginPanel.closeImportDialog(),
  backToList: () => pluginPanel.backToList(),
  openPluginFromDetail: (id) => pluginPanel.openPlugin(id),
  togglePluginFromDetail: (id) => pluginPanel.togglePluginFromDetail(id)
};

console.log('[KOOK Plugin UI] KOOKPluginUI registered');

startEntryButtonPolling();
window.addEventListener('pagehide', cleanupEntryButton);
window.addEventListener('pageshow', startEntryButtonPolling);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') {
    startEntryButtonPolling();
    draggableButton?.constrainToViewport();
  }
});

} // End of browser environment check / duplicate load check
