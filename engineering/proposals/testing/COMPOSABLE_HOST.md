# Composable Plugin test host API

> 状态：设计已冻结，尚未实现。本文会影响 public test API、资源生命周期与测试教程；prototype 只验证
> 实现可行性，只有 correctness blocker 或代表性迁移的反证才能重开 public surface。当前行为仍以
> [`../../../docs/development/testing.md`](../../../docs/development/testing.md) 为准。

## 决策问题

如何让 coding agent 用最少的框架知识测试 Plugin 的 lifecycle、config、HTTP、commands、Workbench、RPC、Vault、database、worker
和外部依赖，同时不把不同层级的真实语义压成一个万能 mock host？

当前 test host 很诚实，但普通行为测试经常需要：

```ts
host.add(Plugin)
host.start(Plugin)
await host.commit()
const plugin = host.require(Plugin)
```

有依赖或 config 时还会增加 `add([Provider, Consumer])`、`cfg().set()` 与 `setAutoStart(true)`。这些方法分别对应真实 catalog、
session intent、config record 和 durable policy，但多数 Plugin 测试只想表达一个可观察结果：

> 用这份 config 和这些可用 provider 启动目标 Plugin，并在成功后取得运行实例。

冻结结论是：

1. test host 保留产品语义，但不要求普通测试手工编排内部 reconciliation 步骤；
2. Runtime 高频行为使用立即执行并等待稳定的 `host.start/stop/restart()`；Core 使用诚实的
   `host.add/remove/restart()`，definition-wide replacement 使用低频但明确的 `replaceDefinition()`；
3. `start/add` 接受一个或一组 explicit roots；真实调用点已经证明同批启动多个互不依赖 Plugin 是常用行为；
4. 只有测试多个 domain change、同一应用边界或 failure summary 时，使用 callback-scoped `host.commit()` / `host.commitExpectFail()`；
5. 删除 host 顶层可遗忘的隐式 staging，不保留“调用若干同步 method，最后记得 commit”的默认模型；
6. 不提供含糊的 `enable/disable`，始终区分 catalog availability、process session intent、durable auto-start policy 与实际 lifecycle；
7. public author host 不暴露 root `ctx`；inbound surface 通过窄 driver 进入，framework white-box authority 进入 internal test harness；
8. local object contract、in-process runtime、real carrier 与 browser test 继续是不同层级。

## 真实调用点信号

在当前 workspace 的 test files 中，粗略搜索得到：

| 调用                   | 数量级 |
| ---------------------- | -----: |
| `host.add`             |    275 |
| `host.start`           |    223 |
| `host.commit`          |    470 |
| `host.commitAllowFail` |     43 |
| `host.stop`            |     52 |
| `host.restart`         |     18 |
| `host.cfg`             |    214 |
| `host.require`         |    327 |
| `host.isRunning`       |     93 |
| `host.ctx.*`           |    122 |

数量本身不是删除 API 的理由，但真实代码中反复出现的 `add -> start -> commit -> require` 证明“启动一个可测试 Plugin”值得成为一个
立即完成的 test behavior。进一步搜索还发现多个 package 自己定义 `addStarted(host, plugins)`，并在上百个调用点一次启动 2–4 个互不依赖
Plugin；因此 single-root-only API 会把真实高频路径错误地下放到 advanced transaction。相反，`setAutoStart(true)` 主要出现在 Runtime 自身
policy/cold-boot tests；它不应偷偷进入普通 `start()`。

## 一个稳定 mental model

coding agent 只需要先选择测试层，再组合所需 driver：

```text
pure function/object
  -> no host

Core Plugin behavior
  -> Core test host
  -> graph/config/lifecycle/effects

Runtime Plugin behavior
  -> Runtime test host
  -> top-level lifecycle + selected domain drivers
       ├─ http
       ├─ commands
       └─ workbench

Direct RpcTarget contract
  -> local RPC client, no host

Static application wiring
  -> static application test host

Dynamic source / HMR / physical carrier
  -> project Vite command or production dynamic launcher

Static deployment artifact
  -> launch the generated artifact

Workbench renderer/Shell behavior
  -> browser/React test
```

真实 dynamic dev server 的收敛见 [`DEV_SERVER_SMOKE.md`](DEV_SERVER_SMOKE.md)。test package 不建立第二个 launcher；项目直接运行 Vite，
或由现有 production programmatic launcher 提供 ready/disposable resource。两者都不会复用 `host.start(Plugin)`，因为 dev server 的 catalog
authority 必须来自 config、source catalog 与 HMR。

static application test 的对应收敛见 [`RUNTIME_SURFACE_ALIGNMENT.md`](RUNTIME_SURFACE_ALIGNMENT.md)：它复用本提案的 domain driver 与只读
query，但不复用 fixture lifecycle mutation。static fixed catalog、configure/prepare 与 runtime-state startup 必须仍由 application boot 一次完成。
除非 assertion 本身依赖这些 application facts，Plugin 作者仍应使用 `createRuntimeTestHost()`；不把同一 behavior suite 迁到
static/dynamic 入口重复执行。dynamic 更不是 test host，`startDynamicDevRuntime()` 是可被测试和 coding agent 调用的 production
launcher。

同一 Runtime test host 上的 driver 共享一个真实 root、Plugin graph、generation ownership 和 disposal boundary，因此可以自然组合：

```text
Workbench RPC writes credential to Vault
  -> HTTP request uses credential
  -> command reports new status
  -> Plugin stop withdraws every published surface
```

测试不需要在每个 driver 之间复制 Plugin 或同步伪状态。

### 只有五条调用语法

| 形状                   | 执行语义                                             | 例子                                                                     |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `create*TestHost()`    | 同步创建未启动 Plugin 的 test world                  | `await using host = createRuntimeTestHost()`                             |
| host lifecycle command | 立即提交并等待稳定                                   | `await host.start(A)`                                                    |
| callback draft command | 同步记录，不单独执行                                 | `await host.commit(change => change.start(A))`                           |
| sync query             | 只读已提交状态                                       | `host.require(A)` / `host.isRunning(A)`                                  |
| domain driver/lease    | 调用真实 inbound boundary；持有资源时返回 disposable | `host.http.fetch(...)` / `using opened = await host.workbench.open(...)` |

public API 不出现第六种“有时 staging、有时立即执行”的 method。同一个 receiver 上，返回 `Promise` 的 lifecycle command 已稳定；
`change` 上返回 `undefined` 的 command 只属于外层 commit。这条语法必须在 type tests 中固定。

## 冻结的 public surface 一览

除非 prototype 的真实迁移矩阵给出反证，最终 author-facing surface 固定为：

| 入口                       | 初始方法                                                                         | 不包含                                                           |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `createCoreTestHost()`     | 返回 async-disposable `CoreTestHost`                                             | callback lifetime wrapper                                        |
| Core host 顶层             | `add/remove/restart/replaceDefinition/commit/commitExpectFail/require/isRunning` | `start/stop/get/has/last/status/ctx`                             |
| `createRuntimeTestHost()`  | 返回 async-disposable `RuntimeTestHost`                                          | callback lifetime wrapper、physical listener                     |
| Runtime host 顶层          | `start/stop/restart/replaceDefinition/commit/commitExpectFail/require/isRunning` | staged mutation、`add/remove/fork`、重建的 `status`              |
| `runtimeHost.config`       | `patch`                                                                          | raw ConfigService、field-path UI protocol、test-only `reset/set` |
| `runtimeHost.http`         | `origin/fetch`                                                                   | WebSocket Upgrade、通用 RPC codec                                |
| `runtimeHost.commands`     | `execute/list`                                                                   | `register/createMount`                                           |
| `runtimeHost.workbench`    | `open`                                                                           | UI action、registry、transport mode                              |
| Plugin database assertion  | owner-bound `PluginDatabaseHandle.read()`                                        | `host.database`、raw PGlite/backend admin                        |
| fork value                 | `definePluginFork(Plugin, forkId)`                                               | host mutation、raw node address                                  |
| standalone local RPC       | `createLocalRpcClient`                                                           | Runtime host、URL、physical carrier                              |
| official Vitest assertion  | `expect(failure).toHavePluginLifecycleIssue(target, expected)`                   | 通用 matcher suite、snapshot serializer、global equality tester  |
| framework internal harness | root/service/transaction/failure-injection authority                             | `@pluxel/test` 主入口 re-export                                  |

表中没有为了对称而预留的方法。新增 surface 必须由至少两个真实 author-side 调用点或一个不可替代的 correctness boundary 证明。

## 必须保留的状态区分

测试 API 的简洁不能删除以下产品事实：

| 概念                      | 含义                                                    | test API                                              |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| catalog availability      | host 是否拥有某个 concrete implementation candidate     | advanced change 的 `catalog.add/remove`               |
| session intent            | 本次进程明确希望 node running/stopped                   | `host.start/stop`；advanced `change.start/stop`       |
| durable auto-start policy | 下次 cold boot 是否自动希望 node running                | framework internal harness                            |
| actual lifecycle          | 当前 generation 是否 running、failed、blocked、draining | `host.isRunning/require` 与 slot-free failure summary |
| desired Plugin config     | 已保存、等待或已经应用的 raw record/revision            | fixture `initialConfig`；live `host.config.patch`     |
| applied Plugin config     | 当前 generation 已确认的 snapshot/revision              | config result 与 Plugin public behavior               |

因此不提供：

```ts
host.enable(Plugin)
host.disable(Plugin)
```

`enable` 无法回答“加入 catalog”“本次启动”还是“以后自动启动”。对 coding agent 而言，短但多义比多一个单词成本更高。

public author `change` 也不提供 `policy.setAutoStart()`。当前真实调用全部属于 Runtime cold-boot、RuntimeState、Management 或 capability
framework tests；Plugin 不拥有自己的 durable launch policy。相关测试进入 Runtime internal harness，普通 Plugin 测试只表达本进程
`start/stop`。这也让“public `start()` 永不修改 auto-start policy”成为更容易验证的单向边界。

## 冻结的 Runtime API

Plugin lifecycle 改为 host 顶层主能力，不再经过 `plugins` namespace。`createRuntimeTestHost()` 创建的就是 Plugin Runtime test
host；对它而言 `start(Plugin)` 不是次级 driver，而是最高频的核心行为。在每个 lifecycle assertion 前重复 `plugins.` 虽然在
领域归属上能辩护，但没有为 caller 增加新的决策信息。

分层因此是：

- 顶层只放 Plugin world 的核心 fixture/lifecycle/query：`start/stop/restart/replaceDefinition/commit/require/isRunning`；
- 二级 driver 保留领域 namespace：`config.patch`、`http.fetch`、`commands.execute`、`workbench.open`；
- host 自身不需要 `start()`；factory 建立 host，`dispose()` 结束 host，因此不与 Plugin target 形式的 `start(Plugin)` 竞争；
- 不同时提供 `host.plugins.start()` alias，避免形成两套教程。

`host.lifecycle.start(Plugin)` 仍不采用：`lifecycle` 容易包含 host/lease/worker 等多种 lifetime，却没有说明 target domain。
`host.plugin(Plugin).start()` 也不采用：它会制造可逃逸、replacement 后 stale 的 handle，并使 batch 变得别扭。顶层 method 的
Plugin constructor / fork ref 参数已经在类型和 autocomplete 中消除了 target 歧义。

### Host lifetime

主要教程路径使用显式 async disposal：

```ts
import { createRuntimeTestHost } from '@pluxel/runtime/test'

await using host = createRuntimeTestHost()
```

host 实现 `AsyncDisposable`，并保留显式 `dispose()` 作为同一幂等 operation。最终 public surface 只保留
`createCoreTestHost()` / `createRuntimeTestHost()`；删除 `withHost()`、`withRuntimeHost()`、旧 `createHost()` 与
`createRuntimeHost()`，不留下两种 lifetime 教程或 compatibility alias。仓库已经使用 explicit resource management，嵌套 callback wrapper
不再提供独立价值。

factory 保持同步是有意的：它只构造隔离的 test world，不启动 Plugin、不打开 port，也不宣称异步 readiness。所有会改变或观察稳定状态的
operation 仍返回 Promise。`AsyncDisposable` 描述 teardown，而不意味着 construction 必须伪装成 async；如果某个未来 backend 在 host 可用前
确实需要 fallible async initialization，应重新审视 factory contract，不能把后台 Promise 藏进同步创建。

### Capability 默认值逐项保持真实

Runtime capability 不是同一种开关，不能为了 options 外观整齐而统一成“全部默认关闭”。test host 接受一个
`RuntimeTestHostConfig` 对象，复用 production config value；不再接受第二个包含 internal root seam 的 public options 参数。config 只投影
Plugin 作者确实需要的 `name/logger/events/plugins/persistence/database/workers/management/workbench/vault`；`configService/runtimeState` snapshot、
route capability installation、request address、artifact resolver 等进入 internal/specialized host。默认固定为：

| capability | option 缺席时                            | 显式配置                                          |
| ---------- | ---------------------------------------- | ------------------------------------------------- |
| Workbench  | disabled，零 backend                     | `workbench: { enabled: true }`                    |
| Vault      | disabled，零 backend                     | `vault: {}` 或具体 Vault config                   |
| Database   | service 存在，首次 acquire 才加载 PGlite | `database: false` 或明确的 PGlite/Postgres config |
| HTTP       | in-process directory 可用，不打开端口    | physical carrier 进入专门 host                    |
| Commands   | owner-aware catalog 可用                 | 不需要 test-only enable flag                      |
| Workers    | service 可用，pool 保持惰性              | 使用既有 worker budget config                     |

test world 自身的 control/config/runtime-state store 始终是每 host 隔离的 memory implementation，不暴露 backend injection；这些是 fixture
authority 的实现资源，不是 Plugin capability。`persistence` 未传时则显式规范化为 production 已支持的 `{ mode: 'memory' }`，避免 implicit-memory
warning，同时保持真实 namespace、flush、revision 和 writable semantics；调用方传入 production `persistence` config 时原样覆盖。factory 不读取或
复用进程级默认目录，因此两个 test host 不得共享隐式状态。

host disposal 只关闭自己取得的 service/connection，不删除调用方显式传入的 persistence path、Postgres database 或其他 durable data。需要磁盘
隔离时由 `@pluxel/test/fixtures` 创建并拥有临时目录；需要 database cleanup 时由具体 integration fixture 管理。`dispose()` 不能因“这是测试”就
把 caller-owned backend 当成可递归删除的资源。

测试只为真正 optional 的能力明确开启所需项：

```ts
await using host = createRuntimeTestHost({
	vault: {},
	workbench: { enabled: true },
})
```

这会删除当前 `createRuntimeHost()` 为测试偷偷默认开启 Workbench 的特殊行为。几个规则固定如下：

- Workbench/Vault option 缺席就是 disabled，不因 Plugin 声明、driver 调用或另一 capability 被开启而自动安装；
- `host.workbench` 等 driver facade 在 host construction 时一次性建立并冻结，以保持 object shape 和 autocomplete 稳定；facade 本身不安装
  backend，disabled 时调用必须立即抛出 setup error；
- driver method 不依赖动态 `this`，因此 `fetch: host.http.fetch` 等注入方式安全；
- disabled capability 不构造 backend、不打开 carrier，也不改变 Context shape；
- capability 之间若存在真实安装依赖，host creation 应列出缺失项并失败，不能静默补齐；
- 每项 capability 沿用自己的 production config contract，不发明统一的 `{ enabled }` wrapper；文档只给出该 capability 的 canonical 常用写法。

Workbench/Vault 的默认关闭让测试文件成为安全能力的最小清单；Database/Commands/Workers 则保留真实 Runtime 的惰性 baseline，避免每个
正常 Plugin 重复声明基础设施。disabled 测试仍显式传 production 支持的 `false`，不把“缺席”和“强制禁用”错误地视为所有 domain 都相同。

### 高频路径：启动并取得实例

```ts
const worker = await host.start(WorkerPlugin, {
	initialConfig: {
		endpoint: 'https://api.example.test',
		concurrency: 2,
	},
})
```

这个操作的语义固定为：

1. 把目标 underlying constructor candidate 加入 test catalog，fork ref 则同时 ensure durable fork；
2. seed 目标 node 的 initial raw config（若提供）；
3. 为目标 node 添加本进程 `running` session intent；
4. 提交一次 strict reconciliation 并等待稳定；
5. start failure 时抛出携带 slot-free lifecycle failure projection 的 `PluginLifecycleAssertionError`；
6. 成功时返回当前运行 instance。

它明确**不**设置 auto-start policy。test host disposal 仍停止完整 dependency closure。

`start()` 表示 ensure-running：目标已经 running 且没有 `initialConfig`/catalog change 时返回当前 instance，不暗中 restart。需要证明新
generation 时必须显式调用 `restart()`。

`initialConfig` 只表示 fixture bootstrap，不表示“此刻更新 config”。它只在目标尚无 desired config record、且尚未进入 lifecycle 时可用，并在
同一次 operation 中建立 initial desired record。判断依据是 committed node/config state，不是 helper 的调用次数或 implementation cache：

- validate/prepare 前失败并完整 rollback 时，可以修正输入后重试；
- 一旦 config 已提交或 node 已进入 lifecycle，即使 start 最终 failed/stopped，再传 `initialConfig` 也必须拒绝；
- 后续无论 running 或 stopped，都使用 `host.config.patch()`，并保留其真实 `applied | deferred | saved-not-applied` 结果；
- error 应明确建议 `host.config.patch()`，不能根据当前状态把同一 option 偷偷切换成 live update。

config 输入类型必须诚实。当前 `ConfigPatch<T>` 从 instance 的非 function field 猜测 config，同时又用 `Record<string, unknown>` 放行任意 key；
它既不能看到 private `this.configs.use(schema)`，也不能提供可靠 autocomplete。新 API 在 Plugin constructor 尚未携带公开 type-level config
contract 时明确接受 `RawPluginConfig`，始终通过 lowering 得到的 authoritative schema 做 runtime validation。Plugin package 若公开 schema
input type，调用方可以在变量处使用 `satisfies`，但 test host 不伪造 `ConfigPatch<T>` 精确类型。未来只有作者 API 本身建立真实 constructor →
config input 类型关系后，才能无 breaking semantic change 地收紧这一参数。

同一个动词在不同 lifecycle state 的行为固定如下：

| 调用前 state               | `start(target)`                                                      |
| -------------------------- | -------------------------------------------------------------------- |
| target 尚未进入 catalog    | add target、可选 bootstrap、提交 running intent，成功后返回 instance |
| known stopped              | 提交 running intent，成功后返回 instance；不接受 `initialConfig`     |
| failed / blocked           | 显式 retry start，成功后返回 instance；不接受 `initialConfig`        |
| running                    | 无 options 时返回当前 instance，不产生新 generation                  |
| mutation/commit 正在进行中 | fail-fast concurrency error，不隐藏排队                              |

running target 上若 options 会造成有效 catalog change，也必须改用显式 `commit()`；完全重复的 catalog candidate 可以视为 no-op。这样
`start()` 不会因为 caller 顺手多传一个 provider 就暗中改变 running graph 或 generation。

有 required provider 时，调用方必须提供其 implementation candidate，但不需要显式启动 provider：

```ts
const consumer = await host.start(ConsumerPlugin, {
	catalog: [ProviderPlugin],
})
```

`catalog` 表示“这些 implementation 在 host 中可用”，不是重复声明 dependency。真实 dependency edge 仍只来自 constructor lowering；
Core graph 根据 Consumer 的 required edge 启动 Provider。使用 `dependencies`、`providers` 或 `with` 会误导调用方以为 test API 在声明或
覆盖 dependency，因此名称选择 `catalog`。

冻结签名：

```ts
type RawPluginConfig = Readonly<Record<string, unknown>>

type PluginTestLifecycleIssue = Readonly<{
	plugin: PluginNodeAddress
	phase: PluginLifecycleIssuePhase
	kind: PluginLifecycleIssueKind
	message: string
	error?: PluginLifecycleErrorInfo
	blockedBy?: PluginNodeAddress
}>

type PluginTestCommitSummary = Readonly<{
	lifecycleReport: Readonly<{
		ok: boolean
		issues: readonly PluginTestLifecycleIssue[]
	}>
}>

type LifecycleFailureCommitSummary = PluginTestCommitSummary &
	Readonly<{
		lifecycleReport: Readonly<{
			ok: false
			issues: readonly [PluginTestLifecycleIssue, ...PluginTestLifecycleIssue[]]
		}>
	}>

declare const pluginForkRefBrand: unique symbol

interface PluginForkRef<TPlugin extends PluginConstructor> {
	readonly plugin: TPlugin
	readonly forkId: string
	readonly [pluginForkRefBrand]: TPlugin
}

declare function definePluginFork<TPlugin extends PluginConstructor>(
	plugin: TPlugin,
	forkId: string,
): PluginForkRef<TPlugin>

type PluginTestTarget<TPlugin extends PluginConstructor = PluginConstructor> =
	TPlugin | PluginForkRef<TPlugin>

type PluginInstanceFor<TTarget extends PluginTestTarget> = TTarget extends PluginConstructor
	? InstanceType<TTarget>
	: TTarget extends PluginForkRef<infer TPlugin>
		? InstanceType<TPlugin>
		: never

type DependencyOverrideTarget = Readonly<{
	consumer: PluginTestTarget
	requirement: PluginConstructor
}>

type DependencyOverrideInput = DependencyOverrideTarget & Readonly<{ provider: PluginTestTarget }>

type ProviderDefaultInput = Readonly<{
	requirement: PluginConstructor
	provider: PluginConstructor
}>

type PluginInstances<TTargets extends readonly PluginTestTarget[]> = {
	readonly [Index in keyof TTargets]: TTargets[Index] extends PluginTestTarget
		? PluginInstanceFor<TTargets[Index]>
		: never
}

type PluginInitialConfigOptions = Readonly<{
	initialConfig?: RawPluginConfig
}>

type RuntimePluginStartOptions = PluginInitialConfigOptions &
	Readonly<{
		catalog?: readonly PluginConstructor[]
	}>

type RuntimePluginBatchStartOptions = Readonly<{
	catalog?: readonly PluginConstructor[]
}>

interface RuntimeConfigTestDriver<TTarget extends PluginTestTarget = PluginTestTarget> {
	patch(target: TTarget, patch: RawPluginConfig): Promise<PluginConfigResult>
}

interface RuntimeHttpTestDriver {
	readonly origin: string
	fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
}

interface RuntimeCommandsTestDriver {
	execute(name: string, input: unknown, context?: CommandContext): Promise<unknown>
	list(): readonly CommandDescriptor[]
}

interface RuntimeTestHost extends AsyncDisposable {
	readonly config: RuntimeConfigTestDriver
	readonly http: RuntimeHttpTestDriver
	readonly commands: RuntimeCommandsTestDriver
	readonly workbench: RuntimeWorkbenchTestDriver
	start<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: RuntimePluginStartOptions,
	): Promise<PluginInstanceFor<TTarget>>
	start<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
		options?: RuntimePluginBatchStartOptions,
	): Promise<PluginInstances<TTargets>>
	stop(target: PluginTestTarget): Promise<void>
	restart<TTarget extends PluginTestTarget>(target: TTarget): Promise<PluginInstanceFor<TTarget>>
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): Promise<void>
	commit(build: (change: RuntimePluginTestChange) => undefined): Promise<void>
	commitExpectFail(
		build: (change: RuntimePluginTestChange) => undefined,
	): Promise<LifecycleFailureCommitSummary>
	require<TTarget extends PluginTestTarget>(target: TTarget): PluginInstanceFor<TTarget>
	isRunning(target: PluginTestTarget): boolean
	dispose(): Promise<void>
}

type RuntimeTestHostConfig = Pick<
	RuntimeHostConfig,
	| 'name'
	| 'logger'
	| 'events'
	| 'plugins'
	| 'persistence'
	| 'database'
	| 'workers'
	| 'management'
	| 'workbench'
	| 'vault'
>

declare function createRuntimeTestHost(config?: RuntimeTestHostConfig): RuntimeTestHost
```

这里继承的 `config.plugins` 是 production `PluginServiceConfig`（`startTimeoutMs/drainTimeoutMs/startConcurrency/stopConcurrency`），不是 Plugin
constructor list 或 catalog seed。类型文档必须直接写出这一点；candidate availability 仍只有 `start(..., { catalog })` 与对应 draft command。
不要为了消除字段重名在 test API 中另造 `lifecycle` alias。

单个 constructor/fork ref 返回精确 instance；target array 表示同一次 Runtime session commit 中的多个 explicit roots，并按输入顺序返回 readonly
typed tuple。空 array、重复 root 在 validate 阶段拒绝。这个 overload 有真实 workspace helper 作为证据，不扩展成 `startAll()` 平行词汇。
batch 仍遵循真实 failure isolation：若一个 root failed，其他成功 root 不回滚；Promise 以携带 summary 的 assertion error reject，因此 caller 不会
收到虚假的 partial instance tuple。需要断言部分成功时改用 `commitExpectFail(...)` 再分别查询状态。

batch form 有意不接受一个无法保持异构类型关系的 `initialConfig` map。多个 root 需要不同 bootstrap config 时使用一次 `commit()`：

```ts
await host.commit((change) => {
	change.start(BackendPlugin, { initialConfig: backendConfig })
	change.start(ConsumerPlugin, { initialConfig: consumerConfig })
})
```

随后只对测试需要直接调用的节点使用 `require()`；不要为返回一组可能 failed/blocked 的 instances 发明 partial tuple result。

`catalog` 也只保留这一处普通 fixture 入口，不再增加 host-construction `catalog` 或 `withProviders()` 的第二种写法。single/batch roots 的
supporting candidates 放在 `start(..., { catalog })`；需要单独控制 availability 时进入 callback-scoped `commit()`。它只对 required/optional
provider 提供相同的 candidate availability，不承诺 optional provider 会 running 或被选择：真实 dependency/selection 事实仍来自 Plugin
declaration 和 session state。场景要求 provider 作为独立 running root 时，把它放进 batch `start([Provider, Consumer])`。

### 多 Plugin、依赖与实现选择

一次启动多个独立 root 直接使用 batch：

```ts
const [api, worker, scheduler] = await host.start([ApiPlugin, WorkerPlugin, SchedulerPlugin], {
	catalog: [DatabaseProvider, QueueProvider],
})
```

array 中的是 explicit roots；`catalog` 中的是依赖解析可用的 candidates。required edge 仍由 constructor lowering 得出，因此不需要按
依赖顺序手工 start。多个 root 需要不同 initial config 时，在同一 callback 中记录多个同步 command：

```ts
await host.commit((change) => {
	change.start(ApiPlugin, { initialConfig: apiConfig, catalog: [DatabaseProvider] })
	change.start(WorkerPlugin, { initialConfig: workerConfig, catalog: [QueueProvider] })
})
```

“让 implementation 可用”与“选中 implementation”是两件事。只有一个 compatible candidate 时使用真实默认推导；多个 concrete
implementation 时，使用显式 provider default 或 consumer-specific override：

```ts
await host.commit((change) => {
	change.catalog.add([MemoryCachePlugin, RedisCachePlugin])
	change.dependencies.setDefault({
		requirement: CachePlugin,
		provider: MemoryCachePlugin,
	})
	change.dependencies.setOverride({
		consumer: WorkerPlugin,
		requirement: CachePlugin,
		provider: RedisCachePlugin,
	})
	change.start([ApiPlugin, WorkerPlugin])
})
```

这里 Api 使用 Memory default，Worker 使用 Redis override。不增加 `start(..., { implementation })` 之类快捷参数；选择的 key 必须
包含 requirement，consumer-specific selection 还必须包含 consumer，否则多依赖场景会产生隐式全局状态。

### 高频 lifecycle behavior

```ts
await host.stop(WorkerPlugin)
const next = await host.restart(WorkerPlugin)
await host.replaceDefinition(WorkerPlugin, WorkerPluginV2)
```

- `stop()` 提交本进程 stopped intent、等待 drain，catalog 与 auto-start policy 不变；已知且已经 stopped 的 target 是稳定 no-op，从未进入
  catalog 的 target 是 invalid target，不伪装成成功；
- `restart()` 只接受当前 running target，提交一次显式 generation restart，成功后返回新 instance；stopped target 应使用 `start()`；
- `replaceDefinition()` 只接受 current/next constructor，校验两者 canonical definition address 相同，并替换 default 与所有 forks 共享的
  implementation；
- replacement 只返回完成信号，不暴露 definition family 的内部 planning summary；需要 instance 时使用与 next constructor 绑定的 target 调用
  `require()`；
- 方法返回的 Promise resolve 时，operation 已稳定且 cleanup 已 settle 或进入结构化 drain report；
- host driver 不提供同步 staged versions，因此调用后忘记 commit 不会产生“断言旧状态但测试仍通过”的错误。

`replaceDefinition(Current, Next)` 不会把任意 `Next` constructor 偷偷改写为 `Current` 的 canonical identity。真实 loader/HMR test 通过 source
重新求值得到 replacement facts；只测试 lifecycle replacement 的 synthetic fixture 显式声明：

```ts
import { lowerTestReplacement } from '@pluxel/test/unsafe'

lowerTestReplacement(Current, Next)
await host.replaceDefinition(Current, Next)
```

这个 helper 必须在 replacement command 前执行，并验证 Next 的 dependency/config lowering facts；它不由 host 自动调用，也不从
`@pluxel/core/test`、`@pluxel/runtime/test` re-export。coding agent 因此能看出测试正在伪造一次 module evaluation，而普通 replacement API
仍保持 production identity guard。

catalog removal 是较低频且语义不同的操作，不使用顶层 `remove()` 模糊 stop 与 unavailable。它进入 advanced change：

```ts
await host.commit((change) => {
	change.catalog.remove(WorkerPlugin)
})
```

### 多变化场景：callback-scoped commit

测试真正关心同一次 graph/config/dependency/session change 时：

```ts
await host.commit((change) => {
	change.start(ConsumerPlugin, {
		catalog: [ProviderPlugin],
		initialConfig: { endpoint: 'https://example.test' },
	})
	change.dependencies.setDefault({
		requirement: StoragePlugin,
		provider: ProviderPlugin,
	})
})
```

callback 是同步、短生命周期的 draft authority：

- 只能在 callback 中调用；
- 不能保存、return 或跨 `await` 使用；callback 必须返回 `undefined`；
- callback 返回后一次 validate/prepare/apply；
- callback throw 时整个 draft rollback；
- operation 完成前另一项 host mutation 立即失败，不在隐藏 queue 中等待；
- public target 只接受 constructor/`PluginForkRef`，不接受 display name、address 或手写 key；
- strict commit 成功只返回完成信号；预期 lifecycle failure 的 commit 返回 slot-free、结构化的 production report projection。

第二项 mutation 的 concurrency error 应根据调用形状建议 batch `start([A, B])` 或 callback `commit()`；不能只报告“busy”，迫使 coding agent
猜正确组合方式。`Promise.all([host.start(A), host.start(B)])` 明确无效，因为哪个 operation 先取得 authority 不应决定 test graph。

`change` 与 host 共享核心 command vocabulary，但不伪装成同一种执行对象：

```ts
await host.commit((change) => {
	change.start(ProviderPlugin, { initialConfig: providerConfig })
	change.start(ConsumerPlugin, { initialConfig: consumerConfig })
	change.restart(ExistingPlugin)
})
```

- `host.start()` 立即提交、等待稳定并返回 instance；`change.start()` 只同步记录同义 command 并返回 `undefined`；
- callback 内不逐项 `await`，只在外层 `await host.commit(...)` 一次；
- Runtime 共享 `start/stop/restart/replaceDefinition` 及 start options；Core 共享 `add/remove/restart/replaceDefinition` 及 add options；
- `require/isRunning`、driver 和 `commit` 不复制到 `change`；draft 内没有可观察的中间 committed state，也不能递归提交；
- `catalog/config/forks/dependencies` 只保留 author 高级变化所需的正交领域命令，不迫使常见 lifecycle 改写成
  `change.session.start()`。

mutation exclusivity 覆盖所有直接的 author-side host state command：顶层 lifecycle/commit 与 `host.config.patch()` 共享一个 fail-fast gate。
`Promise.all([host.config.patch(...), host.restart(...)])` 没有稳定顺序，必须写成两个明确 awaited operations。HTTP/RPC/command 等已开始或并发
进入的 inbound work 继续遵循真实 generation admission、drain 与 cancellation 语义；通过这些产品入口触发的领域工作不被 test gate 改写。
需要精确操纵 reconciliation 内部阶段的测试属于 framework internal harness。

同步 `require()/isRunning()` 在 mutation 进行中同样 fail-fast；不能返回 operation 开始前的 committed snapshot，让 caller 误以为它观察到
刚提交的结果。mutation Promise resolve 后 query 才重新可用。driver/inbound work 不受这条 fixture query lock 约束，它们继续观察生产
generation admission 语义。

冻结类型使用 `callback: (change) => undefined`，而不是 TypeScript 宽松的 `=> void`，使 `async` callback 和意外 return 优先在编辑器报错。
draft command 同样声明返回 `undefined`，因此 block callback 和 `change => change.start(A)` 都可以 typecheck；若声明为 `void`，后者会与
callback return contract 冲突。
JavaScript、`any` 或显式 cast 仍可绕过类型，因此 runtime 也必须检查 callback return；任何非 `undefined` 结果（包括 thenable）都 rollback 并
抛出明确 programming error。callback 退出时立刻把 draft authority 标为 inactive，任何被保存到外部后调用的方法都必须 fail-fast。正确性
不能只依赖类型或文档约定。

若返回 thenable，implementation 在同步标记 draft inactive 和 rollback 后必须附加 rejection observer，避免被禁止的 async callback 稍后形成
unhandled rejection；outer `commit()` 仍立即以“callback must be synchronous” programming error reject，不等待或执行 thenable 作为第二种
commit path。async continuation 对 draft 的调用只会得到 inactive-authority error。

完全没有 command 的 `commit(() => {})`，以及任何接收 empty target array 的 command，在 prepare 前作为 programming error 拒绝。新 API 不把 empty
commit 保留为“再 reconcile 一次”的隐式指令；failed target 使用显式 `start(target)` retry，running target 使用 `restart(target)`。一个有效
command 因当前 committed state 而成为 no-op 则仍可成功，例如 ensure-running 的 `start(A)`；这与从未描述任何意图不同。

draft 以 normalized target identity 合并，不依赖语句顺序实现 last-write-wins：

- 完全等价的重复 operation 可以幂等折叠；
- 同一 domain 对同一 target 的矛盾 operation，例如 `start(A)` 后 `stop(A)`、`catalog.add(A)` 后 `catalog.remove(A)`，在
  prepare 前以 programming error 拒绝，并同时指出两项 operation；
- `catalog.add(P) + config.seed(P) + start(C)` 属于跨 domain 的有效组合；
- caller 真正要表达两个先后可观察的状态时，写两个 awaited operation/commit，不能靠 callback 内 method 顺序暗示中间状态。

冻结前必须把 normalization/conflict algebra 做成类型和 runtime contract，不把结果留给语句顺序：

| 同一 commit 内的组合                                                   | 结果                                        |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| 完全等价的重复 command                                                 | 折叠为一项                                  |
| root 同时出现在 `start(...)` 与 supporting `catalog`                   | catalog availability 折叠，root intent 保留 |
| 两次 `start(A)` 但 `initialConfig` 不同                                | prepare 前冲突失败                          |
| `start(A, { initialConfig: x })` + `config.seed(A, x)`                 | 值等价时折叠，否则冲突                      |
| `start(A)` + `stop(A)` / `restart(A)`                                  | 冲突；中间状态必须拆成两次 commit           |
| `catalog.add(A)` + `catalog.remove(A)`                                 | 冲突                                        |
| 同一 requirement 设两个不同 default                                    | 冲突                                        |
| 同一 consumer + requirement 设两个不同 override                        | 冲突                                        |
| provider default + consumer-specific override                          | 有效；override 只胜出于该 consumer          |
| 对同一 definition 同时 `replaceDefinition` 和 lifecycle/config command | 除非原型证明唯一无歧义规则，默认冲突        |

config 等价比较使用 authoritative normalized value，不使用 object identity。conflict error 应列出两个非敏感 operation 的 target/path，但不输出
config 值。

这里的“一次 commit”不是数据库式 all-or-nothing。prepare 前的 invalid change 或 callback throw 会 rollback draft；进入 lifecycle 后仍遵循
现有 provider failure isolation、dependent blocking、unrelated Plugin 可成功与 drain report 语义。strict helper 因目标 start failure reject，
不表示已经成功提交的无关节点会被反向撤销。

`commit` 在这里仍然准确：callback 创建一个短生命期 draft，caller 在其中完整描述 changes，callback 返回后立即提交。不要恢复当前
“host 自己长期持有 pending draft”的模式：

```ts
host.add(A)
await unrelatedWork()
host.start(A)
await host.commit()
```

它让 mutation boundary 隐藏在任意测试语句之间，也让忘记 `commit()` 成为合法但无效的测试。

冻结的 draft surface：

```ts
interface RuntimePluginTestChange {
	start(target: PluginTestTarget, options?: RuntimePluginStartOptions): undefined
	start(targets: readonly PluginTestTarget[], options?: RuntimePluginBatchStartOptions): undefined
	stop(target: PluginTestTarget): undefined
	restart(target: PluginTestTarget): undefined
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): undefined
	readonly catalog: {
		add(plugins: PluginConstructor | readonly PluginConstructor[]): undefined
		remove(targets: PluginConstructor | readonly PluginConstructor[]): undefined
	}
	readonly forks: {
		ensure<TPlugin extends PluginConstructor>(
			target: PluginForkRef<TPlugin>,
			options?: PluginInitialConfigOptions,
		): undefined
		remove<TPlugin extends PluginConstructor>(target: PluginForkRef<TPlugin>): undefined
	}
	readonly config: {
		seed(target: PluginTestTarget, value: RawPluginConfig): undefined
	}
	readonly dependencies: {
		setDefault(input: ProviderDefaultInput): undefined
		clearDefault(requirement: PluginConstructor): undefined
		setOverride(input: DependencyOverrideInput): undefined
		clearOverride(input: DependencyOverrideTarget): undefined
	}
}
```

dependency override 使用 named object，因为 consumer/requirement/provider 都是 constructor-like identity，位置参数很容易调换。清除使用独立
`clearOverride()`，不让 `provider: null` 承担第二种动作。

`config.seed()` 只用于 node 首次启动前的 fixture desired state。对 running Plugin 调用必须拒绝，并指导使用 production-like live mutation；
这防止测试意外绕过 persistence、listener、desired/applied revision 和 `saved-not-applied` 语义。

failure test 使用独立且可从 autocomplete 发现的 `commitExpectFail()`：

```ts
const failure = await host.commitExpectFail((change) => {
	change.start(Consumer, { catalog: [BrokenProvider] })
})
```

`commit()` 是 strict 路径；`commitExpectFail()` 要求 reconciliation 产生至少一个 lifecycle failed/blocked/drain issue，然后返回
`LifecycleFailureCommitSummary`。它包含已归属到 Plugin generation 的 `resolve-failed/config-failed/start-failed/dependency-blocked/drain-failed`
issue。它仍然对
callback programming error、invalid graph、fixture config input validation 与 persistence commit failure 抛错，也不改变 apply、rollback 或
underlying production report；projection 只发生在 author-facing return boundary。

如果 commit 完全成功，helper 以 assertion error reject，防止预期失败的测试因忘记检查 summary 而假通过。
`commit()` 成功只返回 `void`：author 测试没有检查 reconciliation planning facts 的稳定需求，返回 `pluginChanges` 还会重新暴露
`PluginNodeSlot`。`commitExpectFail()` 返回的 `LifecycleFailureCommitSummary` 固定 `ok: false` 和 non-empty issues tuple，并把 issue 的
`plugin/blockedBy` 从 internal slot 投影为 frozen canonical `PluginNodeAddress`。它不包含 `pluginChanges/runtimeUpdate`，因为 failure facts 才是该操作
的测试目标。不再把控制流差异藏在 options object 或仅靠文档解释。Core/Runtime framework tests 若需检查 successful/failed commit 的
restart/availability delta 或 raw slots，使用 internal harness 取得完整 production summary。

### Live config 使用 production mutation

```ts
const result = await host.config.patch(WorkerPlugin, {
	concurrency: 4,
})

expect(result).toMatchObject({
	ok: true,
	application: 'applied',
})
```

`host.config.patch` 应调用与 Management RPC 相同的 use case/coordinator，而不是直接修改 `ConfigService`：

- validate once；
- persistence flush/confirm；
- desired revision；
- running listener notification；
- `applied | deferred | saved-not-applied`；
- stable domain failure discriminant。

`host.start(..., { initialConfig })` 与 advanced `change.config.seed()` 是 fixture construction；`host.config.*` 是 production-like
mutation。这是两个不同意图，不提供一个会根据 node 当前状态偷偷切换语义的 `cfg().set()`。

`host.config.patch()` 不允许塞进同步 `commit()` callback，也不增加 `change.config.patchLive()`。若产品 contract 是“先持久化并通知
config，再 restart”，测试就明确写两个 awaited operation：

```ts
await host.config.patch(WorkerPlugin, { concurrency: 4 })
await host.restart(WorkerPlugin)
```

只有 production coordinator 本身提供跨 config/lifecycle 的原子 contract 时，test API 才能暴露相同边界；不能为了测试看起来可组合而创造
产品不存在的 transaction。Runtime 内部若必须构造不可能由 public behavior 到达的 raw state，使用 internal harness，不扩大 Plugin-facing API。

Management 的 nested `patchField(fieldPath, value)` 属于表单/协议 mapping，不进入通用 author driver；Plugin 行为测试可以提交完整 nested value
给 `patch()`，Workbench/Management protocol tests 则经过其真实 RPC 或 internal use-case harness。没有真实 author-side 重复前不增加第三个 config
mutation 入口。

同理，v2 不预先提供 `host.config.reset()` 或 `change.config.reset()`。当前 workspace 没有 Plugin author 调用点，production Management client
也尚未公开 reset；仅有一个未接入控制面的 use case 和 Core ConfigService white-box `unset()` tests，不足以建立 author contract。需要构造 key
deletion、默认值恢复或 raw revision 的 framework tests 使用 internal harness。未来 production 先冻结 reset 的删除范围、持久化和 listener 语义后，
test driver 才镜像同一 operation。

## Core host 使用自己的真实动词

Core 没有 session intent；只要 node 在 graph 中，它就是 lifecycle planning 的一部分。因此 `@pluxel/core/test` 不提供会伪装 session 的
`start/stop()`，而使用立即完成的 `add/remove()`：

```ts
await using host = createCoreTestHost()

const [provider, consumer] = await host.add([Provider, Consumer])
await host.remove(Consumer)
const nextProvider = await host.restart(Provider)
```

single `add()` 可以接受 `initialConfig` 并返回 typed instance；batch `add()` 与 Runtime batch `start()` 一样返回输入顺序的 typed tuple，异构
bootstrap config 进入 `commit()`。advanced draft 也只使用 Core vocabulary：

```ts
await host.commit((change) => {
	change.add(Provider)
	change.add(Consumer, { initialConfig: { endpoint: 'https://example.test' } })
})
```

冻结签名与 Runtime 的差异直接出现在类型上：

```ts
type CorePluginAddOptions = PluginInitialConfigOptions

interface CoreTestHost extends AsyncDisposable {
	add<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: CorePluginAddOptions,
	): Promise<PluginInstanceFor<TTarget>>
	add<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
	): Promise<PluginInstances<TTargets>>
	remove(target: PluginTestTarget): Promise<void>
	restart<TTarget extends PluginTestTarget>(target: TTarget): Promise<PluginInstanceFor<TTarget>>
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): Promise<void>
	commit(build: (change: CorePluginTestChange) => undefined): Promise<void>
	commitExpectFail(
		build: (change: CorePluginTestChange) => undefined,
	): Promise<LifecycleFailureCommitSummary>
	require<TTarget extends PluginTestTarget>(target: TTarget): PluginInstanceFor<TTarget>
	isRunning(target: PluginTestTarget): boolean
	dispose(): Promise<void>
}

type CoreTestHostConfig = Pick<CoreHostConfig, 'name' | 'logger' | 'events' | 'plugins'>

declare function createCoreTestHost(config?: CoreTestHostConfig): CoreTestHost

interface CorePluginTestChange {
	add(target: PluginTestTarget, options?: CorePluginAddOptions): undefined
	add(targets: readonly PluginTestTarget[]): undefined
	remove(target: PluginTestTarget): undefined
	restart(target: PluginTestTarget): undefined
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): undefined
	readonly config: {
		patch(target: PluginTestTarget, value: RawPluginConfig): undefined
	}
	readonly dependencies: {
		setDefault(input: ProviderDefaultInput): undefined
		clearDefault(requirement: PluginConstructor): undefined
		setOverride(input: DependencyOverrideInput): undefined
		clearOverride(input: DependencyOverrideTarget): undefined
	}
}
```

Core 的 `config.plugins` 同样只是 `PluginServiceConfig` lifecycle executor tuning，不是 initial graph。Core graph 仍只由 `add()`/draft `add()` 建立。

Core draft 以同步 `add/remove/restart/replaceDefinition` 共享 host 命令词汇，只额外提供 `config.patch` 与
`dependencies.setDefault/setOverride`。Core 没有 catalog、session intent、
durable auto-start policy、Runtime persistence 或 Management config mutation，因此不得为了 API 外观加入空实现。

Core 与 Runtime public test 代码有意不追求 structural compatibility；选择测试层之后，动词直接表达该层的产品事实。两者只共享确实同义的
`restart/replaceDefinition/require/isRunning/commit` 和“Promise resolve 时已稳定”的保证。

Core `add()` 是 ensure-materialized-and-running：相同 candidate 已经 running 时返回当前 instance，不产生 generation；`remove()` 对不存在的
target 抛 invalid-target error，不把测试拼写错误当成幂等成功。Core `restart()` 同样要求 target 当前存在且 running；`replaceDefinition()`
作用于整个 definition family。需要构造 absent、
failed 或多项 graph transition 的 framework matrix 时使用 `commit()` / `commitExpectFail()`，不继续给高频 helper 增加 mode flag。

## Public author host 与 framework internal harness 分开

当前 `host.ctx` 同时被 Plugin package 当作方便入口，也被 Core/Runtime 自身测试用于 root service、transaction、logger、artifact binder 和
backend authority。这两类需求不能继续决定同一个 public surface。

最终 public `CoreTestHost` / `RuntimeTestHost` 不暴露 root `ctx`，查询 surface 只保留：

```ts
host.require(Plugin) // running instance，否则抛 setup error
host.isRunning(Plugin) // boolean convenience
```

不保留低使用率且重叠的 `get/has/last/services/plugins()`；single/batch add/start 返回明确请求的 instance，其他 strict mutation 成功只返回
完成信号。Plugin 业务
状态通过 returned instance 或 inbound driver 观察，owner-bound storage 的必要白盒断言从 instance 的 public/domain seam 进入。

也不新增一个从多个内部来源重建的 `status()` snapshot。即时问题“现在是否 running”由 `isRunning()` 回答；failed/blocked/drain 的因果证据属于
`commitExpectFail()` 返回值或 `PluginLifecycleAssertionError.summary`。这避免 caller 拿一个脱离 commit 边界、可能已经 stale 的简化状态猜原因。

Core/Runtime 自身需要 root authority 的测试迁移到明确 internal 的 test harness：`@pluxel/core/internal/test` 与
`@pluxel/runtime/internal/test`。该 harness 可以暴露 root context、raw service、staged transaction 和 failure injection，但不被
`@pluxel/test`、`@pluxel/runtime/test` 主入口 re-export，也不进入 Plugin 作者文档。跨 package 的 framework conformance fixture 也依赖这个
internal contract，而不是迫使所有 Plugin 作者得到 service locator。两个 subpath 明确是 framework-internal、无独立 semver guarantee；跨 package
使用仍必须由 workspace typecheck/conformance 覆盖，不能退回相对路径穿越 package boundary。

这不是减少测试能力：它让 author API 优化“验证 Plugin 行为”，让 framework harness 优化“验证 Runtime 实现”，两边都不再背负另一边的
偶然调用模式。

## 可组合 Runtime drivers

test host 只为 Plugin 的 inbound/publication boundary 提供 driver，不成为任意 Context service locator。

### Plugin lifecycle 主能力

```ts
host.start(...)
host.stop(...)
host.restart(...)
host.replaceDefinition(...)
host.commit(...)
host.commitExpectFail(...)
host.require(...)
host.isRunning(...)
```

负责 graph/governance/lifecycle，不执行 Plugin 业务 method。

### HTTP

```ts
const response = await host.http.fetch(new Request(new URL('/orders/42', host.http.origin)))
```

它提供标准 Fetch-like `(input: Request | URL | string, init?: RequestInit) => Promise<Response>` 签名，string 必须是 absolute URL，因此可以直接注入
Plugin 自己的 HTTP/RPC client。driver 总是返回 Promise，不暴露当前 Elysia dispatcher 偶尔同步返回的实现差异，也不保留 `env/ctx` 测试后门。
它仍经过真实 directory、generation admission 和 sealed Elysia app，但不打开端口。`origin` 是 immutable normalized string，固定为 logical
`http://local.test`；它不是可连接的 listener address，也不接受 test option。需要 Host/Origin admission 特例时向 `fetch()` 传自己的 absolute URL。
`http` namespace 初始实现只包含 `origin/fetch`。

driver 必须保留 Response body lifecycle：body consume/close/cancel 前，对应 request 仍可能持有 generation admission。host 追踪未结束的 returned
body，并在 host disposal 时 best-effort cancel；这类没有显式 disposable handle 的 body 不计为 leaked child lease，cancel failure 仍进入 teardown
aggregate。测试 streaming、client abort 或 stop/drain 时应显式消费 body，或调用 `await response.body?.cancel()`/中止原 Request signal，不能靠
host 最终 disposal 代替被测行为。

WebSocket 不进入这个 driver，因为它需要真实 Upgrade/carrier。

### Commands

```ts
const result = await host.commands.execute('orders.refresh', { id: '42' }, context)
const published = host.commands.list()
```

driver 使用真实 root command catalog、schema/transform、owner registration 和 cleanup。初始 public surface 只有 `execute()` 与 `list()`；
它不提供 `register/createMount/snapshot/subscribe`，因为注册权属于运行中的 Plugin，mount 与 catalog observer 属于 framework contract。
Plugin 测试通过 start/stop 前后的 `list()` 和真实 execution 观察 publication。当前 package tests 已有 root command list/execute 需求，因此
这个 driver 不是为 namespace 对称预留的空抽象。

### Workbench

```ts
using opened = await host.workbench.open({
	target: ConnectorPlugin,
	entry: ConnectorWorkbench.credentials,
	principal: ADMIN,
})
```

详细 contract 见 [`WORKBENCH_RPC.md`](WORKBENCH_RPC.md)。它使用真实 publication/session 和 local Cap'n Web membrane，不模拟 renderer。

### Direct RPC

```ts
using api = createLocalRpcClient<Api>(new ApiTarget(service))
```

它不依赖 host，也不放入 `host.rpc` namespace。挂载到 Elysia 的 HTTP/WebSocket endpoint 分别由 HTTP driver或 real carrier 测试。详细分层
见 [`DIRECT_RPC.md`](DIRECT_RPC.md)。

### Management

Runtime Management RPC 是 host 产品控制面，不是普通 Plugin 业务依赖。只有测试 Workbench management UI、protocol mapping 或 provider
authorization 时才创建 Management client；不要让普通 Plugin tests 通过 Management RPC 启动自己，只为追求“更端到端”。

如果多个外部 consumer tests 需要同一个 client，未来可以增加独立 `host.management.connect(principal)` proposal。它不得与
host 的 fixture authority 混成一个对象：前者验证受限产品控制面，后者建立测试世界。

## 不把 storage 变成 test backdoor

Vault、database、persistence、cache 和 worker 是 Plugin 使用的 owned capability，不自动成为：

```ts
host.vault.setFor(Plugin, key, value)
host.database.table(Plugin, name)
host.workers.runAs(Plugin, task)
```

这种 API 会绕过 owner view、领域 schema、flush/transaction、resource admission 或 Plugin readiness。

默认验证路径是：

1. 通过 Plugin 的真实 public behavior、HTTP、command 或 RPC 建立/读取状态；
2. 需要 white-box storage assertion 时，从 `host.require(Plugin).ctx` 取得该 Plugin 已绑定 owner 的 capability；
3. 大量业务测试需要快速 seed 时，由具体 Plugin package 提供领域 fixture/controller，不由 Runtime 猜 key、table 或 document contract；
4. Runtime 自身 storage implementation tests 才使用 internal backend authority。

这允许 credential RPC 写 Vault 后立即用 HTTP/command 验证，也不会建立跨 Plugin 的万能 service locator。

### Database 默认值与内容断言

`database` option 缺席时，Runtime test host 安装真实 `DatabaseService`，但不立即 import 或创建数据库。第一个 Plugin 调用
`ctx.database.use(definition)` 时才惰性建立该 host 的 PGlite coordinator；由于 test host 的默认 persistence 已显式规范化为
`{ mode: 'memory' }`，adapter 使用 `memory://`。每个 host 拥有独立 coordinator，各 Plugin/default fork 按 production owner schema 隔离，host
disposal 关闭 PGlite。`database: false` 必须保持零 adapter；Postgres-specific contract 则显式传 production Postgres config。

Plugin 行为测试优先通过领域 API、HTTP、command 或 RPC 观察结果。确实需要验证 rows/indexed state 等 package-owned persistence fact 时，从当前
running instance 重新取得同一个 owner-bound database handle，并使用 Drizzle query + Vitest 标准 matcher：

```ts
const plugin = host.require(OrdersPlugin)
const database = await plugin.ctx.database.use(OrdersDatabase)

const rows = await database.read((db) =>
	db.select({ id: orders.id, state: orders.state }).from(orders).orderBy(orders.id),
)

expect(rows).toEqual([{ id: 'order-1', state: 'ready' }])
```

`use()` 对同一 Plugin generation 和同一 authored definition 返回其既有 handle；传错 definition 会沿用 production guard 拒绝。`read()` 保留
owner role、scheduler、drain 和 readonly boundary，因此不能替换为 root client、PGlite instance 或物理 schema 查询。测试需要 seed 大量领域
fixture 时可以在具体 Plugin package 内通过同一 handle 的 `transaction()` 建立显式 helper，但 generic host 不提供 `seedTable/expectRows()`；否则会
绕过 table schema、owner isolation 和 Plugin 业务 invariant。

restart/replacement 后必须从新 instance 的 Context 重新 acquire handle，再断言持久化结果；旧 generation 的 cached handle 应按 production
semantics 拒绝。stop 后检查 physical schema、migration bookkeeping、cross-owner isolation 或 adapter cleanup 属于 DatabaseService/driver internal
contract test，不为了它们给 author host 增加 backend admin authority。

## 外部依赖与可控时间

可组合不等于所有东西使用真实网络和真实时间。

- 入站 Pluxel boundary 保持真实；出站第三方 HTTP、cloud SDK、queue 或 model provider 使用 Plugin 已有 adapter/client seam；
- database contract tests 可以使用 PGlite，driver-specific behavior 使用对应真实 database integration；
- background task 在 `init()` 中启动并注册 cleanup，不让 host start 等待任务永久完成；
- readiness 是 Plugin 可观察状态，不用 `sleep()` 猜测；
- deadline/backoff/debounce 优先注入 clock 或使用 fake timer；
- cancellation test 使用 gate + AbortSignal，并等待 resource settlement；
- 只有真实 timeout contract 才等待 wall clock，并给单个 case 明确 budget。

test host 不提供一个全局 fake clock service，除非 Runtime 自己拥有所有相关时间来源；否则它会给外部 library 和原生 timer 造成虚假的统一
控制承诺。

同理，host 不增加一个覆盖所有 driver 的 `timeoutMs`：Plugin start/drain 继续使用真实 lifecycle timeout，HTTP 使用 `Request.signal`，RPC/session
使用各自 cancellation/deadline，测试 runner 的 case timeout 只是最后一道防挂死保护。长生命周期工作不能留在 `init()` 里让 `start()` 一直等待；
`init()` 只建立 task、注册 cleanup 并达到可声明的 readiness。专门验证 lifecycle timeout 时配置既有 Plugin/root timeout；不要由 test helper
偷偷延长，否则测试与 production contract 不再相同。

Vitest 测试若观察的确实是 carrier、external adapter 或异步 publication 的 eventual state，直接使用 runner 已有的
`expect.poll(() => observed).toEqual(expected)`；等待 mock/callback 可使用 `vi.waitFor()`。不要把它们包装成 `host.waitFor/eventually()`。这些工具
不得用于弥补 lifecycle/config helper 提前 resolve：`start/stop/restart/config.patch` 自己承诺的稳定边界仍必须由 implementation 等待完成。

## 一个完整的组合示例

```ts
await using host = createRuntimeTestHost({
	vault: {},
	workbench: { enabled: true },
})

const connector = await host.start(ConnectorPlugin, {
	catalog: [HttpProviderPlugin],
	initialConfig: { endpoint: 'https://upstream.example.test' },
})

using credentials = await host.workbench.open({
	target: ConnectorPlugin,
	entry: ConnectorWorkbench.credentials,
	principal: ADMIN,
})

const secret = 'test-secret'
const saved = await credentials.root.run('replace', { authKey: secret })
expect(saved.action).toMatchObject({ ok: true })
expect(JSON.stringify(saved)).not.toContain(secret)

const response = await host.http.fetch(new Request(new URL('/connector/probe', host.http.origin)))
expect(await response.json()).toEqual({ authenticated: true })

expect(await connector.ctx.vault!.kv().get('auth-key')).toBe(secret)

await host.stop(ConnectorPlugin)
expect(
	(await host.http.fetch(new Request(new URL('/connector/probe', host.http.origin)))).status,
).toBe(404)
await expect(credentials.root.load()).rejects.toThrow()
```

这段测试只有产品概念：host、Plugin、config、Workbench entry、HTTP request、Vault assertion 和 stop。没有 registry、node address、manual
commit、DOM selector 或 physical port。

## Failure 与 assertion 设计

Core/Runtime host API 不内建 `expect()`，其 command、result 与 error 保持 runner-neutral；official `@pluxel/test` Vitest adapter 只增加下面一个
identity-aware matcher。其他 runner 仍可消费相同结构化 failure summary，framework harness 则可使用 internal resolver。

- `start/restart()` 是 assertive fixture operation：目标未 running 时 reject；`replaceDefinition()` 是 definition-wide strict operation；
- `commitExpectFail()` 用于检查 expected start/blocked/drain issues；
- HTTP、command、config、Workbench action 和 Plugin domain API 保留各自 production result；
- programming error、invalid target、stale draft authority 和 capability disabled 不伪装成 domain failure；
- message 面向诊断，测试分支依赖现有 stable kind/code/discriminant。

official Vitest stack 保留一个已有真实需求的 matcher：

```ts
expect(failure).toHavePluginLifecycleIssue(BrokenProvider, {
	kind: 'start-failed',
})
```

`toHavePluginLifecycleIssue()` 只负责从 constructor/fork ref 定位 summary 中的 canonical node/issue，并优先匹配 stable
phase/kind/blockedBy；对尚无 stable cause code 的错误保留 optional `message: string | RegExp` 诊断匹配，但明确不把 message 变成稳定协议。
它必须支持 `.not` 与 `expect.soft()`，失败时展示非敏感的 expected target/fields 和 normalized actual issues，而不是只打印“没有找到”。这避免
Plugin 作者理解 slot/address，并复用 Vitest 的 matcher reporting。当前测试调用没有使用旧 assert 的返回值，因此 matcher 返回 `void` 不损失真实
能力。

matcher 由 `@pluxel/test/vitest` preset 安装的 setup 自动注册；module augmentation 同样由该 entry 的 types 提供。runner-neutral 的
`@pluxel/core/test` 与 `@pluxel/runtime/test` 不依赖 Vitest，test file 也不逐个导入 side-effect setup。identity resolver 是 matcher
implementation/internal harness 的共享内部能力，不再 public export
`assertPluginLifecycleIssue/findPluginLifecycleIssue/pluginLifecycleIssuePlugins`。除此之外不增加 `toBePluginRunning()`、
`toHavePluginConfig()`、snapshot serializer 或 Plugin target global equality tester；`isRunning()`、returned instance、标准 Vitest matcher 与
domain result 已经提供足够证据。

Vitest `expect.extend()` 会按 upstream contract 自动把 custom matcher 投影到 asymmetric matcher surface；实现不另造第二个 asymmetric API，也不把
它作为教程路径，但不能声称它不存在或尝试用私有 patch 禁用。type/runtime conformance 至少证明该机械投影不会崩溃；主要行为和 diagnostics
仍以 `expect(failure).toHavePluginLifecycleIssue(...)` 为权威。

TypeScript 必须能看到同一个 preset import 才能加载 augmentation。canonical 项目把导入 `@pluxel/test/vitest` 的 `vitest.config.ts` 纳入
`tsconfig.include`；workspace template 与迁移脚本同步修正，不要求 test files 添加额外 import，也不通过 runner-neutral host 偷渡 Vitest type
dependency。compile-only fixture 必须证明仅使用 preset 的新项目能发现 matcher。

adapter declaration 只扩展 Vitest matcher，不把 `expect` 注入 host package：

```ts
type PluginLifecycleIssueExpectation = Readonly<{
	phase?: PluginLifecycleIssuePhase
	kind?: PluginLifecycleIssueKind
	blockedBy?: PluginTestTarget
	message?: string | RegExp
}>

declare module 'vitest' {
	interface Matchers<T = any> {
		toHavePluginLifecycleIssue(
			target: PluginTestTarget,
			expected?: PluginLifecycleIssueExpectation,
		): void
	}
}
```

Vitest 的 matcher augmentation 无法仅凭 `T` 完美隐藏错误 receiver，因此 implementation 必须验证 received 是 failure summary，并给出明确
usage error；type tests 仍应尽可能把 method 限制到 compatible receiver。不要为了实现 receiver-sensitive autocomplete 再引入
`expectPluginFailure(summary)` wrapper，那会重新产生第二套 assertion 语言。

当前实现只有 structured `CommitSummary`，strict helper 抛出的普通 Error 会丢失它；同时本提案删除 `last()`，因此需要一个且仅一个
test-only wrapper：

```ts
class PluginLifecycleAssertionError extends Error {
	readonly code = 'PLUGIN_TEST_LIFECYCLE_ASSERTION_FAILED'
	readonly operation:
		| 'add'
		| 'remove'
		| 'start'
		| 'stop'
		| 'restart'
		| 'replaceDefinition'
		| 'commit'
		| 'commitExpectFail'
	readonly targets: readonly PluginTestTarget[]
	readonly summary: PluginTestCommitSummary
}
```

它只表示“mutation 已执行，但请求的 lifecycle/cleanup postcondition 未满足”，例如 requested root 未 running、generation config injection 失败、
本次 drain 出现 error，或 `commitExpectFail()` 实际完全成功。其 `summary` 始终是 slot-free `PluginTestCommitSummary`；strict lifecycle failure 时
自然满足 failure subtype，unexpected success 时则为 `{ ok: true, issues: [] }`。它不包装 callback programming error、invalid graph、fixture config
validation、persistence commit failure、capability disabled 或 teardown failure。预期 lifecycle failure 的测试仍
使用 `commitExpectFail()`，不以 catch 作为普通控制流；error class 的价值是让意外 strict failure 保留完整诊断，并允许 runner/reporter
显示 summary。

### 面向修复的 diagnostics

自动生成的 test-host error 必须让没有阅读 internal source 的 coding agent 能直接修改调用点：

- message 固定包含 operation 与 typed target，例如 `start(ConsumerPlugin)`，并附带已有 structured lifecycle kind/report；
- required provider 不可用时列出 requirement identity；Runtime 建议把 concrete implementation 加入 `{ catalog: [ProviderPlugin] }`，Core
  建议 `add([ProviderPlugin, ConsumerPlugin])`；若 host 不知道可用 implementation，不伪造 constructor 名称；
- `initialConfig` 已越过 bootstrap boundary 时，建议 `host.config.patch()`；Workbench disabled 时，指出对应 host creation option；
- programming error、invalid graph、persistence failure、lifecycle assertion failure 与 teardown failure 保持可区分；除上述唯一 wrapper 外，
  不用一个通用 `PluginTestError` 抹平已有 discriminant；
- helper 自己生成的 diagnostics 不插值 config value、Vault secret、auth key、RPC payload 或 provider credential；Plugin 自己抛出的
  `message/stack/cause` 可能包含业务数据，调用方不应在未脱敏时 snapshot 或发布 failure summary；
- helper 不做隐藏 retry、sleep 或超时延长。需要 retry/deadline 的产品行为由该 domain 的显式 API 表达。

错误文本用于人和 agent 定位，测试逻辑仍只依赖已有 stable code/kind/report，不依赖整段英文 message。

## Teardown 与 child lease 所有权

host、Workbench entry、standalone local RPC client 和未来 real-carrier handle 都遵循同一条规则：创建者拥有资源，`using`/`await using` 是主教程
路径。host 只登记由自己的 driver 创建的 child lease；standalone `createLocalRpcClient()` 不反向绑定任意 host。registry 只是为了兜底和诊断，
不把资源所有权变成隐式。

`host[Symbol.asyncDispose]()` 与 `host.dispose()` 指向同一幂等 operation；并发调用共享同一个 settlement。teardown 按固定顺序：

1. 将 host 标记为 closing，拒绝新的 mutation、request 与 `open()`；
2. 若已有 fixture mutation，等待它按自身 production contract settle；dispose 不在 apply 中途制造第二种 rollback/cancel 语义；
3. cancel 尚未结束的 in-process HTTP response bodies，并以反向创建顺序关闭 Workbench/RPC/carrier child leases，阻止新 session work；
4. withdraw Plugin publications，停止完整 graph，并等待现有 generation admission/drain；
5. flush/close persistence 与 optional capability backends；
6. dispose root-owned services；
7. 完成全部 best-effort cleanup 后，集中抛出 leak、drain 和 cleanup failures，保留每个原始 cause。

teardown 不在遇到第一个 failure 后跳过剩余资源，也不静默吞错。显式 disposable child lease 若直到 host disposal 仍未关闭，算作 test leak：host
会先将其关闭，再让 disposal reject，并仅报告非敏感的 driver kind、target 与创建位置（可取得时）。这使忘写 `using` 成为稳定失败，而不是依赖
进程退出的偶发问题。所有重复/并发 `dispose()` 调用取得同一个 Promise 与同一 fulfillment/rejection；implementation 不重新执行 teardown，也不
复制 aggregate causes。

host 进入 closing 后，除重复 `dispose()` 外的所有新 query、mutation 和 driver open/request 都以 closed-resource setup error 拒绝；已经返回的
child capability 则按各 production protocol 进入 broken/aborted 状态。不要让部分 facade 抛、部分 facade 静默返回 empty/404。

测试 runner 同时已有 assertion failure 时，应使用语言/runtime 的 suppressed/aggregate error 机制保留两者；不得用 teardown message 覆盖原始
测试失败。实现必须覆盖 child cleanup failure、Plugin drain failure、多个 failure 聚合、重复 dispose 和 leaked lease 的 contract tests。

## Plugin fork 保留为 typed value

本次 test API 重构明确保留 fork。[`../REMOVE_PLUGIN_FORKS.md`](../REMOVE_PLUGIN_FORKS.md) 若未来被采纳，届时同步 breaking 删除 test fork
surface；现在不用一个半支持的 union 预演未来。冻结入口是纯 value constructor：

```ts
const East = definePluginFork(RedisPlugin, 'east')
const West = definePluginFork(RedisPlugin, 'west')
```

`definePluginFork()` 只用现有 identity codec 校验并原样保留 `forkId`，然后返回 immutable branded `PluginForkRef<T>`；它不读 host、不消费 candidate、不写
RuntimeState、不 materialize node。同一 canonical definition + forkId 在不同 ref object 中仍是同一 target。host admission 才校验
constructor 已 lowering、definition 允许 fork，以及当前 catalog candidate 与 ref 绑定的 implementation 一致。
Core 实现中只有一个 brand/factory；`@pluxel/test` 与 `@pluxel/runtime/test` 可从各自教程入口 re-export 同一 symbol，不得各自构造
不兼容的 fork ref。

default constructor 与 fork ref 使用同一 lifecycle/config/query API，并可以混合 batch：

```ts
const [defaultRedis, eastRedis, westRedis] = await host.start([RedisPlugin, East, West])

await host.config.patch(East, { endpoint: 'redis://east.test' })
await host.restart(East)
expect(host.require(West)).toBe(westRedis)
```

batch start 不接受异构 initial config；每个 fork 的 bootstrap 在同一 commit 中表达：

```ts
await host.commit((change) => {
	change.start(East, { initialConfig: eastConfig })
	change.start(West, { initialConfig: westConfig })
})
```

Runtime 中 `start(forkRef)` 是高频 compound command：让 underlying constructor candidate 可用、ensure durable fork、可选 seed config、提交
session running intent。fork 只作为 dependency provider、不作为独立 root 时，使用正交的 advanced command：

```ts
await host.commit((change) => {
	change.catalog.add(RedisPlugin)
	change.forks.ensure(East, { initialConfig: eastConfig })
	change.dependencies.setOverride({
		consumer: WorkerPlugin,
		requirement: CachePlugin,
		provider: East,
	})
	change.start(WorkerPlugin)
})
```

provider default 只能是 default constructor；这是 Runtime 的现有产品不变量，fork 不能成为 global provider default。consumer-specific override 的
consumer/provider 都可以是 fork ref。`change.forks.remove(ref)` 表达删除 durable fork identity 及其 policy/config/override/cleanup 序列；
`stop(ref)` 只改 session intent，不删 fork。Core 没有 durable fork registry，直接使用 `add(ref)` / `remove(ref)` materialize/dematerialize。

implementation replacement 始终 definition-wide，因此 `replaceDefinition(Current, Next)` 只接受 constructor，不接受 fork ref，也不返回某一
family member 的 instance。constructor/ref 都与 expected implementation 绑定；replacement 完成后，旧 target 传给任何 public target-taking
lifecycle/query/driver/draft command（包括 `start/stop/restart/require/isRunning/config/workbench/catalog`）都必须 stale-reject。否则
`isRunning(Old)` 可能对 Next generation 返回 true，`stop(Old)` 还会意外控制新实现。caller 必须用 next constructor 重建同 forkId 的 ref：

```ts
await host.replaceDefinition(RedisPluginV1, RedisPluginV2)
const EastV2 = definePluginFork(RedisPluginV2, 'east')
const east = host.require(EastV2)
```

identity-only cleanup 是例外：`change.forks.remove(East)` 必须能删除 catalog 已 absent 或 implementation 已 replacement 的 orphan fork，因此它只使用
ref 中的 canonical definition + forkId，不要求 current candidate。这个例外只用于删除 identity，不能被 `require()` 或 config access 复用。

`catalog` 始终只接受 constructors，因为 availability 属于 definition candidate；Plugin target 位置接受 constructor/fork ref；public author API 不接受 raw
`PluginNodeAddress`。Workbench target、lifecycle assertion、diagnostics、Vault owner assertion 和 teardown 必须保留 fork identity。

## 无兼容层的迁移原则

这是一次明确的 breaking redesign。目标分支合并时 workspace 和 public exports 只能剩一套模型，不发布 deprecated alias，也不安排跨版本
兼容窗口。为了避免在全量机械迁移中才发现设计错误，实施顺序是：

1. 先以未导出的 prototype 实现 Core `add/remove/commit`、Runtime `start/stop/commit`、batch overload 与 teardown；
2. 在 prototype 上迁移代表矩阵，而不是只挑最短 happy path：single config、2–4 explicit roots、required/optional provider、expected failure、
   config live update、restart/replacement、HTTP、commands、Workbench/Vault、database、long-running cleanup 和 framework white-box；
3. 用真实迁移记录检查调用行数、autocomplete、错误修复信息、类型退化、资源泄漏和是否仍需 internal import；发现结构问题时只修改
   prototype，不增加 alias；
4. 在代表迁移中验证 fork ref、definition replacement、failure 和 disposal contract；若发现 correctness blocker，停止全量迁移并先重开设计审查；
5. 一次性迁移 workspace，并为重复 stack 建立 package-owned fixture function，而不是把业务拓扑塞进 generic host；
6. 同一变更删除旧顶层 staged mutation semantics、`cfg`、有 mutation 副作用的 `host.fork`、`with*Host`、author-facing
   `create/with*Context`、public `host.ctx` 与旧 exports；
7. 用 `rg`/typecheck 设置 zero-old-symbol gate，防止文档、模板和低频 package 遗留旧调用；
8. public docs 只写新模型；breaking mapping、行为差异和 package bump 写入 Tegami changelog。

迁移期间可以在未合并分支中短暂同时存在 prototype 与旧实现以便对照，但该状态不得发布或进入主分支。这不是 compatibility surface。

机械迁移只处理能保持语义的模式；其余必须人工选择边界：

| 旧模式                                                | 新模式                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Core `add(A); commit(); require(A)`                   | `await host.add(A)`                                                    |
| Runtime `add([P, C]); start(C); commit()`             | `await host.start(C, { catalog: [P] })`                                |
| Runtime `addStarted([A, B, C]); commit()`             | `await host.start([A, B, C])`                                          |
| pre-start `cfg(A).set(value)`                         | single `initialConfig`；multi-root 使用 callback `commit`              |
| running `cfg(A).set(value); commit()`                 | `await host.config.patch(A, value)`                                    |
| staged `commitAllowFail()`                            | callback-scoped `commitExpectFail(change => ...)`                      |
| `assertPluginLifecycleIssue(summary, P, expected)`    | `expect(summary).toHavePluginLifecycleIssue(P, expected)`              |
| author-side `setAutoStart(...)`                       | Runtime internal harness                                               |
| `const F = host.fork(P, 'f')` + `start(F)`            | `const F = definePluginFork(P, 'f')`; `await host.start(F)`            |
| dependency-only `host.fork(P, 'f')`                   | `change.forks.ensure(F)` + dependency override                         |
| `lowerTestReplacement(P, Next); replace(P, Next)`     | `lowerTestReplacement(P, Next); await host.replaceDefinition(P, Next)` |
| `host.fetch(request)`                                 | `host.http.fetch(request)`                                             |
| `host.require/isRunning`                              | 保留顶层，但只查询已提交状态                                           |
| `host.ctx.commands.list/execute`                      | `host.commands.list/execute`                                           |
| internal Workbench registry/session wiring            | `host.workbench.open({ target, entry, principal })`                    |
| root service、transaction、artifact/failure injection | framework internal harness                                             |

不能仅从相邻语句推断 `add([P, C])` 中 P 是 supporting catalog candidate 还是独立 session root；codemod 必须利用 constructor dependency facts，
无法证明时留下人工迁移项。也不能把所有旧 `cfg().set()` 机械改为 live `config.patch()`，必须按首次 lifecycle boundary 分类。

## Coding agent 盲测验收门槛

“对 agent 清晰”不以 API 设计者的直觉验收。在 public export 前，准备一个只含冻结 `.d.ts`、一页 quick start、代表性 fixture Plugin
与编译/测试命令的隔离 package；不给 agent 内部实现、旧 test helper 或本 proposal。用相同 prompt 和相同 correction budget 完成：

| 任务                                 | 必须自主选择的边界                                                       |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Runtime single root + initial config | `start` 而不是 staged commit/live patch                                  |
| 2–4 个独立 roots                     | batch `start` 与 typed tuple                                             |
| required provider                    | `{ catalog }` 而不是伪造 dependency declaration                          |
| default + forks 混合 roots           | `definePluginFork` + batch `start`                                       |
| dependency-only fork                 | `forks.ensure` + consumer override                                       |
| definition replacement               | explicit replacement fixture + `replaceDefinition` + next-bound fork ref |
| 多个 root 的异构 bootstrap config    | callback-scoped `commit`                                                 |
| expected provider failure            | `commitExpectFail` + structured issue assertion                          |
| live config + new generation         | `config.patch` 后显式 `restart`                                          |
| HTTP route / mounted HTTP RPC        | `http.fetch`                                                             |
| mounted WebSocket RPC                | real carrier，不是 `http.fetch` 或 local object RPC                      |
| Workbench credential                 | `workbench.open` + Vault/business behavior，不是 DOM                     |
| database persistence                 | owner-bound handle `read` + standard matcher                             |
| Core Plugin                          | `add/remove`，不是 Runtime `start/stop`                                  |
| cleanup                              | `await using`/lease disposal，不是 sleep                                 |

对 lifecycle 归属做受控 A/B，至少比较顶层 `host.start(Plugin)`、`host.plugins.start(Plugin)` 与
`host.lifecycle.start(Plugin)`。不比较字符数，而记录：

- 首次提交是否 typecheck 且验证了正确 behavior；
- 选错 Core/Runtime、fixture/live config、local RPC/HTTP/WebSocket 层的次数；
- 是否使用 internal import、DOM、direct Vault backend、hidden sleep 或遗漏 cleanup；
- 编译器与 runtime diagnostic 修正轮数；
- 是否只靠 autocomplete 找到 batch、`catalog`、`initialConfig`、`commitExpectFail` 与 driver boundary。

顶层形状的完成率必须不低于 namespace 对照，且不增加“误把 Plugin start 当成 host/server start”。agent 不得把
`commitExpectFail` 误解为吞掉 programming/persistence errors，并必须理解“无 lifecycle issue 也是 assertion failure”。未通过时把结果
视为重开设计审查的 blocker，不在迁移中加 alias 掩盖问题。A/B 对照中每个形状只允许一个 canonical 写法。

冻结声明还必须单独通过 compile-only contract matrix，不能只依赖运行时迁移碰巧覆盖类型：block callback 与 expression callback
应通过，async/有返回值 callback 应拒绝；single target 与 default/fork mixed literal batch 应分别推导精确 instance/readonly tuple；batch
`initialConfig`、fork 作为 global default、fork 传给 `replaceDefinition`、raw node address 和已 destructure driver 的错误调用都应在预期位置
拒绝。driver method destructure 后的合法调用必须通过，显式 `dispose()` 与 `AsyncDisposable` 则必须在 runtime contract test 中证明是同一幂等
operation。replacement 后的旧 constructor/ref 属于依赖 committed state 的 runtime stale-target test，不能误称为 TypeScript 能静态拒绝。

正向精确关系使用 workspace 已采用的 Vitest `expectTypeOf()`；负向 surface 使用 `@ts-expect-error` 并由 package `typecheck` 覆盖。不要新建
test-host type assertion DSL，也不要让仅用于推导的 lifecycle expression 在 runtime test 中真的执行。matcher augmentation 还必须有独立 type test，
证明 official preset 导入后可发现、错误 target/expectation 被拒绝，且没有把 Core/Runtime host package 反向绑定到 Vitest。

## 验收条件

总体设计只有同时满足以下条件才可采纳：

1. Runtime single Plugin + initial config 缩为一次 `host.start()`；Core 对应行为是一次 `host.add()`；二者返回 typed instance；
2. single/batch add/start 都在一次 commit 中稳定，并从 literal constructor tuple 推导 readonly instance tuple；
3. required provider 仍由 constructor facts 决定，Runtime `catalog` option 不复制 dependency declaration；
4. `host.start()` 不修改 auto-start policy；public author change 不暴露 policy，Core 不出现 session/policy vocabulary；
5. stop/remove/restart/replaceDefinition/strict commit resolve 时 lifecycle 与 cleanup 已达到现有稳定边界，成功只返回 `void`；
6. multi-change callback 不可逃逸、不可跨 `await`，throw 时无 pending draft；empty draft 拒绝；block 与 expression callback 都可 typecheck，
   `async` callback 在 type/runtime 都拒绝；
7. `commitExpectFail` 要求至少一个 lifecycle issue，完全成功时拒绝，且不吞 programming/persistence/invalid graph error；official Vitest
   matcher 支持 target/fork、blockedBy、`.not`、soft assertion 与结构化安全诊断；
8. config 参数不伪造 constructor-level 类型关系；`initialConfig` 与 live mutation 不隐式换语义；未有 production/author 证据前不提供 reset；
9. Workbench/Vault disabled 时零 backend；Database 默认每 host 隔离、惰性的 memory PGlite，`database: false` 真正零 adapter；内容断言经过
   owner-bound handle，driver 不自动安装 capability 或暴露 backend admin；
10. HTTP、commands、Workbench driver 都观察同一 Plugin generation 和 withdrawal；
11. Workbench `principal` 必填，local RPC、real WebSocket carrier 与 browser test 不互相冒充；
12. public author host 不暴露 root `ctx`，framework white-box tests 仍有明确 internal harness；
13. host 与所有 host-owned leases 可以统一、幂等地 teardown，standalone lease 独立 teardown，并有 leak/aggregate failure tests；
14. provider candidate availability、default selection 和 consumer override 各有且只有一条路径，同一 commit 的 conflict algebra 有完整测试；
15. default/fork 混合 batch 保持 tuple 类型，dependency-only fork 可 ensure + override，global provider default 拒绝 fork；
16. `replaceDefinition` 影响完整 family，不接受 fork ref，且旧 constructor/ref 不能在 replacement 后返回错误类型的 instance；
17. author surface 只接受 constructor/`PluginForkRef`，不要求 Plugin 作者构造 definition/node address；
18. 代表矩阵迁移后不再需要 package 自建 `addStarted`/Workbench registry wiring 等 framework 样板；
19. 一个未读 internal source 的 coding agent 通过上述盲测矩阵，能从 autocomplete 写出 single/batch lifecycle、config、RPC/HTTP、failure
    matcher 与 cleanup test；
20. old symbol zero gate、public exports、模板、用户文档和 Tegami changelog 与最终实现一致。

## 原型阶段需要回答

- callback draft 如何在 TypeScript 和 runtime 阻止异步/逃逸使用；
- command normalization/conflict algebra 能否在 Core 与 Runtime 共享同一实现，而不把两者的状态语义伪统一；
- provider default/override 是否覆盖代表性 abstract provider 迁移；
- fork ref 的 candidate-staleness guard 能否在所有 target-taking facade 上共享，而不重新暴露 node address；
- live config API 是否复用 Management use case，还是提取一个不绑定 RPC 的 application service；

这些问题只允许调整 internal implementation。若它们证明冻结签名无法诚实实现，必须以具体反证重开 public API review，
不在迁移过程中就地增加 alias、option 或 overload。无论如何都不能破坏核心区分：常用行为立即完成，复杂变化显式成组，
optional capability 不被偷偷安装，不同测试层不互相冒充。
