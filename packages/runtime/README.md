# @pluxel/runtime

`@pluxel/runtime` 是运行时内核。它只负责稳定的 `Context`、services、协议和运行时注册。整条前端链路见 [`docs/FRONTEND_ARCHITECTURE.md`](../../docs/FRONTEND_ARCHITECTURE.md)。

## 运行时模型

runtime 只消费两类前端输入：

- 编译后的插件 UI remote
- 宿主渲染的 builtin/doc 扩展

对应边界：

- 作者侧声明：`ui('./ui/index.tsx').bind(ctx)`
- build 后产物：重写成 `ctx.ext.ui.packaged()`
- runtime 只理解 `packaged()`，不理解源码入口

## MF2 在 runtime 里的角色

- 作为插件 UI 的 remote artifact format
- 作为浏览器宿主按需加载插件 UI 的协议层
- 作为 shared singleton 的统一契约

对应实现入口：

- `@pluxel/runtime/web/federation`
- `ExtensionService`
- 浏览器宿主侧的 federation runtime

## `ctx.ext`

- `this.ctx.ext.rpc.expose(...)`
  暴露自定义 UI 的 RPC
- `this.ctx.ext.sse.expose(...)`
  暴露自定义 UI 的 SSE
- `this.ctx.ext.signaldb.collection({ name })`
  runtime-owned collection，服务端 authoritative store
  `collection.doc(selector)` 给单文档场景生成 `get/field/path/snapshot/form/action`
  `doc.form()` 默认同步当前 selector 命中的文档；如果你明确要无同步表单，才传 `state: false`
- `pluginUi.bind(this.ctx)`
  绑定作者侧 UI 声明
- `this.ctx.ext.ui.packaged()`
  注册编译后的 UI remote
- `this.ctx.ext.ui.doc(...)`
  注册宿主渲染 doc/builtin 扩展
- `this.ctx.http.plugin.routes(...)`
  插件级 HTTP 路由挂载入口
- `workerDecl.bind(this.ctx, options)`
  HMR worker 绑定入口
- `this.ctx.vault.open(...)`
  插件级加密持久化入口
- `this.ctx.root.fs.*`
  root FS 入口
- `this.ctx.loader.api`
  loader API

## 配置

- `configs.use(schema)` 读到的是 schema 归一化后的输出
- 默认值放进 Valibot schema 本身，不要在插件里再写 `config ?? defaults`

## SignalDB 语义

- 服务端 authoritative collection
- 浏览器 replica collection
- runtime 内建的 pull/push transport
- 基于 SSE 的变更广播

浏览器侧读取：

- `createPluginUi(...).useCollection(...)`
- `createPluginUi(...).useDoc(...)`

服务端写法：

- `this.ctx.ext.signaldb.collection({ name, initial, persistence, clientWrites })`
- `collection.doc(selector)`
- `await collection.ready()`
- `collection.watch(...)`

其中 `clientWrites` 控制浏览器 replica 是否允许把修改 push 回服务端 collection。

## `createPluginUi(...)`

- `use()`
  当前 extension context 下的插件 UI client；也可写 `use('global')` / `use('plugin')` 选择明确上下文
- `useCollection()`
  读取 SignalDB collection 副本
- `useDoc()`
  读取 SignalDB 单条记录
- `useSignalDbQuery()`
  在 React 组件里执行 SignalDB reactive query

SignalDB 的 React 响应性现在走官方链路：

- collection 副本使用 official reactivity adapter：`@signaldb/maverickjs`
- React 读取使用 official hook factory：`@signaldb/react`
- Pluxel 在 `@pluxel/runtime/web/ui` 里把这条链路封装成 `useCollection()` / `useDoc()` / `useSignalDbQuery()`

导入边界：

- 插件 UI 不应直接 import `@signaldb/react`
- 插件 UI 不应直接 import `@signaldb/maverickjs`
- 插件 UI 不应直接 import `@maverick-js/signals`
- MF shared contract 也不单独共享这些包；只共享 `@pluxel/runtime/web/ui`

`rpc` / `sse` / `notify` / `confirm` / `locale` / `context` 都直接从 `use()` 返回对象上拿；底层传输细节统一走 `transport`，不再单独拆出一串重复 helper。

`use()` 返回对象的能力边界：

- `context`
  当前 extension context（`global` 或 `plugin`）
- `rpc`
  当前插件命名空间 RPC 客户端
- `sse`
  当前插件命名空间 SSE 客户端
- `notify` / `confirm`
  宿主注入的 UI 能力（强制）
- `locale`
  宿主提供的 locale 服务；负责当前 locale、fallback locale，以及 `formatDate()` / `formatNumber()`
- `transport`
  底层 transport 客户端（`fetch / withRpc / http / links / sse`），仅在需要低层能力时使用

插件自定义 UI 的正式本地化现在统一走 `@inlang/paraglide-js`，runtime 不再维护插件级文本字典注册层。Paraglide 的 Vite 插件已经由 Pluxel 的插件 UI 编译链自动接入：

- dev：`@pluxel/hmr` 的 UI 子编译自动注入
- build：`buildPluginUiRemote(...)` 自动注入
- 约定：插件包根目录必须提供 `project.inlang`，消息源目录固定为 `messages/`，生成目录固定为 `src/paraglide/`

## doc 约束

宿主渲染 doc 现在只依赖 `signaldb`：

- 展示读 state collection
- 交互写 state 或 action collection
- 副作用由插件后端 watch collection 后处理

## 开发期

runtime 本身不启动 Vite。开发期统一通过 `@pluxel/hmr` 接入：

- `startHmrHostFromConfig(...)`
- `attachHmrRuntime(ctx, ...)`

## 主要 subpath

- `@pluxel/runtime/services`
  runtime services 导出
- `@pluxel/runtime/web`
  浏览器协议与 SDK
- `@pluxel/runtime/web/ui`
  插件 UI contract / client helpers / SignalDB hooks
- `@pluxel/runtime/web/extensions`
  builtin/doc contract
- `@pluxel/runtime/web/federation`
  MF remote 命名和 shared contract
- `@pluxel/runtime/frozen`
  冻结宿主构建
- `@pluxel/runtime/shared`
  给 `@pluxel/hmr` 复用的纯工具
- `@pluxel/runtime/internal`
  runtime 与 hmr 之间的内部 glue
