# CakeUI 0.12.0 发布记录

2026-09-16 16:57（Asia/Shanghai）完成。

- 网站：https://bifrost.vanillacake.cn/
- 帮助页：https://bifrost.vanillacake.cn/help/
- PC 插件界面：https://bifrost.vanillacake.cn/pc-plugin/
- KFC `cuddly`、`cuddly-browser-extension` 均已发布 `0.12.0`，接口返回 201，随后回读版本确认。
- 四个平台的扩展 ZIP SHA256 均为 `b07a7a1e511aa2354a36683272d96306569d0ac22874b39ce582496e5d1f3782`，与本地包一致。

仅重新创建 console 和 control-api。build-worker、runner-agent、gateway、mihomo、postgres、cert-manager 保持原容器运行。
API 在原线上镜像内沿用原有依赖重新构建，仅替换 OAuth 完成页样式；控制台使用已验证的静态产物，保留旧哈希资源，兼容部署前打开的页面。

## 验证

- 两个新容器 healthy。
- 首页、JS/CSS、帮助页、PC 插件页面与 CakeUI 资源的线上字节哈希和本地产物一致。
- 匿名 auth/session 仍返回 401；未跳过任何鉴权。
- 实际浏览器已验证登录入口和 OAuth 完成页样式，无页面脚本错误。
- 线上图文帮助检查通过：10 章节、7 图片、搜索、目录、弹窗、键盘、下载和移动布局。
- KFC 客户端内安装/重载未代替用户操作；扩展更新后仍需在浏览器扩展管理页重新加载。

## 回滚

远端目录：`/home/miku/cuddly-umbrella/release/cakeui-20260916-1653/`。
保留 `sources-before.tar.gz` 及以下镜像，不做清理：

- `cuddly-console:before-cakeui-20260916-1653`
- `cuddly-control-api:before-cakeui-20260916-1653`

需要回滚运行版本时，在项目目录执行：

```sh
docker tag cuddly-console:before-cakeui-20260916-1653 cuddly-console:latest
docker tag cuddly-control-api:before-cakeui-20260916-1653 cuddly-control-api:latest
docker compose -p cuddly -f docker-compose.yml -f docker-compose.production.yml up -d --no-deps --no-build --wait control-api console
```

源码还原需单独检查备份后恢复；不要重启其他服务。KFC 旧版 0.11.23 保留未覆盖。
整个发布没有执行 Git 提交、建分支或推送。
