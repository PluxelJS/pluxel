# Frontend：会话、状态与资源

Workbench frontend 是一个固定 Shell，既能直接渲染 Content，也能按需加载完整 Plugin applications。业务 HTTP 与 Workbench 正交；
Workbench 不得成为 Plugin 核心能力的启动前提。

修改连接读[一个 document，一条 session](#一个-document一条-session)；修改缓存读[三类前端状态](#三类前端状态)；修改打开/关闭读 [Layout 和 entry activation](#layout-和-entry-activation)；修改布局与路由读[原生工作区与文档路由](#原生工作区与文档路由)。异步和 StrictMode 变更都需核对 [React state correctness](#react-state-correctness)。

## 固定边界

Management client/react 拥有认证会话与管理 DTO；Workbench client/react/federation 拥有 layout/opened handle、per-open renderer 和 activation。Definition、browser-safe projection、MF singleton 与 Bridge contract 统一见 [WORKBENCH](WORKBENCH.md)，本页只记录 Shell 的状态与 UI 所有权。

## 一个 document，一条 session

`client.tsx` 在 module scope 创建 document-unique `RuntimeSessionClient` 和初始 bootstrap promise，避免 React StrictMode
重复建立 physical WebSocket。`/__pluxel/runtime/session` 上依次完成：

1. authentication-required bootstrap；
2. password/TOTP/OIDC challenge；
3. authenticated ready bootstrap；
4. Management + Workbench capabilities；
5. layout/openEntry、Content push、Plugin API、logs follow 和 observer callbacks。

Workbench App 把 Workbench capability 视为硬要求；management-only bootstrap 不能渲染一个“部分可用”的 Shell。
认证 authority、publication inventory 或 socket epoch 失效时，页面销毁当前 UI 并要求完整 reload。没有 feature reconnect、
旧 root恢复或备用 API transport。

MF manifest、JS/CSS、字体/图片等静态文件仍走 HTTP；Content plan 随现有 `openEntry()` RPC 返回，不增加 artifact
HTTP fetch。浏览器提交 single-use ticket 写入 `HttpOnly` cookie 也使用一个 fixed same-origin POST。这些 HTTP 端点不承载
Management 或 Plugin RPC。

## 三类前端状态

同一个 document 共用一条 Cap’n Web session，不代表所有 React 状态共享 owner、cache 或更新协议。Frontend 按事实分成三层：

| 状态                      | 生命周期                       | 实现                                                                         | 不负责                                              |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Shell local UI            | document / workspace           | FlexLayout Model、Worksplit 文档协调、React 局部状态                         | RPC cache、capability ownership                     |
| Shell Management snapshot | authenticated document session | Shell 私有 `@tanstack/react-query` `QueryClient` + `RuntimeManagementClient` | descriptor/scope provenance、per-open root disposal |
| Plugin renderer resource  | 单次 `openEntry()` / Bridge    | `createWorkbenchRenderer()` 创建的 per-open owner，内部使用 Query Core       | Shell workspace、跨 open cache                      |

Shell 不复用 Plugin renderer adapter，也不伪造 descriptor 或 opened owner。`RuntimeManagementClient` 已经负责 Cap’n Web
result 的 transport 元数据移除与释放；领域 parser 验证原树并直接构造最终 frozen snapshot，只有不透明数据叶子需要独立复制。React Query 只负责本地 DTO 的去重、缓存、竞态隔离、loading/error
状态和失效。Query cache 中禁止存放 `RpcStub`、opened handle、subscription 或其他需要显式释放的对象。

Shell 的 QueryClient 与 authenticated session 同寿命，在 `App` 内创建，session epoch 销毁时整体清空。Query key 统一从
`managementQueryKeys` 生成，并使用 canonical node identity。默认 `retry: false`、`networkMode: 'always'`、
`refetchOnReconnect: false`；浏览器 online 状态不能代表现有 WebSocket 可用，socket broken 仍由 session gate 要求完整 reload。
普通 snapshot 允许 stale window 与 window-focus refresh。Mutation 按实际受影响的 read model 精确失效；若写入结果为
`unknown` 或 transport 在提交后断开，则先取消旧 fetch，再等待 authoritative refetch，不能让 mutation 前的晚到结果成为最终状态。

共享 transport 也不等于 snapshot 自动实时。当前 Management 普通读取没有统一 change feed，实时一致性来自本地 mutation
invalidation、显式刷新与 focus freshness；不能用短轮询冒充 WebSocket push。只有具备权威变更源与单调 revision 的领域才应增加
push invalidation。Plugin snapshot/watch 继续 subscribe-before-read，日志等有序连续流继续使用专用协议、gap recovery 与有界
buffer；layout、Content controller、entry activation、workspace draft 也不进入 React Query。

## Layout 和 entry activation

Workbench layout 是 capability-free immutable snapshot。它包含 target、placement、openable identity、owner revisions 和
discriminated pinned Content/MF reference，不包含 Content plan 或任意 Plugin API dictionary。

Shell 打开页面时执行一个原子 activation：

```text
current layout entry
  -> openEntry(expected layout revision)
  -> static Content: validate portable plan -> Shell render
  -> interactive Content: validate plan/presentation -> subscribe only when it has data -> Shell render
  -> federated View: fresh root(s) -> pinned MF/Bridge activation
```

纯 Markdown Content open 只做短 owner admission；返回 immutable plan 后立即释放，不创建 imperative root、MF/Bridge 或
server-side opened lease。Interactive Content 保留一个 framework-owned root；Federated View 只有整个 tuple 成功才成为 active：

```text
target node + owner generation lease
+ layout/publication revision + descriptor identity
+ producer build revision + expose
+ opened root(s) + one Bridge instance
```

失败 candidate 会 destroy Bridge（若已创建）、关闭 host facade，并 dispose single-owner opened handle。关闭 active
View 的顺序同样固定为 Bridge destroy → host facade close → opened handle dispose。旧 renderer 不能接新 roots，新 renderer
也不能接旧 roots。

## Renderer

Content renderer 只消费 client boundary 二次验证后的封闭 AST/presentation，并以 React semantic elements 输出。Text 由 React escaping；
没有 raw HTML、runtime Markdown parser、图片或 Plugin component。Fragment DOM id 用每个 mounted Content 的 `useId()` scope，
同一文档打开多次也不会碰撞。

含 data 的 Content 先 subscribe，再按 sequence 接受 callback、manual load 与 action 的 full-state outcome；action-only Content 不创建
observer。初始失败显示 retry，已有 data 后失败保留值并标记 stale。当前 action control 在 pending 时禁用，跨 control 重叠由 server
lane 返回 busy；带 `confirm` 文案的 action 先用 host confirm。Dialog/embedded form 复用 Config portable field adapter 与 `AutoForm({ fields })`，server
validation issues 映射到字段；validation/domain/unexpected failure 保留 draft，成功清理。Content close 后 observer 和 late unary result
都不能更新 React state。

Renderer 每次 Bridge mount 都有独立 owner 与 cache；Shell 不共享其 QueryClient，也不把 transport-owned capability 放入 React state。公开 resource API、Provider/CSS 与 DTO consumption 见 [renderer resources](../docs/workbench/renderer-resources.md)；其生命周期约束见 [WORKBENCH](WORKBENCH.md#renderer-resource-与撤回)。

## Host facade

Remote 只得到固定 appearance、feedback、受限 relative navigation、document 状态与显式借用的 unary Management 操作。Navigation/document 不适用时为 null；路径必须通过规范形式校验，dirty/title registration 随 per-open handle 撤销。它不取得 raw socket、MF Runtime、Shell store 或私有 Provider。

公开 navigation facade 校验规范路径，不接受 query/hash。目标 frame 由当前完整 committed directory 和 canonical URL 决定，
不能只检测 `workbench-standalone` 前缀，也不能由 `openDocument()` 强制覆盖成 shell。文档标题和 `meta` 直接写入原生 Model 的
`name` / `helpText`，检查 Action 回执；View 只在自己首次覆盖时借用当前原生值用于撤销，不能把打开前的过期标题写回新页面。

## 原生工作区与文档路由

已认证 browser document 持有一个 `WorkspaceSession`，Shell 借用其中的 Worksplit 实例。一个 FlexLayout Model 是标签、TabSet、
TabGroup、Border、顺序、pin、分隔线和最大化的唯一事实来源；Worksplit 拥有文档身份、独立 Router/history、复用、MRU 和关闭协调。
业务 dirty、revision、draft 和保存结果属于具体文档。没有另一个 tabs/grid store，也不把只读投影反向同步到 Model。

每个文档通过 `createAppRouter({ history })` 消费同一份生成的 route tree，history 由 Worksplit 提供且仅在内存中记录。
route tree 只渲染内容，不创建递归 Shell；Management、Product、Mantine 和 session providers 位于文档 Router 之外。
工作区浏览器地址只由 Worksplit 的 `connectBrowser()` 写入，固定工具获得焦点时保留活动文档 URL。
文档地址取自 TanStack 的 `publicHref`，包含实际 UI basepath；路由匹配仍使用 Router 的内部路径。
Shell 导航把内部路径、解析后的 search 与 hash 交给 Worksplit 的 TanStack `open()`；公开 href 留给浏览器导航，不能再作为 `to` 重复添加 basepath。
恢复后的惰性文档也用同一 Router parser 识别身份，不能按公开 URL 手工剥离 basepath 或拼接第二份路径。
`frame: standalone` 从页面入口分流，用完整页面导航跨越工作区边界；它的 browser Router 不与工作区 history 同时运行。

普通打开按 Worksplit 身份规则复用已有文档，显式新实例产生独立 Router 和 opened owner。插件的 `tab()` publication 从详情页打开为
独立文档，URL 用 canonical descriptor key 标识入口；publication group 是业务导航分类，与原生 TabGroup 不共享状态。
新文档的默认名称只从完整 committed publication 读取 tab label/key、相同 canonical owner 的 displayName 或 compiled route title，
不能借用其他 fork 或未发布 owner 的名称。首次 start 和普通打开使用同一只读选择；复用、恢复和已提交的 Host/F2 名称以原生 Model 为准，不重新投影覆盖。
跨 TabSet/Border 移动、pin、分组、折叠和最大化保留内容实例；真正关闭或 route 替换才进入原有 activation cleanup。

原生 `onContextMenu` 和 `onShowOverflowMenu` 由 Shell 呈现，菜单保留 React Provider ancestry，并通过 `workbench.dispatch()`
提交原生 Actions、检查实际回执。Native builder 的批量可见标签操作不包含折叠组的隐藏成员；文案明确范围。
完整容器关闭和纯删除 Action group 由 Worksplit 一次预检内容守卫，守卫拒绝时不逐个删除。输入、菜单状态和主题属于 Shell 局部状态。

布局持久化保存 Worksplit snapshot，包括原生 Model 和文档恢复信息，不保存 RPC handle、Router、业务 draft 或服务对象。
恢复仍需验证 workspace、结构与实际 publication/权限；坏快照保留现场，修复或重置必须显式执行。
已保存的原生节点必须包含明确的 `type` 和容器 `children`，不能把缺损快照交给 Model 补齐为默认布局；
只有代码中的初始 `layout` 可以采用原生可选字段的缺省值。
使用新的存储 key，旧 workspace 格式不恢复；没有兼容 reader、启动迁移或两种格式双写。
存储不可用不阻塞打开和编辑，但须提供可发现的错误反馈。恢复后台标签不会立即为所有插件发起 open RPC。

`WorkspaceSnapshotStorage` 使用 `pluxel:worksplit:1:${uiBasePath}` key，按当前浏览器 origin 与 UI basepath 隔离布局。
连续变化合并写入，`pagehide`、页面隐藏与 teardown 补写待保存快照；序列化结果相同不重复写盘。
快照读取/结构校验失败不会写回默认值；显式恢复默认布局先请求关闭文档，解除固定与关闭保护后才写入默认快照并完整导航。
这些行为不保证强制终止浏览器或存储故障时的数据持久性。

Remote 不 import Worksplit、Shell router 或布局 store。Renderer 内容使用普通 CSS Flex/Grid、Mantine 组件和容器响应式布局；
独立停靠页面通过 publication 声明。公开 Bridge 不传入宿主布局 renderer，内容局部布局不再建立独立宿主分区协议。
站外链接、下载、修饰键和新窗口行为交给浏览器。单个文档错误由其 Router 边界显示并允许重试，不卸载其他文档或全局 Shell。

## Module Federation policy

每 document 只有一个 MF Runtime。Shell 建立 fixed shared winners 后才按需加载 exposes；未打开的 View 不请求其 expose，Content-only 不产生 producer。完整 shared、CSS、candidate 与更新契约见 [WORKBENCH](WORKBENCH.md#mf2-与-react-bridge)。Frontend 不实现页内 revision swap 或 old-remote fallback。

## 内置编辑器滚动与目录

插件详情用普通 Mantine Tabs 组织配置、概览、依赖、日志和日志级别；每个内容区域有受限高度的滚动容器。
本地业务选项卡不创建新的 editor group 或宿主分区，publication 页面从入口按钮进入独立工作区文档。
FormToc 与 ContentOutline 只读取对应文档内的 config anchors / Markdown headings，不扫描其他编辑器或 federated renderer DOM。
目录是否可用由实际 anchors 决定，不靠 scrollHeight，也没有跨文档目录 claim 或右侧 portal registry。

## React state correctness

- module-scoped session 和 bootstrap promise 保证 StrictMode 不重复连接；
- Shell 与共享 session providers 在工作区导航时保留；每个文档独立 Router/error boundary，不能用活动 pathname key 重建整棵应用；
- Plugin detail 表单与视图属于具体文档和 canonical node，相同插件的并行文档不共享 draft；
- WorkspaceSession 在已认证入口创建，Shell effect replay 不新建实例；最终 teardown dispose Worksplit，再释放其中的内容 owner；
- Content/View activation 和 handle/Bridge cleanup 用 mount count + microtask cleanup 吸收 effect replay；
- `useRemoteValue` render 只构造本地 store，commit 才订阅/读取；依赖切换隔离 owner，effect replay 复用资源，晚到订阅仍需释放；
- 跨组件共享事实使用 `subscribe/getSnapshot` store；
- 空 array/object 和 Context value 保持稳定 identity；
- Content state 与 remote read 使用 sequence/epoch guard，旧结果不覆盖新 target/route；
- renderer query/mutation cache 属于 per-open owner，StrictMode replay 不重复 subscription，teardown 后 late result 只释放不提交；
- structured query key canonicalize 后才进 cache，typed invalidation 只解析当前 renderer scope 的 resource；
- mutation per-hook single-flight，并在 active owner 中于 settle 后执行预先验证的 invalidation；
- mutation handler 显式 await/catch 或用 `void` 表达有意忽略；
- UI state 永不保存已释放的 Cap’n Web proxy。

## 实现入口

- `packages/workbench/shell/src/client.tsx`
- `packages/workbench/shell/src/app/managementQuery.tsx`
- `packages/workbench/shell/src/workbench/client.ts`
- `packages/workbench/shell/src/workbench/runtime.tsx`
- `packages/workbench/shell/src/app/workbench/`
- `packages/workbench/shell/src/app/workbench/session.tsx`
- `packages/workbench/shell/src/app/workbench/document.tsx`
- `packages/workbench/shell/src/app/workbench/snapshot.ts`
- `packages/workbench/shell/src/app/router/`
- `packages/services/src/management/web/session/`
- `packages/workbench/src/workbench/client.ts`
- `packages/workbench/src/workbench/portable-value.ts`
- `packages/workbench/src/workbench/react.tsx`
- `packages/workbench/src/workbench/renderer-scope.tsx`
- `packages/workbench/src/workbench/react-internal.tsx`
- `packages/workbench/src/workbench/federation.ts`
- `packages/workbench/shell/src/app/workbench/WorkbenchContentRenderer.tsx`

## 验证

Shell 测试位于 `packages/workbench/shell/`，client/resource 测试位于 `packages/workbench/tests/`。覆盖 StrictMode 单连接、query cache 不持有 capability、旧请求不覆盖 mutation 后权威快照、每次 open 独立资源、late result 只释放不提交，以及 Bridge → facade → handle 关闭顺序。

浏览器回归验证真实 session epoch/full reload、MF/React root 隔离、单一 browser history 所有者、多个独立文档 Router、布局持久化、原生菜单/拖拽/分组/焦点与窄窗口可达性。只改纯状态算法时用所属状态模块测试；真实连接、Bridge/CSS 或资源泄漏不能以纯状态测试代替。

本次原生工作区迁移的测试映射、真实浏览器与在线回执、库阻塞修复和未验证范围见 [FlexLayout 验收记录](WORKBENCH_FLEXLAYOUT_VALIDATION.md)。该记录描述对应轮次的证据，不另定义当前 API。
