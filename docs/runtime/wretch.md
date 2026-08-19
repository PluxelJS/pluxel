---
title: 出站 HTTP（Wretch）
description: 从不可变的 Wretch 基础实例派生业务客户端，并统一应用宿主的出站策略。
---

# 出站 HTTP（Wretch）

> `@pluxel/wretch` 面向插件作者的公开入口是 `.` 与 `./workbench`。可安装版本以 npm registry 为准；仓库内边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/wretch` 提供一个原生、不可变的 Wretch 基础实例，并在请求真正发出前应用宿主级出站策略。URL 构造、addon、middleware、catcher 和响应链仍使用原生 Wretch API。

## 第一个 HTTP consumer

```ts twoslash
import { WretchPlugin, type Wretch } from '@pluxel/wretch'
import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import QueryStringAddon from 'wretch/addons/queryString'
import { retry } from 'wretch/middlewares'

type Customer = { id: string; name: string }

const CustomerConfig = v.object({
	baseUrl: v.pipe(v.string(), v.url()),
})

@Plugin({ displayName: 'Customer' })
export class CustomerPlugin extends BasePlugin {
	private readonly config = this.configs.use(CustomerConfig)
	private api!: Wretch

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	override init(): void {
		this.api = this.http.client
			.url(this.config.baseUrl, true)
			.addon(QueryStringAddon)
			.middlewares([retry({ maxAttempts: 2, retryOnNetworkError: true })])
	}

	find(id: string): Promise<Customer> {
		return this.api.get(`/customers/${encodeURIComponent(id)}`).json<Customer>()
	}
}
```

host 安装 provider：

```ts no-twoslash
host.add([WretchPlugin, CustomerPlugin])
host.cfg(WretchPlugin).set({
	timeoutMs: 30_000,
	maxConcurrentRequests: 64,
	maxQueuedRequests: 256,
	allowedOrigins: ['https://catalog.example'],
})
```

`client` 本身就是 Wretch。Wretch 的 immutable 语义保证不同 consumer 通过 `.url()`、`.options()`、`.headers()`、`.auth()`、`.addon()` 或 `.middlewares()` 派生 client 时不会互相污染。

主入口只导出 `WretchPlugin` 与 `Wretch` 类型，不重新导出裸 `wretch()` factory 或 addons。示例在同一个 immutable chain 中组合上游 addon/middleware；consumer 使用这些扩展时仍应把 `wretch` 声明为自己的 dependency。

## 宿主 outbound policy

`WretchPlugin` 只有四个 Plugin config 字段：

| 字段                    | 默认值  | 语义                                                 |
| ----------------------- | ------- | ---------------------------------------------------- |
| `timeoutMs`             | `30000` | 每次底层 fetch attempt 的超时；`0` 关闭 host timeout |
| `maxConcurrentRequests` | `64`    | 所有 consumer 共享的进行中 fetch attempt 上限        |
| `maxQueuedRequests`     | `256`   | 并发满时最多等待多少 attempt；`0` 禁止排队           |
| `allowedOrigins`        | `[]`    | 空数组不限制；非空时只允许列出的精确 HTTP(S) origin  |

`allowedOrigins` 中每项必须是没有 path、query、hash 或 credential 的 HTTP(S) origin。实际 request URL 也必须是 absolute HTTP(S) URL；不支持相对 URL 或其他协议。

policy 通过 Wretch `defer()` 在请求发送前安装。consumer 的 retry middleware 位于外层，所以每次 retry attempt 都会单独经过：

1. absolute URL 与 origin 检查；
2. 全局并发/队列 admission；
3. timeout 与 lifecycle AbortSignal；
4. 实际 fetch；
5. 释放并发槽。

队列满时 reject `Error('Outbound HTTP request queue is full')`；origin 不允许时 reject 包含 origin 的 Error；timeout 使用名为 `TimeoutError` 的 `DOMException`。这些目前不是带稳定 code 的 Pluxel error hierarchy，transport 不应依赖完整 message 做协议映射。

retry、dedupe、缓存、认证刷新和业务错误解析不属于 host policy。它们应由 consumer 用 Wretch middleware/addon 明确组合；需要 cache 时使用 `@pluxel/cache`，不要在 provider 内隐式缓存响应。

## 生命周期与 cancellation

取得的 client 与 consumer owner 和 provider generation 绑定：

- consumer stop/replacement 后，旧 client 的新请求会失败；
- provider stop/replacement 后，所有旧 client 都会失败；
- 正在等待并发槽的请求会从队列移除并 reject；
- 已进入 fetch 的请求会收到 lifecycle abort signal；
- consumer 自己传入的 `options.signal` 会和 lifecycle/timeout signal 合并。

自定义 `.fetchPolyfill()` 必须遵守标准 `AbortSignal`，才能在 teardown 或 timeout 时及时结束。不要清空受管 client 的 deferred callbacks，否则会移除 provider policy。

## 可选的 managed settings

默认情况下，consumer 只受 host policy 管理。若希望操作者在 Workbench 为某个 consumer 配置普通 headers、HTTP(S) proxy 和更短 timeout，consumer 必须显式调用：

```ts no-twoslash
override async init(): Promise<void> {
	await this.http.enableManagedSettings()
	this.api = this.http.client.url(this.config.baseUrl, true)
}
```

managed settings 按 caller 的完整 Plugin node address 隔离并持久化。`client` 每次发送请求前读取最新状态，所以设置保存后，已缓存的 immutable client 也会自动生效。

`WretchManagedSettings` 的真实形状是：

```ts twoslash
type WretchManagedSettings = Readonly<{
	headers: Readonly<Record<string, string>>
	proxyUrl?: string
	timeoutMs?: number
}>
```

- managed header 会覆盖请求中同名普通 header；最多 32 项，单值最长 4096 字符；
- `authorization`、`cookie`、`proxy-authorization`、`set-cookie`、`x-api-key` 等 secret-bearing header 会被拒绝；
- transport-owned header（如 `host`、`content-length`、`connection`）也会被拒绝；
- proxy 必须是无 credential、path、query 或 hash 的 HTTP(S) origin；authenticated proxy 不受支持；
- consumer `timeoutMs` 必须是正整数，并且只能收紧 host timeout；host timeout 为 `0` 时，它成为有效 timeout。

managed settings 使用 runtime persistence，而不是 secret store。不要把 access token、API key 或 cookie 放入该 contract。Workbench disabled 时不会创建 UI backend，但已显式启用的 persisted settings 仍会应用于核心 HTTP client。

## 挂载 Workbench Port

从 `@pluxel/wretch/workbench` 导入稳定 Port，在 consumer 的 Workbench contract 中创建 outlet：

```ts no-twoslash
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from '@pluxel/wretch/workbench'

export const CustomerWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.tab({
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})
```

然后在 consumer 启动时启用设置并绑定 caller-owned RPC：

```ts no-twoslash
override async init(): Promise<void> {
	await this.http.enableManagedSettings()
	this.api = this.http.client.url(this.config.baseUrl, true)

	this.ctx.workbench.mount(CustomerWorkbench, {
		settings: workbench.bind.rpc(() => this.http.workbenchSettings()),
	})
}
```

`workbenchSettings()` 必须在 `enableManagedSettings()` 完成后调用，否则会抛错。它返回的 RPC 实现 `get()`、`update(settings)` 与 `reset()`，snapshot 同时包含 `hostTimeoutMs` 和最终 `effectiveTimeoutMs`。

同一 caller 并发执行 `enableManagedSettings()` 会共享一次初始化。caller/provider 停止后，旧 RPC 被撤销；provider cleanup 也会关闭 managed `ProxyAgent`。UI 只是该 caller-owned capability 的投影，不是核心 HTTP 请求能够运行的前提。
