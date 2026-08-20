---
title: Plugin 模型与生命周期
description: 理解 Plugin 的依赖关系、版本代际、可选集成、资源回收和失败传播。
---

Plugin 不只是一个由宿主任意调用的类，而是依赖图中可独立启动和停止的能力节点。只有必需依赖已经运行、配置通过校验且 `init()` 成功后，它才会进入运行状态。

## 三种组成关系

先判断一项能力是否需要独立的生命周期，再选择关系：

| 关系             | 何时使用                   | 写法                                     |
| ---------------- | -------------------------- | ---------------------------------------- |
| 必需 Plugin      | 缺少提供方就不能工作       | 构造器参数 + 值导入                      |
| 可选 Plugin 集成 | 提供方只是可选增强         | `definePluginRef<T>()` + `plugins.use()` |
| Plugin 内部组成  | 不需要独立启停、配置或治理 | 普通类或函数 + effects                   |

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

provider 启动失败时，consumer 不会拿到一个半可用实例：consumer 被标记为 blocked，其他无关分支仍可以继续运行。

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
| 给内部组成单独建立子作用域     | `effects.scope(meta)`               |
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

插件需要请求停止自身时使用 `this.ctx.registry.shutdownSelf()`。它调度后续 graph commit，返回 `void`；不要等待自己的 generation 被销毁。

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

graph identity 来自 entry provenance 和 root export definition slot，runtime node 再区分 default/fork instance。class name、constructor object 与 `displayName` 都不是持久化、配置、日志、HTTP、Workbench 或 commands identity。

Plugin source 必须经过 Pluxel Vite/Rolldown pipeline。raw TypeScript runner 不生成这些语义事实。

主线下一页：[配置模型](./configuration.md)。HTTP、worker、Workbench 和完整测试矩阵都是按需专题，不是继续理解核心模型的前置阅读。
