---
title: 事件：广播与依赖协议
description: 使用 Core 自带事件传递通知，区分 ambient 广播、provider channel 与异步完成语义。
---

`ctx.events` 和 `EvtChannel` 属于 Core，不需要安装服务。先判断是否真的需要通知：需要一个指定提供方执行操作并返回结果时，直接调用[依赖方法](./model.md#required-dependency)。

| 需求                                          | 选择                          | 保证                                 |
| --------------------------------------------- | ----------------------------- | ------------------------------------ |
| 没有特定 provider 的宿主内通知                | `ctx.events`                  | 当前 root 内广播，订阅归调用方 owner |
| 某个 provider 的公开事件，consumer 必须依赖它 | provider 上具名 `EvtChannel`  | 依赖关系与订阅归属都可追踪           |
| 请求、查询或需要一个明确业务结果              | constructor dependency + 方法 | 返回值与失败由领域契约定义           |

## 同一 Host 的广播

需要在同一宿主中广播消息，而且不要求某个插件存在或先启动时，使用 `ctx.events`。这种无特定提供方的广播称为 ambient 事件。先扩展 `Events` 类型，再通过
`ctx.events` 订阅和发布：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'

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

发布端在自己的业务方法中调用：

```ts no-twoslash
this.ctx.events.emit('catalog:invalidated', catalogId)
```

事件类型应放在双方能导入的领域契约模块中；保证 augmentation 进入各自 TypeScript 编译范围，不通过导入一个业务插件来偷偷安装依赖。

module augmentation 只合并 TypeScript 事件词汇，不会 import、安装、打开 auto-start policy 或连接两个 Plugin，也不提供启动顺序保证。每个 root
共享一个 emitter backend，但每个 Plugin、Part 和 caller Context 得到固定 owner 的普通 `EventsService` view；订阅自动进入
该 owner effects，stop、replacement 和 init rollback 都会取消订阅。事件名应使用带领域前缀的稳定字面量，避免无归属的通用名称。

## Provider 的公开事件

如果事件属于某个 provider 的公开能力，consumer 必须依赖该 provider，或者 availability 会影响 consumer lifecycle，则公开
具名 `EvtChannel`，不要把依赖伪装成 ambient 广播：

```ts twoslash
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/core'

type Invoice = { id: string }
type InvoicePaid = (invoice: Invoice, signal: AbortSignal) => void | Promise<void>

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	readonly events = {
		invoicePaid: new EvtChannel<InvoicePaid>(this.ctx),
	} as const
}

declare function projectInvoice(invoice: Invoice, options: { signal: AbortSignal }): Promise<void>
@Plugin({ displayName: 'Invoice projection' })
export class InvoiceProjectionPlugin extends BasePlugin {
	constructor(private readonly billing: BillingPlugin) {
		super()
	}

	protected override init() {
		this.billing.events.invoicePaid.on(async (invoice, signal) => {
			await projectInvoice(invoice, { signal })
		})
	}
}
```

listener registration 会绑定调用方 Context effects，stop/replacement 时自动取消；仍可以使用返回的 disposer 提前移除。生产者需要等待所有异步 listener 并隔离单项失败时，使用 `emitSettled()`。
`EvtChannel` 直接接收 `this.ctx`；不要传 `() => this.ctx`。调用方归属由 dependency caller facade 显式绑定，不通过动态 Context provider 推断。

## 发布完成与异步失败

`ctx.events` 和 `EvtChannel` 都提供以下发布形式：

| 方法                     | 适合什么                            | 调用者必须知道                                    |
| ------------------------ | ----------------------------------- | ------------------------------------------------- |
| `emit(...)`              | 同步通知或不等待异步处理的广播      | 返回通知计数，不是业务成功数，不等待 Promise 完成 |
| `await emitAll(...)`     | 需要所有结果、任一失败即报告失败    | reject 不代表已开始的其他工作被取消或回滚         |
| `await emitSettled(...)` | 等待本次各 listener 的成功/失败记录 | 必须消费每项 status；不会自动重试失败 listener    |

下面是 BillingPlugin 内部方法中的发布片段，`signal` 由本次业务操作传入。它是公开事件参数，不会由 channel 自动补上：

```ts no-twoslash
const outcomes = await this.events.invoicePaid.emitSettled(invoice, signal)
for (const outcome of outcomes) {
	if (outcome.status === 'rejected') {
		this.ctx.logger.error('invoice projection failed', {
			invoiceId: invoice.id,
			error: outcome.reason,
		})
	}
}
```

## 订阅与等待的寿命

- 在 `init()` 或明确的操作作用域中订阅。`on()` 返回 disposer，可提前撤销；普通订阅随 owner 停止、替换或初始化回滚自动移除。
- 只等下一次通知可用 `once()`；`waitFor()` 返回可取消的 Promise，必须等待/处理拒绝，并按操作需要设置 signal 或超时。owner 清理会取消等待。
- 取消订阅只阻止后续通知，不等于正在执行的 listener 已停止。长任务使用明确的 signal 和[资源清理](./lifecycle.md)，不要在 handler 中留下无监督的 Promise。
- 广播不是持久队列，也不补发订阅前的历史通知。需要恢复状态时先查询权威状态；需要必需的启动顺序时声明 dependency，不等待一条可能错过的“ready”广播。

验证 consumer 能收到事件、提前撤销和停止后不再收到，以及异步 listener 失败能够被调用者观察。不要只测试类型 augmentation 能编译。
