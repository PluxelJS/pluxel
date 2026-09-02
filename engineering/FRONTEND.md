# Frontend Architecture

Workbench frontend 是一个固定 Shell，既能直接渲染 Content，也能按需加载完整 Plugin applications。业务 HTTP 与 Workbench 正交；
Workbench 不得成为 Plugin 核心能力的启动前提。

## 固定边界

- `@pluxel/runtime/web`：portable Runtime session、Management API 与严格校验的 DTO；
- `@pluxel/runtime/web/react`：Management client 的 React Context adapter；
- `@pluxel/runtime/workbench`：Content/View/Attachment definition；
- `@pluxel/runtime/workbench/client`：layout、portable Content plan/presentation 与 opened entry handle validation；
- `@pluxel/runtime/workbench/react`：exact descriptor hook、host facade 和 Pane Kit；
- `@pluxel/runtime/workbench/federation`：Shell-owned MF Runtime 和 View activation orchestration。
- `@pluxel/runtime/internal/workbench-react`：toolchain-generated React Bridge wrapper ABI，不是作者入口。

完整 Plugin UI source value-import 自己的 Workbench definition，并只从 `@pluxel/runtime/capnweb` import browser-safe API
types。它不能 import Plugin implementation、Context、database schema/handle、Node builtin 或 secret。Toolchain 独立构建
每个含 renderer 的 Plugin definition 的 UI producer并验证这条反向依赖边界。Generated Bridge 和 renderer descriptor
projection 只保留 View identity，不把同一 definition 中 Content 的 schema、handler 或 server imports 带进 browser graph。
Content Markdown 在 build time 降为 portable plan，也不进入 browser module graph。

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
per-Bridge React Context，再渲染 Plugin 默认导出的零 props component。

```tsx
export default function Settings() {
	const { api, host } = useWorkbench(SettingsWorkbench.main)
}
```

`useWorkbench(exactDescriptor)` 同时完成 TypeScript API 推导和 runtime declaration identity 校验。Remote 不取得
wrapper props、raw socket、MF Runtime、Shell router/store 或官方 App private Context。

`useRemoteValue()` / `createRemoteValue()` 只是 Plugin-owned `read()`/`watch()` 的小型 client snapshot owner：

- 先建立 optional subscription，再首次读取，避免初始窗口丢失 invalidation；
- 合并 reading 期间的 invalidation；
- error 不引入自动 reconnect 或全局 cache；
- dispose subscription 并拒绝 late read 覆盖；
- awaited object DTO 使用 `detachWorkbenchPortableValue()` 校验、深拷贝并释放 transport result。

Plugin 可以围绕自己的 API 写更复杂的 React helper，但 Workbench 不提供查询语言、collection store 或通用 event model。

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
- mutation handler 显式 await/catch 或用 `void` 表达有意忽略；
- UI state 永不保存已释放的 Cap’n Web proxy。

## 实现入口

- `packages/workbench-app/src/client.tsx`
- `packages/workbench-app/src/workbench/client.ts`
- `packages/workbench-app/src/workbench/runtime.tsx`
- `packages/workbench-app/src/app/workbench/`
- `packages/runtime/src/web/session/`
- `packages/runtime/src/workbench/client.ts`
- `packages/runtime/src/workbench/react.tsx`
- `packages/runtime/src/workbench/react-internal.tsx`
- `packages/runtime/src/workbench/federation.ts`
- `packages/workbench-app/src/app/workbench/WorkbenchContentRenderer.tsx`
