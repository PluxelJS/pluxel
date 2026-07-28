# 编写 Pluxel 插件

这是一条面向插件作者的代码主路径。新建或整理可发布 package 时先按
[`plugin-package.md`](plugin-package.md) 配置入口、依赖、tsdown 和 package metadata，再用
[`plugin-best-practices.md`](plugin-best-practices.md) review 所有权，并让
[`oxlint.md`](oxlint.md) 检查可静态判断的约束。

插件测试使用 [`testing.md`](testing.md) 的 `@pluxel/test/vitest` 标准工具链，不用 raw runner 绕过
decorator 和 metadata transform。

插件作者统一从 `@pluxel/runtime` 导入；默认入口直接转发 core 作者 API，并增加常驻 runtime 能力。

## 先记住四件事

1. 插件是依赖和生命周期单元。
2. constructor 只放没有它就无法工作的插件依赖。
3. `init()` 负责启动检查、注册运行时能力和登记资源清理。
4. HTTP 是常驻业务能力；Workbench extension 只通过可选的 `ctx.workbench.mount()` 挂载。

## 一个标准插件

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'

import { AccountsPlugin } from './AccountsPlugin.ts'
import type { BillingCommands } from './browser-contracts.ts'
import { BillingConfig } from './config.ts'
import { BillingRpc } from './rpc.ts'

const BillingUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<BillingCommands>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.route('/overview', {
					title: 'Billing',
					order: 50,
				}),
			],
		},
	},
})

const BillingWorkbench = workbench.extension({
	contract: BillingUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

@Plugin({ name: 'BillingPlugin' })
export class BillingPlugin extends BasePlugin {
	private readonly config = this.configs.use(BillingConfig)

	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	override async init(signal: AbortSignal) {
		await this.verifyUpstream({ signal })

		this.ctx.http.plugin.routes((app) => app.get('/invoices', () => this.accounts.listInvoices()))

		this.ctx.workbench.mount(BillingWorkbench, {
			commands: workbench.bind.rpc(() => new BillingRpc(this)),
		})
	}
}
```

这个形状刻意把不同所有权分开：

- browser-safe Contract、server Extension 和 Plugin implementation 分开；
- required dependency 放在 constructor；
- 运行时工作放在 `init()`；
- Workbench贡献通过唯一 optional gate 挂载。

## 单独构建的 Node module

需要把另一份 TS/JS 源码图作为独立 Node ESM 加载，或交给 Tinypool/`worker_threads` 时，在 module level 声明，
并在当前插件 Context 中消费：

```ts
import { BasePlugin, defineNodeModule, Plugin } from '@pluxel/runtime'
import { Tinypool } from 'tinypool'

const taskModule = defineNodeModule(import.meta.url, './task.ts')

@Plugin({ name: 'TaskPlugin' })
export class TaskPlugin extends BasePlugin {
	override async init() {
		await this.ctx.nodeModules.use(taskModule, async (url) => {
			const pool = new Tinypool({ filename: url.href })
			return () => pool.destroy()
		})
	}
}
```

`defineNodeModule()` 只声明 entry，不创建线程；`use()` 等待首次 artifact 与 setup，失败会让插件启动失败。
开发期重建会先用新 URL 完成 setup，再清理上一成功消费者；更新失败保留旧消费者。插件 stop/replacement 自动执行
active cleanup，不保存 binding、revision 或 dispose handle。

也可以在 callback 中直接 `import(url.href)`。artifact 是自包含单文件 Node ESM，可以使用 Node builtin 和可安全
bundle 的普通 library；不能 value-import Pluxel runtime/core、Plugin/Context/Workbench server API，不能导入 CSS/browser
asset，也不能嵌套声明 Plugin、Workbench 或 Node module。没有 artifact 时不会回退 inline execution。

## 依赖：按“缺失时能否工作”选择

### Required plugin dependency

没有 provider 就不能工作时，直接使用 constructor：

```ts
@Plugin({ name: 'OrdersPlugin' })
export class OrdersPlugin extends BasePlugin {
	constructor(private readonly database: CommerceDbPlugin) {
		super()
	}
}
```

不需要在 `@Plugin` 中重复列依赖。Pluxel 工具链生成 `design:paramtypes`，core 据此排序、注入并传播启动失败。

插件源码必须通过宿主的 Vite/Rolldown 链加载。Node 可以执行普通、可擦除类型的 `.ts` 工具脚本，但不会替 Pluxel 生成 legacy decorator metadata，因此不能作为插件源码 runner。

### Optional plugin integration

provider 已由宿主 catalog 管理、只需监听其运行状态时，直接使用 `this.plugins.use(Token)`：

```ts
override init() {
	this.plugins.use(AuditPlugin, (audit) => audit.registerSource(this))
}
```

provider 未运行时 callback 不执行；provider replacement 后会重新绑定。callback 可以返回 cleanup。

实现包本身也允许不存在时，使用 module-level `optionalPlugin()` ref：

```ts
import { BasePlugin, optionalPlugin, Plugin } from '@pluxel/runtime'

const Audit = optionalPlugin(() =>
	import('pluxel-plugin-audit').then(({ AuditPlugin }) => AuditPlugin),
)

@Plugin({ name: 'OrdersPlugin' })
export class OrdersPlugin extends BasePlugin {
	override init() {
		this.plugins.use(Audit, (audit) => audit.registerSource(this))
	}
}
```

ref 必须是 module-level `const`，并包含一个 literal dynamic import 和明确 export selection。Pluxel 在 consumer
启动完成后解析它；目标包 absent 不会阻塞 consumer，包存在但 evaluation、metadata 或启动损坏会产生明确诊断。
首次发现的 candidate 默认启用，此后宿主保存的 disabled state 优先。optional request 不会自动安装包。

不要把 optional integration 放进 constructor，否则它会错误地阻塞主插件；也不要自行执行 raw `import()` 后注册
provider，否则会绕过 graph ownership、dedupe、RuntimeState 和 HMR。

## Feature：只表示插件内部组成

required feature：

```ts
@Plugin({
	name: 'SearchPlugin',
	features: [QueryCacheFeature],
})
export class SearchPlugin extends BasePlugin {
	readonly cache = this.features.use(QueryCacheFeature)
}
```

lazy feature：

```ts
const analyticsFeature = defineLazyFeature({
	key: 'analytics',
	load: async () => (await import('./AnalyticsFeature.ts')).AnalyticsFeature,
})

override async init() {
	const analytics = await this.features.load(analyticsFeature)
	if (analytics) this.installAnalytics(analytics)
}
```

Feature 不承担插件间依赖。判断方法很简单：独立生命周期和替换边界用 plugin；宿主插件内部实现拆分用 feature。

## 配置：声明一次，只读取归一化结果

```ts
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

export const WorkerConfig = v.object({
	concurrency: v.optional(v.number(), 4),
	endpoint: v.string(),
})

@Plugin({ name: 'WorkerPlugin' })
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)

	override init() {
		this.startWorkers(this.config.concurrency)
	}
}
```

- 默认值写进 schema，不在业务代码里再写 fallback。
- `configs.use()` 放在顶层 class field，便于工具链提取稳定 metadata。
- 配置值在 `init()` 或运行期方法中读取，不在 constructor 中读取；runtime 在实例构造后、启动前完成注入和校验。
- 多 schema 页面需要布局时使用 `cfg(schemaMap)`，不要动态拼 schema key。

## 生命周期：失败要诚实，资源要可回收

`init()` 应验证插件能否真正提供能力。必要外部服务不可达、配置无效、数据库 schema 不匹配时直接抛出带行动建议的错误：

```ts
override async init(signal: AbortSignal) {
	const pool = createPool(this.config)
	this.ctx.effects.defer(() => pool.end())

	await assertReachable(pool, { signal })
	await assertSchemaVersion(pool, EXPECTED_SCHEMA_VERSION)
}
```

资源创建成功后立即登记 cleanup。普通资源优先使用 `ctx.effects.defer()`；只有需要明确业务停止顺序时才实现 `stop()`。cleanup 必须幂等。

后台工作应返回可释放 handle，让 `effects.own()` 等待它真正停止：

```ts
const worker = startWorker()
this.ctx.effects.own(worker, { tag: 'worker' })
```

`worker.dispose()` 应停止接单、取消底层工作并等待退出。已有 task 使用 `cancel()` 时可写
`this.ctx.effects.defer(() => task.cancel())`，但 `cancel()` 必须在任务真正停止后才 settle。底层 API 只接受
`AbortSignal` 时，在 worker/task 内部持有局部 `AbortController`，由 `dispose()` abort 后再 await task。

EffectsService 不提供全局 lifetime signal，因为只传 signal 不能让它发现或等待 Promise。HTTP、Command、timeout
等调用级 signal 仍由对应调用边界传递；不要用 effects 生命周期替代请求取消。

不要捕获启动错误后只记日志继续运行。那会制造“生命周期显示 running、能力实际不可用”的半启动状态。

core 的行为是：失败插件不进入 running，required dependents 被阻塞，无关插件继续。是否退出进程、告警或拒绝部署由宿主决定。

插件确实需要停止自身时调用 `this.ctx.registry.shutdownSelf()`。它会登记 removal 并调度后续 commit，返回
`void`；不要 `await`，因为 lifecycle 必须先等待当前 owner invocation 返回，才能安全停止这个 generation。

## HTTP 与 Workbench Plane

### 业务 HTTP

业务路由始终使用 `ctx.http.plugin`：

```ts
override init() {
	this.ctx.http.plugin.routes((app) =>
		app.get('/health', () => ({ ok: true })),
	)
}
```

HTTP 不依赖 Workbench Plane，适合业务 API、webhook、health endpoint 和外部集成。

默认路由位于 `/__pluxel/plugins/<plugin-id>`，适合不需要宿主级稳定地址的插件 API。产品协议需要
固定根路径时，仍由插件直接声明，不要改用 `ctx.http.host`：

```ts
override init() {
	this.ctx.http.plugin.routes(
		(app) => app.get('/health', () => ({ ok: true })),
		{ publicPath: '/orders' },
	)
}
```

`publicPath` 只改变挂载地址，不表示匿名访问；鉴权仍由插件负责。它与 scoped `path` 互斥，不能占用
runtime root 或 `/__pluxel` 保留命名空间。路由依旧归当前 plugin Context 所有，插件停止、替换和 HMR
时自动清理。不要从插件调用 `ctx.http.host.routes()` 绕过这个 ownership。

### 可选 Workbench

Workbench 使用三个文件边界：

```text
browser-contracts.ts   RPC/data/event 类型
workbench-contract.ts  browser-safe Contract
plugin.ts              Extension、Binding 与业务实现
ui/index.tsx           直接导入 Contract value
```

服务端只挂载 Extension 和显式 Binding：

```ts
const DashboardWorkbench = workbench.extension({
	contract: DashboardUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

override init() {
	this.ctx.workbench.mount(DashboardWorkbench, {
		commands: workbench.bind.rpc(() => new DashboardRpc(this)),
		notes: workbench.bind.liveQuery({
			database: this.database,
			dependsOn: [notes],
			query: (db) => db.select({ id: notes.id, title: notes.title }).from(notes),
		}),
		activity: workbench.bind.events(({ emit, signal }) =>
			this.publishStatus(emit, signal),
		),
	})
}
```

- Contract module 只导入 browser-safe 类型和 `@pluxel/runtime/workbench/contract`；
- Extension 不写 plugin ID，owner 由 `ctx.workbench.mount()` 的 Context 推导；
- `bind.rpc()`、`bind.liveQuery()`、`bind.events()` 都是纯 declaration，disabled 时不执行 query 或 producer；
- `liveQuery` 只投影当前 plugin database 的 runtime-validated DTO，mutation 走 typed RPC；
- `dependsOn` 完整列出查询读取的普通 Drizzle tables，并与 database handle 保持同 owner；
- builtin document 只用于只读内容，交互界面使用 React View + RPC。

浏览器直接传入 Contract value：

```tsx
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { DashboardUi } from '../workbench-contract.ts'

const ui = createWorkbenchUi(DashboardUi)

export function Overview() {
	const { commands, notes } = ui.useResources()
	const snapshot = notes.useQuery()

	if (snapshot.state === 'loading') return <Loading />
	if (snapshot.state === 'error') return <ErrorPanel error={snapshot.error} />
	return <Dashboard commands={commands} rows={snapshot.rows} />
}

export default ui.define({ Overview })
```

`ui.define()` 精确检查全部 remote View，没有额外 export。普通 View 不声明 `uses`；同一 bundle 是
owner resources 的前端信任边界，facade 按 RPC 调用、query variant 或 event subscription 延迟连接。

集合页需要把不同对象作为 Workbench 原生 Tab 打开时，声明一个不进入导航的参数化 route：

```ts
const AccountsUi = workbenchContract.define({
	views: {
		Launcher: {
			placements: [workbenchContract.route('/accounts', { title: 'Accounts' })],
		},
		Account: {
			placements: [
				workbenchContract.route('/accounts/:accountId', {
					title: 'Account',
					navigation: false,
				}),
			],
		},
	},
})
```

```tsx
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'

export function Launcher() {
	const host = useWorkbenchHost()
	return (
		<button
			onClick={() =>
				host.openTab({ path: '/accounts/notifications', title: 'notifications', meta: 'Bot' })
			}
		>
			Open
		</button>
	)
}

export function Account() {
	const { routeParams } = useWorkbenchHost()
	return <AccountDetails accountId={routeParams.accountId ?? ''} />
}
```

参数只匹配完整路径段，参数名必须以字母开头；参数化 route 必须设置 `navigation: false`。`openTab()` 的
`path` 只能指向当前 Workbench target 已注册的 shell route，不能跳转到任意宿主 URL。相同规范化路径只保留一个
Tab，再次打开会聚焦并更新标题；Tab 和 metadata 会随 Workbench 恢复。

RPC generic 应引用独立 browser-safe interface，而不是 provider 实现类。TypeScript generic 在运行时会擦除；
runtime 只验证 envelope、opaque grant、resource kind、Port/version 和结构化错误。

### 依赖插件注入统一配置 Tab

跨插件 UI 使用 typed Port。consumer 拥有 placement 和注入资源，provider 只提供无 placement renderer：

```ts
export const FetchSettingsPort = workbenchContract.port({
	id: 'fetch.settings',
	version: 1,
	resources: {
		settings: workbenchContract.rpc<FetchSettingsCommands>(),
	},
})

export const ConsumerWorkbench = workbench.portOutlet({
	id: 'FetchSettings',
	port: FetchSettingsPort,
	placement: workbenchContract.tab({
		label: 'Fetch',
	}),
})

export const FetchUi = workbenchContract.define({
	resources: {},
	views: {
		FetchSettings: { accepts: FetchSettingsPort },
	},
})
```

```tsx
const ui = createWorkbenchUi(FetchUi)

export function FetchSettings() {
	const { settings } = ui.usePort(FetchSettingsPort)
	return <FetchSettingsForm commands={settings} />
}

export default ui.define({ FetchSettings })
```

renderer 从 consumer 的 committed direct required dependencies 中按 Port ID + exact version 唯一解析。provider
不能决定 consumer placement；零个 renderer 显示 unavailable，多个显示 ambiguity error，不按注册顺序猜测。

`portOutlet()` 自动声明与 Port 同名的一对一 resources 和 mapping。consumer 需要重命名、组合多个 resource
或只注入部分已有 resource 时，使用完整的 `workbenchContract.define({ resources, outlets })`。

provider stop/replacement 会立即撤销 Port grant。renderer 自己的 owner resources 与 consumer 注入 resources 使用
独立、target-scoped grant；transport 只提交 opaque grant，不提交 plugin/resource namespace。

## 公开有限事件集合

插件公开的事件集合在设计时已知时，使用命名的 `EvtChannel` 属性，让调用方获得可发现、可精确
类型化的 API：

```ts
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/runtime'

type InvoicePaid = (invoice: Invoice, signal: AbortSignal) => void | Promise<void>

@Plugin({ name: 'BillingPlugin' })
export class BillingPlugin extends BasePlugin {
	readonly events = {
		invoicePaid: new EvtChannel<InvoicePaid>(this.ctx),
	} as const
}

billing.events.invoicePaid.on(async (invoice, signal) => {
	await projectInvoice(invoice, { signal })
})
```

不要为有限事件重新实现 `Map<string, handler>`，也不要把所有事件压成一个宽泛 payload 再让调用方
自行分支。`EvtChannel.on()` 会把订阅绑定到调用方 Context 的 effects，插件停止或替换时自动清理；
它仍返回幂等 disposer，并支持 `{ signal }`。生产者需要等待所有异步 listener 且隔离单项失败时，
使用 `emitSettled()`。

只有事件名本身确实由用户或外部系统动态定义时，才使用动态 registry。若 capability 管理多个资源，
可以同时提供资源局部 channel 与 capability 聚合 channel；聚合 channel 的第一个参数应明确标识来源。

## 公开外部系统 capability

包装外部平台 SDK 或 API 时，让平台原生具名方法直接出现在 capability 对象上；Pluxel 增加的 raw、
生命周期、组合工具和诊断统一放在 `$`，避免 `api/client/$raw/$tool` 多套入口并存：

```ts
const bot = telegram.bots.require('notifications')
await bot.sendMessage(payload)

bot.selfInfo // 鉴权后的平台原生身份，未鉴权时为 undefined
bot.$.info // 冻结的本地 ID/API 地址等非敏感元数据
await bot.$.raw.call('sendMessage', payload, { signal })
```

`$.info`、status、日志和序列化结果不得包含 token、secret、Context 或内部 client。对象已经拥有 owner
Context 时，从 `ctx.logger.with(...)` 派生带资源标识的 logger，不要重复注入 logger；向底层 client
传参时列出明确字段，不要展开包含 Context、事件或其他 capability 的大 options 对象。

大量固定原生方法应由一个共享 prototype 承载，standalone client 与受管对象复用同一方法实现；
不要在每个实例构造时批量创建闭包，也不要为了复用 client 而把 `call/$raw/$tool` 泄漏到受管对象
顶层。

长连接或后台 polling capability 的 `$.status` 应返回冻结、有界、无密钥的实时快照，记录 phase、
累计计数和最近时间点，不保存无界历史。连接状态机是事实源，Workbench Plane state 只是投影；
heartbeat、空 poll 等高频内部变化不应造成固定周期持久化写。最低层网络 transport 应支持 factory
注入，使重连、退避和 teardown 能在不访问真实网络的测试中验证。

外部 stream 带 sequence/cursor 时，把 decode 和 listener 调度串到同一异步 tail，并在 listener 完成后
再提交 checkpoint。重复项应幂等丢弃，乱序项只能进入有明确上限的 buffer；断线恢复必须等待旧 tail
收敛后再读取 checkpoint。resume 被协议拒绝、ACK 超时或缺口无法收敛时，应清空旧恢复状态并回退
全新连接，不能无限重试过期 session，也不能让 buffer 无界增长。

## 错误边界

生命周期错误和单次业务错误不要混淆：

- 插件无法继续提供能力：让 `init()` 失败，或由宿主触发 restart/replacement。
- 单个请求参数错误、上游超时、mutation 失败：返回请求级错误，不改变插件生命周期。
- timer、watcher、queue consumer 等后台任务：捕获并记录每次错误，按业务语义重试或暂停。

```ts
const timer = setInterval(() => {
	void this.syncOnce().catch((error) => {
		this.ctx.logger.error('sync failed', { error })
	})
}, 30_000)

this.ctx.effects.defer(() => clearInterval(timer))
```

## 宿主约束

宿主使用 static 或 dynamic Vite route 加载插件源码。两条 route 的插件作者 API 完全相同。

Workbench Plane 只有一个顶层配置来源：

```ts
workbench: false
```

或：

```ts
workbench: {
	enabled: true,
	access: { exposure: 'private' },
}
```

关闭时，宿主不创建 UI compiler、watcher、管理路由或 workbench state backend。

## 提交前检查

CLI monorepo 模板已经配置 Pluxel Oxlint rules。先运行 `pnpm lint:fix`，再运行覆盖 format、lint、
typecheck、tests 和 production build 的 `pnpm verify`。

测试最低覆盖标准和 core/runtime test host 的选择见 [`testing.md`](testing.md)。

- required dependency 是否只写在 constructor？
- optional integration 是否使用 `plugins.use()`？
- feature 是否确实是插件内部组成？
- 默认值是否都在 schema？
- 启动前置条件是否在 `init()` 中验证并诚实失败？
- 每个资源是否在创建后立即登记 cleanup？
- 业务 HTTP 是否独立于 Workbench Plane？
- Workbench资源是否全部通过 `ctx.workbench.mount()` 挂载？
- 后台任务是否捕获错误？
- 插件是否只通过 Vite/Rolldown 宿主入口运行？
