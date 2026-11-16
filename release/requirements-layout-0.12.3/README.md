# 0.12.3：需求列表布局修复

2026-09-16 17:35（Asia/Shanghai）发布完成。

保留经典 CakeUI，仅修复浏览器扩展/PC 插件“按需求”列表：

- 覆盖普通按钮的居中布局，标题统一 12px 内边距、左对齐。
- 列表使用 `grid-auto-rows: max-content`，避免 13 条需求被压缩到约 25px 高并裁切文字。
- 行间 6px、条目内 3px 间距；右侧操作垂直居中。
- 长标题省略，环境标签保留；分支摘要最多两行；元信息保持在行内。

## 验证

- 新增浏览器布局回归：13 条需求、超长标题/分支、单条需求、PC 宽布局及滚动。
- 修复前，新增回归成功捕获“列表不滚动、行被压缩”问题；修复后通过。
- 扩展单测 151 项通过；主项目 394 项通过、1 项跳过。
- 控制台构建/类型检查、帮助页交互与移动端检查通过。
- ZIP 共 25 个运行文件，与 0.12.2 相比只有 `cake-layout.css`、`manifest.json` 不同。
- 线上 PC 样式、首页 bundle、教程资源与本地产物 SHA256 一致，匿名 session 保持 401。

## 部署与发布

- 仅更新 `cuddly-console-1`，未重启后端/构建/代理服务。
- 镜像标签：`cuddly-console:requirements-layout-0.12.3`。
- 前一镜像：`cuddly-console:before-requirements-layout-0.12.3`。
- 远端发布目录：`/home/miku/cuddly-umbrella/release/requirements-layout-0.12.3`。
- 源码备份：发布目录的 `sources-before.tar.gz`。
- KFC 网站、浏览器扩展均发布 0.12.3（POST 201），回读确认最新版本和四个平台的文件校验值。
- 扩展 ZIP SHA256：`964a5065db6cb1674d8f7a5aea03da3674633776f3a16d28242b0b9eda9b0c32`。

用户需在 KFC 更新插件后，前往扩展管理页重新加载；未操作用户客户端安装。
未写入发布凭据，未执行 Git 提交、分支、worktree 或 push。
