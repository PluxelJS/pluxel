# Frontend Architecture

Workbench frontend 是一个固定 Shell，既能直接渲染 Content，也能按需加载完整 Plugin applications。业务 HTTP 与 Workbench 正交；
Workbench 不得成为 Plugin 核心能力的启动前提。

## 固定边界

- `@pluxel/runtime/web`：portable Runtime session、Management API 与严格校验的 DTO；
- `@pluxel/runtime/web/react`：Management client 的 React Context adapter；
- `@pluxel/runtime/workbench`：Content/View/Attachment definition；
- `@pluxel/runtime/workbench/client`：layout、portable Content plan/presentation 与 opened entry handle validation；
- `@pluxel/runtime/workbench/react`：descriptor-bound renderer scope、query/mutation、低层 exact descriptor hook、host facade 和 Pane Kit；
- `@pluxel/runtime/workbench/federation`：Shell-owned MF Runtime 和 View activation orchestration。
- `@pluxel/runtime/internal/workbench-react`：toolchain-generated React Bridge wrapper ABI，不是作者入口。

普通 Plugin UI 的 renderer-specific `*.scope.ts(x)` 是唯一可以 value-import 自己 Workbench definition 的 module；renderer graph
内的 page/panel 只 import scope/resource，跨 renderer shared component 只接收普通 props/data。低层
`useWorkbench(exactDescriptor)` renderer 可改由 default entry 作为唯一 direct definition boundary。Browser contract 可以
type-only import。UI 不能 import Plugin implementation、Context、database schema/handle、Node builtin 或 secret。Toolchain
独立构建每个含 renderer 的 Plugin definition 的 UI producer，验证 scope/entry 绑定 exact descriptor，并把该 import 改写成
browser-only projection。Projection 保留 exact View/Attachment API types，但 generated JS 不执行 source definition，也不把同一
definition 中 Content 的 schema、handler 或 server imports 带进 browser graph。Content Markdown 在 build time 降为 portable
plan，也不进入 browser module graph。

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
result 的 wire validation、portable copy 与 top-level disposal；React Query 只负责本地 DTO 的去重、缓存、竞态隔离、loading/error
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

每个 expose 是标准 React Bridge application。Toolchain 生成 wrapper，wrapper 把 opened handle 和 host facade 放入
per-Bridge React Context，再渲染 Plugin 默认导出的零 props component。Plugin 用 renderer-specific scope 绑定默认 entry：

```tsx
// settings.scope.ts
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { SettingsWorkbench } from '../workbench.js'

export const settingsScope = createWorkbenchRenderer(SettingsWorkbench.settings)
export const settingsQuery = settingsScope.query(({ api }) => ({
	queryKey: ['settings', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

// settings.tsx
import { SettingsPage } from './settings-page.js'
import { settingsScope } from './settings.scope.js'

export default settingsScope.render(SettingsPage)
```

Scope/resource 是 module-scoped declaration；每次 `render()` Bridge mount 创建独立 renderer owner 和私有 Query Core client，
持有当前 exact roots/host、subscription 与 close state。相同 descriptor 或 parameterized route 同时打开多次，也不会跨
handle、params、principal、session 或 owner generation 共享 cache。Query result 在进入 cache 前完成 portable validation、
deep copy/freeze 和 top-level result disposal；带 watch 的 snapshot 必须 subscribe-before-read，读取期间的 invalidation 合并成
一次 follow-up。Renderer close 停用 controls、subscription 和 cache，晚到 RPC 只完成 detach/dispose，不能提交 React state。

公开 query/mutation options、默认值、错误码、inactive controls 与 typed invalidation 只由
[`docs/workbench/index.md`](../docs/workbench/index.md) 定义；本文件不重复维护作者 API 教程。Frontend 实现只要求这些公共语义
映射到 per-open owner，且不向 Remote 暴露 raw QueryClient、cache、socket 或 document-global client。

`useWorkbench(exactDescriptor)` 同时完成 TypeScript API 推导和 runtime declaration identity 校验，并与
`useRemoteValue()` / `createRemoteValue()` 一起保留为高级 escape hatch。后两者仍是 Plugin-owned `read()`/`watch()` 的小型
client snapshot owner：

- 先建立 optional subscription，再首次读取，避免初始窗口丢失 invalidation；
- 合并 reading 期间的 invalidation；
- error 不引入自动 reconnect 或全局 cache；
- dispose subscription 并拒绝 late read 覆盖；
- awaited object DTO 使用 `detachWorkbenchPortableValue()` 校验、深拷贝并释放 transport result。

Plugin 可以围绕自己的 API 写领域 callback、progress/cancel 或 lossless stream helper，但 Workbench 不提供查询语言、
跨 renderer cache、collection store 或通用 event model。Remote 不取得 wrapper props、raw socket、MF Runtime、Shell
router/store 或官方 App private Context。

## Host facade

Remote 只得到：

- appearance：`locale`、`colorScheme`；
- feedback：`notify()`、`confirm()`；
- relative navigation：`navigate()`、`openDocument()`；
- parameterized document：server-matched params、dirty marker、display title；

`navigation` 和 `document` 在不适用的 frame 中为 `null`。所有 path 都重新规范化，Remote 不能导航任意宿主 URL。
Document dirty/title registration 属于 per-open host handle；View close 时幂等撤销。

## Pane Kit 与 Workspace

Remote 需要 navigation/primary/inspector 三栏时，使用 `WorkbenchPaneLayout` / `WorkbenchPane`。Plugin 只声明
稳定 ID、role、尺寸约束和内容；Shell 拥有 split driver、responsive drawer、keyboard、focus 和 workspace persistence。
每种 role 最多一个，并且恰好有一个 primary。容器宽度变化不卸载 pane children。

官方 Shell 将当前标签页的 Pane Kit 控件放入头部：navigation 与 inspector 各自切换，中央控件聚焦 primary 或恢复
先前的周边 pane。primary 永远可见，不能被这个或任何其他控件隐藏；窄屏仍使用同一状态的 responsive drawer。
Plugin 不复制这组 chrome，也不把宿主私有的 plugin rail、assist 或 bottom dock 误当作 Pane Kit role。

`split-like-vscode` 是独立 UI library，不知道 Plugin、View、route 或 persistence。Pluxel adapter 收敛在
`packages/workbench-app/src/app/workbench/split/`。Remote bundle 不 import Worksplit、宿主 router、split adapter 或
workspace store。

Workspace controller 独立拥有 tabs、editor groups、focus 和递归 grid。URL 只镜像 focused document；打开同一完整
document path 会聚焦已有 tab。Plugin 不感知 tab group、drag/drop 或 split topology。

## Module Federation policy

每个 Workbench document 只有一个 MF Runtime。Shell 先建立 exact singleton shared winners，再以 `loaded-first` 按需注册 producer：

- React/ReactDOM 及其实际 subpaths；
- `@mantine/core`、`@mantine/hooks`；
- `@module-federation/bridge-react`；
- `@pluxel/runtime/workbench`、`/client`、`/react`。
- `@pluxel/runtime/internal/workbench-react`。

Plugin 不能修改 share scope、runtime plugin、manifest resolution 或 fallback。Mantine 基础 CSS 由 Shell 唯一加载，remote
只创建自己的 `MantineProvider`；producer 不得重复导入 Core stylesheet。其他 UI/领域依赖由 producer 自己 bundle。
未打开 View 不请求其 expose；一个 Plugin definition 的多个 Views 共用 producer，但按 expose/chunk 延迟加载。
Content-only Plugin 没有 producer，不参与 shared compatibility 或 Bridge activation。
`@tanstack/query-core` 是 renderer owner 的内部实现依赖，不进入这个 fixed shared set。

Development Content/UI update 先发布 topology/Content；缺失 producer 在后台构建，未就绪 View 保留 layout 位置并显示
building 状态。后台 producer 成功后提交完整 tuple 并触发完整 document reload；失败不推进 producer inventory，而是
显示 failed 状态和安全错误 message。Production/static build 仍要求完整 immutable candidate 一次性通过验证。Frontend 不实现
页内 remote revision swap 或 last-known-old fallback。

## React state correctness

- module-scoped session 和 bootstrap promise 保证 StrictMode 不重复连接；
- layout runtime、Content/View activation 和 handle/Bridge cleanup 用 mount count + microtask cleanup 吸收 effect replay；
- 跨组件共享事实使用 `subscribe/getSnapshot` store；
- 空 array/object 和 Context value 保持稳定 identity；
- Content state 与 remote read 使用 sequence/epoch guard，旧结果不覆盖新 target/route；
- renderer query/mutation cache 属于 per-open owner，StrictMode replay 不重复 subscription，teardown 后 late result 只释放不提交；
- structured query key canonicalize 后才进 cache，typed invalidation 只解析当前 renderer scope 的 resource；
- mutation per-hook single-flight，并在 active owner 中于 settle 后执行预先验证的 invalidation；
- mutation handler 显式 await/catch 或用 `void` 表达有意忽略；
- UI state 永不保存已释放的 Cap’n Web proxy。

## 实现入口

- `packages/workbench-app/src/client.tsx`
- `packages/workbench-app/src/app/managementQuery.tsx`
- `packages/workbench-app/src/workbench/client.ts`
- `packages/workbench-app/src/workbench/runtime.tsx`
- `packages/workbench-app/src/app/workbench/`
- `packages/runtime/src/web/session/`
- `packages/runtime/src/workbench/client.ts`
- `packages/runtime/src/workbench/portable-value.ts`
- `packages/runtime/src/workbench/react.tsx`
- `packages/runtime/src/workbench/renderer-scope.tsx`
- `packages/runtime/src/workbench/react-internal.tsx`
- `packages/runtime/src/workbench/federation.ts`
- `packages/workbench-app/src/app/workbench/WorkbenchContentRenderer.tsx`
