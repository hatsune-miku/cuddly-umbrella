# Bifrost 公开身份与个人隐私

## 数据边界

- `user_accounts.display_name` 是 Bifrost 名字，`name` 是兼容旧客户端的公开别名。新用户与迁移用户初始使用 `用户-<完整用户 ID>`。
- `tenantKey`、`openId`、头像、Bifrost 来源用户名为公开账号资料。邮箱不在展示 DTO 中。
- `user_private_profiles.fields` 独立保存提供方资料；目前仅 `feishu.realName`、`feishu.username` 通过专用私有 DTO 输出。未来字段须明确注册，不能直接返回整段 JSON。
- 用户名来源 `username_source=bifrost` 才进入公开 DTO；其他来源保守地按私有处理，旧值迁至私有资料后清空公开列。
- 业务署名内部写入 `user:<UUID>`，对外统一投影为当前公开名字，并附带 `requestedById` / `createdById` 等稳定 ID。无法可靠关联的历史署名显示“历史用户”，原值仅保留服务器归档，不能按历史真实姓名搜索。

## API 与会话

- `GET /api/v1/me` 返回自己的公开资料。
- `PATCH /api/v1/me` 只接受 `displayName`，所有已认证用户（包括 level 0）可改自己的名字；不接受目标用户 ID，Cookie 写入仍需 CSRF。
- `GET /api/v1/me/private-profile` 仅接受本人交互登录产生的 `browser` Cookie，不接受 Bearer、查询目标 ID 或任意管理员豁免。没有读取其他用户隐私的管理路由。
- PC/MCP 派生会话分别标记 `pc` / `mcp`。迁移前会话为 `legacy`：正常功能保持有效，但查看私有详情须在浏览器重新登录。
- 私有数据不进入普通 session、MCP、用户管理、列表搜索或业务 DTO。`whoami.session.identity.name` 现在是公开名字，不再无条件遮盖。
- 私有响应 `Cache-Control: no-store`。页面仅在“个人设置 → 账号与登录 → 飞书账号详情”获取私有数据，离开/隐藏页面即清空，不写浏览器存储。
- OAuth 更新提供方姓名和头像，不覆盖用户自行设置的公开名字。

## 迁移与发布

迁移 `20261106-public-profile-v1` 与原权限迁移共享初始化锁，可重复运行，不重复初始化名字。迁移前停止 API、Gateway 和 Worker，并备份数据库；不在有活动构建时切换版本。

回滚必须成对恢复旧镜像和迁移前数据库，不能只切回旧代码；旧代码会再次以飞书姓名作为公开身份。备份权限为服务器账号专用，不能通过应用下载。

验证覆盖全量单元/集成测试、独立 PostgreSQL schema 的旧数据迁移和重复初始化、level 0 改名、管理员越权否定、派生会话隔离、真实姓名搜索隔离、浏览器深层页面与窄屏布局、stdio / HTTP MCP 握手及授权回调。

本边界针对 Bifrost 管理的身份资料，不修改用户主动写进分支名、需求描述、构建日志等自由文本的内容。
