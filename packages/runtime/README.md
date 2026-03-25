# @pluxel/runtime

`@pluxel/runtime` 是运行时内核。它只负责稳定的 `Context`、services、协议和运行时注册。

这份 README 主要回答两个问题：

- 什么属于 runtime，什么不属于
- 插件前端最终有哪些稳定 runtime 语义

不负责：

- Vite
- HMR
- workspace 源码执行
- `ui(...).bind(ctx)` 这类 authoring 语义

这些都属于 `@pluxel/hmr`。

如果你要理解插件前端整条链路，不要只看这个 README，直接看：

- [`docs/FRONTEND_ARCHITECTURE.md`](../../docs/FRONTEND_ARCHITECTURE.md)

## 运行时模型

runtime 只消费两类前端输入：

- 编译后的插件 UI remote
- 宿主渲染的 builtin/doc 扩展

对应边界：

- 作者侧声明：`ui('./ui/index.tsx').bind(ctx)`
- build 后产物：重写成 `ctx.ext.ui.packaged()`
- runtime 只理解 `packaged()`，不理解源码入口

换句话说，runtime 看到的是“结果”，不是“作者怎么声明这个结果”。

再压缩成一句工程判断：

- authoring / HMR / build 负责“怎么从源码得到 UI”
- runtime 负责“怎么注册和消费已经稳定的 UI 结果”

## MF2 在 runtime 里的角色

runtime 里对 MF2 的定位很窄，也很明确：

- 作为插件 UI 的 remote artifact format
- 作为浏览器宿主按需加载插件 UI 的协议层
- 作为 shared singleton 的统一契约

它不承担：

- authoring API
- HMR 声明语义
- 插件元数据中心

runtime 只消费：

- manifest / remote entry / exposed module / shared contract

对 runtime 来说，MF2 不是“插件作者要理解的配置系统”，而是“浏览器宿主与编译产物之间的稳定协议层”。

对应实现入口：

- `@pluxel/runtime/web/federation`
- `ExtensionService`
- 浏览器宿主侧的 federation runtime

## `ctx.ext`

- `ctx.ext.rpc.expose(...)`
  暴露自定义 UI 的 RPC
- `ctx.ext.sse.expose(...)`
  暴露自定义 UI 的 SSE
- `ctx.ext.signaldb.collection({ name })`
  runtime-owned collection，服务端 authoritative store
- `ctx.ext.ui.packaged()`
  注册编译后的 MF remote
- `ctx.ext.ui.doc(...)`
  注册宿主渲染 doc/builtin 扩展
- `ctx.ext.ui.state(collection, selector)`
  给 doc/builtin 场景生成 `get/field/path/snapshot/form/action`

推荐这样理解这组 API：

- `rpc` / `sse`
  命令式交互
- `signaldb`
  状态同步
- `ui`
  呈现注册

不要把 `ctx.ext.ui` 和 `ui(...).bind(ctx)` 混成一层。前者是 runtime API，后者是 HMR/build authoring bridge。

## SignalDB 语义

`ctx.ext.signaldb` 现在代表的是 runtime-owned collection sync，而不是一个随手塞进来的状态工具。

它包含四层语义：

- 服务端 authoritative collection
- 浏览器 replica collection
- runtime 内建的 pull/push transport
- 基于 SSE 的变更广播

浏览器侧已经集成 official `@signaldb/sync` `SyncManager`，所以插件作者不需要自己再拼同步逻辑；前端直接用：

- `createPluginUi(...).useCollection(...)`
- `createPluginUi(...).useDoc(...)`

后端则用：

- `ctx.ext.signaldb.collection({ name, initial, persistence, clientWrites })`
- `await collection.ready()`
- `collection.watch(...)`

推荐这样分工：

- 共享状态、doc 表单、轻量动作：SignalDB
- 明确命令式调用：RPC
- 连续事件流：SSE

其中 `clientWrites` 控制浏览器 replica 是否允许把修改 push 回服务端 collection。

## `createPluginUi(...)`

浏览器插件前端当前推荐只记 4 个 helper 入口：

- `use()`
  当前 extension context 下的插件 UI client；也可写 `use('global')` / `use('plugin')` 选择明确上下文
- `useCollection()`
  读取 SignalDB collection 副本
- `useDoc()`
  读取 SignalDB 单条记录
- `useSignalDbQuery()`
  在 React 组件里执行 SignalDB reactive query；这是自定义前端组件的唯一推荐读取方式

这里故意没有再包一层“万能 state store helper”。插件前端直接面对 collection / doc 两个心智单位，和后端 `ctx.ext.signaldb.collection(...)` 保持一一对应，避免再发明一套前端私有状态 DSL。

SignalDB 的 React 响应性现在走官方链路：

- collection 副本使用 official reactivity adapter：`@signaldb/maverickjs`
- React 读取使用 official hook factory：`@signaldb/react`
- Pluxel 在 `@pluxel/runtime/web/ui` 里把这条链路封装成 `useCollection()` / `useDoc()` / `useSignalDbQuery()`

但这三者当前都属于 runtime UI contract 的内部实现细节，而不是插件 public import surface：

- 插件 UI 不应直接 import `@signaldb/react`
- 插件 UI 不应直接 import `@signaldb/maverickjs`
- 插件 UI 不应直接 import `@maverick-js/signals`
- MF shared contract 也不单独共享这些包；只共享 `@pluxel/runtime/web/ui`

这意味着插件作者不需要自己手写 `useSyncExternalStore`、事件订阅或中间 store；写自定义 UI 时，直接在组件里组合：

```ts
const pluginUi = createPluginUi('MyPlugin')

function EventsPanel() {
  const events = pluginUi.useCollection('events')
  const latest = pluginUi.useSignalDbQuery(
    () => events.find({}, { sort: { at: -1 }, limit: 20 }),
    [events],
  )

  return latest.map((event) => <div key={event.id}>{event.message}</div>)
}
```

推荐规则只有两条：

- 读单条固定文档时优先 `useDoc()`
- 只要是列表、聚合、排序、过滤、自定义派生读取，都用 `useSignalDbQuery(...)`

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

这里再强调一次导入边界：

- 插件作者在浏览器侧应只从 `@pluxel/runtime/web/ui` 取这些能力
- 不应该再直接 import runtime 内部实现文件

示例：

```ts
const pluginUi = createPluginUi('MyPlugin')
const { notify, confirm, locale } = pluginUi.use('plugin')
notify({ tone: 'success', title: '已保存', message: '配置已应用' })
const ok = await confirm({ message: '确认重置？', tone: 'danger' })
notify({ tone: 'info', title: locale.formatDate(Date.now()) })
```

插件自定义 UI 的正式本地化现在统一走 `@inlang/paraglide-js`，runtime 不再维护插件级文本字典注册层。Paraglide 的 Vite 插件已经由 Pluxel 的插件 UI 编译链自动接入：

- dev：`@pluxel/hmr` 的 UI 子编译自动注入
- build：`buildPluginUiRemote(...)` 自动注入
- 约定：插件包根目录必须提供 `project.inlang`，消息源目录固定为 `messages/`，生成目录固定为 `src/paraglide/`

也就是说：

- runtime 负责提供稳定的 `locale` 状态和宿主 UI 能力
- Paraglide 负责把插件源码里的消息编译成可执行模块
- 插件 UI 如需接入 locale 切换，应在 `definePluginUIModule({ setup({ locale }) { ... } })` 里桥接 Paraglide runtime

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

## doc 约束

宿主渲染 doc 现在只依赖 `signaldb`：

- 展示读 state collection
- 交互写 state 或 action collection
- 副作用由插件后端 watch collection 后处理

因此 doc/builtin 不需要直接依赖 RPC/HMR 语义。

## 开发期

runtime 本身不启动 Vite。开发期统一通过 `@pluxel/hmr` 接入：

- `startHmrHostFromConfig(...)`
- `attachHmrRuntime(ctx, ...)`

这个边界是刻意的：runtime 不应该反向依赖 dev host。

## 建议阅读路径

如果你现在要追一条具体实现链，推荐顺序是：

1. `packages/runtime/src/services/plugin-interaction/ExtService.ts`
2. `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
3. `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`
4. `packages/runtime/src/web/plugin-ui/*`

如果你要继续往 authoring / HMR / build 看，再跳到：

1. `packages/hmr/src/plugin.ts`
2. `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
3. `packages/build/src/rolldown/plugins/hmrUiBridgePlugin.ts`
4. `packages/hmr/src/plugin-build.ts`

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
