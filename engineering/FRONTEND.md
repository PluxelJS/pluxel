# Frontend：会话、状态与资源

Workbench frontend 是一个固定 Shell，既能直接渲染 Content，也能按需加载完整 Plugin applications。业务 HTTP 与 Workbench 正交；
Workbench 不得成为 Plugin 核心能力的启动前提。

修改连接读[一个 document，一条 session](#一个-document一条-session)；修改缓存读[三类前端状态](#三类前端状态)；修改打开/关闭读 [Layout 和 entry activation](#layout-和-entry-activation)；修改布局读 [Pane Kit 与 Workspace](#pane-kit-与-workspace)。异步和 StrictMode 变更都需核对 [React state correctness](#react-state-correctness)。

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
| Shell local UI            | document / workspace           | React state、TanStack Store、专用 controller                                 | RPC cache、capability ownership                     |
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

Remote 只得到固定 appearance、feedback、受限 relative navigation、document 状态与显式借用的 unary Management 操作。Navigation/document 不适用时为 null；路径重新规范化，dirty/title registration 随 per-open handle 撤销。它不取得 raw socket、MF Runtime、Shell store 或私有 Provider。

## Pane Kit 与 Workspace

Remote 需要 navigation/primary/inspector 三栏时，使用 `WorkbenchPaneLayout` / `WorkbenchPane`。Plugin 只声明
稳定 ID、role、尺寸约束和内容；Shell 拥有 split driver、responsive drawer、keyboard、focus 和 workspace persistence。
每种 role 最多一个，并且恰好有一个 primary。容器宽度变化不卸载 pane children。

官方 Shell 将当前标签页的 Pane Kit 控件放入头部：navigation 与 inspector 各自切换，中央控件聚焦 primary 或恢复
先前的周边 pane。primary 永远可见，不能被这个或任何其他控件隐藏；窄屏仍使用同一状态的 responsive drawer。
Plugin 不复制这组 chrome，也不把宿主私有的 plugin rail、assist 或 bottom dock 误当作 Pane Kit role。

`split-like-vscode` 是独立 UI library，不知道 Plugin、View、route 或 persistence。Pluxel adapter 收敛在
`packages/workbench/shell/src/app/workbench/split/`。Remote bundle 不 import Worksplit、宿主 router、split adapter 或
workspace store。

Workspace controller 独立拥有 tabs、editor groups、focus 和递归 grid。URL 只镜像 focused document；打开同一完整
document path 会聚焦已有 tab。Plugin 不感知 tab group、drag/drop 或 split topology。

Shell 的路由适配与错误边界集中在 `app/router/`。链接由 workspace navigation 统一处理去重和编辑组聚焦；站外链接、下载、
修饰键和新窗口行为交给浏览器。单个 document 的渲染错误由自己的边界显示并允许重试，不卸载其他编辑区或全局 Shell。

Workspace persistence 只订阅 `uiState`，不因 transient dirty markers 写盘或触发 React 重渲染。连续变化合并为一次 idle/timeout
写入，写入时读取最新且经过持久化清洗的状态；`pagehide`、页面隐藏与 teardown 会补写尚未保存的变化。序列化结果相同时不重复写盘，
存储不可用不阻塞工作台；这不是对浏览器强制终止或存储故障的数据持久性保证。

## Module Federation policy

每 document 只有一个 MF Runtime。Shell 建立 fixed shared winners 后才按需加载 exposes；未打开的 View 不请求其 expose，Content-only 不产生 producer。完整 shared、CSS、candidate 与更新契约见 [WORKBENCH](WORKBENCH.md#mf2-与-react-bridge)。Frontend 不实现页内 revision swap 或 old-remote fallback。

## 内置编辑器滚动与目录

中部、概览和底部各自拥有受限高度的滚动容器，页签栏不参与滚动。概览与目录是右侧独立视图；目录搜索框固定，列表滚轮不向外传播。

目录是否可用由当前编辑器的 config anchors / Markdown headings 决定，不靠 scrollHeight。非活动编辑器撤回目录 claim，portal 只属于当前 Plugin Workbench。FormToc 与 ContentOutline 只读取自己的文档，不扫描其他编辑器或 federated renderer DOM。

## React state correctness

- module-scoped session 和 bootstrap promise 保证 StrictMode 不重复连接；
- 正常路由切换保留根错误边界、Shell 与 session providers；错误恢复按 pathname 清空 error，不能用 pathname key 重建整棵应用；
- Plugin detail 只按 canonical node route 重置 owner-local 表单与视图，同一 Plugin 的子路由不重置整个 Plugin 工作台；
- layout runtime、Content/View activation 和 handle/Bridge cleanup 用 mount count + microtask cleanup 吸收 effect replay；
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

浏览器回归验证真实 session epoch/full reload、MF/React root 隔离、布局持久化、键盘焦点与窄屏 Pane 行为。只改纯状态算法时用所属 store/controller 测试；真实连接、Bridge/CSS 或资源泄漏不能以纯状态测试代替。
