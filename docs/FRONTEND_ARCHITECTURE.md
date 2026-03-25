# Frontend Architecture

这份文档只解释一件事：Pluxel 当前插件前端架构是如何从 `ctx.ext`、authoring bridge、HMR、MF2 build 一直到 runtime 消费串起来的。

目标不是罗列 API，而是把设计意图说清楚，让人和 LLM 都能直接判断：

- 这一层负责什么
- 不负责什么
- 为什么要这样拆
- 某段逻辑应该写在哪一层

## 一句话模型

Pluxel 的插件前端分成三段：

1. authoring
   插件作者写 `ui('./ui/index.tsx').bind(ctx)` 和 `definePluginUIModule(...)`
2. dev/build
   `@pluxel/hmr` 在开发期消费源码入口并编译；build 期把 authoring bridge 重写成 runtime 语义
3. runtime
   `@pluxel/runtime` 只消费编译后的 MF remote 和宿主渲染 doc/builtin 扩展

`Module Federation 2` 在这里的角色很明确：

- 它是插件 UI 的 **remote artifact format + runtime loading protocol**
- 它不是作者 API
- 它不是 HMR authoring API
- 它不是 runtime 的配置中心

## 必记约定

如果只想先记住当前“唯一推荐写法”，直接记这几条：

- 作者侧源码声明：
  从 `@pluxel/hmr/plugin` 导入 `ui` / `worker`
- 浏览器插件 UI：
  从 `@pluxel/runtime/web/ui` 导入 `definePluginUIModule(...)` 与 `createPluginUi(...)`
- 运行时注册：
  后端统一走 `ctx.ext.rpc / sse / signaldb / ui`
- build 产物：
  `ui(...).bind(ctx)` 最终必须降成 `ctx.ext.ui.packaged()`
- 正式 i18n：
  统一走 `@inlang/paraglide-js`，路径约定是 `project.inlang` + `messages/` -> `src/paraglide/`

这些约定不是“示例代码偏好”，而是当前整套前端链路的固定契约。

## 角色表

把整条链路压成一句话容易，但落到实现时最容易混掉的是“谁拥有哪段语义”。当前建议直接按下面这张表记：

| 层 | 主要入口 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| authoring | `ui('./ui/index.tsx').bind(ctx)` / `definePluginUIModule(...)` | 给插件作者稳定声明入口；给 HMR / AST rewrite 一个可识别锚点 | 不直接注册 runtime remote；不要求作者写 MF 配置 |
| dev / HMR | `@pluxel/hmr` | watch 源码、编译插件 UI、把 dev 产物提交给 runtime | 不定义 runtime 协议；不要求 runtime 理解源码 |
| build | `@pluxel/build` + `@pluxel/hmr/plugin-build` | 把 authoring bridge 降成 runtime 语义，并产出 MF2 remote | 不保留 dev handle；不把 `entryPath` 带进最终运行时 |
| runtime | `ctx.ext.*` | 注册运行时交互能力与已编译 UI remote / host-rendered doc | 不消费 authoring bridge；不编译源码 |
| browser host | federation runtime + plugin UI registry | 加载 remote、解析 extension surface、渲染插件 UI | 不知道源码声明长什么样 |

## 设计目标

当前架构追求四件事：

- runtime 不理解源码入口
- HMR 语义和 runtime 语义严格分开
- 插件 UI build 产物是稳定的 MF2 remote，不依赖 dev host
- 宿主渲染 doc/builtin 不需要插件再注册一套自定义前端

这意味着：

- dev 可以快改、快编译、快替换
- runtime 可以只看编译后结果
- 插件作者不需要把 HMR 元信息塞进插件元数据
- 文档型前端和完整自定义前端可以并存

## 1. `ctx.ext`

`ctx.ext` 是插件后端暴露“前端相关能力”的唯一入口。

当前有四层：

- `ctx.ext.rpc`
  给自定义 UI 暴露 RPC
- `ctx.ext.sse`
  给自定义 UI 暴露 SSE
- `ctx.ext.signaldb`
  给自定义 UI 和宿主渲染 doc 提供统一的状态同步 collection
- `ctx.ext.ui`
  注册编译后的 UI remote，或注册宿主渲染的 builtin/doc 扩展

这四层故意没有合并成一个“大一统前端注册器”，原因是它们语义不同：

- `rpc/sse/signaldb` 是运行时数据与交互通道
- `ui` 是前端呈现的注册入口

### 前后端交互通道

从“插件后端”和“浏览器插件前端”之间如何通信来看，当前系统有四条通道：

| 通道 | 后端入口 | 浏览器侧入口 | 适合什么 | 不适合什么 |
| --- | --- | --- | --- | --- |
| RPC | `ctx.ext.rpc.expose(...)` | `createPluginUi(...).use*().rpc` | 明确命令式动作、一次请求一次结果、需要返回值或报错 | 连续状态同步、高频流 |
| SSE | `ctx.ext.sse.expose(...)` | `createPluginUi(...).use*().sse` | 流式事件、进度推送、高频通知 | 结构化状态读写 |
| SignalDB | `ctx.ext.signaldb.collection(...)` | `useCollection()` / `useDoc()` | 结构化状态同步、前后端同构 collection、doc/builtin state/action | 复杂命令式副作用语义 |
| UI | `ctx.ext.ui.packaged()` / `ctx.ext.ui.doc(...)` | 宿主 plugin UI registry | 注册“怎么展示” | 数据同步本身 |

推荐判断规则很简单：

- 要“调用一个能力然后拿结果”，优先 RPC
- 要“持续收一串事件”，优先 SSE
- 要“前后端都围绕同一个 collection 状态工作”，优先 SignalDB
- 要“把某个前端面板/路由/文档挂到宿主里”，走 `ctx.ext.ui`

也因此，`ctx.ext.ui` 不是数据层，`signaldb` 也不是视图注册层。

### SignalDB 的状态模型

`ctx.ext.signaldb` 现在不是简单的“状态对象广播”，而是一套 runtime-owned collection 模型：

- 服务端 collection 是 authoritative source of truth
- 浏览器侧拿到的是 replica collection
- 同步协议由 runtime 内建，不要求插件作者自己拼 pull/push
- 宿主渲染 doc 和自定义 UI 共享同一类状态模型

对插件作者来说，最常用的是两步：

1. 后端声明 collection
2. 前端通过 helper/hook 消费这个 collection

典型后端形态：

```ts
const status = this.ctx.ext.signaldb.collection({
  name: 'status',
  initial: [{ id: 'main', running: true }],
})

await status.ready()
```

典型浏览器形态：

```ts
const pluginUi = createPluginUi('MyPlugin')
const status = pluginUi.useCollection('status')
const current = pluginUi.useDoc('status', { id: 'main' })
```

这里最重要的不是 API 形式，而是语义：

- collection 先是服务端资源
- 浏览器看到的是同步副本
- 组件读写的是 collection，而不是直接调用某个隐藏的 transport

#### 服务端 collection

后端通过 `ctx.ext.signaldb.collection({ name, ...options })` 创建 collection。

当前关键选项：

- `initial`
  首次为空时的种子数据
- `persistence`
  是否落到插件持久化层
- `clientWrites`
  是否允许浏览器副本把变更反推回服务端 collection

这层 collection 暴露的能力也是完整 collection 能力，而不是“只读快照”：

- `ready()`
- `find/findOne/count`
- `insert/insertMany`
- `updateOne/replaceOne`
- `removeOne/removeMany`
- `reset`
- `watch`

其中 `ready()` 很重要，因为 collection 底层可能要先接上 persistence adapter。后端如果在 `ready()` 之前直接 `findOne()`，就会命中运行时保护错误。

#### 浏览器 replica

浏览器侧不是直接操作服务端 collection，而是由 `@pluxel/runtime/web/ui` 里的 SignalDB runtime 建立 replica：

- 每个插件名对应一个 replica namespace
- 每个 collection 名在浏览器侧建一个本地 `Collection`
- React 组件通过 `useSignalDbCollectionState()` / `useSignalDbDocState()` 订阅这个 replica

`createPluginUi(...)` 只是把这些 hook 再封了一层更适合插件作者使用的 API：

- `useCollection(collectionName)`
- `useDoc(collectionName, selector)`

因此浏览器侧拿到的不是“原始网络数据”，而是一个可查询、可变更、可观察的 collection view。

#### 同步机制

目前 SignalDB 同步链路分成三段：

1. 初始拉取
   浏览器通过 runtime transport 拉取某个 collection 的完整快照
2. 后续同步
   浏览器侧 replica 使用 `@signaldb/sync` 的 `SyncManager` 维护同步
3. 变更广播
   服务端 collection 变更后，通过插件命名空间下的 SSE 广播 `snapshot/insert/update/remove/reset`

也就是说，现在并不是插件作者自己实现一个 sync manager，而是 runtime 已经把 official `SyncManager` 集成到了浏览器侧 replica 里。

这样做的意义是：

- 插件作者写的是 collection 语义，不是 transport 语义
- doc/builtin 与 custom UI 可以共用同一套状态模型
- 浏览器侧本地修改和服务端 authoritative 数据之间有明确同步边界

#### `clientWrites` 的意义

`clientWrites` 决定浏览器 replica 是否允许把本地修改 push 回服务端。

- `clientWrites: false` 或未开启
  浏览器侧适合只读或本地临时计算视图；服务端不会接受 push 变更
- `clientWrites: true`
  浏览器侧 collection 修改会通过 sync transport 反推到服务端 authoritative collection

这很适合“点击按钮就是改一条状态，再由后端 watch 该状态并处理副作用”这种模型。

但这里仍然要保持边界：

- 如果动作本质上是“显式命令”，例如触发一次部署、执行一次扫描、立刻返回错误结果，RPC 仍然更清晰
- 如果动作本质上是“更新共享状态，让两端围绕同一份 collection 工作”，SignalDB 更合适

#### state collection / action collection

当前更推荐把 SignalDB 用成两类 collection，而不是把所有行为都塞进一个 collection：

- state collection
  表示长期存在、可被界面持续读取的状态
- action collection
  表示短生命周期、用于触发后端副作用的 action/intention 记录

典型例子：

- `status`
  存当前插件面板状态、运行状态、计数器、表单结果
- `actions`
  插入 `{ id, type: 'close-panel', target: 'settings' }` 这类动作记录

插件后端可以 `watch()` action collection，在处理后删除、归档或重置动作项；前端则继续围绕 state collection 渲染。

这样做比“按钮点了直接四处发事件”更可追踪，也比“所有事都走 RPC”更容易复用到 doc/builtin。

## 2. authoring bridge

插件作者在类里写：

```ts
const pluginUi = ui('./ui/index.tsx')

pluginUi.bind(this.ctx)
```

这层不是 runtime contract，而是 authoring bridge。

它的作用只有两个：

- 给 HMR 提供源码入口
- 给 build-time AST rewrite 提供稳定识别点

runtime 本身不应该理解 `entryPath`，也不应该关心源码在哪里。

这层看起来像“在 runtime 上注册 UI”，但其实不是。`bind(ctx)` 的真实含义是：

- 在 dev 里，把源码入口交给 HMR bridge
- 在 build 里，给 AST rewrite 一个静态可识别调用点
- 在非 dev 且未重写的极端路径下，才退回 `ctx.ext.ui.packaged()`

也因此，`entryPath` 是 authoring 信息，不是 runtime 信息。最终运行时只应该看到 packaged manifest。

## 3. HMR

开发期由 `@pluxel/hmr` 接管这层 bridge：

- 读取 `ui(...).bind(ctx)` 的源码入口
- watch 插件 UI 源码
- 调用插件 UI 编译链
- 把结果提交到 runtime 的 extension module store

这里 runtime 暴露的只是一个很薄的内部 store bridge，真正理解源码的是 HMR。

更具体地说，HMR 这一层拆成两件事：

- `packages/hmr/src/plugin.ts`
  定义作者侧 bridge 形态，让插件作者只写 `ui(...).bind(ctx)`
- `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
  真正消费 bridge、watch 源码、触发编译、把 compiled module 提交给 runtime

## 4. MF2

MF2 在 Pluxel 里承担的是“已编译插件 UI 的标准 remote 形态”：

- 远端名称规则
- manifest 路径规则
- shared package contract
- host 侧 remote loading

这里选 MF2 的原因不是为了让插件作者直接写 federation 配置，而是为了获得：

- 稳定的 remote artifact
- 宿主可按需加载
- shared singleton 管理
- dev/build/runtime 共用一套 remote 语义

在实现上，Pluxel 对 MF2 的使用分成两半：

- build 侧用 `@module-federation/vite`
  产出 `mf-manifest.json`、`remoteEntry.js` 和 expose
- browser host 侧用 `@module-federation/runtime`
  在运行时注册 remote、按需加载 exposed UI module

也就是说，MF2 是“编译后 artifact + 浏览器加载协议”，不是插件作者直接操纵的一层 DSL。

## 5. runtime

正式运行时只做两件事：

- `ctx.ext.ui.packaged()`
  注册编译后的 MF remote
- `ctx.ext.ui.doc(...)`
  注册宿主渲染 doc/builtin

也就是说 runtime 只理解：

- packaged remote
- host-rendered builtin/doc

不理解源码 authoring 入口。

对插件作者来说，这层真正稳定的 API 是 `ctx.ext`：

- `ctx.ext.rpc.expose(...)`
- `ctx.ext.sse.expose(...)`
- `ctx.ext.signaldb.collection(...)`
- `ctx.ext.ui.packaged()`
- `ctx.ext.ui.doc(...)`
- `ctx.ext.ui.state(...)`

这里要注意一个很关键的区分：

- `ui(...).bind(ctx)` 是 authoring bridge
- `ctx.ext.ui.*` 是 runtime extension API

两者都和“前端注册”有关，但不属于同一层。

## dev / build / runtime 三条链路

### 开发期链路

1. 插件作者写 `ui('./ui/index.tsx').bind(ctx)`
2. `@pluxel/hmr` attach 到 runtime `Context`
3. HMR 把 `bindUiSource` 这样的 dev handle 挂到 root-scoped context
4. `ui(...).bind(ctx)` 命中 dev handle，不走 packaged fallback
5. `ExtensionCompilerService` watch 源码并编译插件 UI
6. 编译结果以 compiled module 的形式提交给 runtime `ExtensionService`
7. 浏览器侧通过 manifest / remote runtime 加载最新插件 UI

这条链路里，MF2 仍然参与，但参与的是“编译出来的 remote”这一段，不是 authoring declaration 本身。

### build 链路

1. 构建工具扫描插件源码
2. `hmrUiBridgePlugin` 把 `ui(...).bind(ctx)` 重写成 `ctx.ext.ui.packaged()`
3. 插件 UI 通过 `@pluxel/hmr/plugin-build` + `@module-federation/vite` 构建为 MF2 remote
4. 产物包含 `mf-manifest.json`、`remoteEntry.js` 等 artifact
5. runtime 部署时只看到 packaged remote

这一步是 dev/runtime 语义彻底分开的关键。

如果从构建职责再往下拆，当前分工是：

- `@pluxel/build`
  负责 AST 级 rewrite，把 authoring bridge 降成 runtime 语义
- `@pluxel/build/cli`
  通过默认 overlay 把这类 rewrite 带进标准构建命令
- `@pluxel/hmr/plugin-build`
  负责插件 UI remote 的实际 MF2 构建

因此 build 阶段并不是“顺手把 UI 编出来”，而是明确做了两次语义转换：

1. 把 authoring 调用改写成 runtime 调用
2. 把 UI 源码编译成 MF2 remote artifact

### runtime 链路

1. 插件启动时调用 `ctx.ext.ui.packaged()`
2. runtime 解析 packaged manifest 路径
3. `ExtensionService` 记录 compiled module 元数据
4. 浏览器宿主通过 MF runtime `createInstance/registerRemotes/loadRemote` 加载插件 UI

这一层没有源码入口，也没有 HMR 语义。

## 为什么不是“全部都交给 MF2”

原因很简单：MF2 适合承担 remote artifact 和 loading protocol，不适合直接承担你们整套 authoring/HMR 语义。

如果把 dev authoring 也强行并入 MF 配置，会有几个问题：

- 插件作者必须理解更多 build/runtime 元信息
- HMR 语义会污染 runtime 元数据
- AST rewrite 的可控性下降
- 插件 class 内部注册语义会和 build 产物耦合

Pluxel 目前的选择是更偏“内聚系统设计”而不是“把所有语义都暴露给 MF 配置”：

- authoring 入口仍保持简单
- build 负责降级
- runtime 只消费稳定产物

## 为什么 builtin/doc 不再走独立前端体系

因为 doc/builtin 的目标不是给插件作者再开放一整套自定义 UI runtime，而是：

- 复用宿主已有控件
- 避免为说明页/小交互注册完整插件前端
- 让文档和小型交互维持受控形态

所以 builtin/doc 当前收敛到：

- 展示从 `signaldb` state collection 读取
- 交互写 `signaldb` state/action collection
- 插件后端 watch collection 后执行副作用

这意味着 doc 的定位已经不是“迷你自定义 UI”，而是“宿主控制下的受限交互层”：

- 它优先复用宿主组件和表单系统
- 它优先走 declarative state sync，而不是插件自己再造一套前端 runtime
- 它适合说明页、表单页、单按钮动作、状态面板
- 一旦需要复杂布局、复杂状态协作、长生命周期交互，再切回完整自定义 UI remote

这让 builtin/doc 和完整自定义 UI 的分工非常清楚：

- builtin/doc：受控、低成本、宿主渲染
- custom UI：完整前端、MF remote、RPC/SSE/SignalDB 自由组合

## 浏览器宿主设计

宿主浏览器端现在承担三层职责：

### 1. host shell

包括：

- layout / route shell
- header / navbar / plugin detail frame
- extension surface 渲染

### 2. plugin UI registry

包括：

- extension registry
- compiled module state
- MF runtime host instance
- plugin route/component 解析

### 3. plugin UI client helpers

浏览器插件前端统一从 `@pluxel/runtime/web/ui` 导入：

- `definePluginUIModule(...)`
- `createPluginUi(...)`
- `useSignalDbCollectionState(...)`
- `useSignalDbDocState(...)`
- `useRuntimeTransportClient()`

这层的目标是给插件作者一套稳定的“浏览器侧契约”，而不是暴露宿主内部实现。

当前 `createPluginUi(...)` 的推荐心智模型是：

- `use()`
  当前 extension context 下的插件 UI client；也可显式传 `use('global')` / `use('plugin')`
- `useCollection()` / `useDoc()` / `useSignalDbQuery()`
  SignalDB 副本读取

这里没有再抽象出额外的“前端 state facade”。原因是 Pluxel 已经把状态模型稳定在 SignalDB collection 上，再套一层自定义 store API 只会让后端 collection 语义和前端消费语义重新分叉。

SignalDB + React 的响应性现在也刻意不再自造：

- collection reactivity adapter：official `@signaldb/maverickjs`
- React bridge：official `@signaldb/react`
- 浏览器 replica sync：official `@signaldb/sync`

也就是说，Pluxel 现在只是把官方三段拼好，并暴露成稳定 helper；不是再维护一套私有 React 订阅层。

这里还刻意保留了一条边界：

- 这些包不是插件 public contract
- 插件前端统一只从 `@pluxel/runtime/web/ui` 取 SignalDB 能力
- MF shared contract 只共享 `@pluxel/runtime/web/ui`，不单独共享 `@signaldb/react` / `@signaldb/maverickjs` / `@maverick-js/signals`

原因是我们要共享的是“稳定插件契约”，不是把 runtime 内部实现细节也暴露给 remote。

也就是说，helper 本身不再把 `context/services/transport/rpc/sse` 全都拆成独立 hook；先选一个插件 UI client，再从返回对象上取 `rpc` / `sse` / `notify` / `confirm` / `locale` / `context`，需要底层传输时再用 `transport`。

`use()` 的返回能力边界：

- `context`
  当前 extension context
- `rpc`
  插件命名空间 RPC
- `sse`
  插件命名空间 SSE
- `notify` / `confirm`
  宿主注入的 UI 能力（强制）
- `locale`
  宿主注入的 locale 服务；负责 locale 状态、fallback locale，以及日期/数字格式化
- `transport`
  底层 transport 客户端（escape hatch）

SignalDB 的读取建议：

- `useDoc(collection, selector)`
  固定单文档读取
- `useCollection(collection)`
  需要读写整个 replica、拿集合句柄时使用
- `useSignalDbQuery(() => collection.find(...).fetch(), [collection])`
  列表、排序、过滤、聚合、派生值；自定义组件里优先用这个

UI 能力的典型写法：

```ts
const pluginUi = createPluginUi('MyPlugin')
const { notify, confirm, locale } = pluginUi.use('plugin')

notify({ tone: 'success', title: '完成', message: '操作成功' })
const ok = await confirm({ message: '确认继续？' })
notify({ tone: 'info', title: locale.formatDate(Date.now()) })
```

对“完整自定义插件 UI”的正式本地化，当前唯一推荐路径是 `@inlang/paraglide-js`。Pluxel 不再维护插件级字典注册接口，而是把 Paraglide 放在插件 UI 编译链里处理：

- `@pluxel/hmr` 的 dev 子编译自动注入 `paraglideVitePlugin(...)`
- `buildPluginUiRemote(...)` 的 build 子编译也自动注入
- 当前约定目录：
  `project.inlang` + `messages/` -> `src/paraglide/`

这套路径现在应该理解成编译契约，而不是建议值：

- `project.inlang`
  插件包根目录必需
- `messages/`
  插件包根目录下的唯一消息源目录
- `src/paraglide/`
  唯一生成目录，不再让插件各自指定 outdir

这样 Paraglide 属于“插件源码如何变成可执行 UI 模块”的一部分，而不是 runtime 再维护一套中心化翻译服务。

如果插件 UI 需要和宿主 locale 同步，标准桥接点是 `definePluginUIModule({ setup({ locale }) { ... } })`：

- runtime 只负责提供唯一的 locale 状态源
- 插件自己把这个状态桥接给 Paraglide runtime
- 构建后产物里不再保留 dev 专用翻译装配逻辑

最小桥接示意：

```ts
import { definePluginUIModule } from '@pluxel/runtime/web/ui'
import { overwriteGetLocale, overwriteSetLocale } from './paraglide/runtime'

export default definePluginUIModule({
	setup({ locale }) {
		overwriteGetLocale(() => locale.locale)
		overwriteSetLocale((next) => locale.setLocale(next))
		return locale.subscribe(() => {
			overwriteGetLocale(() => locale.locale)
		})
	},
})
```

## MF2 在宿主里的具体角色

当前宿主对 MF2 的使用方式是：

- host 侧手动 `createInstance(...)`
- shared strategy 使用 `loaded-first`
- shared package 由 runtime 的 federation contract 定义
- remote 在运行时按需 `registerRemotes(...)`
- 模块通过 `loadRemote(...)` 加载

这意味着：

- 宿主本身不需要用 MF 插件接管整个构建
- runtime 可以把 MF2 当作一个稳定的 remote loading 层
- dev host 只需要负责“如何产出 remote”，不必让宿主 shell 也变成一个 MF host app

这是刻意的设计：Pluxel 要的是“插件前端 remote 化”，不是“整个控制台做成泛化微前端平台”。

## shared contract

shared contract 由 `@pluxel/runtime/web/federation` 统一定义。

当前重点是：

- `react`
- `react-dom`
- `react/jsx-runtime`
- `react/jsx-dev-runtime`
- `@mantine/core`
- `@mantine/hooks`
- `@pluxel/runtime/web/ui`

原则：

- runtime/browser 宿主和插件 remote 共享同一套 React / Mantine / UI contract 单例
- shared contract 变化必须视为架构级变化，而不是普通依赖升级

这里还有一个刻意的选择：当前 shared contract 倾向“版本对齐 + host 单例提供”，而不是让每个 remote 自己带一套副本。原因不是节省一点包体，而是避免：

- React / hooks 身份分裂
- Mantine context 分裂
- `@pluxel/runtime/web/ui` 契约副本不一致
- dev/runtime 行为出现“同代码不同单例”的隐性 bug

## SignalDB 的位置

上面已经解释了它的 collection/sync 机制，这里只补它在整套前端架构里的角色定位：

它承担：

- 服务端 authoritative collection
- 浏览器副本 collection
- builtin/doc 的受控状态读取
- custom UI 的统一状态读取
- action/state collection 的轻量副作用触发模型

它不承担：

- 替代所有 RPC
- 把所有副作用都隐式化

当前推荐是：

- 纯状态同步、文档表单、小动作：优先 `signaldb`
- 明确命令式副作用：优先 RPC
- 高频事件流：SSE

把这三者放在一起看，推荐的前后端分工是：

- SignalDB
  负责“现在是什么状态、双方围绕什么 collection 协作”
- RPC
  负责“明确执行一个动作，并立刻拿到结果或错误”
- SSE
  负责“把连续事件推给前端，而不是把它们固化成长期状态”

这三层同时存在不是重复设计，而是故意避免把“状态”“命令”“事件流”混成一个接口。

## 当前推荐心智模型

可以直接记成下面这张逻辑图：

```text
Plugin class
  -> ctx.ext.rpc / sse / signaldb / ui
  -> ui('./ui/index.tsx').bind(ctx)        # authoring bridge

dev:
  @pluxel/hmr
    -> consume ui bridge
    -> compile plugin UI source
    -> emit MF2 remote artifacts
    -> push compiled module metadata into runtime

build:
  @pluxel/build + @pluxel/hmr/plugin-build
    -> rewrite ui(...).bind(ctx) to ctx.ext.ui.packaged()
    -> build MF2 remote

runtime:
  @pluxel/runtime
    -> ctx.ext.ui.packaged()
    -> ExtensionService stores compiled module metadata
    -> browser host loads MF2 remote

browser host:
  plugin UI registry + MF runtime + plugin UI helpers
```

如果要把这张图再翻译成“写代码时怎么判断放哪层”，可以用下面这个简单规则：

- 你在写插件类里的运行时交互注册：放 `ctx.ext`
- 你在写插件 UI 浏览器模块：放 `definePluginUIModule(...)`
- 你在写 HMR 侧源码声明：放 `ui(...).bind(ctx)`
- 你在做构建期降级：放 `@pluxel/build`
- 你在做 remote 编译/manifest 生成：放 `@pluxel/hmr/plugin-build`
- 你在做 remote 加载：放 browser host federation runtime

## 关键实现文件

如果需要从文档直接跳进代码，当前最值得读的文件是：

- `packages/runtime/src/services/plugin-interaction/ExtService.ts`
  `ctx.ext` 聚合入口
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
  runtime 的 packaged remote / doc 注册
- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
  state sync collection 与 transport
- `packages/hmr/src/plugin.ts`
  `ui(...).bind(ctx)` authoring bridge
- `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
  dev 期源码消费、编译、compiled module 提交
- `packages/build/src/rolldown/plugins/hmrUiBridgePlugin.ts`
  build 期 bridge rewrite
- `packages/hmr/src/plugin-build.ts`
  MF2 remote build helper
- `packages/runtime/src/web/plugin-ui/federation.ts`
  shared contract / remote naming / manifest path
- `packages/components/src/extension/federationRuntime.ts`
  浏览器宿主的 MF runtime

## 什么时候改这套架构

只有在下面几种情况出现时，才值得继续动主架构：

- 出现第二种非-HMR host，需要复用同一套 plugin UI 编译/remote 语义
- MF2 runtime 或 build plugin 新能力足以显著简化当前 bridge
- builtin/doc 需要跨越当前受控边界，开始承载更复杂的前端交互模型
- SignalDB/RPC/SSE 的职责边界出现系统性冲突

否则，当前架构的主目标已经达成：

- runtime 稳定
- dev 快速
- build 可判定
- authoring 语义清晰
- MF2 只扮演它最擅长的角色
