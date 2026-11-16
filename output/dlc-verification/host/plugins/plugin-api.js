// KOOK 插件 API 实现

if (window.KOOKPluginAPI) {
  console.log('[Plugin API] Already loaded, skipping...');
} else {
const PluginAPI = {
  registerMenu(options) {
    console.log('[Plugin API] 注册菜单:', options);
    return options.id;
  },

  onMessage(name, handler) {
    console.log('[Plugin API] 监听消息:', name);
  },

  showToast(message, type = 'info') {
    console.log('[Plugin API] 显示提示:', message);
    if (typeof alert !== 'undefined') {
      alert(message);
    }
  },

  openUrl(url) {
    console.log('[Plugin API] 打开链接:', url);
    if (typeof window !== 'undefined' && window.open) {
      window.open(url);
    }
  },

  sendToRenderer(name, data) {
    console.log('[Plugin API] 发送消息:', name, data);
  },

  getConfig(key) {
    if (typeof localStorage !== 'undefined') {
      const config = localStorage.getItem(`plugin-config-${key}`);
      return config ? JSON.parse(config) : null;
    }
    return null;
  },

  setConfig(key, value) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`plugin-config-${key}`, JSON.stringify(value));
    }
  },

  getUserInfo() {
    if (typeof document === 'undefined') return null;
    try {
      const userElements = document.querySelectorAll('[class*="user-name"], [class*="username"], [class*="User"]');
      if (userElements.length > 0) {
        const username = userElements[0].textContent?.trim();
        return username ? { username } : null;
      }
      return null;
    } catch (e) {
      console.error('[Plugin API] Failed to get user info:', e);
      return null;
    }
  },

  getChannelInfo() {
    if (typeof document === 'undefined') return null;
    try {
      const channelElements = document.querySelectorAll('[class*="channel-name"], [class*="Channel"]');
      if (channelElements.length > 0) {
        const channelName = channelElements[0].textContent?.trim();
        return channelName ? { name: channelName } : null;
      }
      return null;
    } catch (e) {
      console.error('[Plugin API] Failed to get channel info:', e);
      return null;
    }
  },

  sendChannelMessage(content) {
    if (typeof document === 'undefined') return { success: false, error: 'Document not available' };
    try {
      const inputElements = document.querySelectorAll('textarea, input[type="text"]');
      for (const input of inputElements) {
        if (input.offsetParent !== null) {
          input.value = content;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const sendButton = input.parentElement?.querySelector('button, [role="button"]');
          if (sendButton) {
            sendButton.click();
            return { success: true };
          }
        }
      }
      return { success: false, error: 'No input element found' };
    } catch (e) {
      console.error('[Plugin API] Failed to send message:', e);
      return { success: false, error: e.message };
    }
  }
};

if (typeof window !== 'undefined') {
  window.KOOKPluginAPI = PluginAPI;
  console.log('[KOOK Plugin API] ====== Plugin API script loaded ======');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PluginAPI;
}
}
