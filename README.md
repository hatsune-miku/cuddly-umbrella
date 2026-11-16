# Bifrost

Bifrost 将在线 H5 构建、不可变 Artifact 和 QA 环境选择收敛到一个工作区。

日常使用请阅读 [在线图文教程](https://bifrost.vanillacake.cn/help/)，支持章节检索、截图放大和打印；
也可以下载 [使用教程 PDF](./output/pdf/Bifrost_使用教程.pdf)。可维护源稿见
[使用教程 Markdown](./docs/BIFROST_USER_GUIDE.md)。教程覆盖扩展安装、环境与分支选择、构建队列、
需求分享和常见问题。

图文页由 `docs/scripts/build_help.mjs` 生成到 `apps/console/public/help/`，控制台构建时会自动更新。
页面为无需登录的静态帮助文档，不读取业务数据；插图来自真实组件的本地演示数据，重新截图可运行
`node docs/scripts/capture_help_screens.mjs`（先构建控制台，并准备 Playwright 与 Chromium）。

生产界面的产品基名只在根目录 `product.config.json` 中定义。控制台、浏览器扩展和 KFC 清单的展示
标题由这个基名统一派生；修改后执行常规 `pnpm build`、`pnpm test` 或 `pnpm typecheck` 会自动同步扩展
Manifest 与 KFC 清单。`cuddly.*` 存储键、`x-cuddly-*` 请求头、`/__cuddly/*` 路由和 Docker/数据库
名称属于稳定技术命名空间，不随展示品牌变化。

首个切片支持：

- 在线 H5 分支构建任务。
- 本地磁盘不可变 Artifact。
- 多个相互隔离的 QA 环境，以及浏览器标签页级、不可变的 Preview 组合。
- 预览站在无 Token 时使用官方前端与官方热更；带有效 Preview Token 时使用该标签页选定的页面和
  Remote Artifact，后端请求代理 Token 所选环境的 Backend Origin。
- 飞书 OAuth 保护的 QA 控制台；操作人名称只取自飞书身份，不接受客户端自定义。
- Compose 内置 Mihomo，支持通过管理面配置 Clash/Trojan 订阅。
- Host 驱动的站点绑定：绑定固定预览 hostname、站点形态和无 Token 时的默认环境，不固定标签页
  实际预览的环境。
- 按标签页预览：页面与 Remote 都在对应站点的隔离预览域名生效；每个 Preview Token 独立固定
  环境与精确 Artifact 选择，不影响其它标签页，也不存在可被覆盖的公共前端版本。

详细设计见 [CUDDLY_WEB_ARTIFACT_SYSTEM_DESIGN.md](./CUDDLY_WEB_ARTIFACT_SYSTEM_DESIGN.md)。

## 本地开发

AI 客户端接入请参阅 [Bifrost MCP 使用文档](./apps/mcp-server/README.md)。
提供 43 个 MCP 工具，覆盖构建、日志、产物、需求分享、预览及管理操作；默认仅开放日常操作，
通过飞书独立授权。推荐直接填写远程地址 `https://bifrost.vanillacake.cn/api/v1/mcp`，
使用 Streamable HTTP + OAuth；客户端无需安装 Node.js 或项目依赖。原 stdio 接入继续兼容。

```bash
pnpm install
pnpm typecheck
pnpm test
```

本地以非 production 模式启动 Control API 和 Gateway 时使用内存 Store，适合 UI 和路由开发；
Docker Compose 与正式部署使用 PostgreSQL。

## 发布到 KFC

KFC 中发布两个关联条目：`Bifrost` 打开网站，`Bifrost 浏览器插件` 安装浏览器扩展。当前 KFC
客户端按工具而不是按组件安装，因此二者使用独立工具 ID，确保网站入口和扩展制品都能实际使用。
扩展制品由 20 个运行时文件白名单生成，`manifest.json` 直接位于 ZIP 根目录；KFC 版本必须与扩展
Manifest 版本完全一致。

先执行本地校验或完整 dry-run：

```powershell
pnpm kfc:validate
pnpm kfc:pack -- -Version 0.11.8
pnpm kfc:release -- -Version 0.11.8 -DryRun
```

正式发布前，打开 `https://kfc-api.vanillacake.cn/admin`，使用飞书登录并复制“我的发布令牌”。令牌只
放在当前终端环境变量中，不写入仓库或命令参数：

```powershell
$env:KFC_HUB = 'https://kfc-api.vanillacake.cn'
$env:KFC_TOKEN = '<从 KFC 管理页复制的令牌>'
pnpm kfc:release -- -Version 0.11.8
Remove-Item Env:KFC_TOKEN
```

发布脚本依次校验两份清单、打包扩展，并用根目录中的 KFC 官方发布器分别发布扩展与网站；不会执行
任何 Git 操作。浏览器禁止外部程序直接装入扩展，因此首次安装后仍需在 `chrome://extensions` 或
`edge://extensions` 打开开发者模式，选择 KFC 展示的已解压目录；KFC 更新扩展后需在该页面点一次
“重新加载”。

## KOOK PC 插件 DLC

Bifrost PC 插件以 `kook-plugin-tools-bifrost` 独立发布，归属 `kook-plugin-tools`，作者沿用 `rin`。
网站与浏览器扩展的 KFC 条目保持不变。DLC 清单在 `dlcs/bifrost/`，运行时源码在
`apps/console/pc-plugin/`；打包时从这些源码生成两个脚本，不再依赖宿主仓库中旧的 Bifrost 副本。

```powershell
pnpm kfc:dlc:pack
pnpm kfc:dlc:publish -- --version 0.3.0 --changelog-file release/bifrost-dlc-0.3.0.md
```

打包默认使用相邻 `../kook-plugin-tools` 的宿主清单与校验器，也可通过 `-HostDirectory` 指定。
发布使用进程环境中的 `KFC_HUB` 和 `KFC_TOKEN`。版本必须与 `dlc.json` 和插件版本一致；
已发布 DLC 不覆盖同版本。构建产物位于 `dist-kfc/`，只包含清单、许可证和运行时脚本。

PC 面板从 `/pc-plugin/` 加载共用 UI，使用飞书登录及当前权限规则；不再自动创建 Guest 操作会话。
PC 登录通过服务端的一次性授权请求连接系统浏览器与 KOOK：浏览器完成飞书登录并核对验证码后确认，
面板凭自己保留的随机校验密钥领取独立会话。不依赖 Cookie 共享、BroadcastChannel 或 window.opener。
请求五分钟内有效，关闭再打开面板可继续等待；服务重启会使未完成请求失效，需要重新登录。
修改面板适配器或登录接口时，需要同步部署 Console / Control API；只有 DLC 内运行时脚本变化才需要发布新 DLC 版本。
KFC 安装后需通过宿主应用到目标 KOOK，或在插件中心导入 DLC ZIP；重新加载后生效，配置保持不变。

## Docker Compose

```bash
docker compose up --build
```

持久化数据统一位于仓库的 `data/docker`。控制台监听宿主机 `9888`，站点 Gateway 监听
`9872`；自动 SSL 的 HTTP-01 challenge 服务只监听回环地址 `127.0.0.1:19873`。正式环境的
HTTPS 反向代理指向 Console 与 Gateway，预览域名在管理后台“项目”页面的“预览站点”区域配置。

`vanillacake.cn` 服务器部署使用生产覆盖文件，让容器只监听回环地址：

```bash
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

生产覆盖将 Console 映射到 `127.0.0.1:9888`、Gateway 映射到
`127.0.0.1:9872`，再由 `deploy/nginx` 中的站点配置接入 HTTPS。

### 飞书 OAuth

当前控制台和所有面向用户的 Control API 都要求飞书登录。飞书应用后台必须精确登记以下回调地址：

```text
https://bifrost.vanillacake.cn/api/v1/auth/feishu/callback
```

Compose 默认把 `CUDDLY_PUBLIC_ORIGIN` 设为 `https://bifrost.vanillacake.cn`，它必须与浏览器实际访问的
HTTPS Origin 及飞书白名单一致。更换部署域名时，应同时覆写该变量并登记新 Origin 下的同一路径；
它不从请求 `Host` 动态推断，避免未受信 Host 改变 OAuth 回调。

飞书凭据不放在 `.env`、Compose、镜像、仓库或 release 包中。启动新版 Control API 前，在部署机的
仓库根目录以交互方式创建仅宿主所有者可读的 Secret 文件：

```bash
secret_dir=data/control-api-secrets/feishu
install -d -m 0700 "$secret_dir"
umask 077
read -r -p 'Feishu app_id: ' feishu_app_id
read -r -s -p 'Feishu app_secret: ' feishu_app_secret
printf '\n'
printf '%s' "$feishu_app_id" >"$secret_dir/app_id"
printf '%s' "$feishu_app_secret" >"$secret_dir/app_secret"
unset feishu_app_id feishu_app_secret
chmod 0600 "$secret_dir/app_id" "$secret_dir/app_secret"
```

专用只读 bind mount 会把它们只交给 Control API 使用的 `/srv/cuddly/secrets/feishu/app_id` 和
`/srv/cuddly/secrets/feishu/app_secret` 路径；Runner 与其它服务不挂载宿主的
`data/control-api-secrets`。文件缺失或为空时服务会拒绝启动。可用
`stat -c '%a %n' data/control-api-secrets/feishu/app_id data/control-api-secrets/feishu/app_secret`
核对权限，不要输出文件内容。

登录使用 Authorization Code + PKCE。飞书 access token 只在服务端换取身份后短暂存在，不返回给
浏览器；Bifrost 保存的是自身随机会话令牌的摘要。会话 Cookie 为当前控制台 Host 专属，带
`Secure`、`HttpOnly` 和 `SameSite=Lax`，不会共享给预览子域或 Gateway。写操作还需要会话绑定的
CSRF Token。当前阶段只做登录鉴权和操作人识别，不区分 QA/Admin 角色；飞书应用的可用范围必须只
包含允许操作 Bifrost 的公司成员。

### 预览域名与自动 SSL

自动 SSL 默认关闭。宿主 Nginx 只需执行一次通用预览入口安装；之后新增或停用站点绑定不需要
逐域名修改 Nginx：

```bash
sudo CUDDLY_PREVIEW_BASE_DOMAIN=bifrost.vanillacake.cn \
  ./deploy/nginx/install-preview-wildcard.sh
```

DNS 必须让每个最终站点名解析到部署服务器。部分 DNS 服务商的 `*.vanillacake.cn` 泛解析可以
覆盖 `main.bifrost.vanillacake.cn`，另一些服务商则需要额外配置
`*.bifrost.vanillacake.cn`；部署前应直接查询最终站点名确认。也可以为每个站点配置等价的精确
DNS 记录。

若需要让配置分享生成的任意 `p-<id>.bifrost.vanillacake.cn` 链接直接通过 HTTPS 访问，应使用
DNS-01 签发一张同时覆盖根域和一级泛域名的证书。腾讯云 DNSPod 模式通过以下环境变量启用：

```dotenv
CUDDLY_AUTO_SSL_DNS_PROVIDER=tencentcloud
```

凭据只放在宿主机 `data/cert-manager-secrets/tencentcloud-dns.env`，生产 Compose 会以只读方式挂载
给 Cert-manager；文件应为 `0600`，不要写入 Compose、镜像或 Git：

```dotenv
TENCENTCLOUD_SECRET_ID=...
TENCENTCLOUD_SECRET_KEY=...
TENCENTCLOUD_DNS_ZONE=vanillacake.cn
```

此模式使用 Certbot manual DNS hook 调用 DNSPod API，申请
`bifrost.vanillacake.cn` 与 `*.bifrost.vanillacake.cn`。钩子会清理异常中断遗留的挑战记录，并按
DNSPod 的 600 秒 TTL 等待二次校验缓存失效；签发结束后删除本轮 TXT。未设置 DNS provider 时，
仍保留原来的逐站点 HTTP-01 签发方式。

安装器会读取 Nginx `user` 配置并探测 worker UID，必要时安装系统 `acl` 包，然后把 UID 保存到
`/etc/letsencrypt/.cuddly-nginx-worker-uid`。安装器只授予证书根目录的遍历权限；Cert-manager
每次签发或续期成功后，仅为对应域名的 `live/<hostname>` 与 `archive/<hostname>` lineage 设置
读取 ACL，因此不会向 Nginx worker 暴露同机其它站点的私钥。无法自动识别时可显式传入
`CUDDLY_NGINX_WORKER_UID=<uid>`。安装器还会配置一个 systemd path unit：容器内 Certbot 的 deploy
hook 只写入共享目录中的重载标记，宿主 unit 在校验配置后重载 Nginx，因此续签无需容器访问宿主
进程或 Docker Socket。

生产 Compose 把宿主 `/etc/letsencrypt` 挂载到 Cert-manager。使用基础 Compose 的自包含磁盘目录
时，安装器还需指向同一个宿主绝对路径，例如：

```bash
sudo CUDDLY_LETSENCRYPT_DIR=/srv/cuddly/data/docker/letsencrypt \
  ./deploy/nginx/install-preview-wildcard.sh
```

管理后台打开自动 SSL 后，Cert-manager 才会执行 Certbot；联系邮箱可留空，此时使用 Certbot 的
无邮箱注册模式。关闭时只轮询配置，不启动 Certbot，也不修改现有证书。

Runner 在自己的 Node 24 容器内执行一次性 checkout，以及每个项目明确配置的安装、打包命令，
不依赖 Docker Socket。私有仓库使用干净的 HTTPS
项目仓库地址与 Git HTTP 认证头都在管理后台的“项目”页面配置。认证头加密保存且不会回显；
不要把 Token 放进仓库 URL 或提交到仓库文件。

Runner 服务本身以 production 模式运行，但不会把该模式泄漏给项目的依赖安装：安装阶段固定使用
`NODE_ENV=development` 以保留构建所需的 devDependencies，并设置 `HUSKY=0` 跳过临时工作目录中
没有意义的 Git hook 安装；正式打包阶段再使用 `NODE_ENV=production`。项目命令中显式声明的环境
变量仍由 shell 命令自身决定。

Runner 会在 `/srv/cuddly/git-cache/v1` 按“仓库地址 + 凭据作用域”维护持久的 shallow bare
对象缓存。每个任务仍先向远端 fetch 所选分支的最新 tip，再通过本机 Git 传输生成完全独立的
depth-1 工作目录；不共享 checkout、`node_modules`、alternates 或构建输出。仓库锁只覆盖 fetch
和对象复制，随后 checkout、Git LFS、依赖安装和构建都在各自 Job 中运行，所以不同项目仍可并行，
同一仓库的任务也只在很短的源码物化阶段排队。fetch 会同步刷新当前分支可达的 tag，并在成功解析
本次 commit 后才允许构建，绝不会拿旧 tip 继续运行。

只有缓存自身明确不可用时，Runner 才会清理未完成目录并执行原来的远端浅 clone；网络、鉴权、分支
和未知 I/O 错误不会触发第二次下载。HTTP(S) 仓库 URL 不允许携带用户信息、query 或 fragment，
认证只能使用加密保存的 Authorization Header；SSH 缓存按实际私钥指纹隔离，无法安全读取指纹时
使用受磁盘水位保护的直接 clone。缓存采用 14 天 LRU 和 1 GiB 目标软上限，并在磁盘剩余 4 GiB
时开始清理、2 GiB 时拒绝继续扩张；对象复制和直接 clone 共用容量预留。当前部署保持单 Runner
实例，以便进程内并发控制与文件锁共同生效。

Mihomo 只在 Docker 内部暴露混合代理端口和控制端口，不映射到宿主机公网。Control API
与 Runner 的 Git/依赖网络使用该代理；代理关闭时 Mihomo 运行在 DIRECT 模式。订阅链接只在
管理后台配置，使用自动生成并持久化的设置密钥加密，API 只返回掩码。

构建任务成功后只登记新的 READY Artifact，不自动上线或改动任何浏览器标签页。Artifact、构建历史
和每分支最新候选都按“环境 + 项目 + 分支”隔离；不同环境可以对同一分支执行不同命令，并各自只
保留一个最新 READY 候选。新包构建期间旧包保持可用；新包登记成功后，Worker 清理同一槽位中已被
取代且未被有效 Preview 使用的旧包。被现有 Preview Token 精确引用的旧包允许暂时保留，Token
撤销或到期后，启动时及每分钟执行的 sweep 会再次回收。
磁盘删除采用 `DELETING -> 原子移入回收区 -> 删除目录 -> DELETED` 两阶段流程；超时、断网或
Runner 5xx 时保持 DELETING 并幂等重试，绝不恢复成可能指向残缺目录的 READY。构建失败会清掉
staging，后台还会在安全宽限期后收敛没有数据库记录的 orphan 目录。轻量 DELETED 元数据继续
保留构建历史，但不再属于可用 Artifact。

Remote 项目是独立的打包目标，项目标识必须与 KOOK 的 Remote key 一致，例如 `base`、
`discover`、`mini_game`、`voice_runtime`。它们使用 `kook-remote-v1` 适配器。Remote 构建完成后同样只会产生
当前环境的候选 Artifact；创建浏览器预览不会改动任何环境，也不会自动发布到官网。
Runner 会在临时 clone 的 Remote `scripts/get_config.js` 中让 `CUDDLY_ASSET_PREFIX` 优先于原有
`PUB_PATH`，并为 Bifrost Remote 使用 Rspack 的 `publicPath: "auto"`。动态 chunk 会从实际加载的
`remoteEntry.js` 地址推导根路径：在 Bifrost 站点和 KOOK 官网原地热更中都指回同一 Artifact，
不会错误落到官网根路径或原有 OSS；仍可继续使用现有 `build:ttt`/`build:prod` 命令；
`mini_game` 使用 `apps/mini_game` 的独立 `rspack.config.ts`，安装该目录的依赖闭包后执行
`build`，输出到 `apps/mini_game/dist`，不依赖旧模块的 `build:prod` / `build:ttt` 脚本。
Runner 同样只覆盖其 `output.publicPath`，保留发布元数据中的实际 Artifact 路径。
该适配不会写回或 push 业务仓库。对尚未接入 `.remote-version` 的历史分支，Runner 还会在临时
clone 中让 `VERSION` 优先决定 Module Federation provider；产物适配器必须在 `remoteEntry.js` 中
核对到该精确 provider 声明后才接受产物，避免把名字不匹配、实际无法加载的 Remote 发给 QA。
provider 保留 KOOK remote key 作为前缀，例如 `discover_<artifact-id>`；Artifact ID 只负责隔离同一
模块的不同构建，不再把模块改名为 `cuddly_discover_*`。已有旧 Artifact 仍可读取，新规则从新构建生效。
内置 Remote 模板使用 pnpm 的目录依赖闭包过滤器，只安装 `apps/<module>` 及其 workspace 依赖，
不会因为同仓库内无关项目的安装脚本拖慢或阻断打包；目录不存在时会直接失败，不回退成全仓安装。
安装和构建命令直接调用 `pnpm`，Runner 不再指定版本或注入任务级 pnpm 包装脚本；
实际版本由运行环境中的 pnpm / Corepack 按项目自身配置决定，仍保留 `--frozen-lockfile` 校验。
所有适配器（本体、Remote、H5）的构建命令执行前，Runner 会在一次性 clone 中用 TypeScript AST
识别 Sentry 构建插件的模块引用，重定向到任务内的 `@bifrost-build/sentry-disabled` 兼容包。
支持 `@sentry/webpack-plugin`（含 `/webpack5`）、Vite、Rollup、esbuild 的静态 import、require、
动态字面量 import、re-export，以及旧版构造函数和新版插件工厂；不再匹配或改写 `disable` 表达式。
兼容包不加载真实插件，不注册上传、release、遥测或注入钩子；sourcemap 生成、运行时 Sentry SDK
和其他构建插件不变。仅修改临时 clone，不写回业务仓库，也不修改 node_modules 内原有依赖或 pnpm
共享存储；依赖安装完成后才生成隔离兼容包，避免被包管理器清理。日志记录适配文件数和模块入口，
不输出插件配置。未知的 Sentry 构建插件子路径会明确报错，需新增适配；这不是任意脚本的网络沙箱，
动态拼接模块名、安装脚本、node_modules 内的间接入口、构建时新生成的配置和独立 sentry-cli 命令
不在此静态适配范围内。需要这类入口时应补适配与无上传回归测试，不能把上传失败静默当作构建成功。
Remote 的 entry 与动态 chunk 使用严格校验的站点根相对 Artifact 路径；Gateway 在覆写热更响应时
再按当前预览站 Host 生成绝对 entry。因此同一个系统中的不同环境不依赖某个全局 Artifact 域名，
也不会因为产物 URL 指向另一个环境的站点而被跨环境校验拒绝。升级前产生的绝对 URL Artifact 仍
按原地址兼容读取，直到被该环境的新包替换。

## 站点绑定

站点绑定把一个合法 DNS label 形式的站点 ID（例如 `main`）映射到预览域名
`main.bifrost.vanillacake.cn`，并关联页面项目、站点形态、页面回退源、对应官网、资源代理路径
白名单、允许使用的 Remote 项目，以及无 Token 请求使用的默认环境。页面项目必须已启用，并使用
`kook-online-h5-v1` 或
`generic-static-v1`；Remote
项目使用 `kook-remote-v1`。

Gateway 按请求 Host 读取站点绑定。无 Preview Token 时，页面、静态资源和 `hot-module` 都代理
官方来源，只有 `/api`、`/mis` 等后端请求使用绑定的默认环境。浏览器扩展创建 Preview Token 后，
Token 会独立固定一个 `ACTIVE` 或 `FROZEN` 且未归档的环境，以及可选的页面 Artifact 和 Remote
Artifact；页面未选择包时仍代理官方页面，未选择的 Remote 仍保留官方热更响应。Artifact 必须属于
Token 所选环境，不能跨环境复用。

环境选择与 hostname 解耦，因此同一个 `main.bifrost.vanillacake.cn` 可以在不同标签页分别预览线上
和测试环境，不需要为每个环境复制站点绑定。无效、已过期或属于其它站点的 Token 明确返回 `404`，
绝不静默退回默认环境或旧的公共组合。

## 环境配置

环境是构建、Artifact、站点后端和浏览器 Preview 的共同隔离边界。管理后台的“环境”
页面维护名称、稳定 slug、Backend Origin、“走公司内网”开关和状态；slug 创建后不可修改，
Backend Origin 必须是不带路径、凭据、query 或 fragment 的 HTTP(S) origin。“走公司内网”默认
关闭；打开后，仅该环境的业务后端与 `hot-module` 回源请求通过 Bifrost 内置 Mihomo，页面回退源和
资源 CDN 不受影响。Gateway 没有配置内网代理或代理不可达时请求明确失败，绝不静默改为直连。

项目的仓库、项目类型、默认分支和适配器仍是全局身份；安装命令、打包命令、产物目录和启用状态
则在“项目 × 环境”配置中明确保存。系统不会要求为测试环境复制一套项目，也不会
让环境配置隐式继承后续修改过的全局命令。任务入队时会把环境及这组命令一起固化到快照；Runner
额外提供 `CUDDLY_ENVIRONMENT_SLUG` 与 `CUDDLY_BACKEND_ORIGIN`，项目只有主动引用时才会受到影响。

环境状态的语义固定如下：

- `ACTIVE`：可以构建并创建新的标签页 Preview。
- `FROZEN`：拒绝新构建，但仍可用已有 READY Artifact 创建 Preview。
- `ARCHIVED`：从普通 QA 入口隐藏，拒绝构建和新 Preview。

升级已有数据库时，现有 `shared` 环境会保留原 UUID，并为每个已有项目生成一份等价的显式环境
配置。已有站点的旧上游字段会迁移成页面回退源；`shared` 的 Backend Origin 使用原网页端上游。
历史 Revision 表与字段只为数据库兼容和审计保留，Gateway 不再读取 `current_revision_id`，线上值
应清空。面向用户的 Revision 发布接口固定返回 `410 PUBLIC_REVISION_DISABLED`，Console 不提供
“使用此包”“发布”或回滚公共环境的入口。

对 `/api/v3/version/hot-module` 和 `/v3/version/hot-module`，Gateway 保留原请求的
`app`/`addon`/`id` 查询参数及 KOOK 登录态，取得官方完整响应后只覆盖有效 Preview 明确选择的
Remote。无 Token 时完整返回官方响应；有 Token 时未选择模块、官方批次 `id`/`version` 和未知字段
原样保留；异常响应按原状态
和内容放行。首期覆盖项统一标记 `restartRequired: true`，保证刷新后加载选定产物，不尝试在已运行
页面内强制热切换。该专用改写最多缓冲 256 KiB JSON，不扩大其它代理请求的缓冲范围。

页面中写死的跨域资源 URL 可加入资源代理路径白名单。默认使用
`https://img.kookapp.cn/` 与 `https://static.kookapp.cn/`；这些来源下的图片、字体、样式、脚本、
Remote、媒体与 JSON 数据都会改写为预览站点的同源代理地址，并通过 `GET`/`HEAD` 只读转发。
Gateway 会同时处理首屏 HTML、
Artifact 文本资源、动态 DOM 属性以及 `fetch`/XHR 等浏览器 API；Cookie、Authorization、预览
Token 和上游 `Set-Cookie` 均不会穿过这条链路。应用自身 JS/CSS 不应借此回退到官网应用 CDN，
仍必须存在于当前 Artifact 中。

资源代理来源分为站点基础列表与环境附加列表，Gateway 按当前请求实际使用的环境合并去重；因此
浏览器扩展把同一预览站点切换到测试环境时，可以只为测试环境追加
`https://img.chuanyuapp.com/`。两处配置都要求每行一个 HTTP(S) URL 前缀、以 `/` 结尾，且最多
20 条；保存环境后最多等待 Gateway 的 5 秒环境缓存即可生效，不需要重新打包业务项目。

## 浏览器扩展

在 Chromium 的扩展管理页面启用开发者模式，选择“加载已解压的扩展程序”，目录为
`apps/browser-extension`。这是唯一且长期稳定的加载目录；后续更新只会原地覆盖其中的文件，QA
无需改选目录，只需在扩展管理页面点击“重新加载”。`dist-kfc/` 下带版本号的 ZIP 是 KFC 发布制品，
不作为浏览器日常加载入口；当前版本制品为
`dist-kfc/cuddly-browser-extension_0.11.7.zip`。扩展默认连接 `https://bifrost.vanillacake.cn`，可在弹窗右上角的覆盖式
连接设置中切换其它服务地址；本地开发时使用 `http://localhost:9888`。扩展与控制台共用目标
Control Origin 上的飞书会话，未登录时会打开登录页；队列、构建和审计中的操作人固定使用飞书姓名，
扩展不再保存匿名队列标识或自定义显示名。正式使用时还需在管理后台为各环境配置浏览器可访问的
HTTPS 站点绑定。

升级或修改已解压扩展后，必须在 `chrome://extensions` 对 Bifrost 点击一次“重新
加载”，使 popup 与常驻 Service Worker 使用同一协议版本；否则扩展会明确提示重载，不会先创建
一个无法应用的 Preview。

只选择 Remote、没有选择页面 Artifact，且当前标签页正位于站点绑定对应环境的官方 Origin 时，扩展
使用“官网原地热更”：页面不跳转，也不跨域重定向 hot-module 请求。`document_start` 的 MAIN world
脚本把 KOOK 原请求的 URL、query、Cookie、Authorization 和签名原样交给同源官方接口，只在成功
JSON 上按 key 覆盖当前标签页选中的 Remote；未选模块、批次元数据和未知字段全部保留。非目标请求、
官方错误、未知响应结构或 bridge 异常均返回原官方响应。Preview Token、飞书会话和 KOOK 凭据都不
进入页面脚本；选中 Remote 的 `remoteEntry` 与动态 chunk 才从 Bifrost 不可变 Artifact 路径加载。

页面项目的分支草稿与“是否替换页面”是两个独立状态：关闭弹窗后仍会记住分支，但只有 QA 在页面
项目下拉框中明确选择某个分支，才会生成 `siteArtifactId`。升级前遗留的页面分支不会再被隐式带入；
选择“官网页面”或停用预览会关闭页面替换。底部按钮会预先显示“原地应用”或“应用并打开 Bifrost”，
不会再到点击后才暴露实际路由方式；状态栏右侧显示当前扩展版本，便于确认 Chrome 已完成重载。

选择了页面 Artifact、当前 Origin 或环境不匹配时，扩展仍使用整页 Site Preview：把当前标签页导航
到对应 `*.bifrost.vanillacake.cn`，并只为该标签页附加短期 Preview Token。关闭标签页、离开适用
Origin、替换组合、Token 过期或主动停用时，会话状态会被清理，服务端 Token 也会被幂等撤销；官网
原地模式会刷新当前页以恢复官方 Remote。旧版 `__cuddly/previews/<token>/v3/version/hot-module`
直连接口固定返回 `410`，无效、过期或跨站点的 Preview Token 明确返回 `404`，都不会静默回退。
应用和停用的规则、状态与标签页导航由扩展后台作为同一事务处理；即使操作中途关闭 popup，也不会
留下“页面已跳转但规则已移除”或“规则已启用但仍停在官网”的半完成状态。

管理后台“系统”页可维护全局的“官网原地应用规则”，每条由 `URL 包含模式 + 环境` 组成。匹配按
完整 URL 的大小写敏感字面量包含判断；同时命中多条时取最长模式。命中后扩展会锁定对应环境、选择
该环境的站点绑定，并把页面项目固定为官网页面；应用只可能原地刷新，任何缺包、空选择、绑定缺失或
环境漂移都会明确禁用/报错，绝不会静默降级为打开 Bifrost。两个内置官网之外的新 Origin 会在用户
授权后动态注册仅覆盖该 Origin 的 `document_start` 脚本，不会向所有网站注入。

弹窗顶部的环境选择器列出所有未归档环境，独立于当前站点绑定；切换环境会立即按“官网 Origin +
标签页”持久化，关闭再打开 popup 不会恢复成线上环境。环境变化后，分支、构建命令、候选 Artifact、
分享和新 Preview 全部使用所选环境。已应用标签页与正在编辑的环境不同时，扩展会明确提示，直到 QA
重新点击“应用”，不会悄悄改变正在测试的页面。

标签页 Token 隔离的是路由、后端选择和 Artifact，不会改变浏览器同源规则。同一个预览 hostname
下的线上与测试标签页仍共享 Cookie、localStorage 和 Service Worker；不兼容的登录态可能互相覆盖，
Cookie 也会随该 Host 的请求发送到所选后端。需要同时隔离账号或不允许凭据跨环境时，应为环境使用
独立 hostname（或后续增加专门的 Cookie 命名空间），不能只依赖标签页 Token。

弹窗右上角“分享”会把当前环境及站点全部项目的选择保存为一个具名、持久化的需求配置，并复制
`https://bifrost.vanillacake.cn/s/<token>` 短链。32 字符 `token` 同时是配置记录的稳定 ID；短链不把
配置塞入 KOOK 的 query/hash，因此不会与 KOOK Router、登录跳转或页面刷新相互覆盖。Bifrost 主站和
扩展的“项目版本”都提供“按需求 / 按分支”二级视图并记住上次选择。按需求视图按创建时间倒序列出
所有人的配置，任何已登录用户都可以新建、查看、改名、用当前环境与分支覆盖、复制链接或删除。

同一配置更新后仍使用原 ID 和短链，旧链接下一次打开时采用更新后的环境与分支；删除后旧链接返回
404。已经创建的标签页 Preview 是独立快照，不会因配置编辑或删除而在测试过程中漂移。QA 点击一条
需求时，扩展会先持久化它的环境和全部项目选择，再解析各分支当前最新的成功 Artifact 并自动应用；
即使某个分支尚未打包，正确的环境与分支也会保留下来，方便直接发起构建。新包构建期间旧包继续服役，
构建成功后下一次使用该需求才会采用新包。配置记录不保存 Artifact ID，也不会阻止“每环境、项目、
分支只保留一个最新候选包”的回收。明确选择“官网页面/官方热更”的项目仍会跟随 KOOK 官网发布。
没有安装扩展、分支尚未打包或配置已经失效时，短链会停留在 Bifrost 落地页，展示环境、项目、分支与
就绪原因，不会静默回退到错误版本。
即使全部项目都选择“官网页面/官方热更”，打开短链也会创建一份新的环境专属 Preview Token，使
后端走配置组环境；不会因没有 Artifact 选择而退化成 SiteBinding 默认环境。

Preview 只覆盖 Token 明确选择的 Remote；未选 Remote 始终保留官方接口返回值。Remote Artifact
仅在被同一环境的有效 Preview 引用时可通过
`/__cuddly/preview-artifacts/<artifactId>/...` 读取。没有有效 Preview 的旧包会按每分支一个最新候选
的规则回收，因此历史 Revision 记录不等于可回滚的文件备份。分支选择器中的“官方热更（不覆盖）”
只是从当前标签页组合中省略该模块，不会修改公共环境。

构建队列默认允许 3 个不同项目并行执行，可在管理后台的“系统”页面调整。同一项目的任务
始终串行，后续任务会留在全局队列中，直到该项目的当前任务结束。构建记录详情支持中断排队或
运行中的任务；运行任务会先进入“正在中断”，Runner 的命令进程组真正退出后才标记“已取消”。

控制台使用可搜索的专用分支选择器；浏览器扩展使用锚定在项目行下方的紧凑下拉列表，保留搜索、
最近一次构建活动排序，并直接展示排队位置、安装、打包、校验、保存和中断进度。队列轮询不会重复
查询 Git；任务结束后只刷新受影响项目的分支目录，瞬时失败时保留旧目录并在下一轮重试。

扩展弹窗使用 `560×600` 的紧凑单列布局，通过“项目版本 / 构建队列”两个 Tab 分隔配置与全局活动
队列；队列项和项目行中的活动进度都能打开任务详情，查看命令、时间线、结果和实时日志，并可中断排队
或运行任务。成功
提交构建后，该项目分支的按钮会保持禁用，直到手动刷新或切换分支；关闭再打开 popup 也会保留这项
状态。分支选择本身也由 Service Worker 按标签页和站点实时持久化；选择分支、发起构建后立即关闭
popup，再打开仍会回到刚才的分支。任一已选分支没有成功 Artifact 时，“应用”会禁用并在悬停或
键盘聚焦时说明具体原因。

## 项目配置

管理后台可以配置每个打包项目的显示名称、Git 仓库地址、默认分支和站点适配器；安装命令、打包
命令、产物目录和启用状态按环境配置。页面项目的预览域名、默认环境、官网、页面回退
源、资源代理路径白名单及关联 Remote 也在同一个项目编辑区维护；一个页面项目仍可拥有多个站点
绑定。

项目由内置模板或管理后台创建。Git 仓库、默认分支、构建命令与凭证只保存在数据库；恢复模板
会清空仓库和凭证。任务进入队列时会保存项目配置快照，后续修改不会改变已经排队或执行中的任务。

默认声明 `online-h5`、`webapp`、`biz` 以及 KOOK 当前 13 个 Remote 项目模板，均需在管理后台
补齐仓库后显式启用。Remote 模板默认从同一 Monorepo 中只安装对应 `apps/<module>` 的 workspace
依赖闭包，并构建 `apps/<module>/dist`。普通 QA 接口只返回名称、状态和默认分支；仓库地址与构建
命令只通过管理接口读取。控制台、构建、预览以及环境与项目设置都要求有效飞书会话；当前尚未划分
角色，因此任何在飞书应用可用范围内且成功登录的用户都拥有相同能力。操作人名称来自飞书身份，
用于队列展示和审计记录。

## 配置边界

日常配置全部由管理后台维护：

- 环境：名称、稳定 slug、Backend Origin、是否走公司内网、状态，以及每个项目在该环境中的命令、产物目录与启用状态。
- 项目：仓库、默认分支、适配器与凭证，以及页面项目下的预览域名、默认环境、官网、页面回退源、资源代理路径白名单与关联 Remote 项目。
- 系统：官网原地应用规则、Cookie 域、并行度、超时、响应改写上限与自动 SSL。
- 代理：启用状态、订阅链接和自动刷新周期。

Compose 中的数据库账号、服务地址、端口和磁盘路径属于单机部署内部连线，不是可变业务配置。
飞书 `app_id`、`app_secret` 是认证启动凭据，只通过上述 Secret 文件注入，不能在管理后台中配置。
日常运行无需在 `.env` 保存敏感值；换用其它控制台 Origin 时覆写 `CUDDLY_PUBLIC_ORIGIN`，换用其它
预览根域名时则由 Compose 与宿主 Nginx 安装器同时覆写 `CUDDLY_PREVIEW_BASE_DOMAIN`。两者都属于
DNS、TLS 与 OAuth 白名单共同决定的部署边界，不是管理后台中的业务配置。
