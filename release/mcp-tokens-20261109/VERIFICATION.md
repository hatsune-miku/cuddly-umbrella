# mcp-tokens-20261109

2026-11-09 15:57（Asia/Shanghai）部署完成。

## 范围

- 主页账号菜单新增 MCP 接入，使用现有 CakeUI 风格。个人 Token 可生成、复制配置和撤销，原文仅返回一次。
- `mcp_personal_tokens` 独立 PostgreSQL 表：256 位随机秘密、SHA-256 摘要、用户外键、前缀、创建/使用/撤销时间；无固定过期时间，不依赖浏览器会话。
- 所有权限检查跟随账号当前等级/角色，Token 只接受 Authorization Bearer，不接受 Cookie，也不能访问个人隐私或创建其他凭据。
- HTTP 与 stdio 共用鉴权；stdio 配置变量为 BIFROST_MCP_TOKEN。旧 OAuth/stdio 登录凭据兼容保留。
- 只更新 API 和 Console 镜像，部署时确认没有活动构建并临时暂停 Worker，完成后恢复。

## 验证

- 全量 Vitest：555 通过，3 跳过。两项 PostgreSQL 集成测试使用隔离临时 schema 单独运行通过；剩余为原有可选 Artifact 存储集成测试。
- 全项目 typecheck、build 通过。
- 新增 9 项 API/协议测试涵盖 level 0 发放、越权否定、CSRF、只存摘要、退出/过期/重启、动态权限、实际 HTTP MCP、业务写入、Cookie/隐私/衍生凭据隔离、20 个并发上限。
- PostgreSQL 验证重连持久性、重复初始化、撤销持久性及并发发放上限，临时 schema 已清理。
- 隔离浏览器验证主页入口、生成、剪贴板 JSON 配置、刷新不再显示原文、不写浏览器存储、撤销、旧会话重新登录提示和 360px 布局。截图在 output/mcp-token-review。
- stdio 使用新 Token 与旧会话分别验证 0/1/2/4/6/8 级工具目录与 whoami。
- 线上设置页 HTTP 200，匿名管理接口 401/no-store，无效个人 Token 401。既有 MCP whoami 仍成功，CSRF 脱敏。
- 线上新表创建成功，未替任何用户生成 Token；API、Console、Gateway 等健康，Worker 已恢复轮询。

## 发布与代码来源

备份 `/home/miku/cuddly-backups/pre-mcp-tokens-20261109`，数据库备份权限 600。镜像保留 `cuddly-control-api:pre-mcp-tokens-20261109` 和 `cuddly-console:pre-mcp-tokens-20261109`。

已执行 git fetch origin 和 git ls-remote --symref origin；远端没有任何 refs，本地 main 也没有首次提交，全部工作文件为未跟踪。因此没有可拉取/合并的提交，基于现有本地代码实施，未提交或推送代码。服务器部署目录不含 Git 仓库。
