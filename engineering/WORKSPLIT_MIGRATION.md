# Worksplit 原生会话迁移记录

本页记录 2026-11-05 的迁移范围、采用版本和实际验收；长期所有权约束由 [Frontend](FRONTEND.md#原生工作区与文档路由)维护。

## 版本与安装

采用 `PluxelJS/split-like-vscode` 的 main 提交 **`ce26b292e9b1ad090c0f8f5e4b5afec04b1aeab9`**，包含已验证基线。迁移前父仓库 gitlink 为 `265bbed1bde9879c585224bfad4348941b95a3ab`，实际干净 checkout 已在较新的 `84c7330bfa64442808bd004f36610f9a26a09670`；核对后快进，没有覆盖子模块工作。

当前源码还包含子模块内可审查的本地修复，不能把它描述为未修改的上游提交：原生 Border 的业务 config 接纳、菜单容器继承原生主题、内联菜单控件的键盘操作及操作后焦点交接。菜单键盘最小复现先在纯 FlexLayout 中失败，修复归入其完整补丁；主题、菜单生命周期和焦点协调问题归入 Worksplit。显式原生点击/按键会取消旧内容的延迟焦点请求，单纯 DOM focus 不取消首次打开；最大化隐藏当前焦点时，沿用库的焦点交接并保护更新的用户意图。这些问题均先建立最小失败复现，没有在 Shell 复制原生控件或恢复焦点重试。FlexLayout 完整补丁 SHA-256 为 `035fdfbd510815624b5adbff94c1abe6a50b7a51cd1feb8b280a8e4267516155`。

使用根 pnpm workspace 的真实源码构建，包版本仍是 `0.1.0`，不以版本字符串证明升级。移除旧 `@worksplit/core` 成员，接入独立 `@worksplit/split-view` 工作区；当前三个业务消费者均未使用 SplitView。

精确原生组合为 React/React DOM `19.3.1`、FlexLayout `0.11.1`、React Router `1.170.46`、router-core `1.171.39`、history `1.162.5`。根 `patchedDependencies` 使用 vendor 的四份完整补丁，没有嵌套安装。`scripts/check-worksplit-native.mjs` 调用当前构建制品携带的公开安装检查器；三宿主解析到同一组真实依赖，每个检查覆盖 27 个补丁目标。支持条件由[上游原生支持](../vendor/split-like-vscode/docs/navigation-support.md)维护。

`vp run worksplit:native:check`、各宿主 build/dev 的安装检查不缓存。Workbench 完整交付用 `vp run @pluxel/workbench#compile`：`compile-web` 生成 `public`，`compile-lib` 才将该 UI 带入宿主实际读取的 `dist/public`，两者不能混作同一验收边界。

## 消费者与保留能力

| 消费者                 | 会话与业务所有者                                                                                                        | 保留能力                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workbench Shell        | `WorkspaceSession` 拥有会话；根 `WorkbenchDocumentRoot` 拥有 controller；ConfigForm/SDK activation 拥有编辑与保存事实   | 内置页面、插件详情、MF View/Content、独立页面、复制、多文档、插件 Border 面板与归档、目录、配置草稿、快捷键、浏览器导航及布局恢复 |
| Typst playground       | `main.tsx` 拥有会话；各编辑内容拥有 controller；共享 source project 与 `DocumentClient` 拥有文件、草稿及请求次序        | 文件树、只读边界、临时标签、结构化/源码/表单编辑、章节、引用、撤销重做、预览定位、保存重开及 PDF                                  |
| Report Template Studio | `StudioSession` 拥有会话；持续路由 controller 绑定资源；`WorkspaceController` 与 Electron main 拥有共享草稿、服务及磁盘 | 文件工作区、表单/源码/正文、独立预览、共享输入、冲突恢复、AI 工具、保存与导出、工具停靠及正常窗口退出                             |

没有引入财务项目的容器数量、导航、保存或业务布局限制。

## 行为选择与删除的旧路径

- 宿主显式 `start`，Workbench 仅绑定 `instance`。正常退出用 `closeWorkspace`，最终 teardown 用 `dispose`。Electron 正常窗口关闭先经过 renderer 的受保护退出，再由 main 关闭窗口。
- `useContent()` 只借用 handle，异步资源使用 `runEffect`；持续 controller 负责标题、保存、焦点与 token 绑定的离开决定。Shell SDK 自动标题由该 controller 接纳，不占用原生手工重命名；打开时的标题作为绑定 href 的业务 presentation 留在原生 Tab config，activation 的临时标题结束后恢复该输入。
- 普通 Shell 入口继续在当前文档的真实 Router 中下探、筛选和返回；另开内容使用 Worksplit。保存未确认可拒绝离开，保存中新编辑保留。已批准导航用每个请求自己的 `defer` 暂停/释放编辑，批量拒绝不逐个删除。
- 默认复用采用 `preserve`；必须另开时使用 `new`。新副本遵循上游自动标题语义，不复制原标签手工名称或草稿。原生手工名称随原标签跨导航保留。
- Shell 显式保留全工作区一个临时预览的旧政策；Typst 保留编辑器区域的临时文件/章节政策。`keepOpen` 不等于固定。相邻预览使用 `reveal` 保留编辑焦点，后台打开不请求焦点。
- Shell 的 home 显式为 routed root。v2 快照保留现有存储 key；旧格式、损坏或错误 workspace 明确报恢复错误，用户显式重置。退出使用库返回的最终快照并停止旧延迟写入。业务草稿不进入布局快照。
- 使用原生默认菜单与键盘焦点交接；Shell 仅保留中文、工具显隐/尺寸、可见范围关闭和右侧副本等业务组合。原生 Model、Actions 与 destination/beside 执行布局操作并返回真实结果。
- 删除旧 lifecycle hook、独立 browser connection、旧结果分支、普通查询的布局序列化、重复菜单会话、命令转发、identity-conflict 路径、布局后再移动链和延迟焦点重试。保留有业务含义的面板归档、共享草稿、保存 lane 与持久化策略。

## 验证与证据

本地证据位于 `.artifacts/worksplit-migration/`，包括原始 console receipt、测试日志、实际 UI 截图及导出的 PDF。它们不替代下列命令对应的真实宿主边界。

- 已执行根安装与 frozen lock 检查；三消费者公开安装检查均为 `changed: 0`、`alreadyApplied: 27`。验证了实际 JS/CSS/声明、严格 ESM/CJS 类型、原生导航 ESM/CJS 回归及源码到生成产物的一致性。
- Typst `source-check.mjs` 的真实浏览器验证覆盖文件草稿、临时标签、编辑器/预览焦点、保存重载、分屏与拖回归组；`document-check.mjs` 覆盖实际章节输入、并发输入、引用、保存、关闭旧 lease 后新 lease 重载、导出 PDF 与共享标签布局，均无浏览器错误。
- Studio 原有完整 Electron desktop smoke 和 Worksplit 专项通过。专项覆盖默认 Duplicate、键盘上下文菜单分屏、真实鼠标拖回、窄窗格、默认关闭与正常窗口关闭到进程退出；完整验收覆盖真实 IPC、共享草稿、保存冲突、外部改动、正文/表单/源码保存与 PDF。
- Studio 正式测试为 34 文件、230 项通过、1 项 Windows ACL 条件跳过。增强 Electron 专项使用无效共享 JSON 触发真实保存失败，正常窗口关闭整批拒绝并保留全部标签和草稿；撤销后正常退出，进程 code 0、无强杀 signal。
- Shell 的实际 Plugin Host 综合验收通过 23 项，配置表单通过 9 项，插件面板通过 4 项。覆盖真实 MF 多副本与独立输入、反复开关后的 owner/socket 数、原生分组/拖放/菜单/键盘、窄窗格、明暗主题、重载后懒文档首次激活再返回、浏览器导航拒绝、待确认写入、保存中新编辑和批量关闭拒绝。配置验收只修改 `outboundPath` 并通过原 receipt 所属实例恢复；该示例没有配置更新监听器，准确核对“已保存、未应用”的回执和 UI，没有声称运行实例已应用该暂存值。
- Typst source 验收 50 项、document 验收 12 项，浏览器错误均为零；前者和后者均使用现有真实宿主与编译器。
- Shell、最终完整门禁与库缺陷修复的结果在验收结束后补入本节。

## 不适用和环境边界

Typst 与 Studio 当前没有浏览器工作区 history 或原生布局快照持久化，不为验收新增这些功能。三个消费者均未使用独立 SplitView，因此受控显隐、折叠恢复和展开尺寸持久化不适用。

当前 Plugin Host 未发布 standalone 入口；受保护的整工作区离开与外部交接由 Shell 集成测试覆盖，真实浏览器只验证规范 standalone URL 不创建工作区。该环境没有验证从已发布业务入口发起的整工作区外部交接，不以库测试替代这一缺口。

工作区起始为 `main` 且存在其他任务的未提交修改；保留这些修改。Plugin Host 原 HMR 模式为 paused，任务结束保持 paused；每批源码通过现有控制台 apply 并核对应用报告。没有取得提交、推送或合并授权。
