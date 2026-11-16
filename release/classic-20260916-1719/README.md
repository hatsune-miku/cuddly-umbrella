# 0.12.2：恢复经典 CakeUI

2026-09-16 17:24（Asia/Shanghai）发布完成。

按用户要求撤回 0.12.1 的额外设计，恢复 0.12.0 经典 CakeUI。恢复了共享主题、
认证完成页样式、控制台/扩展布局样式、教程样式和 UI 资源生成脚本；
删除当前文档中的 `FRONTEND_REDESIGN_0.12.1.md`，旧发布归档仍保留。
业务代码、用户配置、鉴权、热更替换、构建逻辑均未改动。

## 一致性和验证

- 六个恢复的样式/构建源文件与 0.12.0 备份逐文件 SHA256 一致。
- 主站 JS/CSS 恢复为 `index-DOx4CdBc.js`、`index-BoKe-Hsq.css`，与经典版一致。
- 扩展 ZIP 的 25 个运行文件与 0.12.0 相比，仅 `manifest.json` 的版本号不同。
- 主项目最终回归 394 项通过、1 项跳过；扩展 151 项通过。
- 首轮测试临时比较目录被错误纳入测试发现，移至系统临时目录后已消除；
  一次 Windows 临时文件 EPERM 单测重试及完整重跑均通过，未修改业务代码。
- 控制台构建/类型检查、交互截图、图文帮助检查通过。
- 线上首页、业务 bundle、PC 插件、登录样式和教程资源均与本地产物哈希一致。
- 匿名 session 仍为 401；登录页和 OAuth 完成页实际浏览器检查通过。

## 线上部署

仅重建 `cuddly-console-1`，其他容器均未重启。

- 镜像：`cuddly-console:classic-20260916-1719`
- 镜像 ID：`sha256:c5c357b73f3d217e02b2517309af320c162ae749f9bbcd09d163fefe857fa1c9`
- 部署前镜像：`cuddly-console:before-classic-20260916-1719`
- 远端目录：`/home/miku/cuddly-umbrella/release/classic-20260916-1719`
- 源码备份：远端目录中的 `sources-before.tar.gz`

必要时回滚本次部署：

```sh
docker tag cuddly-console:before-classic-20260916-1719 cuddly-console:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait console
```

注意：此操作回到被用户拒绝的 0.12.1，只用于故障恢复，不是预期外观。

## KFC

`cuddly`、`cuddly-browser-extension` 均发布为 0.12.2，POST 201，回读确认最新版本。
扩展四个平台 SHA256 均为：

`882964ee74765a3e37204418736d077119c94b042e7f0909bf6e66f35189a3d6`

用户在 KFC 更新后需在浏览器扩展管理页重新加载。未操作用户客户端安装。
未保存发布凭据，未执行 Git 提交、分支、worktree 或 push。
