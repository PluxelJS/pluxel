# Plugin Authoring Model

本文档面向 Pluxel 插件作者和宿主应用开发者。目标是先把插件模型写清楚：插件应该如何启动、如何失败、如何管理资源、如何表达依赖。不要先引入 `fatal`、`required`、resource profile 之类更高层策略；这些都应该建立在稳定的插件错误模型之上。

## 核心判断

插件失败是插件生命周期状态，不是进程控制能力。

插件作者只需要表达：

- 我需要哪些配置和依赖。
- 我启动前必须验证哪些条件。
- 条件不满足时我启动失败。
- 我创建了哪些资源，以及如何释放。

插件作者不应该表达：

- 这个失败是否应该杀进程。
- 这个插件是否是宿主关键能力。
- 失败后宿主要不要摘流量、重启、告警。

这些属于入口、部署环境、health check、CI 或管理界面策略。

## Core 错误模型

Pluxel core 的插件模型应该保持小而确定：

- `init()` 抛错：该插件本轮启动失败。
- 依赖它的插件：不启动，并在 lifecycle report 中记录 dependency issue。
- 不依赖它的插件：继续按依赖拓扑和并发策略启动。
- 启动失败的插件：仍保留在 registry/container 中，后续 config、HMR 或下一次 commit 可以重试。
- `stop()` 或 dispose 失败：记录错误，但不应该阻塞整体关闭。
- core 不负责决定是否退出进程。

这意味着启动失败不是“系统崩了”，而是“这次生命周期提交中某个节点没有进入 running 状态”。

提交后的生命周期观察面是 `CommitSummary.lifecycleReport`：

- `lifecycleReport.ok` 是快速判断本次生命周期是否有问题的摘要。
- `lifecycleReport.issues` 是唯一事实列表，记录插件、阶段、错误类型、消息和依赖阻塞关系。
- 需要派生“哪些插件未启动 / 被依赖阻塞 / 停止时报错”时，使用 lifecycle selector helper，不要在业务代码里重复手写过滤条件。

## 插件最佳写法

### 在 `init()` 做确定性启动检查

配置错误、连接失败、数据库 schema version 不匹配、必要外部服务不可用，都应该在 `init()` 中验证。失败时直接抛错，不要只打日志然后继续半启动。

```ts
class CommerceDbPlugin extends BasePlugin {
	private pool?: Pool

	override async init(signal: AbortSignal) {
		const config = this.dbConfig
		const pool = createPool(config)
		this.pool = pool
		this.ctx.effects.defer(() => pool.end())

		await assertReachable(pool, { signal })
		await assertSchemaVersion(pool, EXPECTED_SCHEMA_VERSION)
	}

	get client() {
		if (!this.pool) throw new Error('CommerceDbPlugin is not running')
		return this.pool
	}
}
```

不要这样写：

```ts
override async init() {
	try {
		await assertSchemaVersion(this.pool, EXPECTED_SCHEMA_VERSION)
	} catch (error) {
		this.ctx.logger.error('schema check failed', { error })
	}
}
```

这种写法会让插件看起来启动成功，但实际处于不可用状态。

### 用依赖表达硬前置条件

如果一个插件没有另一个插件就不能工作，应该把它建模为插件依赖。比如订单插件需要数据库 provider，就依赖 `CommerceDbPlugin`。

```ts
@Plugin({ name: 'Orders', dependencies: [CommerceDbPlugin] })
class OrdersPlugin extends BasePlugin {
	constructor(private readonly db: CommerceDbPlugin) {
		super()
	}

	override init() {
		this.ctx.http.plugin.routes((app) => {
			app.get('/orders', async () => this.db.client.query.orders.findMany())
		})
	}
}
```

这样 `CommerceDbPlugin` 启动失败时，`OrdersPlugin` 自然不会启动。业务插件不需要自己重复判断数据库是否 ready。

### 可选插件集成和 lazy feature 不要写成硬依赖

如果某个能力只是增强功能，不应该阻塞主插件启动。可选能力应该在运行期探测并降级。

如果增强能力由另一个插件提供，使用 `this.plugins.use()`；provider 未运行时回调不执行，provider 替换后会重新绑定：

```ts
override init() {
	this.plugins.use(AuditPlugin, (audit) => audit.registerSource(this))
}
```

如果增强能力是当前插件内部的按需组成，使用 module top-level 的 lazy feature 声明：

```ts
const auditFeature = defineLazyFeature({
	key: 'audit',
	load: async () => (await import('./AuditFeature')).AuditFeature,
})

override async init() {
	const audit = await this.features.load(auditFeature)
	if (audit) this.registerAuditHooks(audit)
}
```

不要把可选服务放进 constructor 硬依赖，否则它失败会让主插件也进入 lifecycle report 的启动失败链路。

## Web Management 可选边界

HTTP、配置、日志、effects、events 和插件持久化是常驻能力。UI、插件管理 RPC/SSE 和管理态同步只存在于 Web Management：

```ts
import { ui } from '@pluxel/runtime/web-management'

const dashboard = ui(import.meta.url, './ui/index.tsx')

override init() {
	this.ctx.http.plugin.routes((app) => app.get('/health', () => ({ ok: true })))

	this.ctx.webManagement.use((web) => {
		web.ui.register(dashboard)
		web.rpc.expose(() => new DashboardRpc(this))
		web.sse.expose(() => this.events())
		web.state.collection({ name: 'dashboard-status' })
	})
}
```

宿主关闭 Web Management 时回调体完全不执行，也不会影响插件生命周期。不要在回调外创建仅供管理 UI 使用的状态或资源。

`ui()` 只是纯声明，不携带运行时注册方法。开发环境由 Vite 在 `web.ui.register()` 时绑定源码，生产环境由同一个入口注册已构建制品。

宿主只有一个开关：`webManagement: false`，或 `webManagement: { enabled: true, access: { exposure: 'private' } }`。

## 依赖和 Feature 声明

required 插件依赖必须同时出现在 constructor 和装饰器元数据中：

```ts
@Plugin({ name: 'Orders', dependencies: [CommerceDbPlugin] })
class OrdersPlugin extends BasePlugin {
	constructor(private readonly db: CommerceDbPlugin) {
		super()
	}
}
```

required 本地 feature 使用 `this.features.use()`，并显式列入 `@Plugin({ features: [...] })`。正确性不依赖 class-field AST 推断。

### 资源创建后立即注册清理

连接池、worker、watcher、subscription、timer 创建成功后，马上注册清理逻辑。清理逻辑必须幂等。

```ts
override async init() {
	const watcher = watch(this.dir)
	this.ctx.effects.defer(() => watcher.close())

	const timer = setInterval(() => void this.flush(), 10_000)
	this.ctx.effects.defer(() => clearInterval(timer))
}
```

如果资源必须按业务顺序停止，可以实现 `stop()`；但普通资源释放优先用 `ctx.effects.defer(...)`，避免遗漏。

### 运行期业务错误不要变成生命周期错误

单次 HTTP 请求失败、GraphQL mutation 参数错误、外部 API 超时、用户输入无效，应该作为请求错误或业务错误返回。它们不应该让插件停止。

```ts
app.post('/orders', async ({ body, status }) => {
	const parsed = OrderInput.safeParse(body)
	if (!parsed.success) return status(400, parsed.error.message)
	return this.orders.create(parsed.output)
})
```

只有插件无法继续提供自身能力时，才应该让生命周期失败。

### 后台任务必须捕获错误

后台循环、队列 consumer、watcher callback、fire-and-forget async task 都不能裸跑。错误必须被捕获、记录，并根据插件自己的语义决定继续、暂停或触发重试。

```ts
override init() {
	const timer = setInterval(() => {
		void this.syncOnce().catch((error) => {
			this.ctx.logger.error('sync failed', { error })
		})
	}, 30_000)

	this.ctx.effects.defer(() => clearInterval(timer))
}
```

不要这样写：

```ts
override init() {
	setInterval(() => {
		void this.syncOnce()
	}, 30_000)
}
```

这种错误容易变成未观测异常，也不会进入清晰的插件状态。

## 数据库和 migration

数据库连接可以作为 provider plugin。它不是“每个裸连接都是一个插件”，而是一个稳定能力提供者。

推荐模型：

- `CommerceDbPlugin` 管理连接池、配置、schema version check。
- `OrdersPlugin`、`BillingPlugin` 等业务插件依赖它。
- migration 执行不放进 Pluxel core。
- migration 是否已经执行，由 DB provider plugin 在 `init()` 中检查。

```ts
class CommerceDbPlugin extends BasePlugin {
	override async init(signal: AbortSignal) {
		this.pool = createPool(this.config)
		this.ctx.effects.defer(() => this.pool.end())

		await assertReachable(this.pool, { signal })
		await assertSchemaVersion(this.pool, '2026_06_24_001')
	}
}
```

如果 schema version 不满足，`CommerceDbPlugin` 抛错。依赖它的业务插件不启动。入口和管理界面可以基于启动报告决定如何提示、告警或阻止发布。

## 配置读取

配置声明可以写在 class field，但配置值只能在 `init()` 或运行期方法中读取。

```ts
class CommerceDbPlugin extends BasePlugin {
	dbConfig = this.configs.use(CommerceDbConfig)

	override async init() {
		const pool = createPool(this.dbConfig)
		this.ctx.effects.defer(() => pool.end())
	}
}
```

不要在 constructor 中读取配置值。配置注入发生在 runtime 构造实例之后、启动之前；过早读取会拿到 sentinel 或导致不确定行为。

## 日志应该服务于定位

插件启动失败时，优先抛出带上下文的错误。日志用于补充现场，不要替代失败。

推荐错误信息包含：

- 哪个前置条件失败。
- 当前值和期望值。
- 用户或运维应该做什么。

```ts
throw new Error(
	`CommerceDb schema version mismatch: expected ${EXPECTED}, got ${actual}. Run migrations before starting this host.`,
)
```

避免：

```ts
throw new Error('db error')
```

## 插件作者检查清单

- 启动前置条件是否都在 `init()` 中验证？
- 不满足前置条件时是否直接抛错？
- 硬依赖是否用插件依赖表达？
- 可选能力是否不会阻塞主插件？
- 创建的资源是否注册了清理？
- 后台任务是否捕获并记录错误？
- 请求级错误是否没有升级成插件生命周期失败？
- 配置值是否只在 `init()` 或运行期方法中读取？
- 错误信息是否足够定位问题？

## 暂时不要引入的概念

在插件模型稳定前，不要急着引入这些概念：

- 插件自己声明 `fatal`。
- 插件自己决定是否退出进程。
- core 内置 migration runner。
- 每个资源 profile 都变成新的顶层模型。
- 为了“重要错误”改变启动调度顺序。

这些可以由入口、管理界面、部署系统或未来更高层策略处理。插件模型本身先保持简单、确定、可组合。
