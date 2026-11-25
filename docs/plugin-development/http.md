---
title: 插件 HTTP 与 WebSocket 服务
description: 在插件中集成 Elysia 2 路由、Webhook 与 WebSocket，实现强类型接口与生命周期联动。
---

在 Pluxel 插件中对外提供 Web 接口非常便捷：通过在 `init()` 钩子中调用 `this.ctx.service(ElysiaApp)`，即可直接使用原生的 [Elysia](https://elysiajs.com/) 实例定义路由。宿主在启动时负责监听端口并将请求分发至对应插件，当插件停止或热重载时，相关路由会自动安全注销。

Host 须安装 `elysia()`；`servicesPreset()` 包含它，见 [Host 服务组合](../host/services.md)。

插件向外部服务发起请求时使用内建的 `ctx.wretch` 或 `ctx.fetch`。 [受管出站 HTTP](./outbound-http.md)

## 最小路由

在插件中挂载 HTTP 接口的典型示例：

```ts twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { BasePlugin, Plugin } from '@pluxel/core'

type Order = { id: string }

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		// 1. 获取当前插件绑定的 ElysiaApp 实例并注册路由
		this.ctx
			.service(ElysiaApp)
			.get('/health', () => ({ ok: true }))
			.get('/orders/:id', ({ params }) => this.findOrder(params.id))
	}

	private findOrder(id: string): Order {
		return { id }
	}
}
```

将 `OrdersPlugin` 注册进宿主后启动服务，即可直接访问 `GET /health` 与 `GET /orders/1`。

> [!NOTE]
> **关于路由前缀与命名空间**
> 声明的路由路径即为最终对外暴露的 URL 路径。如果需要统一的路由前缀，建议使用 Elysia 的 `.group()` 组织：
>
> ```ts
> import { ElysiaApp } from '@pluxel/services/elysia'
>
> this.ctx.service(ElysiaApp).group('/api/v1', (app) => app.get('/orders', () => this.listOrders()))
> ```
>
> 注意：`/__pluxel` 为框架管理面板的保留前缀，插件不可占用。

## 直接使用 Elysia 能力

`this.ctx.service(ElysiaApp)` 返回当前插件与它的 Parts 共享的 Elysia 实例，可以直接声明路由、schema 和请求钩子。

### 强类型输入校验与文档（TypeBox）

Elysia 内建了基于 TypeBox 的高性能校验器 `t`：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { t } from 'elysia'

this.ctx.service(ElysiaApp).post(
	'/orders',
	{
		body: t.Object({
			customerId: t.String({ minLength: 1 }),
			items: t.Array(t.String(), { minItems: 1 }),
		}),
	},
	async ({ body, status }) => {
		const order = await this.createOrder(body)
		return status(201, order)
	},
)
```

### 挂载中间件与钩子（Hooks）

可以使用 `onRequest`、`onBeforeHandle` 或 `onError` 统一处理请求生命周期：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'

this.ctx
	.service(ElysiaApp)
	.onRequest(({ request }) => {
		this.ctx.logger.debug('Incoming request', { url: request.url })
	})
	.onError(({ error, code }) => {
		this.ctx.logger.error('Request error', { code, error })
	})
```

## WebSocket

Pluxel 支持通过 Elysia 2 原生语法接入 WebSocket 双向通信：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { websocket } from 'elysia/websocket'

this.ctx
	.service(ElysiaApp)
	.use(websocket())
	.ws('/events', {
		open(socket) {
			socket.subscribe('orders')
		},
		message(socket, message) {
			socket.send({ type: 'echo', message })
		},
		close(socket) {
			socket.unsubscribe('orders')
		},
	})
```

当插件停止或进行热替换时，框架会自动向属于该插件的活动 WebSocket 连接发送关闭信号并安全断开，避免产生挂起的僵尸连接。

## 按所有权组织大型路由

对于路由数量较多的插件，可以通过拆分辅助函数或配合 `PluginPart` 进行结构化拆解：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'

class MetricsPart extends PluginPart<OrdersPlugin> {
	protected override init() {
		// Part 内部同样可以通过 this.ctx.service(ElysiaApp) 注册专属路由
		this.ctx.service(ElysiaApp).get('/orders/metrics', () => this.getMetrics())
	}

	private getMetrics() {
		return { activeOrders: 10 }
	}
}

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	private readonly metrics = this.parts.use(MetricsPart)
}
```

## finalization 与生命周期

在插件的 `init()` 中注册路由和模块。该代插件初始化成功后，宿主等待该 Elysia 实例的异步模块就绪，编译路由，检查冲突，然后随本次提交发布已接纳的路由。停止或替换该代插件时，宿主撤回它的路由并结算在途请求、stream 与 WebSocket。

## 错误边界

- 不同插件节点声明相同种类、method 和路径的路由时，冲突候选的生命周期报告会记录启动失败，已接纳的节点继续处理请求。
- **业务异常与状态码**：对于业务预期的参数或权限错误，应直接返回标准的 HTTP 状态码（如 400、401、404），避免直接将内部未处理的原始数据库报错暴露给客户端。

## 测试

在单元测试中验证 HTTP 接口非常轻量。在 `createTestHost` 中挂载 `elysia()` 服务，随后通过 `host.http.fetch` 即可发起虚拟请求：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { expect, it } from 'vitest'
import { OrdersPlugin } from './orders'

it('能够正确响应 HTTP 请求', async () => {
	await using host = await createTestHost({
		services: [elysia()],
	})

	await host.start(OrdersPlugin.nodeAddress())

	// 使用内置的轻量 fetch 客户端
	const res = await host.http.fetch(new URL('/health', host.http.origin))
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ ok: true })
})
```

## 当前 Elysia 2 与 carrier 边界

Pluxel 当前使用 Elysia `2.0.0-rc.0`。在 Vite 开发模式下，Vite 拥有 listener，保留自身的 HMR 接线。生产 Node 应用通过 `listenElysia()` 启动 srvx listener。在插件的 Elysia 实例上直接调用 `app.listen()` 或 `app.stop()` 会因物理 listener 属于宿主而报错。直接注册 `app.onStart()` 或 `app.onStop()` 也会报错，当前 Elysia 版本缺少外部挂载与卸载协议。插件初始化与资源释放使用 `init()` 和当前 Context 的 effects。
