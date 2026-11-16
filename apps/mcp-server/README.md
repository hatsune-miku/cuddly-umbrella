# Bifrost MCP

Bifrost MCP 支持远程 Streamable HTTP（推荐）和本地 stdio。操作人绑定 Bifrost 用户 ID，对外显示 Bifrost 公开名字。

## 个人 Token 接入（推荐）

打开 [Bifrost MCP 接入](https://bifrost.vanillacake.cn/settings/mcp)，或从主页账号菜单选择「MCP 接入」。使用飞书登录，输入名称并生成 Token。原文只显示一次，页面提供 Token、Authorization 值和 JSON 配置的复制按钮。

在客户端选择 Streamable HTTP，地址为 `https://bifrost.vanillacake.cn/api/v1/mcp`，请求头为 `Authorization: Bearer <你的 Token>`。不选择 OAuth，不需要客户端自动刷新凭据。

```json
{
  "mcpServers": {
    "bifrost": {
      "url": "https://bifrost.vanillacake.cn/api/v1/mcp",
      "headers": { "Authorization": "Bearer <你的 Token>" }
    }
  }
}
```

Token 长期有效直到本人撤销，不依赖浏览器会话、客户端凭据目录或服务进程；权限和角色跟随账号当前设置。每个账号最多保留 20 个 Token，列表显示名称、前缀、创建和最近使用时间。删除客户端配置不等于撤销 Token，请在网页管理。

本地 stdio 使用同一个 Token：在 MCP 启动环境中设置 `BIFROST_MCP_TOKEN`，无需运行 `login`。服务端只保存 SHA-256 摘要，个人 Token 不能读取隐私资料、生成其他凭据或作为浏览器 Cookie。

## 旧版 OAuth 接入（兼容保留）

在支持 **Streamable HTTP + OAuth** 的 MCP 客户端中新增服务器：

- 名称：`bifrost`
- 地址：`https://bifrost.vanillacake.cn/api/v1/mcp`
- 认证：OAuth / 自动发现

连接后，客户端会打开飞书登录及 Bifrost 授权页。核对客户端和回调地址，选择权限后确认即可。
不需要 Node.js、pnpm、项目源码、额外客户端桥接程序、复制 Cookie 或手动粘贴 token。
这里的 HTTP 指传输协议，公网连接始终使用 **HTTPS**。

通用 URL 配置（具体字段以客户端为准）：

```json
{
  "mcpServers": {
    "bifrost": { "url": "https://bifrost.vanillacake.cn/api/v1/mcp" }
  }
}
```

支持 `mcp_servers` TOML 配置的客户端：

```toml
[mcp_servers.bifrost]
url = "https://bifrost.vanillacake.cn/api/v1/mcp"
```

部分客户端仍需在其界面点击「登录／授权」，或运行它自身提供的 MCP OAuth 登录命令。
不支持 OAuth 的旧客户端不能只填 URL 接入；请升级客户端或使用下方兼容 stdio 方式。
本入口不是旧版独立 `/sse` 传输，不需要添加 `/sse` 后缀。

授权由服务端按 `permissionLevel` 和 `roles` 强制执行，可用工具随账号权限和功能配置变化。
远程授权默认上限为 2 级，且不能超过当前账号等级；即使客户端请求更高等级，也不会默认选中管理权限。重新授权可调整上限。
访问令牌有效 1 小时，客户端可用轮换刷新令牌自动续期；连接最长 7 天，且不超过授权时飞书会话的剩余有效期。
客户端可调用标准 OAuth 撤销端点断开连接；单纯删除客户端配置不保证服务端撤销。

## 旧版本地登录凭据（兼容保留）

需要 Node.js 22+、项目依赖和带 MCP 授权入口的 Bifrost 后端。

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm mcp:build
pnpm mcp:login
pnpm mcp:status
```

`login` 会打开浏览器。使用飞书登录后，确认“授权本机 MCP”。登录成功后关闭网页即可。凭据存放在当前系统用户的 `~/.config/bifrost/mcp/`，按服务地址隔离；不需要复制 Cookie、在客户端配置中粘贴密钥，或把凭据发给 AI。

将 [client.example.json](client.example.json) 中的配置添加到支持 stdio 的 MCP 客户端。示例中的脚本路径是当前开发机路径；其他机器应替换成实际绝对路径。不要用 `pnpm start` 作为 MCP 启动命令，包管理器输出可能污染协议 stdout，直接使用 `node`。

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "node",
      "args": ["C:/Users/guanz/projects/cuddly-umbrella/apps/mcp-server/dist/main.js"],
      "env": {
        "BIFROST_URL": "https://bifrost.vanillacake.cn"
      }
    }
  }
}
```

如果客户端不继承 PATH，把 `command` 换成 `node.exe` 的绝对路径。

使用 TOML 的客户端可以配置：

```toml
[mcp_servers.bifrost]
command = "node"
args = ["C:/Users/guanz/projects/cuddly-umbrella/apps/mcp-server/dist/main.js"]

[mcp_servers.bifrost.env]
BIFROST_URL = "https://bifrost.vanillacake.cn"
```

上述命令仅适用于兼容 stdio 接入；远程 HTTP 用户无需执行。两种方式共用工具实现，每位使用者分别授权。

## 操作范围

| 默认最低等级 | 范围 |
| --- | --- |
| 0 | 当前身份、运行入口信息 |
| 1 | 项目、环境、分支、队列、构建、日志、产物、需求、预览查询 |
| 2 | 发起/重试/取消构建、需求增删改、创建/撤销预览 |
| 4 | 系统配置查询和修改、功能权限配置 |
| 6 | 用户管理 |

用户等级必须大于等于功能所需等级，并同时具备功能所需的全部角色。`owner`、`administrator` 仅豁免角色检查，不豁免等级。大多数功能默认 `roles=[]`；通过权限等级实现访问控制，通过角色优化体验。

权限与用户管理入口为控制台用户菜单中的“权限与用户”（`/permissions`）。功能权限配置固定要求 4 级，用户管理固定要求 6 级，均为 `roles=[]`。4 级用户只能看到功能权限标签，达到 6 级才显示用户标签。默认新用户和迁移前已登录用户为 2 级，游客为 0 级。

鼓励通过 `permissionLevel` 实现权限拦截，通过 `roles` 优化体验。6 级管理者可以为任何人分配、增减任意角色，包括 `owner` 和 `administrator`。修改用户等级时，目标值不能高于操作者当前有效等级；自己也不能越级提升。只改角色可以保留目标已有的更高等级。新用户默认等级的修改同样受操作者等级限制。特殊角色仍不能越过等级限制，例如 8 级 owner 无法访问 9 级功能。

本地 stdio 启动时从服务端读取工具目录，目录变动后重连即可刷新；每次业务调用仍由服务端校验当前权限。远程 HTTP 逐请求读取当前权限，并受 OAuth 授权上限约束。管理写操作和破坏性操作要求 `confirm: true`，模型应先获得用户明确授权。

HTTP 模式由服务端按授权令牌限制可调用工具，MCP 令牌不能直接访问普通业务 API。
stdio 与 HTTP 共用账号权限，不能通过本地环境变量提高权限。旧 OAuth 授权会迁移为对应等级上限：read→1、operate→2、admin→8；不会提高账号权限。
不要共享凭据。工具的只读/破坏性/幂等注解仅供客户端审批参考。

## 工具目录

所有工具使用 `bifrost_` 前缀，完整参数由 MCP `tools/list` 提供。

### 身份、环境和项目查询

- `whoami`：当前身份、地址、`permissionLevel` 和 `roles`，不返回凭据；`session.identity.name` 是 Bifrost 公开名字，不是飞书真实姓名。MCP 会话不能访问个人隐私资料。
- `get_runtime`：入口、预览域和原地替换识别规则。
- `list_environments`：环境名称、标识、状态、代理开关和排序。
- `list_projects`：环境内的项目和热更模块。
- `get_matrix`：环境默认/公共版本矩阵，不代表插件私人选择。
- `list_branches`：分支搜索、构建状态、可用产物与时间。
- `get_project_settings`：全局项目定义。
- `get_environment_projects`：环境实际启用项目、安装/打包命令。
- `get_system_settings`、`get_proxy_settings`：系统设置及代理健康状态，敏感字段脱敏。

### 打包与产物

- `get_queue`：全局队列、运行任务、排队位置和发起人。
- `list_builds`：完整历史分页，包含失败和取消，支持状态和关键词筛选。
- `get_build`：任务详情、命令计划、时间线和结果。
- `get_build_log`：后端脱敏日志，默认末尾 120 行，支持行数和字符数上限。
- `wait_build`：短时等待，最多 25 秒；返回是否已完成，不会长期占用 MCP 调用。
- `create_build`：指定环境/项目/分支打最新包。
- `retry_build`：仅重试失败或取消任务。
- `cancel_build`：中断排队或正在执行的任务。
- `list_artifacts`：分页产物摘要。
- `get_artifact`：入口、热更元数据和分页文件清单，支持文件路径搜索。

发起和重试构建必须提供 `idempotencyKey`。同一个逻辑请求重复调用时复用相同键；明确再打一次才使用新键。MCP 不会对失败写请求自动重试。超时后先查队列/历史，不要盲目再创建任务。

重试沿用项目、环境、分支和 profile，但使用**当前最新代码和配置**，不是旧提交的精确重放。打包只生成产物，不自动发布或切换用户页面。

### 站点、需求分享和预览

- `list_sites`、`resolve_site`、`list_site_candidates`：查看站点及官方入口绑定。
- `list_requirements`：按创建时间降序列出全部人的需求，支持搜索和分页。
- `get_requirement`：配置详情、最新 revision 和产物就绪状态。
- `resolve_share`：通过需求专属域名找到需求，支持中文域名。
- `create_requirement`：创建持久化需求和分享地址，支持自定义 URL 前缀。
- `update_requirement`：完整更新配置，必须携带 `expectedRevision` 防止覆盖他人修改。
- `delete_requirement`：删除共享需求，原分享链接随之失效。
- `create_requirement_preview`：按需求创建完整或仅热更的限时会话。
- `create_preview`、`get_preview`、`revoke_preview`：直接管理指定产物的隔离预览会话。

需求 `items` 必须包括所选站点的本体和全部热更模块。不接管的项也应明确填 `mode: "official"`。需求分享是分支配置组：分支后续重新打包，分享就会跟随最新成功产物；限时预览会话则选择具体产物。

MCP 不控制本机浏览器插件、PC 注入器或页面跳转。创建会话不等于“已应用到当前标签页”。无插件预览可直接交付需求的 `directPreviewUrl`；不要自行拼接未经系统支持的 token 查询参数。

### 管理写操作（系统配置默认 4 级，用户管理 6 级）

- `save_project`：新增/完整更新项目定义；构建命令会在服务器执行。
- `reset_project`：恢复内置模板，并清除该项目独立 Git 授权。
- `save_environment`：新增/完整更新环境；支持排序、冻结、归档，不能更改已有 slug。
- `save_environment_projects`：保存各项目在指定环境的真实安装、打包和产物目录配置。
- `save_site`、`delete_site`：维护站点、官网映射和资源代理规则。
- `update_system_settings`：局部更新并发、超时、国内源、证书和识别规则。
- `update_proxy_settings`、`refresh_proxy`、`reset_proxy_settings`：维护 Mihomo 配置。
- `get_permissions`、`update_permissions`：读取和配置功能权限。
- `list_users`、`update_user_permissions`：搜索用户、修改等级和角色；保存需携带 `expectedRevision`。

完整更新工具调用前先读取现有配置。不要把“改名字”变成用默认值覆盖其余字段。代理订阅或 Git 授权宜由用户在后台配置，不建议通过 AI 对话传递。
包含 `[REDACTED]` 的脱敏配置不能直接写回；若原命令内嵌密钥，请在管理后台完成修改。

## 可以直接这样提问

- “看看测试环境 voice_runtime 最近一次失败发生在哪个阶段，给我日志证据，先不要重试。”
- “检查网页端 feature/xxx 在 QA 环境有没有可用包，没有的话打一次，告诉我排队位置。”
- “把刚才那个失败任务重新打一次，不要重复提交。”
- “创建‘耳麦回归’的提测需求：QA 环境，本体官方，voice_runtime 用 feature/mic，其余热更官方。先检查产物是否就绪。”
- “查一下这个需求目前各项目用哪个分支，分享链接是否跟随最新产物。”
- “列出当前所有人的打包任务，取消我刚才误触发的那一个。”

MCP 还提供：

- `bifrost://guide`：操作边界和工作流约定。
- `bifrost://tools`：当前权限下的工具目录及每项功能的等级、角色要求。
- `diagnose-build` 提示词：只读失败诊断。
- `prepare-qa` 提示词：需求提测准备清单。

## stdio 配置和授权生命周期

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIFROST_URL` | `https://bifrost.vanillacake.cn` | 后端公开 origin，禁止路径、用户名和密码；仅 loopback 允许 HTTP |
| `BIFROST_MCP_TOKEN` | 无 | 推荐，网页生成的长期个人 Token，优先于旧会话和本地凭据 |
| `BIFROST_CREDENTIALS_DIR` | `~/.config/bifrost/mcp` | 本机凭据目录；登录和 MCP 进程必须使用相同目录 |
| `BIFROST_SESSION_TOKEN` | 无 | 可选，覆盖本机凭据；仅适合由安全的进程环境注入，不要提交到 Git |

旧版登录凭据最长有效 7 天，且不超过授权时浏览器会话剩余有效期。个人 Token 不受此期限影响，在网页撤销之前一直有效。

```powershell
# 查看身份，不会输出 token/CSRF
pnpm mcp:status

# 服务端撤销当前 MCP 专用会话，删除本机文件；原浏览器会话保留
pnpm mcp:logout
```

网络故障导致撤销失败时保留本地凭据，便于恢复网络后再次撤销。只删除本地文件不会撤销服务器上的会话。

授权采用显式确认、随机 state、PKCE S256、60 秒一次性授权码、loopback 回调和独立会话。授权码只有配对本机进程持有 verifier 才能兑换；浏览器跳转里不包含长期令牌。所有业务写请求继续获取会话 CSRF 并由原 API 校验身份。

POSIX 使用目录 `0700` / 文件 `0600`；Windows 文件位于当前用户配置目录，继承该用户目录的 ACL。不要将该目录设置为团队共享目录。凭据可以执行该身份已有权限的操作，不要把它当公开预览 token。

## 后端部署与边界

远程服务直接集成到 control-api，使用现有 443 入口，无新端口、域名或额外进程。权限系统随数据库初始化自动迁移，亦可运行 `pnpm db:migrate`。

- `POST /api/v1/mcp`：无会话状态的 Streamable HTTP，逐请求校验 Bearer、工具范围和身份。
- `/.well-known/oauth-protected-resource/api/v1/mcp`：资源元数据。
- `/.well-known/oauth-authorization-server`：OAuth 元数据。
- `/api/v1/auth/mcp-http/{register,authorize,token,revoke}`：动态客户端注册、PKCE S256 授权、续期和撤销。
- `GET/POST /api/v1/auth/mcp-http/consent`：复用飞书登录的显式授权页。

MCP access/refresh token 仅以 SHA-256 摘要持久化；内部业务会话凭据不会返回客户端。
生产 OAuth 状态位于 `/srv/cuddly/secrets/mcp/oauth-state.json`（目录 0700、文件 0600，原子替换），
包含客户端信息和内部会话秘密，必须和其他服务秘密同等保护，不提交 Git、不打入发布包。
已连接客户端可跨重启续用；未完成授权的临时请求和一次性 code 在重启时失效。
刷新令牌一次一换，检测重放会撤销整条连接；刷新不能增加权限。注册、授权和 token 端点有请求限流及存储容量上限。
当前持久化面向单个 control-api 实例；多副本前需迁移共享事务存储，不能让多个进程并发写此文件。
代理需把 `/.well-known/oauth-` 转到 API，关闭 API 响应缓冲并允许 120 秒读取超时。
控制 API 只信任实际部署的两层转发代理（主机 TLS Nginx → console Nginx），不信任用户伪造的 X-Forwarded-For 前缀；改变入口拓扑时需同步核对该设置。
授权规范参考：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

本机 MCP 不依赖 Node 服务间的 internal token，不得把 `CUDDLY_INTERNAL_TOKEN` 用作 MCP 凭据。

后端新增：

- `GET/POST /api/v1/auth/mcp/authorize`：确认授权。
- `POST /api/v1/auth/mcp/token`：一次性 code + PKCE 兑换。
- `GET /api/v1/auth/mcp/style.css`：复用现有 CakeUI 授权页面的少量表单样式。
- `GET /api/v1/artifacts?summary=1&page=...&pageSize=...`：兼容旧 API 的摘要分页。
- `GET /api/v1/artifacts/:artifactId?page=...&pageSize=...&query=...`：文件清单分页。

权限系统新增 `user_accounts`、`authorization_policy`、`authorization_migrations` 表及会话授权上限字段。迁移以已核对的飞书唯一身份将 guanzhen 初始化为 8 级、`["owner", "administrator"]`，只执行一次，不按昵称匹配，也不覆盖后续权限修改。v2 迁移将旧的 8 级管理规则拆分为系统配置 4 级、用户管理 6 级，不修改用户自身等级。权限修改有 revision 冲突保护、审计记录，并阻止移除最后一位 6 级管理者；用户等级修改与操作者权限重验在同一事务内完成。

飞书仍使用已有 callback，不需要再给 loopback 地址加飞书白名单。一次性授权码保存在控制 API 单实例内存中，重启会使未兑换的授权失效；以后若水平扩容，应使用共享短期存储或粘性路由。

不提供任意 Shell、任意 HTTP、直接 SSH/数据库写入、产物文件改写，以及已停用的公共发布操作。

## 验证

```powershell
pnpm --filter @cuddly/mcp-server typecheck
pnpm exec vitest run apps/mcp-server/src apps/control-api/src/mcp-auth.test.ts apps/control-api/src/mcp-http.test.ts apps/control-api/src/mcp-provider.test.ts apps/control-api/src/auth-routes.test.ts
pnpm mcp:build
pnpm --filter @cuddly/mcp-server smoke
```

协议测试使用官方 MCP Client 的真实 HTTP 和内存 transport；集成测试使用真实控制 API、真实鉴权中间件和内存数据库，覆盖 OAuth、权限隔离、刷新重放、撤销、重启持久化、构建去重/操作者/取消/重试、需求 revision 冲突、预览和产物分页。stdio smoke 会实际拉起编译后的进程并完成握手，不访问线上、不创建真实构建。
