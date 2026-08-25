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
| owner-bound Part | 需要局部配置/资源，但不独立治理 | `this.parts.use(CachePart)`              |
| 简单内部 helper  | 只有少量纯逻辑或显式 wiring     | 普通类或函数 + effects                   |

不要把所有组成都拆成 Plugin。Plugin 边界意味着独立的 identity、graph edge、启动结果和 replacement 行为；只服务一个 owner 的 cache、client 或 helper 通常应留在 owner 内部。

## Required dependency

从 provider package 根入口 value-import 具体 Plugin，并直接放入实际 consumer 的 constructor；consumer 可以是 graph node Plugin，
也可以是它静态拥有的 `PluginPart`：

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

真实项目应从 `@acme/accounts` package root 的 named export 导入 `AccountsPlugin`。构建工具从这个 value import 和 constructor 参数生成
required fact；Plugin constructor 直接进入 owner graph，Part constructor 的 requirement 会自动提升到 owning Plugin graph，`@Plugin()`
不再重复声明依赖。

同一个 Plugin definition 不能在一个 constructor 中重复声明。dependency override 按 requirement definition 识别依赖，参数名和位置不会成为
持久配置；如果需要 primary/replica 这类双角色，应先定义具有不同语义身份的 Plugin token，而不是重复同一个参数类型。

provider 启动失败时，consumer 不会拿到一个半可用实例：consumer 被标记为 blocked，其他无关分支仍可以继续运行。

注入值是绑定 consumer caller Context 和当前 provider generation 的轻量 facade。provider replacement 后旧 facade、旧 method
reference 与旧字段写入都会被拒绝；普通 public field 的读写仍作用于 provider 自己的实例，不会在 consumer 侧形成影子字段。

因此 Plugin 及其基类不能声明 ECMAScript `#private` field、method 或 accessor：这类成员要求 receiver 持有原生 private brand，
与 caller facade 不兼容，构建工具会报 `plugin_caller_view_private_brand_unsupported`。TypeScript `private` 普通属性可以使用；
需要 runtime 强封装时，把状态放进 closure，或从 capability 返回带有明确 stop/replacement 失效语义的 handle。这个限制不适用于
不会作为 provider dependency facade 暴露的 `PluginPart`；Part constructor 接收依赖不会让 Part 自己成为 graph provider。

Plugin 对其他节点暴露的可调用成员应写成普通 prototype method；accessor只返回普通数据或有自身receiver与失效契约的对象handle。
不要写 `status = () => ...`、function expression field或 `this.status.bind(this)` field。这些写法会捕获 raw provider，无法保留 consumer 的 caller Context，构建工具会报
`plugin_caller_view_callable_field_unsupported`。普通数据 field 仍可读写；需要 callable handle 时返回有独立对象 receiver 和明确
stop/replacement 失效语义的 capability。

dependency facade 在 provider construction 完成后固定 ordinary field/prototype surface，因此不要用 type-only
`declare field` 或在 `init()`/method 中动态增加跨 Plugin 字段；前者会得到
`plugin_caller_view_declared_field_unsupported`。需要暴露的数据使用真实 class field，需要行为使用 prototype method。

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
	protected override init() {
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

当内部组成需要自己的 config、effects、registration 或 nested composition，但仍应与父 Plugin 一起启动、失败和重启时，使用
`PluginPart`：

```ts no-twoslash
class CachePart extends PluginPart<SearchPlugin> {
	constructor(private readonly backend: CacheBackendPlugin) {
		super()
	}

	protected override init() {
		const cache = this.backend.createCache()
		return () => cache.dispose()
	}
}

@Plugin()
class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(CachePart)
}
```

Part 是静态、owner-bound composition，不是新的 graph node：

- `parts.use()` 完整占据普通 private field initializer，Part 不加 `@Plugin()`；
- required dependency 写在真正消费它的 Part constructor，工具链自动提升并去重到 owner graph；
- field initializer 只声明结构，资源与副作用留在 protected `init()` 或 `plugins.use()` callback；
- 每个 field occurrence 有独立 instance、child Context 和 effects scope，但没有独立启停、config revision 或 provider selection；
- Part、nested Part 和 owning Plugin 按 children-before-owner 顺序启动，任一 Part 失败都会让整个 owner start 失败；
- `ctx/host/parts/plugins/configs` 只在 Part subclass 内可见，owner 默认持有 private Part field 并只暴露领域 API。

完整的声明规则、依赖、config path、nested host、optional integration 与测试方式见[使用 PluginPart 组织内部资源](./plugin-parts.md)。

## Generation 是资源所有权边界

每次成功启动都是一个 generation。stop、restart、HMR replacement 或 optional graph 变化会结束旧 generation，并在新实例可提交后建立下一代。

资源必须绑定当前 generation：

```ts no-twoslash
protected override async init(signal: AbortSignal) {
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
| 自动派生 Context/config/scope  | `this.parts.use(CachePart)`         |
| 一组登记要么全部提交、要么回滚 | `effects.transaction()`             |

```ts no-twoslash
protected override init() {
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
protected override async init(signal: AbortSignal) {
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

## 在 ambient 广播和公开协议之间选择

事件不要求 provider 存在、启动顺序或 replacement 传播，只用于 host 内松耦合广播时，扩展 Core 的 `Events` map，随后通过
`ctx.events` 订阅和发布：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/runtime'

declare module '@pluxel/core' {
	interface Events {
		'catalog:invalidated': [catalogId: string]
	}
}

@Plugin({ displayName: 'Catalog observer' })
export class CatalogObserverPlugin extends BasePlugin {
	protected override init() {
		this.ctx.events.on('catalog:invalidated', (catalogId) => {
			this.ctx.logger.info('catalog invalidated', { catalogId })
		})
	}
}
```

module augmentation 只合并 TypeScript 事件词汇，不会 import、启用或连接两个 Plugin，也不提供启动顺序保证。每个 root
共享一个 emitter backend，但每个 Plugin、Part 和 caller Context 得到固定 owner 的普通 `EventsService` view；订阅自动进入
该 owner effects，stop、replacement 和 init rollback 都会取消订阅。事件名应使用带领域前缀的稳定字面量，避免无归属的通用名称。

如果事件属于某个 provider 的公开能力，consumer 必须依赖该 provider，或者 availability 会影响 consumer lifecycle，则公开
具名 `EvtChannel`，不要把依赖伪装成 ambient 广播：

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
`EvtChannel` 直接接收 `this.ctx`；不要传 `() => this.ctx`。调用方归属由 dependency caller facade 显式绑定，不通过动态 Context provider 推断。

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

下一步按任务选择：[使用 PluginPart](./plugin-parts.md)或[配置模型](./configuration.md)。HTTP、worker、Workbench 和完整测试矩阵都是按需专题，不是继续理解核心模型的前置阅读。
