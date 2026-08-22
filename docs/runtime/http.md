---
title: 插件 HTTP
description: 用自动绑定生命周期的 Elysia 路由暴露 API、webhook 和稳定公开地址。
---

业务 HTTP 是常驻的运行时能力，与 Workbench 是否启用无关。Plugin 通过 `ctx.http.plugin` 声明路由，运行时会自动绑定所属 Plugin、挂载路径和资源清理；Plugin 被替换或停止时，相应路由也会撤销。

## 最小路由

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/runtime'

type Order = { id: string }

// ---cut---

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	override init() {
		this.ctx.http.plugin.routes((app) =>
			app
				.get('/health', () => ({ ok: true }))
				.get('/orders/:id', ({ params }) => this.findOrder(params.id)),
		)
	}

	private findOrder(id: string): Order {
		return { id }
	}
}
```

`routes()` 提供绑定当前 Plugin Context 的 Elysia app。route tree 在 Plugin stop、replacement 或启动回滚时自动卸载，不需要手工保存 disposer。

## 默认地址与稳定产品地址

默认路由挂在：

```text
/__pluxel/plugins/v1/package/OrdersPlugin/@acme/orders
/__pluxel/plugins/v1/fork/east/package/OrdersPlugin/@acme/orders
```

这段版本化 route 是结构化 Plugin node address 的可读、可逆编码，会显示 package/source、root export 和 fork；它不包含
机器绝对路径或 digest。地址由 runtime/Workbench discovery 返回，调用方不应手工拼接。default/fork 各自拥有独立路由与
lifecycle cleanup。

需要固定 webhook、health 或产品 API 根路径时声明 `publicPath`：

```ts no-twoslash
override init() {
	this.ctx.http.plugin.routes(
		(app) =>
			app
				.get('/health', () => ({ ok: true }))
				.post('/webhooks/payment', ({ body }) => this.acceptPayment(body)),
		{ publicPath: '/orders' },
	)
}
```

最终路径是 `/orders/health` 和 `/orders/webhooks/payment`。`publicPath`：

- 必须是绝对路径；
- 不能是 `/`；
- 不能占用 `/__pluxel` 保留 namespace；
- 与 scoped `path` 互斥；
- 只改变 routing，不代表匿名访问。

鉴权、签名校验、租户判断和速率限制仍由 Plugin/host policy 明确实现。

## 输入校验与输出

使用 Elysia 的 schema/model 能力在 HTTP 边界验证 params、query、headers 和 body。不要先接收 `unknown` 再把未经验证的数据传进领域层。

```ts no-twoslash
import { t } from 'elysia'

this.ctx.http.plugin.routes((app) =>
	app.post(
		'/orders',
		async ({ body, set }) => {
			const order = await this.createOrder(body)
			set.status = 201
			return order
		},
		{
			body: t.Object({
				customerId: t.String({ minLength: 1 }),
				items: t.Array(t.String(), { minItems: 1 }),
			}),
		},
	),
)
```

HTTP DTO 是外部 contract。不要直接返回数据库 row、Plugin instance、Context、Error object 或带 credential 的 SDK response。

## Request cancellation

单次调用的取消属于请求边界，使用 request signal 或下游 API 接受的 `AbortSignal`。Plugin generation cleanup 属于 effects 边界；两者不能互相替代。

长期 background task 不应挂在某个 HTTP request Promise 上。把它建模为 owner-bound worker/queue，再让 HTTP endpoint 只提交任务或查询状态。

## 错误边界

区分可预期的请求错误与异常：

| 情况                     | 处理                                                   |
| ------------------------ | ------------------------------------------------------ |
| 参数、权限或状态冲突     | 返回明确 4xx DTO                                       |
| 上游超时或临时不可用     | 返回领域定义的 5xx/503，并保留 server log cause        |
| 未知异常                 | 让 runtime boundary 记录结构化 error，向外返回通用 500 |
| 插件根本无法继续提供能力 | 不是 HTTP 500 循环；应触发 lifecycle failure/restart   |

不要把 stack、token、内部文件路径或完整上游 response body 直接返回客户端。

## 挂载已有 fetch boundary

Plugin HTTP 的标准作者入口是 Elysia。已有 WinterTC-style fetch handler 时可以使用 `mount()`：

```ts no-twoslash
this.ctx.http.plugin.mount(
	{
		fetch: (request) => legacyRouter.fetch(request),
	},
	{ path: '/legacy' },
)
```

仍然通过 `ctx.http.plugin` 挂载，保留 owner cleanup。Plugin 不调用 `ctx.http.host.routes()`；host API 用于 route launcher 和宿主自有边界，会绕过插件 ownership。

## 动态替换 route tree

普通插件在 `init()` 声明稳定 route tree。确实需要在同一 generation 内替换时，保存 `ElysiaRouteHandle`：

```ts no-twoslash
import type { ElysiaRouteHandle } from '@pluxel/runtime'

private routes?: ElysiaRouteHandle

override init() {
	this.routes = this.ctx.http.plugin.routes((app) => app.get('/', () => 'v1'))
}

enableExtraRoutes() {
	this.routes?.replaceRoutes((app) =>
		app.get('/', () => 'v2').get('/extra', () => ({ enabled: true })),
	)
}
```

`dispose()` 或 Plugin stop/replacement 后，旧 handle 不能再替换路由。异步回调需要先确认当前 generation 仍拥有该 handle。

大多数配置变化更适合由 host restart Plugin，建立新 generation；不要用 route replacement 模拟完整 lifecycle。

## 测试

用 runtime test host 的 `ctx.http.fetch` 访问真实挂载结果，并至少验证：

- success 和 validation failure；
- `publicPath` 或默认 owner path；
- Plugin remove/replacement 后旧 route 返回 404；
- auth/signature failure 不泄露内部错误；
- Workbench disabled 时业务 route 仍工作。

完整 test host 配置见 [测试 Pluxel 插件](../development/testing.md)。出站请求可以使用官方 [Wretch Plugin](../plugins/wretch.md) 或领域 HTTP client，不要与入站 route ownership 混在一起。
