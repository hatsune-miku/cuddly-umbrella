# CakeUI 界面维护

本次 UI 使用 [CakeUI 文档](https://gallery.vanillacake.cn/llms.txt) 对应的
`@a1knla/cakeui@0.1.0`，统一为 blue / light / compact。保留控制台最大宽度和双列项目区、
浏览器扩展单列紧凑布局、可搜索的分支下拉、构建队列和原有业务状态。

0.12.2 已撤回 0.12.1 的额外视觉设计，恢复 0.12.0 的经典 CakeUI 外观。

0.12.3 修复扩展/PC 插件的需求列表：内容左对齐，行间保留 6px 间距，
Grid 行按内容高度排布并在列表内滚动，避免多条需求被压缩裁切。

0.12.4 固定队列/记录 tab 的工具栏与分页高度，移除卡片左侧色条和日志顶部圆角。
扩展内容使用 1.2 倍缩放，外框为 672×600px（Chrome action popup 最高 600px），
PC 插件保持容器自适应、不缩放；分支下拉定位需将 DOMRect 换算为未缩放坐标。
普通内容不可选中，保留输入框、命令、日志、分享链接和文档的复制能力。

0.12.5 将主站环境/端选择移到“按需求 / 按分支”旁；插件环境选择与当前端也在同一行。
插件的端保持按当前标签页自动识别，控件只读，不新增切端导航或更改应用目标。
主站构建记录页保留环境选择，窄屏的上下文选择器允许换行。
不要额外覆盖 CakeUI 的色板、字体、圆角或阴影；产品样式只负责必要布局。

0.12.6 合并主导航、二级导航和上下文控件，项目版本下展示按需求/按分支，构建页展示队列切换或筛选；窄屏可换行。

后续 UI 改动默认主站和浏览器插件双端同步实现与验证，PC 插件从扩展同步，继续保持经典 CakeUI 风格。

0.12.7 统一一级/二级分段切换样式；分段组与环境/端控件均为 36px 高，内部按钮 32px。回归测试检查真实按钮上下边缘，避免仅外层容器居中却视觉错位。

0.12.8 新增环境显示顺序设置，服务端持久化后统一用于主站与插件。数字越小越靠前；旧客户端省略字段时保留已有顺序，不改变选中状态或 URL 锁定逻辑。

0.12.9 增加 Chrome Side Panel 入口，复用浏览器插件的同一套状态、应用逻辑和队列能力；侧栏填充可用宽高，不使用 popup 的固定尺寸与缩放。PC 注入器仍从扩展源同步同一套 UI。

扩展点击工具栏图标直接打开侧栏，要求 Chrome 116+；按所属窗口跟随活动标签页，标签页草稿独立保存。PC 宿主 0.2.0 使用非模态右侧面板，支持拖拽/键盘调宽和宽度记忆。宿主源位于 `apps/console/pc-plugin/bifrost.js`，构建后通过 `/pc-plugin/bifrost.js` 分发，并同步到本机注入器 `user-plugins/bifrost.js`；安装目录中的旧宿主需重新注入才会更新。

## 实现边界

0.12.10：主站、扩展、PC 共用构建日志改为白底黑字，日志工具条同步为亮色；保留日志可复制及顶部直角。Runner 在 CHECKOUT 前输出 `POWERED BY 打包嘟嘟`，校验和上传成功且未取消后输出 `打包完成~`，旧日志不补写。

- 控制台直接使用 CakeUI React 组件。`apps/console/src/ui.tsx` 集中导出控件并定义操作按钮层级。
- 扩展不引入第二套 React 状态树：构建时从真实 CakeUI 组件生成原生节点描述，
  `cakeui-dom.js` 在既有节点上附加组件样式，不更换事件、输入值、禁用状态或业务属性。
- PC 插件由扩展源文件同步，不能单独改 `apps/console/public/pc-plugin/`。
- 帮助页与 OAuth 完成页也使用随包部署的 CakeUI 样式。运行时不访问组件 CDN。
- `packages/ui-theme/theme.css` 只定义兼容变量和共享布局，色板由 CakeUI 提供。
  原有样式放在 `bifrost-layout` 层，CakeUI 基础控件在其上；产品级布局在各自 `cake-layout.css`。
- 本次没有修改网关、DNR、hot-module 覆写、构建调度、权限或接口契约。

## 构建与检查

```powershell
pnpm --filter @cuddly/console build
pnpm --filter @cuddly/browser-extension test
pnpm test
node docs/scripts/capture_help_screens.mjs
node docs/scripts/test_help.mjs
```

`build:ui` 会复制库内 CSS、生成原生控件描述，并同步共享主题。生成文件不能手工改。
修改截图后再次构建控制台，才能将新图带入 `dist`。
浏览器扩展仍在原目录 `apps/browser-extension`，在扩展管理页重新加载即可。

扩展测试覆盖控件语义和业务回归；浏览器检查使用本地演示数据，覆盖分支搜索、标签切换、
环境/项目/代理/系统表单、分享表单、失败任务重试入口、运行任务中断入口、分页与移动布局。
这些检查不会创建生产构建或分享，不会访问真实业务后端。

## 发布

网站按原控制台部署流程更新；OAuth 页面样式引用在 control-api 中，需与 `/ui/` 静态资产一起上线。
只更新前端静态包不会更新 control-api 输出的 OAuth HTML。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./kfc-pack.ps1 -Version 0.12.9
```

该命令只生成可安装 ZIP，不会自动发布 KFC。UI 版本变更不需要更改扩展业务协议。
