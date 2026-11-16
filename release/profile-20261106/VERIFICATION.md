# profile-20261106

2026-11-06 12:20（Asia/Shanghai）已部署并完成只读核验。

- 全量 Vitest：546 通过，2 跳过（其中 PostgreSQL 用独立命令单独执行通过，另一个为原有可选 Artifact 存储集成测试）。
- PostgreSQL 独立临时 schema：旧账号/会话迁移、原始署名服务器归档、重复初始化、改名持久化、权限事务测试通过；临时 schema 已清理。
- `pnpm typecheck`、`pnpm build` 通过。
- 隔离浏览器：level 0 改名、无隐私预取、深层详情访问、离开清除、360px 布局及无运行时异常通过。截图在 `output/profile-review/`。
- stdio MCP 各等级工具目录、HTTP OAuth + PKCE + MCP、浏览器本机授权回调通过。
- API、Console、Gateway 健康；Worker 正常轮询。
- 生产迁移标记 1 条；空/不一致公开名字 0；公开列内提供方用户名 0。
- 线上 MCP whoami 返回 UUID 派生公开名字，CSRF 脱敏；8 个用户的公开名字一致，无隐私字段和提供方用户名。
- `/api/v1/me`、`/api/v1/me/private-profile` 匿名访问均 401 / no-store。设置页和 PC 托管 UI 已可访问。

备份：`/home/miku/cuddly-backups/pre-profile-20261106`，目录权限 700，数据库/源码备份文件权限 600。四个服务旧镜像保留为 `cuddly-<service>:pre-profile-20261106`；新镜像为 `cuddly-<service>:profile-20261106`。

本次未修改 DLC 注入器。PC 面板重新打开即可获取托管 UI；本地浏览器扩展源已更新，已加载的扩展须重新加载。旧会话正常功能不受影响，但查看私有详情需浏览器重新登录。
