# PC 系统浏览器登录修复

KOOK 中的 iframe 与外部 Chrome 不共享 Cookie、BroadcastChannel 或 opener，因此 DLC 0.3.0 的窗口回传不能完成系统浏览器登录。

修复仅涉及托管面板和 Control API，DLC 0.3.0 的安装包不变：

- 新增五分钟有效、一次性领取的登录请求，使用 SHA-256 校验面板持有的随机密钥；密钥不放入浏览器 URL。
- 飞书登录后显示身份与验证码，由用户确认登录 KOOK PC。
- 面板轮询领取独立会话，保留原身份与权限上限，浏览器会话在领取时重新验证。
- 无需 Cookie、BroadcastChannel 或 opener；关闭并重新打开面板可恢复待完成的请求。
- 取消、过期、错误密钥、跨站确认、Guest、重复及并行领取均有回归测试。
- 仅更新 API 和 Console，不重启 KOOK、Gateway、Runner 或 Build Worker。

验证：完整测试 529 通过，2 跳过；Control API 类型检查与构建、Console 构建通过。真实用户飞书登录由用户在 KOOK 中确认。
