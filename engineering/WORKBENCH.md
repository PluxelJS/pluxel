# Workbench 架构

Workbench 将 Plugin 已有的业务能力发布为 Content、View 和 Attachment。后端拥有 publication、打开租约与制品接纳，Shell 拥有布局和浏览器 activation。公开用法见 [Workbench](../docs/workbench/index.md)，Shell 实现见 [Frontend](FRONTEND.md)，交互理由见 [交互设计](WORKBENCH_DESIGN.md)。

## 平台边界

Workbench 是可选 Host 服务。关闭时不安装 Context property、backend、compiler、route 或 transport，业务 Plugin 继续运行。

| 路径       | 用途与所有者                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Content    | Shell 渲染 build-time portable Markdown plan、bounded latest state、短 action 和一次性表单           |
| View       | Plugin 提供 fresh `RpcTarget` 和完整 React renderer                                                  |
| Attachment | provider 拥有 renderer/API；consumer 经 constructor dependency 决定 placement，可提供自己的 API root |
| Placement  | 固定 `tab()` / `route()` / `panel()` topology；领域列表行保持为数据                                  |

普通 Plugin 配置使用 ConfigService/标准 UI。复杂交互、lossless stream、分页、progress/cancel 由 View 的领域 API 表达。启用后的交付采用 Cap’n Web over WebSocket、MF2 Manifest/Snapshot 和 React Bridge；Content-only definition 没有 MF producer。

## Definition 与 publication

Definition 是 flat、frozen、固定键集合。Canonical Plugin definition address 与 entry key 决定 identity；Attachment placement 另固定 consumer definition 和 provider descriptor。`workbench.entry()` / `markdown()` 的 module-relative literal 只提供编译 provenance。

Plugin 在 `init()` 中最多 publish 一次，bindings 精确覆盖需要绑定的 entries，纯 Markdown 无 binding。Part 由 owning Plugin 聚合。Context 决定 owner，publication 纳入 generation effects，在 owner committed/running 后才可见。

`panel(region, { label, icon?, order? })` 生成 `kind: panel` placement，region 仅 left/right/bottom。它沿用 publication/openEntry，以 target node、entry key 和当前 layout revision 接纳；Panel 不进入 route directory。

每次 View/Attachment open 创建 fresh roots，interactive Content 使用框架创建的 per-open root。Factory 取得已认证 principal、服务端重新匹配的 frozen params 和 lifetime signal；领域 observer、任务与缓存随 signal/disposer 释放。Factory 不取得 raw request、consumer Context 或 service locator。Attachment provider 只取得 exact consumer node address，可选 consumer root 保持自己的 owner、授权与 cleanup。

View/Attachment 的 `RpcTarget` 必须与 Host 使用同一 `capnweb` identity。准入先验证版本，再绑定 Host 选择的安装：

| 阶段                  | 检查与接线                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Plugin package build  | 语义分析确认 publication 后，检查 exact peer/dev 和实际安装版，生成 `pluxel.workbenchCapnweb` |
| Static build          | 检查上述发布事实，以及声明 exact peer 的 target 基础库的实际解析版                            |
| Native source         | Node resolve hook 调用 Host 共享准入规则，再接线                                              |
| Vite dev / production | 同一准入规则核对 peer、制品事实与实际版本，再通过 singleton 接线                              |

Management 和脚本控制也使用该 identity。Content-only 和私有 RPC 不触发桥接；绕过标准加载器仍会遇到 registry 的 `instanceof RpcTarget` 检查。

Factory 失败由服务端记录原始异常、node/entry 与 `diagnosticId`，客户端只收到 code 和该标识。超时、owner 撤回及重复使用已导出 target 分别报告，打开失败不自动重试。

## Host HTTP 与 Shell 开发

`workbenchService()` 拥有后端，`workbenchHttp()` 挂载 Shell fallback，`managementHttp()` 拥有认证、管理 session 与受保护制品。组合层通过 bindings 接入 handler，并声明服务准备依赖；Management 可独立启用。

`@pluxel/workbench/dev` 的 `workbenchSourceShell({ entry })` 将源码 HTML 附加到现有 Vite 图，应用提供入口和 React/CSS 配置。组合示例见 [standalone host](../docs/workbench/standalone-host.md)。

打包 Shell 的 HTML、chunk、CSS 和 assets 统一使用 `UI_PUBLIC_BASE`。构建验证固定入口 `shell/src/client.tsx` 的静态/动态 import 闭包和引用文件，HTML 只预加载静态 import；复制至 `dist/public` 后再次验证发行入口。源码读取包根 `public`，发行入口读取 `dist/public`，自定义 `publicDir` 只读取指定目录。

Shell 服务首次静态请求才加载 packaged manifest，直接创建 packaged handler 则立即校验。后续每次 HTML 导航重新校验当前 manifest，重建产生无效 manifest 时明确失败。

## Session 与打开流程

每个 browser document 只有一条 `/__pluxel/runtime/session` WebSocket。Authentication、ready bootstrap、Management、layout/openEntry、Content push、Plugin API 和 logs follow 共用同一 Cap’n Web object graph；Management 只借用 opaque Workbench target/disposer。

Same-origin single-use ticket POST 写入 HttpOnly cookie，MF 静态资源通过 HTTP 提供。代理需保留 cookie、Upgrade 和实例归属；HTTP 服务不从 forwarding headers 推断 physical TLS/locality。

`layoutDto({ target })` 返回 capability-free immutable snapshot：target、placement、descriptor、owner revision 和 pinned Content/MF reference。Content plan 在 open 时返回。`target: null` 返回全部 route/tab，包括无 navigation 的参数化或 standalone route；不含 panel/provider attachment，读取目录不调用 factory。短路径由完整目录计算，冲突的全部参与者使用 canonical node URL。

`workbenchService({ initialShortcuts })` 随 layout 提供初始侧栏偏好，存储和交互由 [Frontend](FRONTEND.md#导航和目录) 拥有。

打开流程固定为：

1. `openEntry({ layoutRevision, target, descriptor, location? })` 校验 revision、identity、route 和 owner admission。
2. 静态 Content 返回 pinned plan，立即释放短 admission，不占 retained quota。
3. Interactive Content 返回 plan、portable presentation 和 fresh root；含 data 才订阅。
4. View/Attachment 创建 fresh roots，加载 pinned manifest/expose，验证 Bridge。
5. 创建 per-open host facade，激活 Bridge；候选全部成功后才成为 active。
6. 失败或关闭按 Bridge destroy → host facade close → opened handle dispose 释放。

每 session 最多 64 个 retained interactive entries，factory 默认超时 15 秒。可预期 admission failure 使用封闭 code；编程和 transport failure 继续 reject。

认证、owner/publication、producer/Content inventory 或 socket epoch 失效会撤回 opened entries。Shell 销毁旧 UI 并完整 reload，刷新预算见 [HMR](HMR.md#browser-update-policy)。

## Content trust boundary

Markdown 构建为有界、immutable portable AST，浏览器再次验证后以 React semantic elements 渲染。每个 slot 恰好出现一次；unknown/missing/duplicate/nested slot、attributes、inline action 和不安全语法均拒绝。Shell 不执行 Markdown parser、raw HTML 或 Plugin JS。

Publication 将真实 Valibot schema 投影为 portable presentation，并核对 artifact/declaration/binding。Data schema 使用 transform-free display validation；action input 使用 object/object-intersection form schema。服务端先检查 budget，再 authoritative parse，随后调用 handler；schema、closure、handler 和 secret 留在服务端。

`load()` 的 detached readonly snapshot 经再次验证后投影为 portable value；action 取得 parse 后 fresh mutable `InferOutput`。确认框只防误触，授权仍由 handler 根据 principal 和当前业务状态判断。

Interactive Content 的同步 `subscribe(changed): Disposable` 在 factory 通过校验后注册一次，先订阅、再首次 load，关闭 root 时释放。失败或取消的 factory 不注册。`changed()` 置 dirty，框架串行 load、合并通知，推送递增 sequence 的完整最新状态。Load/action 共用有界 lane，handler 开始后总做 post-load；action-only 返回 `data: null` 且无订阅。

首次 load 失败可在同一 lease 重试，后续失败保留最近值并标 stale，两者保留订阅。Observer failure 关闭本 entry lease、abort signal 并归还 quota。纯 Markdown 仍要求 owning Plugin running，但没有 binding、RPC root、retained lease、MF 或 Bridge。

## Content 制品与原子提交

Production plan 位于 `workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`，由 `pluxel-workbench-content.json` 索引。加载复核 inventory、digests、canonical path 和内容，发行无需原 Markdown。

Static assembly、dynamic discovery 和 dev compiler 共用 artifact store。Mixed Content/MF candidate 作为完整 revision 原子提交：prepare/commit 失败保留完整 last-known-good tuple，成功才触发 session invalidation。

## MF2 与 React Bridge

一个 Plugin definition 的全部 renderers 合为一个 producer，每个 declaration 生成稳定 `./views/<key>` expose 和 Bridge wrapper。工具链拥有 remote name、shared、public path 与 manifest URL，构建实现见 [Artifact Build](ARTIFACT_BUILD.md#workbench-source-declaration)。

Renderer graph 只有一个 exact definition value-import boundary，通常是 `createWorkbenchRenderer(Exact.entry)` 所在的 scope module；低层 hook 可由 default entry 持有。其他 page/panel import scope/resource，跨 renderer 组件接收普通数据。Toolchain 将该边界改写为 browser-only descriptor projection，保留类型且不执行 server definition；indirect/dynamic/re-export 和跨 renderer scope 均拒绝。

Manifest 是浏览器模块信息的唯一来源，Snapshot 从标准 Manifest 生成。Host 只记录 definition/revision 到 immutable artifact root 的 inventory。Manifest、entry、exposes、types 和 shared versions 验证后才提交；HTTP 只提供冻结 regular-file digest inventory 中的文件，Manifest assets 字段本身不等于完整 import closure。

`@pluxel/core/federation` 拥有 fixed singleton set：React/ReactDOM 及其 subpaths、Mantine Core/Hooks、MF React Bridge、Workbench 根/client/react/internal/react。全部使用 exact versions、`loaded-first` 和 producer `import: false`。Shell 先建立 winner，producer 的其他库自行 bundle。

根 frontend catalog 固定 React/ReactDOM 为同一个稳定版本，公开 peer/dev 声明和发行模板沿用它；消费应用也须安装该精确版本。升级 shared 时同步安装声明，重建 Shell 和全部 producer。工作区 lock 只约束本次框架构建，不能约束消费应用的 fresh install。

Bridge ABI 位于 `@pluxel/workbench/internal/react`。每次 mount 创建独立 React root/Context，调用零 props renderer。Mantine renderer 自建 Provider，共享 module 来自 singleton，Core CSS 由 Shell 唯一加载。Remote 只通过 facade 访问宿主能力。

开发 producer 同样编译为 `jsx/jsxs`，兼容生产 Shell，不按宿主 `NODE_ENV` 生成依赖开发 React 的 `jsxDEV`。构建语义变化须更新 renderer revision。Dev 允许先提交 topology/Content、将缺失 producer 显示为 building；后台成功后 full reload，失败显示安全 message，后续更新可重试。Production 一次提交含 dynamic types 的完整候选。

## Renderer resource 与撤回

Scope/resource 是 frozen declaration。每次 Bridge mount 创建私有 renderer owner/QueryClient，同一 descriptor 的并行 opens 也分别持有 principal、params、session 和 generation。

Query result 进入 cache 前完成 portable-data 校验、transport metadata 清理、原地深冻结和一次 top-level result disposal，只接收有界 JSON-like plain tree。跨调用保存 callback 须 `dup()`，subscription disposer 释放 callback 与领域注册。

`createWorkbenchWatch()` 表达 latest-state invalidation：先订阅后读，single-flight 并合并读取中的通知。Mutation 每 Hook single-flight；typed invalidation 在调用前验证，在 owner active 的 settle 后执行，包括 reject/consume failure。权威 watch 已覆盖的写入无需重复 invalidation。选项、默认值和错误码见 [renderer resources](../docs/workbench/renderer-resources.md)。

Owner 撤回先关闭 invocation admission、abort open signal，再等待已接纳 calls 并 drain。Bridge teardown 停用 Hook controls、QueryClient 和 subscription。不可取消 RPC 的晚到 DTO 仍 consume/dispose，不能更新 React。领域错误保持原义，框架 portable/scope/key/limit/closed 等错误使用稳定 code。

Shell 的 Worksplit content effect 拥有 activation 使用期限，SDK 执行 Bridge → facade → handle 的释放顺序。共享 session、草稿和业务任务由应用 owner 持有；关闭只等待固定的已知 cleanup 集合，不等待普通 setup Promise，RPC stub 本地 dispose 也不表示服务端完成。React 重放、编辑和关闭回执见 [Frontend](FRONTEND.md#动作与关闭)。

Host facade 提供 appearance、feedback、受限 relative navigation、document 状态和显式借用的 unary Management 操作。Detached/cached methods 同样绑定 View lifetime，不取得 session、socket 或 subscription 所有权。工作区布局与菜单由 [Frontend](FRONTEND.md#原生工作区与文档路由) 拥有。

## 实现与验证入口

| 边界                                   | 源码                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Definition / protocol / client         | `packages/workbench/src/workbench/definition.ts`、`client-protocol.ts`、`client.ts` |
| Portable value / renderer owner        | 同目录 `portable-value.ts`、`renderer-scope.tsx`、`react-internal.tsx`              |
| Registry / admission / Content         | `packages/workbench/src/services/workbench/`                                        |
| Session auth / transport               | `packages/services/src/management/web/session/`                                     |
| Lowering / Content compiler / MF build | `packages/rolldown/src/workbench/`、`src/vite/workbench-ui.ts`                      |
| Shell activation / Content UI          | `packages/workbench/shell/src/app/workbench/`                                       |

相关测试覆盖 exact identity、静态 Content 零 retained resource、fresh roots 与并行隔离、portable consumption/late results、Attachment 双 owner、Mixed artifact 原子提交、释放顺序和 disabled 零初始化。Socket、MF/browser 与发行制品的检查方法见 [Workbench 验收](WORKBENCH_FLEXLAYOUT_VALIDATION.md)。
