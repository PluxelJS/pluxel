# Workbench 架构

本页拥有 publication、session、Content 与 MF/Bridge 的内部约束。作者用法见 [Workbench](../docs/workbench/index.md)，renderer resource 用法见 [renderer resources](../docs/workbench/renderer-resources.md)；Shell 状态与 workspace 实现见 [FRONTEND](FRONTEND.md)。

## 平台边界

Workbench 是可选 Host 服务，投影已有业务能力。关闭时不安装 Context property、backend、compiler、route 或 transport；业务 Plugin 仍能运行。

| 路径       | 所有者与用途                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Content    | Shell 渲染 build-time portable Markdown plan、bounded latest state、短 action 与一次性表单             |
| View       | Plugin 提供 fresh `RpcTarget` 与完整 React renderer                                                    |
| Attachment | provider 拥有 renderer/API，consumer 经 constructor dependency 决定 placement，可另提供自己的 API root |
| Placement  | 固定 `tab()` / `route()` topology；动态领域 rows 不创建 entries、producer 或 socket                    |

普通 Plugin 配置由 ConfigService/标准 UI 投影，不复制成 Content。复杂交互、lossless stream、分页、progress/cancel 使用 View，由领域 API 拥有协议。Workbench 不引入数据库查询模型、通用 collection registry 或无领域 schema 的 Vault editor。

启用后的交付固定为 Cap’n Web over WebSocket、MF2 Manifest/Snapshot 与 React Bridge。Content-only definition 不产生 MF producer；含 renderer 时必须满足完整 MF/Bridge contract。

## Definition 与 publication

- Definition 是 flat、frozen、固定键集合；entry key 与 canonical Plugin definition address 决定 identity。Attachment placement 另固定 consumer definition 与 provider descriptor。
- `workbench.entry()` / `markdown()` 使用 module-relative literal；它们是工具链 provenance，不是运行期 import/read。
- Plugin 在 `init()` 中最多 publish 一次；bindings 精确覆盖需要 binding 的 entries，纯 Markdown 不接收 binding。Part 不能直接 publish，由 owning Plugin 聚合。
- owner 从 Context 推导，publication 进入 generation effects，仅在 owner committed/running 后可见。失败启动不留下可见 entry。
- 每次 View/Attachment open 产生 fresh roots；interactive Content 由框架建立 per-open root。Factory 只得到已认证 principal、服务端重新匹配的 frozen params 与 lifetime signal。
- Factory 不获得 raw request、consumer Context 或 service locator。Root 可借用领域服务，其 observer、任务和缓存随 signal/disposer 释放。
- Attachment provider 只取得 exact consumer node address；可选 consumer root 保留自己的 owner、授权和 cleanup。两个 roots 不合并为万能 facade。

## Host HTTP 与 Shell 开发

`workbenchService()` 拥有后端；`workbenchHttp()` 只挂 Shell fallback；`managementHttp()` 唯一拥有认证、管理 session 与受保护制品。组合层通过 bindings 接入 Workbench handler，并显式声明服务准备依赖。关闭 Workbench 仍可保留 Management。

`@pluxel/workbench/dev` 的 `workbenchSourceShell({ entry })` 将源码 HTML 接入现有 Vite 图。应用拥有入口和 React/CSS 配置；附件不创建第二个 server/watcher。Shell 服务首次静态请求才加载 packaged manifest；直接创建 packaged handler 仍立即校验资源。组合用法见 [standalone host](../docs/workbench/standalone-host.md)。

## Session 与打开流程

一个 document 只有一条 `/__pluxel/runtime/session` WebSocket。Authentication challenge、ready bootstrap、Management、layout/openEntry、Content push、Plugin API 与 logs follow 共用同一 Cap’n Web object graph。Management 只借用 opaque Workbench target/disposer，不导入其实现。

写入 HttpOnly cookie 的 same-origin single-use ticket POST 与 MF 静态资源使用 HTTP；它们不承载第二套 RPC。代理须保留 cookie、Upgrade 与实例归属，HTTP 服务不从 forwarding headers 推断 physical TLS/locality。

`layoutDto({ target })` 返回 capability-free immutable snapshot：target、placement、descriptor、owner revision、pinned Content/MF reference；没有 API dictionary 或 Content plan。
`target: null` 包含全部 route placements，包括无 navigation 的参数化/standalone route，不含 tabs。Shell 据完整目录计算短路径；冲突的所有参与者回退 canonical node URL，不能 first-wins。

打开顺序：

1. `openEntry({ layoutRevision, target, descriptor, location? })` 校验 revision、identity、route 与 owner admission。
2. 静态 Content 返回 pinned plan，立即释放短 admission；不占 retained quota。
3. Interactive Content 返回 plan、portable presentation 与 fresh root；仅含 data 时订阅。
4. View/Attachment 获得 fresh root(s)，加载 pinned manifest/expose 并验证 Bridge。
5. 创建 per-open host facade，激活 Bridge；任一步失败释放全部 candidate 资源。
6. 关闭时按 Bridge destroy → host facade close → opened handle dispose 的顺序释放。

每 session 至多 64 个 retained interactive entries，factory 默认超时 15 秒。可预期 admission failure 用封闭 code；编程/transport failure 继续 reject。

认证、owner/publication、producer/Content inventory 或 socket epoch 失效会撤回 opened entries。Shell 销毁旧 UI 后完整 reload，不做 feature reconnect、页内 remote replacement 或旧 root 恢复；刷新预算见 [HMR](HMR.md#browser-update-policy)。

## Content trust boundary

Markdown 在构建时编译为有界 immutable portable AST。每个 slot 恰好放置一次；unknown/missing/duplicate/nested slot、attributes、inline action 与不安全语法均拒绝。浏览器再次验证 plan；Shell 不运行 Markdown parser、不插入 raw HTML、不加载 Plugin JS。

Publication 将真实 Valibot schema 投影为 portable presentation，验证 artifact/declaration/binding exact match。Data schema 是 transform-free display validation；action input 是 object/object-intersection form schema。服务端在 handler 前执行 budget 与 authoritative parse，schema/closure/handler/secret 不传给浏览器。

`load()` 可返回 detached readonly snapshot；服务再次校验并投影 portable value。Action input 是 parse 后的 fresh mutable `InferOutput`。确认框只防误触；handler 仍按 principal 与当前业务状态授权。

Interactive Content 的数据流固定为 subscribe-before-initial-load。`dataChanged()` 只置 dirty，框架串行 load、合并通知，推送递增 sequence 的完整最新状态；load/action 共用有界 lane。Handler 开始后总做 post-load；action-only 返回 `data: null` 且不订阅。后续 load 失败保留最近值并标 stale。Observer failure 关闭本 entry lease、abort signal、归还 quota，不影响其他 entry。

纯 Markdown 没有 binding、RPC root、retained lease、MF 或 Bridge，但仍要求 owning Plugin running。

## Content 制品与原子提交

Production Content 位于 `workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`，由 `pluxel-workbench-content.json` 索引。加载时复核 inventory、digests、canonical path 与内容；发行不依赖原 Markdown。

Static assembly、dynamic discovery 与 dev compiler 使用同一 artifact store。Mixed Content/MF candidate 必须作为完整 revision 原子提交；prepare/commit 失败保留完整 last-known-good tuple，成功才触发 session invalidation。Plan 经 `openEntry()` 返回，不增加任意 artifact fetch。

## MF2 与 React Bridge

每个 Plugin definition 的全部 renderers 合为一个 producer，每个 declaration 生成稳定 `./views/<key>` expose 与 Bridge wrapper。Content 不进入 producer；作者不指定 remote name、shared、public path 或 manifest URL。编译与缓存细节见 [TOOLCHAIN](TOOLCHAIN.md#workbench-source-declaration)。

Renderer graph 只允许一个 exact definition value-import boundary：通常是含 `createWorkbenchRenderer(Exact.entry)` 的 scope module；低层 hook 可由 default entry 拥有。其他 page/panel import scope/resource，跨 renderer 组件只接普通数据。Toolchain 改写为 browser-only descriptor projection，保留类型但不执行 server definition；indirect/dynamic/re-export 或跨 renderer scope 均拒绝。

Manifest 是唯一浏览器模块事实，Snapshot 从标准 Manifest 生成。Host 只保留 definition/revision 到 immutable artifact root 的 inventory，不复制其 assets/shared/types。Manifest、entry、exposes、types 和 shared versions 验证后才提交；HTTP 只服务已冻结的全部 regular-file digest inventory，不能把 Manifest assets 字段误当完整 import closure。

Fixed singleton set 唯一由 `@pluxel/core/federation` 定义：React/ReactDOM 及其 subpaths、Mantine Core/Hooks、MF React Bridge、Workbench 根、client、react 与 internal/react。使用 exact versions、`loaded-first`、producer `import: false`；Shell 先建立 winner，producer 不携带 fallback。其他库由 producer 自己 bundle。

Bridge ABI 位于 `@pluxel/workbench/internal/react`，每次 mount 创建独立 React root/Context，调用零 props renderer。Remote 不读取 Shell private Context。Mantine renderer 自建 Provider，module 来自 singleton、Core CSS 只由 Shell 加载；共享 module 不等于共享 React ancestry。

Dev 可先提交 topology/Content，让缺失 producer 的 placement 显示 building；后台成功提交后 full reload，失败显示安全 message，后续更新可重试。Production 必须一次性通过含 dynamic types 的完整验证，不使用这条降级路径。

## Renderer resource 与撤回

Scope/resource 是 frozen declaration，不保存当前 root 或 cache。每次 Bridge mount 创建私有 renderer owner/QueryClient；同一 descriptor 并行打开也不跨 principal、params、session、generation 共享状态。

Query result 在 cache 前完成 portable-data 校验、去 transport metadata、原地深冻结与一次 top-level result disposal；只接收有界 JSON-like plain tree。Callback 要跨调用保留时 `dup()`，subscription disposer 释放 callback 与领域注册。`createWorkbenchWatch()` 只适配 latest-state invalidation，不承担 lossless events 或业务 revision authority。

Watch 先订阅后读，single-flight 并合并读取中的通知。Mutation 每 Hook single-flight；其 typed invalidation 在调用前校验，在 owner active 的 settle 后执行，包括 reject/consume failure。权威 watch 已覆盖写入时不重复声明 invalidation。具体 options/defaults/error codes 只在[作者指南](../docs/workbench/renderer-resources.md)维护。

Owner withdrawal 关闭 invocation admission、abort open signal，等待已接纳 calls 后 drain。Bridge teardown 同时停用 Hook controls、QueryClient 与 subscription；不可取消 RPC 的晚到 DTO 仍 consume/dispose，但不得更新 React。领域错误保持原样，框架 portable/scope/key/limit/closed 等错误使用稳定 code。

Host facade 只提供 appearance、feedback、受限 relative navigation、document 状态及 Shell 显式借用的 unary Management 操作。Detached/cached management methods 同样绑定 View lifetime；它们不获得 session/socket/subscription ownership。Pane Kit 与 Shell chrome 由 [FRONTEND](FRONTEND.md)拥有。

## 实现与验证入口

| 边界                                   | 实现                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Definition / protocol / client         | `packages/workbench/src/workbench/definition.ts`、`client-protocol.ts`、`client.ts` |
| Portable value / renderer owner        | 同目录 `portable-value.ts`、`renderer-scope.tsx`、`react-internal.tsx`              |
| Registry / admission / Content         | `packages/workbench/src/services/workbench/`                                        |
| Session auth / transport               | `packages/services/src/management/web/session/`                                     |
| Lowering / Content compiler / MF build | `packages/rolldown/src/workbench/`、`src/vite/workbench-ui.ts`                      |
| Shell activation / Content UI          | `packages/workbench/shell/src/app/workbench/`                                       |

修改时验证 exact identity、静态 Content 零 retained resource、fresh roots、并行 opens 隔离、portable consumption/late results、Attachment 双 owner、Mixed artifact 原子提交、Bridge-before-handle cleanup，以及 disabled 零初始化。真实 socket、MF/browser 和制品边界不能仅用本地 target 测试代替。
