# dependency-egress-20261117

2026-11-17 11:29（Asia/Shanghai）已上线。

## 验证结果

- Runner 相关测试 85/85 通过；TypeScript 检查和 tsup 构建通过。
- 独立测试 Runner 完整执行 npm postinstall 下载、构建和产物校验；未写入生产任务数据库。
- 测试容器删除并重建后，postinstall 命中相同二进制缓存，构建继续读取该缓存。
- 故意忽略 SIGTERM 的生命周期子进程：1.5 秒测试安装期限后触发 INSTALL_TIMEOUT，加 5 秒强制终止宽限期，约 7 秒结束；子进程已回收，Runner activeCount 恢复为 0。
- 线上在 Runner 网络命名空间内，清除代理环境变量并使用独立原生 HTTPS Agent，完整下载 npm 镜像响应、GitHub robots.txt 和 Node 发布索引，均 HTTP 200。egress 日志确认连接经 existing-egress。
- Docker 内部 DNS、control-api 健康端点及原 runner-agent:9882 服务名正常。
- 生产 Runner 与 egress 健康，Worker 已恢复；主页 HTTP 200；宿主机不存在 bifrost0 接口。
- Corepack 缓存迁移完成。业务工作目录默认 pnpm 仍为 12.15.0，持久 store 路径验证为 /srv/cuddly/dependency-cache/verification/pnpm-store/v11。没有固定或升级业务项目使用的包管理器版本。
- 生产任务计数上线前后相同：267 成功、94 失败、19 取消；没有正式构建被创建或中断。

## 发布与恢复

- Runner 镜像：cuddly-runner-agent:dependency-egress-20261117。
- Egress 镜像：cuddly-runner-egress:dependency-egress-20261117。
- 生产默认安装时限：CUDDLY_INSTALL_TIMEOUT_MS=600000；宽限期最多另加 5000 ms。
- 备份：/home/miku/cuddly-backups/pre-dependency-egress-20261117，包含旧源码、Compose 配置和约 1.4 GB 的旧下载缓存归档；旧镜像保留为 cuddly-runner-agent:pre-dependency-egress-20261117。
- 首次切换前的 sudo 缓存迁移需要认证，发布保护自动恢复了 Worker，未替换原 Runner。随后通过 trustd 完成迁移，关闭凭据会话，再次发布成功。
- 数据库、API、主页和 Gateway 未重启；只更新 Runner 并新增 egress。

生产业务项目未逐个重新构建。上游站点或代理节点本身不可用时仍可能失败；本次实现统一连接出口、缓存复用和安装限时，不保证所有外部服务永久可用。
