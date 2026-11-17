---
title: 事件：广播与提供方通道
description: 使用 Core 内建的事件机制在插件间传递异步通知，支持全局广播与强类型通道。
---

事件系统常用于插件之间的解耦通知。Pluxel 核心提供了两种事件机制：

1. **全局广播（`ctx.events`）**：适用于松耦合的宿主内事件广播，无需强绑定特定的事件提供方。
2. **提供方通道（`EvtChannel`）**：适用于特定插件暴露的强类型公开事件，消费方需要依赖该插件。

## 场景选型

| 场景                                             | 推荐方案     | 机制说明                                   |
| ------------------------------------------------ | ------------ | ------------------------------------------ |
| 松耦合状态通知（如用户登出、全局配置重载）       | `ctx.events` | 全局广播，任意插件均可监听或发布           |
| 特定插件的生命期事件（如支付成功、文件导出完成） | `EvtChannel` | 挂载在提供方插件上，消费方需声明依赖该插件 |
| 带有明确返回值或需要等待处理结果的操作           | 直接方法调用 | 优先通过构造函数依赖直接调用对方的方法     |

## 全局广播（`ctx.events`）

全局广播适用于没有固定依赖关系的通知。通过扩展 `@pluxel/core` 的 `Events` 接口，可以为事件提供全方位的 TypeScript 类型推导：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'

// 1. 扩展全局事件字典类型
declare module '@pluxel/core' {
	interface Events {
		'catalog:invalidated': [catalogId: string]
	}
}

@Plugin({ displayName: 'Catalog observer' })
export class CatalogObserverPlugin extends BasePlugin {
	protected override init() {
		// 2. 监听全局事件（订阅随插件生命周期自动回收）
		this.ctx.events.on('catalog:invalidated', (catalogId) => {
			this.ctx.logger.info('Catalog invalidated', { catalogId })
		})
	}
}
```

发布事件非常简单：

```ts no-twoslash
this.ctx.events.emit('catalog:invalidated', 'cat_123')
```

通过 `this.ctx.events.on()` 注册的监听器会自动登记到当前插件的作用域中，当插件停止或热重载时，监听器会自动注销。

## 提供方通道（`EvtChannel`）

当事件是某个特定插件的核心能力时，建议在插件中显式定义 `EvtChannel`。这样消费方必须通过构造函数依赖提供方，依赖关系与事件参数类型都清晰可循：

```ts twoslash
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/core'

type Invoice = { id: string }
type InvoicePaidHandler = (invoice: Invoice, signal: AbortSignal) => void | Promise<void>

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	// 1. 提供方公开具名事件通道
	readonly events = {
		invoicePaid: new EvtChannel<InvoicePaidHandler>(this.ctx),
	} as const
}

declare function projectInvoice(invoice: Invoice, options: { signal: AbortSignal }): Promise<void>

@Plugin({ displayName: 'Invoice projection' })
export class InvoiceProjectionPlugin extends BasePlugin {
	// 2. 消费方声明对提供方的必需依赖
	constructor(private readonly billing: BillingPlugin) {
		super()
	}

	protected override init() {
		// 3. 订阅提供方的事件通道
		this.billing.events.invoicePaid.on(async (invoice, signal) => {
			await projectInvoice(invoice, { signal })
		})
	}
}
```

## 异步派发与结果等待

无论使用 `ctx.events` 还是 `EvtChannel`，都提供了以下三种派发方式：

- **`emit(...)`**：同步触发并立即返回监听器总数，适合不需要等待异步结果的“发后即忘”广播。
- **`await emitAll(...)`**：等待所有监听器执行完毕。若任一监听器抛出异常或 Promise reject，将立即向上抛错。
- **`await emitSettled(...)`**：等待所有监听器执行完毕，并返回类似于 `Promise.allSettled` 的数组结构，方便生产者逐项分析各消费方的执行结果与报错原因。

```ts no-twoslash
// 在业务操作中等待所有下游监听完成
const outcomes = await this.events.invoicePaid.emitSettled(invoice, signal)

for (const outcome of outcomes) {
	if (outcome.status === 'rejected') {
		this.ctx.logger.error('Invoice handler failed', {
			invoiceId: invoice.id,
			error: outcome.reason,
		})
	}
}
```

## 订阅的生命周期与注意事项

- **自动回收**：在 `init()` 中调用的 `.on()` 会自动随插件生命周期释放；如果需要中途提前取消监听，可调用 `.on()` 返回的注销函数。
- **单次等待**：只等待下一次通知可使用 `.once()`；若需要用 Promise 形式等待下一次事件，可调用 `.waitFor()` 并支持传入 `AbortSignal` 控制超时。
- **内存事件**：事件通道是进程内的内存通知机制，不包含持久化队列功能。如果应用需要保证消息绝对不丢失或在启动后重放历史消息，应配合数据库或消息代理（如 Redis）设计持久化日志。
