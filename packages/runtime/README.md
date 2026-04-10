# @pluxel/runtime

`@pluxel/runtime` 是运行时内核。它只负责稳定的 `Context`、services、协议和运行时注册。整条前端链路见 [`docs/architecture/frontend.md`](../../docs/architecture/frontend.md)。

## 运行时模型

runtime 只消费两类前端输入：

- 编译后的插件 UI remote
- 宿主渲染的 builtin/doc 扩展

对应边界：

- 作者侧声明：`ui('./ui/index.tsx').bind(ctx)`
- build 后产物：重写成 `ctx.ext.ui.remote.packaged()`
- runtime 只理解 `remote.packaged()`，不理解源码入口

## MF2 在 runtime 里的角色

- 作为插件 UI 的 remote artifact format
- 作为浏览器宿主按需加载插件 UI 的协议层
- 作为 shared singleton 的统一契约

对应实现入口：

- `@pluxel/runtime/web/federation`
- `ExtensionService`
- 浏览器宿主侧的 federation runtime

## `ctx.ext`

- `this.ctx.ext.ops`
  runtime control-plane 的唯一内核入口；插件、RPC、MCP、CLI 都应复用同一套 operation 定义与 descriptor，而不是各自维护一套 handler
- `this.ctx.ext.rpc.expose(...)`
  暴露自定义 UI 的 RPC
- `this.ctx.ext.sse.expose(...)`
  暴露自定义 UI 的 SSE
- `this.ctx.ext.signaldb.collection({ name })`
  runtime-owned collection，服务端 authoritative store
  `collection.doc(selector)` 给单文档场景生成 `get/field/path/snapshot/form/action`
  `doc.form()` 默认同步当前 selector 命中的文档；如果你明确要无同步表单，用 `doc.formUnsynced()`；如果你要指定其他同步源，用 `doc.formFrom(...)`
- `pluginUi.bind(this.ctx)`
  绑定作者侧 UI 声明
- `this.ctx.ext.ui.remote.packaged()`
  注册编译后的 UI remote
- `this.ctx.ext.ui.builtin.doc(...)`
  注册宿主渲染 doc/builtin 扩展
- `this.ctx.ext.ui.interaction.surface(...)`
  声明 consumer-owned interaction surface，负责 placement、输入与最终 apply
- `this.ctx.ext.ui.interaction.offer(...)`
  声明 provider-owned interaction offer，负责准备资源与提供 session UI
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

### runtime control-plane 原则

- runtime 内部控制面统一建模为 operation，而不是额外再造 `PluginHandle` / 专用 RPC façade
- `defineOp(...)` 产出的 canonical descriptor 是唯一语义 IR；carrier 只能投影它，不能再造第二套 metadata
- descriptor 分成五块：`doc`、`exposure`、`policy`、`schemas`、`transports`
- 对外唯一 RPC 面是：
  - `opsList()`
  - `opsInvoke(id, input?)`
  - `opsDispatch(command)`
- `opsList()` 返回的是可序列化的 public descriptor snapshot，而不是内部 registry object 原样透出
- CLI、MCP、RPC 命中的都是同一个 op registry；语义、schema、约束和返回值保持一致
- 即使是 runtime 内部调用，默认也不绕过 op 输入/输出校验；性能优化应在现有 op 模型内做，而不是私下分叉 trusted path
- `exposure` 只表达 `rpc/internal` 这类跨 carrier 可见性；tool / CLI 可见性由对应 transport projection 是否存在决定
- external tool name 统一走 lower-case dotted / kebab 风格；不要把 camelCase 暴露给 carrier
- tool 帮助信息统一来自 op `doc` 和 input schema description；不要在 carrier 里再拼第二份文案
- runtime canonical op namespace 视为 host contract，保留给 runtime 自己使用；插件自定义 op 应使用插件自有前缀，而不是复用 `plugin.*` / `plugins.*` / `runtime.*`
- MCP tool surface 也是 `ctx.ext.ops` 的实时投影，不应退化成“启动时快照”
- `runtime.ops.list` 是 registry 里的唯一 meta-op；`opsInvoke()` / `opsDispatch()` 属于 RPC transport 本身，不再反向注册成泛调用 op

当前 runtime core 已收敛到这一组 canonical runtime op ids：

- `plugins.list`
- `plugin.status`
- `plugins.status.apply`
- `plugin.start` / `plugin.stop` / `plugin.restart` / `plugin.enable` / `plugin.disable`
- `plugin.wait-for-stage`
- `plugin.dependencies.list`
- `plugin.dependencies.inspect`
- `plugin.dependencies.set-target`
- `plugin.base-provider.inspect`
- `plugin.base-provider.select`
- `plugin.fork.ensure`
- `plugin.schema`
- `plugin.config.get`
- `plugins.config.get`
- `plugin.config.validate`
- `plugins.config.validate`
- `plugin.config.patch`
- `plugins.config.set`
- `plugin.config.patch-field`
- `plugins.config.patch-field`
- `plugin.config.reset`
- `plugins.config.reset`
- `runtime.ops.list`

## 配置

- `configs.use(schema)` 读到的是 schema 归一化后的输出
- 默认值放进 Valibot schema 本身，不要在插件里再写 `config ?? defaults`
- cfg/schema 提取与 cfg layout 设计见 `docs/design/plugin-config/overview.md`；Host 合同见 `packages/runtime/docs/config/contract.md`。

## SignalDB 语义

- 服务端 authoritative collection
- 浏览器 replica collection
- runtime 内建的 pull/push transport
- 基于 SSE 的变更广播

浏览器侧读取：

- `const plugin = pluginUi('MyPlugin')`
- `plugin.use().db.collection('name').useView()`
- `plugin.use().db.useDoc(...)`

服务端写法：

- `this.ctx.ext.signaldb.collection({ name, initial, persistence, clientWrites })`
- `collection.doc(selector)`
- `await collection.ready()`
- `collection.watch(...)`

其中 `clientWrites` 控制浏览器 replica 是否允许把修改 push 回服务端 collection。

## `pluginUi(...)`

- `const plugin = pluginUi('MyPlugin')`
  为当前插件 UI 绑定一次插件名，作为 RPC/SSE/SignalDB 的类型锚点
- `plugin.use()`
  默认拿 plugin-scoped app；这也是绝大多数插件 UI 组件的主入口
- `plugin.useGlobal()`
  只在 header/global status bar 这类全局扩展点下使用；其返回值同样是 `app`
- `app.db.collection('name')`
  返回某个 collection 的 hook 句柄：`useView()` / `useDoc()` / `useList()` / `useCount()` / `useLiveQuery()`
- `app.db.useDoc()`
  读取 SignalDB 单条记录
- `app.db.useList()` / `app.db.useCount()`
  读取常见列表与计数
- `app.db.useLiveQuery()`
  在 React 组件里执行 SignalDB reactive query

SignalDB 的 React 响应性现在走官方链路：

- collection 副本使用 official reactivity adapter：`@signaldb/maverickjs`
- React 读取使用 official hook factory：`@signaldb/react`
- Pluxel 在 `@pluxel/runtime/web/ui` 里把这条链路封装成 `plugin.use().db.*`

导入边界：

- 插件 UI 不应直接 import `@signaldb/react`
- 插件 UI 不应直接 import `@signaldb/maverickjs`
- 插件 UI 不应直接 import `@maverick-js/signals`
- MF shared contract 也不单独共享这些包；只共享 `@pluxel/runtime/web/ui`

`rpc` / `sse` / `notify` / `confirm` / `colorScheme` / `locale` / `formatDate()` / `formatNumber()` 都直接从 `plugin.use()` / `plugin.useGlobal()` 返回的 `app` 对象上拿；底层传输细节统一走 `transport`，SignalDB 统一走 `app.db`。

`app` 对象的常用能力边界：

- `pluginName`
  当前 helper 绑定的插件名
- `pathname`
  plugin-scoped 页面下的当前路径；global scope 下为 `null`
- `colorScheme`
  宿主当前主题模式
- `runningPlugins` / `runningPluginsReady`
  当前宿主已运行插件集合与 ready 状态
- `rpc`
  当前插件命名空间 RPC 客户端
- `sse`
  当前插件命名空间 SSE 客户端
- `notify` / `confirm`
  宿主注入的 UI 能力（强制）
- `locale` / `fallbackLocale`
  宿主当前 locale 信息
- `setLocale()` / `formatDate()` / `formatNumber()`
  宿主提供的本地化能力
- `db`
  当前插件命名空间的 SignalDB 浏览器副本入口
- `transport`
  底层 transport 客户端（`fetch / withRpc / http / links / sse`），仅在需要低层能力时使用

插件自定义 UI 的正式本地化现在统一走 `@inlang/paraglide-js`，runtime 不再维护插件级文本字典注册层。Paraglide 的 Vite 插件已经由 Pluxel 的插件 UI 编译链自动接入：

- dev：`@pluxel/hmr` 的 UI 子编译自动注入
- build：`buildPluginUiRemote(...)` 自动注入
- 约定：插件包根目录必须提供 `project.inlang`，消息源目录固定为 `messages/`，生成目录固定为 `src/paraglide/`

## doc 约束

宿主渲染 doc 现在只依赖 `signaldb`：

- 展示读 state collection
- `form`
  宿主 AutoForm，默认从 `collection.doc(selector)` 对应文档同步，并把提交写回 `write`
- `action`
  宿主按钮，不持有独立状态；点击后执行 `write`，常见用法是写入 action collection
- 副作用由插件后端 watch collection 后处理

`PluginBuiltinShowcase.ts` 演示了这三种 builtin：`doc(schemaMap).card(...)`、`docHandle.form(...)`、`docHandle.action(...)`。`PluginContributionFontDemo.ts` 额外演示了 `surface + offer + session` 这条跨插件自定义 UI 交互路径。

当前这套 interaction 系统主要覆盖 3 类职责：

- consumer-own placement + consumer-own state ownership
- provider-own custom UI + provider-own resource preparation
- host-own session resolution + diagnostics + transport

需要明确区分：

- 插件自己的 builtin UI：
  `doc(...)`
- 跨插件 interaction：
  `surface(...) + offer(...) + session host + ui().loadSession/syncDraft/commitSession`

也就是说，`doc` 不再参与 cross-plugin interaction 语义；跨插件系统只服务 provider 自定义 UI。

扩展 manifest 也会暴露这条链路的诊断快照：

- `builtins`
  最终实际渲染的 builtin/doc contribution
- `surfaces`
  consumer 声明的 interaction surface
- `offers`
  provider 声明的 interaction offer
- `sessions`
  host 解析后的活动 session
- `interactions`
  `active / waiting-provider / waiting-surface / rejected` 诊断记录
- `states`
  插件 UI 编译/加载状态

## 开发期

runtime 本身不启动 Vite。开发期统一通过 `@pluxel/hmr` 接入：

- `planHmrHostFromConfig(...)` + `bootPlannedHmrHost(plan)` + `host.hmr.start()`
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
- `@pluxel/runtime/vite`
  Vite 环境判断和 `serverOnly/browserOnly` 插件包装
- `@pluxel/runtime/internal`
  runtime 与 hmr 之间的内部 glue
