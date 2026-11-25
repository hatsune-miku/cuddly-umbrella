# 构建依赖安装

## 网络出口

生产 Compose 为 Runner 启用独立的 `runner-egress` 网络命名空间。Runner 与其共享网络；TUN 仅接管该命名空间的公网连接，经现有 `mihomo:7890` 转发，继续使用后台配置的代理规则和订阅。

这不是主机级 TUN，不修改宿主机路由，也不解密 HTTPS。Docker DNS、回环及私网保留直连；该命名空间禁用 IPv6，避免绕过 IPv4 出口。`runner-agent` DNS 别名仍供 Worker 和 API 使用。

Linux 主机需要 `/dev/net/tun`。只有 egress 容器获得 `NET_ADMIN`，Runner 不获得该能力。基础 `docker-compose.yml` 保持不变；正式部署同时使用 `docker-compose.production.yml`。重建 egress 容器时必须同时重建 Runner，避免继续引用旧网络命名空间。仅重启 egress 进程不需要重建 Runner。

现有 HTTP/SOCKS 代理变量继续保留；不读取变量的下载器由 TUN 接管。DNS 故障、上游服务故障或无可用代理节点仍会导致下载失败，并非所有网络问题都能由代理解决。

## 时限和日志

- 安装默认上限为 600000 ms，包括 frozen-lockfile 失败后的一次降级重试。
- `CUDDLY_INSTALL_TIMEOUT_MS` 可在部署环境或 `.env` 中设为 1000 至 7200000 ms 的整数；修改后重建 Runner。
- 每 30 秒记录安装已耗时和距最后输出的时间；npm 开启前台生命周期日志，保留包管理器原始输出。
- 到期返回 `INSTALL_TIMEOUT`，先终止整个进程组，最多 5 秒后强制杀死。Runner 的 init 进程回收遗留子进程。用户取消仍返回 `BUILD_CANCELED`。
- npm 自身的 HTTP 请求默认 60 秒超时、最多重试两次；脚本自带下载器由整体安装时限兜底。
- 仅安装阶段有此硬时限，构建命令不继承 10 分钟限制。

## 持久化缓存

下载缓存保存于 `/srv/cuddly/dependency-cache`，对应宿主机 `data/docker/dependency-cache`，不随任务临时目录或容器删除。

- 项目缓存按项目标识、仓库地址散列隔离，再按 OS、CPU、Node ABI 和 libc 隔离。
- npm、pnpm、Yarn、XDG 缓存及 Puppeteer、Playwright、Electron、Cypress 使用固定目录；node-gyp 等支持 XDG 的工具也在其中保存缓存。工具自身继续按包或二进制版本索引。
- 安装与后续构建继承相同目录，避免安装能找到浏览器但构建找不到。
- Corepack 使用独立的 `toolchains/corepack` 缓存，升级部署时迁移旧 Runner 的已下载版本及默认版本信息，不另行固定业务项目包管理器版本。
- 未知下载器若不遵循上述目录，仍可能不命中缓存；不会声称代理可自动缓存任意 HTTPS 内容。

缓存不是制品或数据库。需要回收空间时，在没有正在运行的构建且已暂停 Worker 的情况下，按明确项目缓存目录清理；下一次安装会重新下载。不自动删除共享缓存，不复用不同项目的 node_modules。已有磁盘余量检查继续生效。

## 安装脚本策略

保持已有项目兼容性，不全局设置 `ignore-scripts`，不批量加入浏览器或 Electron 的 skip-download 变量。原有 pnpm 构建脚本放行逻辑保留。项目可自行维护脚本白名单和二进制镜像配置；需要缓存的二进制与业务使用版本必须匹配。

## 本次发布与回滚

发布目录：`release/dependency-egress-20261117`。`deploy.sh` 会确认构建空闲、暂停 Worker、备份源码/镜像/原容器下载缓存，再替换 Runner 和添加 egress，检查后恢复队列。数据库和其他服务不重启。

迁移前通过授权的 sudo/trustd 会话创建宿主机 `data/docker/dependency-cache/toolchains/corepack`，再将旧容器 `/root/.cache/node/corepack/.` 复制进去。发布脚本在暂停队列前检查迁移目录，避免在停机窗口内交互索取凭据。迁移中保留 `lastKnownGood.json` 和 `v1`，不改变默认 pnpm 版本。

备份位于 `/home/miku/cuddly-backups/pre-dependency-egress-20261117`。`rollback.sh` 在构建空闲时恢复旧 Compose、Runner 源码和镜像；新持久化缓存保留。旧容器缓存另存于受限备份目录中的 `legacy-download-caches.tar`，不会自动覆盖新缓存。
