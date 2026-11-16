# Project Cuddly

名字不重要，源自 GitHub 给的随机仓库名，但是很合适，就用来当项目名了。

首先，以只读方式了解：

- KOOK Monorepo, KOOK语音（原“开黑啦”）的前端主仓库
 
前端：C:\Users\guanz\projects\kook

  - Monorepo 根目录：C:\Users\guanz\projects\kook
  - Webapp 部分: C:\Users\guanz\projects\kook\apps\webapp
  - Electron 外壳: C:\Users\guanz\projects\kook\apps\html_pc
  - 离线 H5 部分: C:\Users\guanz\projects\kook\apps\h5
  - 热更包体部分: C:\Users\guanz\projects\kook\apps\*



- KOOK 商户后台前端仓库（前期暂不涉及，快速掠过、知道是做什么的即可）

C:\Users\guanz\projects\biz-fe


- KOOK 移动端在线 H5 前端仓库

C:\Users\guanz\projects\html_h5

与主仓库里面的 apps/h5 不同，那个是离线 H5


- KOOK Version Manager (KVM)（前期暂不涉及，快速掠过、知道是做什么的即可）

C:\Users\guanz\projects\kook-kvm


- KOOK Facilities Collection (KFC)（前期暂不涉及，快速掠过、知道是做什么的即可）

C:\Users\guanz\projects\project-kfc


- Bifrost, KOOK语音的代理型私服
 
  - 前端：C:\Users\guanz\projects\bifrost-frontend\bifrost-mis
  - 后端：C:\Users\guanz\projects\bifrost-kookapp

最重要的是，弄懂为什么前端团队给自家做了个私服：

- 缺少在线上环境方便地测试热更包的能力、
- 后端长期提供不了这个支持、
- 其它原因，你需要探索仓库、增进理解，然后总结出来。



- "打包嘟嘟"，KOOK 的个人分支 webapp 部分打包机器人

C:\Users\guanz\projects\kook-builder


- 快速账号切换浏览器插件（前期暂不涉及，快速掠过、知道是做什么的即可）

C:\Users\guanz\projects\kaccount-switch


- misemu（README 里面有一句话描述，其中 mis 是 KOOK 主站后端的管理后台）

C:\Users\guanz\projects\misemu



## 项目现状

目前以下能力其实是已经实现并已经在 QA 中投入大规模使用的：

- 上述 KFC 和 KVM 工具，以及一众其它测试工具
- Bifrost 环境

但是，现在仍然面临这些问题：

- 将一个热更包放到私服上，步骤相对还是繁琐了，而且，目前只有作者本人（我）熟悉这个流程
- 当多个需求先后进入测试阶段，每个需求都在不同分支要求打包不同的热更包：
  - A需求，feature/A\_1 分支打 base, gift, discover，feature/A\_2 分支又要打 voice_runtime
  - B需求，feature/B\_1 分支打 base, voice_panel
  - ...

  如此一来，测试最近终于抓狂了，然后提了技术需求给我：
    - 环境只有一个，每个需求有着截然不同的打包方式，**测试部门完全失去了并行测试的能力**；
    - 当然，通过魔改 PC 包可以打出不依赖打包系统的包，但是一旦出 BUG 要改，重新出 PC 包 20 分钟、打包机连轴转、测试即使拿着 KVM 也经常弄混，
    - 说实话，后端给的打包后台也并不好用，还经常有 BUG。
- 我们不仅有主站，还有 H5 站、biz 站，目前 Bifrost 没覆盖到 H5 和 biz。
- 目前现有的打包服务只能公司内网访问，WFH 不友好。


## Cuddly 需求

在 Cuddly（当前目录，初始是空的，只有本文档）中，我希望：

- 以先进的架构和到位的技术能力，重新实现（除 Electron 外壳外）完整的热更新链条：打包并服务 webapp、 打包热更包、下发热更包、私服模块、飞书鉴权用于识别公司员工等。
- 继承 Bifrost 前后端的部分能力
- Cuddly 自身仍保持前后端分离为两个项目

在目前的理想中，完整的 Cuddly 包含以下模块：

- 私服部分
- 打包能力（仍然命名为打包嘟嘟），涵盖 webapp, h5, 热更包的打包与上传能力
- 打包能力对外 API 服务化，与与之对应的易用封装
- 接入能够拦截 KOOK 请求、修改结果的浏览器插件，就像 Bifrost 项目中的 k-inject.js 一样

技术栈：

- 基本不限，最好与 KVM, KFC 这类大项目差不多

这些全都不急着实现，请你先为以上内容写一个总结即可。
