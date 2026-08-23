---
title: Plugin 模型与生命周期
description: 理解 Plugin 的依赖关系、版本代际、可选集成、资源回收和失败传播。
---

Plugin 不只是一个由宿主任意调用的类，而是依赖图中可独立启动和停止的能力节点。只有必需依赖已经运行、配置通过校验且 `init()` 成功后，它才会进入运行状态。

## 三种组成关系

先判断一项能力是否需要独立的生命周期，再选择关系：

| 关系             | 何时使用                        | 写法                                     |
| ---------------- | ------------------------------- | ---------------------------------------- |
| 必需 Plugin      | 缺少提供方就不能工作            | 构造器参数 + 值导入                      |
| 可选 Plugin 集成 | 提供方只是可选增强              | `definePluginRef<T>()` + `plugins.use()` |
| owner-bound Part | 需要局部配置/资源，但不独立治理 | `this.parts.use(PluginPartClass)`        |
| 简单内部 helper  | 只有少量纯逻辑或显式 wiring     | 普通类或函数 + effects                   |

不要把所有组成都拆成 Plugin。Plugin 边界意味着独立的 identity、graph edge、启动结果和 replacement 行为；只服务一个 owner 的 cache、client 或 helper 通常应留在 owner 内部。

## Required dependency

从 provider package 根入口 value-import 具体 Plugin，并直接放入 constructor：

```ts twoslash
// @filename: accounts.ts
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Accounts' })
export class AccountsPlugin extends BasePlugin {
	listInvoices(): readonly string[] {
		return []
	}
}

// @filename: billing.ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { AccountsPlugin } from './accounts.ts'

@Plugin({ displayName: 'Billing' })
class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	listInvoices() {
		return this.accounts.listInvoices()
	}
}
```

真实项目应从 `@acme/accounts` package root 的 named export 导入 `AccountsPlugin`。构建工具从这个 value import 和 constructor 参数生成 required edge；`@Plugin()` 不再重复声明依赖。

同一个 Plugin definition 不能在一个 constructor 中重复声明。dependency override 按 requirement definition 识别依赖，参数名和位置不会成为
持久配置；如果需要 primary/replica 这类双角色，应先定义具有不同语义身份的 Plugin token，而不是重复同一个参数类型。

provider 启动失败时，consumer 不会拿到一个半可用实例：consumer 被标记为 blocked，其他无关分支仍可以继续运行。

注入值是绑定 consumer caller Context 和当前 provider generation 的轻量 facade。provider replacement 后旧 facade、旧 method
reference 与旧字段写入都会被拒绝；普通 public field 的读写仍作用于 provider 自己的实例，不会在 consumer 侧形成影子字段。

因此 Plugin 及其基类不能声明 ECMAScript `#private` field、method 或 accessor：这类成员要求 receiver 持有原生 private brand，
与 caller facade 不兼容，构建工具会报 `plugin_caller_view_private_brand_unsupported`。TypeScript `private` 普通属性可以使用；
需要 runtime 强封装时，把状态放进 closure，或从 capability 返回带有明确 stop/replacement 失效语义的 handle。这个限制不适用于
不会被依赖注入的 `PluginPart`。

Plugin 对其他节点暴露的可调用成员应写成普通 prototype method；accessor只返回普通数据或有自身receiver与失效契约的对象handle。
不要写 `status = () => ...`、function expression field或 `this.status.bind(this)` field。这些写法会捕获 raw provider，无法保留 consumer 的 caller Context，构建工具会报
`plugin_caller_view_callable_field_unsupported`。普通数据 field 仍可读写；需要 callable handle 时返回有独立对象 receiver 和明确
stop/replacement 失效语义的 capability。

## Optional integration

如果最终宿主可以完全不安装 provider，使用 type-only import 和 module-level opaque ref：

```ts twoslash
// @filename: audit.ts
import { BasePlugin } from '@pluxel/runtime'

export declare class AuditPlugin extends BasePlugin {
	registerSource(source: BasePlugin): void
}

// @filename: orders.ts
import type { AuditPlugin } from './audit.ts'
import { BasePlugin, definePluginRef, Plugin } from '@pluxel/runtime'

const Audit = definePluginRef<AuditPlugin>()

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	override init() {
		this.plugins.use(Audit, (audit) => audit.registerSource(this))
	}
}
```

这条写法有严格边界：

- ref 是 non-exported module-level `const`；
- type 必须能唯一追溯到具体 Plugin 的 package-root named export；
- `plugins.use()` 是 `init()` 中的直接语句；
- callback 同步执行，可以返回 cleanup 或 disposable；
- ref 不会 import、安装、注册或自动启用 provider package。

provider absent、disabled 或 start-failed 时 callback 不执行，也不阻塞 consumer。provider generation 出现、消失或 replacement 时，Core 会重启 consumer 及其 required dependent closure，使 optional integration 不会持有旧 provider。

不要用动态 `import()`、轮询 availability 或缓存裸实例模拟 optional edge。高频变化的业务对象也不适合建模为 Plugin graph edge。

## 用 PluginPart 拆分 owner 内部资源

当内部组成需要自己的 config、effects、commands/HTTP registration 或 nested composition，但仍应与父 Plugin 一起启动、失败和
重启时，使用 `PluginPart`。作者不传 `ctx`、config 或 effects：

```ts no-twoslash
import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'

const CacheConfig = v.object({ maxEntries: v.optional(v.number(), 1_000) })

class CachePart extends PluginPart<SearchPlugin> {
	private readonly config = this.configs.use(CacheConfig)

	override init() {
		const cache = createCache(this.config.maxEntries)
		this.ctx.effects.defer(() => cache.close())
	}
}

@Plugin({ displayName: 'Search' })
export class SearchPlugin extends BasePlugin {
	readonly cache = this.parts.use(CachePart)
}
```

`parts.use()` 必须完整占据一个普通 class field initializer；Part 不写 constructor，也不加 `@Plugin`。每个 field occurrence
都有独立实例、child Context 和 effects scope，相同 Part class 可以使用多次。Part 也可用同样方式拥有 child Part。
Part 在每个 owner generation 中都会构造并调用 `init()`，因此 field initializer 只放声明和轻量状态，资源与外部副作用留在
`init()` 中。

启动顺序是深度优先的 children-before-owner：nested child Part、direct Part，最后才是 Plugin `init()`。停止和 rollback
通过 effects LIFO 反向清理。Part `init()` 失败会让整个 Plugin start 失败，lifecycle error 会指出 `partPath`。

### 理解 Part Context 的隔离边界

Part 得到的不是 owning Plugin 的同一个 Context，也不是新的 root：

```ts no-twoslash
part.ctx !== part.plugin.ctx
part.ctx.root === part.plugin.ctx.root
part.ctx.effects !== part.plugin.ctx.effects
```

它隔离 registration、cleanup 和诊断所有权，同时共享 runtime backend。没有 owner-bound view 的普通 service 继续复用 Plugin
service handle，因此 Part Context 不是安全 sandbox，也不会为每个 Part 复制完整 service graph。

| 能力               | Part 用法                                                                   | 所有权边界                                                 |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| config             | `this.configs.use(schema)`                                                  | 独立 slice，同一个 Plugin config record                    |
| effects/logger     | `this.ctx.effects` / `this.ctx.logger`                                      | child scope 与 `partPath`，随 owner 回收                   |
| optional Plugin    | `this.plugins.use(ref, setup)`                                              | edge 合并到 owner，provider 变化重启 owner                 |
| commands/HTTP      | 对应 `ctx` capability                                                       | facade 绑定 Part，catalog/server 共享                      |
| Node module/worker | module-level `defineNodeModule()` / `defineWorkerTask()` + `ctx` capability | consumer 属于 Part，compiler/pool 共享                     |
| database           | owning Plugin 的 `ctx.database` capability                                  | database definition、migration 和 handle owner 仍是 Plugin |
| required Plugin    | owning Plugin constructor 声明，Part 通过类型化 `this.host` 使用            | 不给 Part 建 required graph edge                           |
| Workbench          | Part 可以准备普通 binding 数据                                              | 只能由 owning Plugin 调用 `ctx.workbench?.mount()`         |

nested Part 的 `host` 是 immediate parent Part，`plugin` 始终指向 root owning Plugin。需要 sibling 完全不可见的业务状态时，状态由
Part 自己的普通对象持有；不要依赖 child Context 自动复制 service instance。

### 用 optional provider 激活 Part

Part containment 保持静态，optional provider 只控制业务 activation。把该 integration 的所有 registration 和 cleanup 放进
`plugins.use()` callback：

```ts no-twoslash
import type { MetricsPlugin } from '@acme/metrics'
import { definePluginRef, PluginPart } from '@pluxel/runtime'

const Metrics = definePluginRef<MetricsPlugin>()

class MetricsPart extends PluginPart<AppPlugin> {
	override init() {
		this.plugins.use(Metrics, (metrics) => {
			this.ctx.commands.register(createMetricsCommand(metrics))
			const subscription = metrics.subscribe((sample) => this.record(sample))
			return () => subscription.dispose()
		})
	}
}
```

provider absent、disabled 或 start-failed 时，Part 仍完成构造、config validation 和一次空 activation 的 `init()`，但 callback
不执行，也不产生 integration effects。provider 出现、消失或 replacement 时，整个 owner generation 重启并按 LIFO 清理旧
Part scope。`plugins.use()` setup 当前必须同步；不要在 callback 中启动 detached Promise。若异步 activation 的成功必须决定
启动结果，或 provider 变化不应重启 owner，应建模为有独立生命周期的 Plugin。

如果组成需要独立 enable/disable、失败状态、provider selection、config revision、HMR replacement、跨 owner 共享状态或被其他
Plugin 注入，它就不是 Part，应成为真正 Plugin。只有少量逻辑且不介意显式传参时，普通 helper 仍然更小。

## Generation 是资源所有权边界

每次成功启动都是一个 generation。stop、restart、HMR replacement 或 optional graph 变化会结束旧 generation，并在新实例可提交后建立下一代。

资源必须绑定当前 generation：

```ts no-twoslash
override async init(signal: AbortSignal) {
	const client = createClient(this.config)
	this.ctx.effects.defer(() => client.close(), { tag: 'client' })

	await client.connect({ signal })
}
```

创建成功后立即登记 cleanup。这样即使后续启动检查失败，已经创建的资源也会被释放。

### 选择 effects primitive

| 需求                           | API                                 |
| ------------------------------ | ----------------------------------- |
| 登记一个 cleanup function      | `effects.defer(cleanup)`            |
| 持有带 `dispose()` 的对象      | `effects.own(disposable)`           |
| 成对 acquire/release           | `effects.acquire(acquire, release)` |
| 给简单 helper 单独建立子作用域 | `effects.scope(meta)`               |
| 自动派生 Context/config/scope  | `this.parts.use(PluginPartClass)`   |
| 一组登记要么全部提交、要么回滚 | `effects.transaction()`             |

```ts no-twoslash
override init() {
	const scope = this.ctx.effects.scope({ tag: 'sync-loop' })
	const loop = new SyncLoop(this.ctx.logger.with({ component: 'sync-loop' }))
	scope.own(loop)
	loop.start()
}
```

cleanup 必须幂等，并在 Promise resolve 前真正停止底层工作。只调用 `abort()` 却不等待 worker、watcher 或 queue consumer 退出，会让旧 generation 与新 generation 重叠。

## `init()` 的职责

`init()` 做三件事：

1. 验证插件是否真的能提供能力；
2. 注册 HTTP、commands、Workbench 等 owner-bound capability；
3. 启动并登记长期资源。

必要上游不可达、schema 不匹配或凭据无效时直接抛错：

```ts no-twoslash
override async init(signal: AbortSignal) {
	const pool = createPool(this.config)
	this.ctx.effects.defer(() => pool.end())

	await assertReachable(pool, { signal })
	await assertSchemaVersion(pool, EXPECTED_SCHEMA_VERSION)
}
```

不要捕获启动错误后只写日志继续运行。那会制造“runtime 显示 running，但能力不可用”的半启动状态。

`init()` 可以返回 cleanup/disposable；它同样会进入当前 generation effects。复杂启动流程优先在每个 acquire 后立即登记，避免只在函数末尾返回一个覆盖不完整的 cleanup。

## 调用失败和生命周期失败

两者影响范围不同：

- 插件无法提供能力：让 `init()` 失败，或由宿主执行 restart/replacement；
- 单个 HTTP/command 调用参数错误或上游超时：返回请求级错误，不改变 Plugin 状态；
- timer、watcher、queue consumer 的单次失败：记录结构化错误，按领域规则重试、暂停或触发明确 shutdown。

```ts no-twoslash
const timer = setInterval(() => {
	void this.syncOnce().catch((error: unknown) => {
		this.ctx.logger.error('background sync failed', { error })
	})
}, 30_000)

this.ctx.effects.defer(() => clearInterval(timer))
```

## 公开有限事件

事件集合在设计时已知时，公开命名的 `EvtChannel`，不要重新实现字符串 registry：

```ts twoslash
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/runtime'

type Invoice = { id: string }
type InvoicePaid = (invoice: Invoice, signal: AbortSignal) => void | Promise<void>

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	readonly events = {
		invoicePaid: new EvtChannel<InvoicePaid>(this.ctx),
	} as const
}

declare function projectInvoice(invoice: Invoice, options: { signal: AbortSignal }): Promise<void>
declare const billing: BillingPlugin

billing.events.invoicePaid.on(async (invoice, signal) => {
	await projectInvoice(invoice, { signal })
})
```

listener registration 会绑定调用方 Context effects，stop/replacement 时自动取消；仍可以使用返回的 disposer 提前移除。生产者需要等待所有异步 listener 并隔离单项失败时，使用 `emitSettled()`。

## Identity 不等于 class name

具体 Plugin 必须由 package root `"."` 的唯一 named export 暴露；host-local Plugin 则来自 canonical source entry 的唯一 root export。

Pluxel 只有两个身份作用域：definition 表示 canonical entry + root export 的实现，node 表示该 definition 的 default 或某个 fork
运行部署。跨配置、RPC、持久化与 URL 使用结构化 `PluginDefinitionAddress` / `PluginNodeAddress`；Core 在进程内把同一 address
intern 成 `PluginDefinitionSlot` / `PluginNodeSlot` 供 graph、DI 与 lifecycle 使用。Address 与 Slot 是值和引用两种表示，不是四种身份。

fork 是同一 concrete definition 的运行时多态：共享 constructor implementation、schema、artifact input 和 HMR 更新，但各自隔离
config、lifecycle、Context、effects 与资源。只有确实能安全运行多个实例的 concrete Plugin 才声明
`@Plugin({ forkable: true })`；abstract capability 本身不承诺 forkability，每个 provider 独立作出决定。class name、constructor
object 与 `displayName` 都不参与 identity；`displayName` 用于界面和 pretty log。日志、Workbench 与默认 HTTP 路径会显示
package/source、root export 和 fork，例如
`package:@acme/orders::OrdersPlugin#fork=east`，不会把 opaque digest 当作公开 Plugin ID。

Plugin source 必须经过 Pluxel Vite/Rolldown pipeline。raw TypeScript runner 不生成这些语义事实。

主线下一页：[配置模型](./configuration.md)。HTTP、worker、Workbench 和完整测试矩阵都是按需专题，不是继续理解核心模型的前置阅读。
