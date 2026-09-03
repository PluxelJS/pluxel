# Test、static 与 dynamic Runtime API 收敛

> 状态：设计已冻结，尚未实现。本文定义三条入口应共享的语法与必须保留的边界；prototype 只验证实现可行性。

## 结论

基础 API 面应该一致，但一致的是**资源语法、driver vocabulary 和失败原则**，不是把三种不同 authority 压成同一个 interface。

```text
Plugin fixture world
  -> createRuntimeTestHost()

fixed static application in a test process
  -> startStaticRuntimeTestHost(application)

dynamic Vite server
  -> project dev command
  -> or startDynamicDevRuntime({ entry })
```

不设计：

```ts
createRuntime({ mode: 'test' | 'static' | 'dynamic' })
startRuntime({ source: ..., carrier: ..., test: ... })
```

这种统一只把关键边界藏进 options。coding agent 看到局部调用时，无法判断 catalog 来自 constructor fixture、fixed application 还是 Vite
source graph，也无法知道是否打开 listener/watcher。

## 三条入口的本质差异

| 入口                           | 输入 authority                               | Factory resolve 时                       | Catalog/lifecycle mutation                             | Inbound boundary             |
| ------------------------------ | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `createRuntimeTestHost()`      | test 直接提供 Plugin constructor/fork/config | 只有隔离 test world；没有 Plugin running | `host.start/stop/commit` 是 fixture authority          | in-process driver            |
| `startStaticRuntimeTestHost()` | `defineStaticRuntime()` application          | application configure/prepare/boot 完成  | fixed catalog；intent 来自 runtime state/control plane | in-process driver            |
| `startDynamicDevRuntime()`     | dynamic config entry + Vite source graph     | Vite/controller/carrier/listener ready   | catalog 来自 source/HMR；intent 来自 control plane     | physical HTTP/WebSocket/Vite |

这些差异必须出现在函数名、参数和返回 surface 上，不能只写在文档里。

## 应统一的基础语言

### 1. Scope ownership

所有持有 Runtime resources 的返回值都实现：

```ts
interface AsyncOwnedResource extends AsyncDisposable {
	dispose(): Promise<void>
}
```

这是设计约定，不急于导出一个几乎没有信息量的公共 base interface。TypeScript 的 structural typing 已足够组合 teardown helper。共同保证：

- `dispose()` 与 `[Symbol.asyncDispose]()` 是同一个幂等 operation；
- factory 失败先清理已经取得的部分资源；
- dispose resolve 后不遗留该 resource 拥有的 Plugin effects、session、watcher、listener 或 background task；
- 多项 teardown failure 使用 `AggregateError` 保留。

### 2. Ready-on-return

factory 返回的对象不再需要启动它自身：

- `createRuntimeTestHost()` 同步建立一个可用但没有 running Plugin 的 fixture world；
- `startStaticRuntimeTestHost()` resolve 时完整 static application 已完成 cold boot；
- `startDynamicDevRuntime()` resolve 时真实 Vite server 已监听并 ready。

因此三者都不暴露 receiver-level `.start()`/`.stop()`。`RuntimeTestHost.start(Plugin)` 的 target 参数使它明确是 Plugin lifecycle command，
不是 host 启动；其余两个入口不提供这个 fixture authority。

不为了表面统一把同步的 `createRuntimeTestHost()` 伪装成 async，也不让已经 booted 的 static/dynamic resource 再走一次 `.start()`。

### 3. 同一 domain 使用同一 driver vocabulary

in-process author hosts 只要经过同一个生产 domain boundary，就复用相同的 facade 类型与名字：

```ts
host.config.patch(...)
host.http.fetch(...)
host.commands.execute(...)
host.workbench.open(...)
```

`RuntimeTestHost` 与 `StaticRuntimeTestHost` 应从同一内部 driver factory 组合这些 facade，避免分别维护 request normalization、disabled
capability error、Workbench session ownership 与 type declarations。facade 可以共享，不要求整个 host 继承同一 base class。

physical resource 不复制这些 driver：

```ts
await fetch(new URL('/health', runtime.origin))
```

一旦存在真实 origin，标准 Fetch/WebSocket/browser client 才是正确 vocabulary。给 dynamic runtime 再加 `runtime.http.fetch()` 会让调用方无法
从代码判断请求是否真的走过 TCP/Vite carrier。

in-process `host.http.origin` 与 physical `runtime.origin` 都是 normalized immutable HTTP origin string，方便注入标准 client；前者位于 driver
namespace 并不可连接，后者位于 server resource 且可连接。不要返回 mutable `URL` object，也不要仅为统一 property 位置把 physical fetch 包回
`runtime.http`。

### 4. Query 与 diagnostics 命名稳定

直接 Plugin fixture 可以保留：

```ts
host.require(Plugin)
host.isRunning(Plugin)
```

static application test 可以复用这两个**只读** query，因为 fixed constructors 是 application 的公开输入；它不复用
`start/stop/commit/replaceDefinition`。dynamic server 不公开 Plugin instance/query，测试通过 production control/read model 或公开 endpoint
观察状态。

一次性启动事实使用只读 noun，不保留可重复调用的 method：

```ts
host.startupReport // StaticRuntimeStartupReport
```

普通 object/error assertion 使用 Vitest built-ins。只有 `LifecycleFailureCommitSummary` 继续使用
`toHavePluginLifecycleIssue`；不要为了表面统一让 static startup report、dynamic diagnostics 和 commit failure 假装成同一个 error shape。

## Static test API 的具体收口

当前 `createStaticRuntimeTestHost()` 实际会完成 application configure、prepare 和 `host.start()`，却返回仍带 `.start()`/`.stop()` 的
`StaticRuntime`，并把 `ctx` 与顶层 `fetch` 暴露给 author tests。这同时产生了“create 到底是否 ready”和“已经启动为何还能 start”的认知成本。
当前 workspace 的 19 个 test calls 在 factory resolve 后没有再次调用 `.start()`；成功路径却反复用 `finally` 调 `.stop()`。真实使用已经
证明它是 booted owned resource，而不是需要两阶段控制的 plan。

冻结 replacement：

```ts
import { startStaticRuntimeTestHost } from '@pluxel/runtime-static/test'

await using host = await startStaticRuntimeTestHost(
	defineStaticRuntime({
		name: 'orders-app',
		plugins: [OrdersPlugin],
		configure: () => ({
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { autoStart: [pluginNodeAddressOf(OrdersPlugin)] },
			},
		}),
	}),
)

expect(host.isRunning(OrdersPlugin)).toBe(true)
const response = await host.http.fetch(new Request(new URL('/orders', host.http.origin)))
expect(response.status).toBe(200)
```

options 从 application 的 binding type 推导，不能像当前实现一样无条件把 `bindings` 标为 optional：

```ts
type StaticRuntimeTestHostOptions<TBindings extends StaticRuntimeBindings> = Readonly<
	{ env?: StaticRuntimeEnvironment } & ({} extends TBindings
		? { bindings?: TBindings }
		: { bindings: TBindings })
>

declare function startStaticRuntimeTestHost<
	const TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<TPlugins, TBindings>,
	...options: {} extends TBindings
		? [options?: StaticRuntimeTestHostOptions<TBindings>]
		: [options: StaticRuntimeTestHostOptions<TBindings>]
): Promise<StaticRuntimeTestHost<TPlugins>>
```

没有 required binding 时保持零 options；存在 `{ serviceUrl: string }` 等 required binding 时，整个 options 与 `bindings` 都在编译期必填。
`env` 缺席固定为 `{}`，不读取 test process environment；application 的 `configure()` 仍是 persistence/database/Vault 等配置的唯一 authority，
test helper 不暗中覆盖为 memory。需要隔离的 fixture 在 application 中显式声明 memory 或 test-owned temporary backend。

最终 surface：

```ts
type StaticPluginTestTarget<TPlugins extends readonly PluginConstructor[]> =
	TPlugins[number] | PluginForkRef<TPlugins[number]>

interface StaticRuntimeTestHost<
	TPlugins extends readonly PluginConstructor[] = readonly PluginConstructor[],
> extends AsyncDisposable {
	readonly startupReport: StaticRuntimeStartupReport
	readonly config: RuntimeConfigTestDriver<StaticPluginTestTarget<TPlugins>>
	readonly http: RuntimeHttpTestDriver
	readonly commands: RuntimeCommandsTestDriver
	readonly workbench: RuntimeWorkbenchTestDriver<StaticPluginTestTarget<TPlugins>>
	require<TTarget extends StaticPluginTestTarget<TPlugins>>(
		target: TTarget,
	): PluginInstanceFor<TTarget>
	isRunning(target: StaticPluginTestTarget<TPlugins>): boolean
	dispose(): Promise<void>
}
```

只读 query 和 target-taking driver 只接受 application `plugins` tuple 中的 constructor，或以其建立的 `PluginForkRef`；
`require(UnrelatedPlugin)` 和对 catalog 外 Plugin 的 config/Workbench 操作应在编译期拒绝。static fixed catalog 限制 implementation code，
不表示 runtime state 不能 materialize 已声明的 fork identity。query 不接受 raw node address，也不会创建缺失 fork。

不包含：

- `.start()` / `.stop()`：factory 已完成 application boot，scope 由 dispose 结束；
- `start(Plugin)` / `commit()`：会绕过 static application 的 runtime-state/control-plane authority；
- `replaceDefinition()` / HMR：source replacement 应经过真实 static Vite plugin；
- root `ctx`、raw service 与 internal host；framework tests 使用 internal harness；
- 顶层 `fetch()`：与 RuntimeTestHost 统一为 `http.fetch()`；
- 顶层 physical `origin`：这个 host 只有 logical `host.http.origin` 且明确 in-process；真实 static Vite 或 artifact smoke 使用真实 launcher。

当前 `@pluxel/runtime-static/test.openRuntimeSessionTestConnection(origin)` 也不保留。workspace 只有一个调用，属于 Runtime Session + Node
WebSocket carrier 的 framework conformance，不是 static application author behavior；实现迁移到 `@pluxel/runtime-static/internal/test` 或该 test
文件的 package-local fixture。未来若 production Runtime Session 出现多个 Node client consumer，应先设计 production client entry，不把单一
framework wiring 固化成 static test API。

`startupReport` 保留 static 产品已有的 partial startup/report 语义。Plugin start failure 未必使整个 static application boot reject，因此不能套用
RuntimeTestHost strict `start(Plugin)` 的 throw contract。普通测试可以直接对 `startupReport.entries` 使用 `toContainEqual`、`objectContaining` 等
Vitest built-ins；只有真实调用点证明 identity diagnostics 难以表达时，才评估 matcher extension。

public report 的精确形状是：

```ts
type StaticRuntimeReportEntry = Readonly<{
	address: PluginNodeAddress
	displayName: string
	rootExportName: string
	status: StaticRuntimePluginStatus
	message?: string
}>

type StaticRuntimeStartupReport = Readonly<{
	runtime: string
	entries: readonly StaticRuntimeReportEntry[]
}>
```

`StaticRuntimeStartupReport` 在本次 breaking refactor 中只保留稳定的 `runtime + entries` read model，不再携带
optional raw `commit: CommitSummary`。static Vite/HMR formatter 和 framework tests 需要 restart delta、blockedBy slot 或 planning facts 时，使用
`@pluxel/runtime-static` 自己的 internal report/harness；不能从 public application/test return 重新泄漏 generic host 已经删除的 raw success
summary。fatal configure/prepare/persistence failure仍 reject factory，不伪装成一条 Plugin status。

## Static physical smoke

static 不因为 dynamic 有 programmatic direct launcher 就新增 `startStaticDevRuntime()`。当前真实入口已经足够清楚：

- development/source/HMR smoke：运行安装了 `staticRuntimeVitePlugin({ entry })` 的项目 Vite command；
- production artifact smoke：启动 freezer 生成的 Node application/artifact，并从外部访问它；
- application contract/in-process HTTP：使用 `startStaticRuntimeTestHost(application)`。

static production artifact 包含 deployment filesystem、variant、public assets、Node listener、TLS/env 与 signal ownership。用一个直接接收
application object 的“server test host”无法验证这些事实；它只能制造看似 physical、实际绕过 freezer 的第四条入口。

如果未来至少两个非-test application host 需要进程内拥有 static Node artifact，再从 production adapter 提取 programmatic launcher；不能只
为了与 dynamic 方法列表对齐而新增。

## Vite options 的小范围统一

static Vite plugin 已使用：

```ts
staticRuntimeVitePlugin({ entry: './src/pluxel.static.ts' })
```

dynamic 外层模块也是 canonical Runtime entry，而不是一份可以内联传入的普通 config value。breaking refactor 统一为：

```ts
dynamicRuntimeVitePlugin({ entry: './src/pluxel.dynamic.ts' })
startDynamicDevRuntime({ entry: new URL('./pluxel.dynamic.ts', import.meta.url) })
```

`entry` 只统一“被 Vite 加载的 canonical module”这一真实共同概念；`defineStaticRuntime()` 与 `defineDynamicRuntimeConfig()` 的内部 schema
仍保持不同。不要进一步把两者改成含糊的 `defineRuntime({ mode })`。

## 验收矩阵

重构前至少用真实调用点证明：

1. 普通 Plugin test 只需 `createRuntimeTestHost()` 与所选 drivers；
2. static application test 能删除当前 `.start()`/`.stop()`、root `ctx` 与顶层 `fetch` 样板；
3. Runtime 与 static test host 的相同 driver 通过共享 conformance suite；
4. static partial startup failure 保留结构化 report，fatal setup failure 在无泄漏清理后 reject；
5. dynamic/static Vite plugin 对 `entry` 使用同一 path normalization rules；
6. dynamic programmatic launcher 与 dynamic Vite plugin 共享 boot/carrier implementation；
7. static Vite 与 production artifact smoke 不依赖 `StaticRuntimeTestHost` 私有状态；
8. 没有 public `mode`/`carrier` flag、万能 `RuntimeHost` union 或仅为类型对称新增的 method。
