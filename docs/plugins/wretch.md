---
title: 出站 HTTP 客户端（Wretch）
description: 使用 WretchPlugin 派生安全、不可变的 HTTP 客户端，统一管理全局超时、并发限制与域名白名单。
---

`@pluxel/plugin-wretch` 基于轻量级 HTTP 库 [Wretch](https://elbywan.github.io/wretch/) 提供出站请求能力。通过统一的插件注入，宿主可以集中管控所有外发网络请求的超时时间、并发队列与可信域名白名单。

## 安装依赖

```sh
pnpm add @pluxel/plugin-wretch
```

<span id="第一个-http-consumer"></span>

## 第一个 HTTP consumer

在业务插件中，通过构造函数注入 `WretchPlugin`，并使用链式调用发起请求：

```ts twoslash
import { WretchPlugin, type Wretch } from '@pluxel/plugin-wretch'
import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import * as v from 'valibot'

const CustomerSchema = v.object({ id: v.string(), name: v.string() })
type Customer = v.InferOutput<typeof CustomerSchema>

export class CustomerNotFound extends TaggedError('CustomerNotFound')<{
	id: string
	message: string
}> {}

const CustomerConfig = v.object({
	baseUrl: v.pipe(v.string(), v.url()),
})

@Plugin({ displayName: 'Customer' })
export class CustomerPlugin extends BasePlugin {
	private readonly config = this.configs.use(CustomerConfig)
	private api!: Wretch

	// 1. 注入 WretchPlugin
	constructor(private readonly http: WretchPlugin) {
		super()
	}

	protected override init(): void {
		// 2. 派生带有固定 Base URL 的不可变客户端
		this.api = this.http.client.url(this.config.baseUrl, true)
	}

	find(id: string): Promise<Result<Customer, CustomerNotFound>> {
		return this.api
			.get(`/customers/${encodeURIComponent(id)}`)
			.notFound(() => Result.err(new CustomerNotFound({ id, message: `Customer ${id} not found` })))
			.json((body) => Result.ok(v.parse(CustomerSchema, body)))
	}
}
```

## 宿主出站安全策略配置

在宿主配置中，可以为出站请求配置全局约束：

```ts no-twoslash
import { WretchPlugin } from '@pluxel/plugin-wretch'

export default defineHostApplication(() => ({
	plugins: [WretchPlugin],
	config: {
		records: [
			{
				owner: WretchPlugin,
				config: {
					timeoutMs: 15_000, // 单次请求超时（毫秒）
					maxConcurrentRequests: 32, // 最大并发请求数
					allowedOrigins: [
						// 域名白名单（留空允许所有）
						'https://api.example.com',
						'https://auth.example.com',
					],
				},
			},
		],
	},
}))
```

如果业务尝试请求白名单以外的地址，请求会在发起前被拦截，保护企业服务免受意外的外发调用。
