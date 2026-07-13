# 编写 Pluxel 插件

这是一条面向插件作者的主路径。先按本文建立插件结构，再用
[`plugin-best-practices.md`](plugin-best-practices.md) review 所有权，并让
[`oxlint.md`](oxlint.md) 检查可静态判断的约束。

插件测试使用 [`testing.md`](testing.md) 的 `@pluxel/test/vitest` 标准工具链，不用 raw runner 绕过
decorator 和 metadata transform。

## 先记住四件事

1. 插件是依赖和生命周期单元。
2. constructor 只放没有它就无法工作的插件依赖。
3. `init()` 负责启动检查、注册运行时能力和登记资源清理。
4. HTTP 是常驻业务能力；Management Module 只通过可选的 `ctx.management.mount()` 挂载。

## 一个标准插件

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	defineManagementModule,
	managementBinding,
	managementResource,
	managementUi,
} from '@pluxel/runtime/management'

import { AccountsPlugin } from './AccountsPlugin.ts'
import { BillingConfig } from './config.ts'
import { BillingRpc } from './rpc.ts'

const BillingManagement = defineManagementModule({
	id: 'BillingPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<BillingRpc>(),
		status: managementResource.collection<BillingStatus>(),
	},
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

		const mounted = this.ctx.management.mount(BillingManagement, {
			api: managementBinding.api(() => new BillingRpc(this)),
			status: managementBinding.collection(),
		})
		await mounted?.resources.status.ready()
	}
}
```

这个形状刻意把不同所有权分开：

- declaration 放在 decorator、class field 或 module scope；
- required dependency 放在 constructor；
- 运行时工作放在 `init()`；
- 管理面贡献通过唯一 optional gate 挂载。

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

缺少 provider 只损失增强能力时，使用 `this.plugins.use()`：

```ts
override init() {
	this.plugins.use(AuditPlugin, (audit) => audit.registerSource(this))
}
```

provider 未运行时 callback 不执行；provider replacement 后会重新绑定。callback 可以返回 cleanup。

不要把 optional integration 放进 constructor，否则它会错误地阻塞主插件。

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

不要捕获启动错误后只记日志继续运行。那会制造“生命周期显示 running、能力实际不可用”的半启动状态。

core 的行为是：失败插件不进入 running，required dependents 被阻塞，无关插件继续。是否退出进程、告警或拒绝部署由宿主决定。

## HTTP 与 Management Plane

### 业务 HTTP

业务路由始终使用 `ctx.http.plugin`：

```ts
override init() {
	this.ctx.http.plugin.routes((app) =>
		app.get('/health', () => ({ ok: true })),
	)
}
```

HTTP 不依赖 Management Plane，适合业务 API、webhook、health endpoint 和外部集成。

### 可选管理面

```ts
override init() {
	this.ctx.management.mount(DashboardManagement, {
		api: managementBinding.api(() => new DashboardRpc(this)),
		activity: managementBinding.stream(this.createStatusStream()),
		status: managementBinding.collection(),
	})
}
```

宿主未启用 Management Plane 时，`mount()` 返回 `undefined`，不注册 module、resource 或 artifact。因此：

- binding declaration 必须是纯描述；`api()` 只保存 factory，真正实例仅在启用后按需创建；
- 插件核心业务不能依赖 mount 成功；需要 collection handle 时使用 `mounted?.resources`；
- module contract 静态声明资源、贡献、placement 和 UI artifact；
- binding 在运行期把 API、collection、stream 实现绑定到 contract；
- collection 适合状态面板、表单和管理交互，不是业务数据库；
- collection 默认是非持久化的管理面投影；只有确实拥有独立管理状态时才显式传入
  `managementBinding.collection({ persistence: true })`；
- builtin document 中 ref/write 的 `collection` 是 module resource key；每个 key 独立解析为
  revision-scoped opaque binding，不使用插件名作为 collection namespace；
- 管理资源只服务管理员 UI，不替代公共业务 HTTP API。

`managementUi(import.meta.url, './ui/index.tsx')` 是静态字符串 declaration，没有 import 或注册副作用。
开发环境由 compiler 按源码 hash 增量构建；`pluxel build` 按 owner 生成
`dist/management/<owner>/`，无 UI 插件不会加载 Vite，且 UI 源码不会进入服务端插件 bundle。
UI 使用的 React、React DOM、Mantine 和 `@pluxel/runtime` 由宿主提供 singleton shared；带 UI 的插件包应
把它们声明为 peer，并作为本地 devDependency 安装供类型检查和 MF named-export 分析，remote 不携带 fallback
副本。

UI entry 用同一个 typed app 同时定义 exports 和读取当前 layout bindings：

```tsx
const app = managementApp(DashboardManagement)

export function Overview() {
	const runtime = app.use()
	return <Dashboard data={runtime.collection('status').useList()} />
}

export default app.define({ Overview })
```

`app.api()` 返回浏览器 RPC client；即使服务端方法同步返回值，跨边界调用也始终是 `Promise`。事件处理器应
使用 `await` 或显式处理 rejection，不要按本地对象同步读取结果或字段。

### 依赖插件注入统一配置 Tab

provider 不应替 consumer 决定任意 placement。把可复用能力定义成 typed port，由 consumer 明确声明
Tab 和自己的资源 binding，provider 只提供 renderer：

```tsx
export const FetchSettingsPort = defineManagementPort('fetch.settings', {
	settings: managementResource.api<FetchSettingsApi>(),
})

// consumer module
const ConsumerManagement = defineManagementModule({
  id: 'ConsumerPlugin',
  resources: {
    fetchSettings: managementResource.api<FetchSettingsApi>(),
  },
  contributions: [managementPort({
    id: 'fetch-settings',
    placement: ManagementPlacements.PluginTabs,
    port: FetchSettingsPort,
    providers: ['FetchPlugin'],
    bindings: { settings: 'fetchSettings' },
    meta: { label: 'Fetch' },
  })],
})

// consumer init: placement 和授权属于 consumer，API 可委托给 required Fetch capability
override init() {
  this.ctx.management.mount(ConsumerManagement, {
    fetchSettings: managementBinding.api(() => this.fetch.settingsFor(this.ctx.pluginInfo.id)),
  })
}

// provider module
const FetchManagement = defineManagementModule({
  id: 'FetchPlugin',
  ui: managementUi(import.meta.url, './ui/index.tsx'),
  contributions: [managementPortRenderer({
    id: 'fetch-settings-renderer',
    port: FetchSettingsPort,
    view: remoteView('FetchSettings'),
  })],
})

// provider UI entry
const provider = managementApp(FetchManagement)
const settingsPort = managementApp(FetchSettingsPort)

export function FetchSettings() {
  const settings = settingsPort.use().api('settings')
  return <FetchSettingsForm settings={settings} />
}

export default provider.define({ FetchSettings })
```

renderer 使用 port app 读取当前 layout 的 `settings` binding，并用拥有 remote 的 provider app 导出
view。同一个 renderer 可投放到任意数量的 consumer；每个实例都绑定到对应 consumer 授权的配置资源。
port 不引入隐藏存储：状态可以由 consumer 自己持有，也可以像示例一样显式委托给 Fetch capability 按
consumer id 持有；renderer 和 Workbench 都不保存服务端 session/draft。layout 只下发
opaque binding，插件卸载、依赖变化或 HMR revision 更新后旧 binding 自动失效。

provider 若只想把只读能力摘要自动投影给 required dependents，可使用
`managementAudience.requiredDependents()`，该模式只能进入 host-owned `plugin.capabilities`；任意 Tab、
route 或 action placement 必须使用 port，由 consumer 显式选择。

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
累计计数和最近时间点，不保存无界历史。连接状态机是事实源，Management Plane state 只是投影；
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

Management Plane 只有一个顶层配置来源：

```ts
management: false
```

或：

```ts
management: {
	enabled: true,
	access: { exposure: 'private' },
}
```

关闭时，宿主不创建 UI compiler、watcher、管理路由或 management state backend。

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
- 业务 HTTP 是否独立于 Management Plane？
- 管理面资源是否全部通过 `ctx.management.mount()` 挂载？
- 后台任务是否捕获错误？
- 插件是否只通过 Vite/Rolldown 宿主入口运行？
