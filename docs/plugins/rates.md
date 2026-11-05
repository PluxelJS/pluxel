---
title: API 请求限流（Rates）
description: 基于滑动窗口与令牌桶算法的高性能限流服务，按调用方身份与操作成本执行原子准入判定。
---

`@pluxel/plugin-rates` 为系统提供灵活的流量控制能力。它支持按租户、用户或 IP 进行多维度频率限制，并返回精确的重试等待时间（`retryAfterMs`）。

## 基础用法

在业务插件中注入 `Rates` 接口并在 `init()` 中初始化限流器：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { Rates, type RateLimiter } from '@pluxel/plugin-rates'

export class MessageRateLimited extends TaggedError('MessageRateLimited')<{
	retryAfterMs: number
	resetAt: number
}> {}

@Plugin()
export class MessagingPlugin extends BasePlugin {
	private limiter!: RateLimiter

	constructor(private readonly rates: Rates) {
		super()
	}

	protected override init(): void {
		// 创建滑动窗口限流器：每分钟最多 100 次
		this.limiter = this.rates.use('send-message', {
			algorithm: 'sliding-window-counter',
			limit: 100,
			windowMs: 60_000,
		})
	}

	async sendMessage(userId: string) {
		// 消费配额并检查决策
		const decision = await this.limiter.consume({ userId })

		if (decision.denied) {
			return Result.err(
				new MessageRateLimited({
					retryAfterMs: decision.retryAfterMs,
					resetAt: decision.resetAt,
				}),
			)
		}

		// 正常执行业务操作
		return Result.ok({ success: true })
	}
}
```

## 支持的限流算法

- **`sliding-window-counter`（滑动窗口计数器）**：平滑流量突刺，计算成本低且统计准确；
- **`token-bucket`（令牌桶算法）**：允许短时间内的合理并发突发，平稳维持平均速率。
