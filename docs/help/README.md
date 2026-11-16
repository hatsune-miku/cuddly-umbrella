# 图文帮助页维护

公开入口：https://bifrost.vanillacake.cn/help/

此目录保存样式和交互源码，章节内容来自 `docs/BIFROST_USER_GUIDE.md`。控制台构建时运行
`docs/scripts/build_help.mjs`，将静态文件生成到 `apps/console/public/help/`。
插图使用真实组件加本地演示数据，不读取生产账号、项目或构建记录。

## 更新与检查

1. 修改章节源稿，必要时先构建控制台，再运行 `node docs/scripts/capture_help_screens.mjs` 更新插图。
2. 运行 `pnpm --filter @cuddly/console build`。
3. 运行 `node docs/scripts/test_help.mjs` 检查图片、搜索、目录、键盘交互、下载及手机布局。
4. 如需核验线上页面，设置 `HELP_ORIGIN=https://bifrost.vanillacake.cn` 后执行同一测试。

截图与浏览器检查脚本接受 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH`，用于指定本机运行时。
PDF 由 `docs/scripts/build_user_guide.py` 独立生成；更新文字后需同步重建 PDF。
当前 PDF 是原有排版手册，网页另外提供图文内容与打印样式。

## 2026-09-14 部署记录

此次只在现有控制台镜像之上增加静态 `/help/` 文件与对应 Nginx 路由，未替换主站业务 bundle。
帮助页无需登录，不访问业务 API；原有 API 鉴权保持不变。浏览器扩展无需更新。

- 远端工作区：`/home/miku/cuddly-umbrella`
- 发布镜像：`cuddly-console:help-20260914-1524`
- 回滚镜像：`cuddly-console:before-help-20260914-1524`
- 发布与源文件备份：`release/help-site-20260914-1524/`
- 常规完整重建：沿用 `docker/console.Dockerfile`，构建时自动生成帮助页。
- 静态增量镜像：`deploy/help-site.Dockerfile`，必须显式选择已核验的控制台基镜像。

紧急回滚控制台可将回滚镜像重新标记为 `cuddly-console:latest`，再仅重建 `console` 容器。
此操作不会修改数据库；如果要撤回源码配置，还应从上述目录的 `sources-before.tar.gz`
恢复 `apps/console/package.json` 和 `docker/console.nginx.conf`。
