# `@pluxel/rates`

Pluxel 官方 caller-aware admission control 插件。它对一次 `identity + cost` 做原子 allow/deny 判定；不负责排队、等待、长期计费或 transport response。

## 使用

```ts
import { Rates, type RateLimiter } from '@pluxel/rates'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'MessagingPlugin' })
class MessagingPlugin extends BasePlugin {
	private messages!: RateLimiter

	constructor(private readonly rates: Rates) {
		super()
	}

	protected override init() {
		this.messages = this.rates.use('send-message', {
			algorithm: 'sliding-window-counter',
			limit: 100,
			windowMs: 60_000,
		})
	}

	async send(tenantId: string, userId: string) {
		const decision = await this.messages.consume({ tenantId, userId })
		if (decision.denied) return rejectMessage(decision.retryAfterMs)
		return this.deliverMessage(userId)
	}
}
```

policy 在同步 `use()` 时拷贝、解析并冻结；配置错误会使 consumer 启动失败。相同 caller、name 和 normalized policy 返回同一 handle，同名不同 policy 抛出 `RatesPolicyConflictError`。name 应是静态业务名，不能来自 request 或 tenant。

支持四种算法：

- `token-bucket`：持续 refill；`burst` 是立即容量，默认等于 `limit`；
- `fixed-window`：与 Unix epoch 对齐的固定窗口；
- `sliding-window-counter`：O(1) 状态的近似滚动窗口；
- `sliding-window-log`：精确滚动窗口，`limit` 上限为 10,000。

`consume(identity, { cost? })` 的 cost 默认是 `1`。identity 可为 primitive、最多 16 项的 tuple，或值均为 primitive 的 plain record；框架进行带类型的 canonical encoding，record 字段顺序不影响 identity。不要使用 credential 或 access token 作为 identity。

## Decision 与错误

```ts
const decision = await limiter.consume({ tenantId, modelId }, { cost: tokenCount })
if (decision.denied) {
	decision.remaining
	decision.retryAfterMs
	decision.resetAt
} else {
	decision.remaining
	decision.resetAt
}
```

backend 成功判定时只有 allow 和 deny。`remaining` 是判定后可立即消费的完整 cost-1 unit 数；`resetAt` 是没有后续 consume 时恢复完整容量的 epoch milliseconds。没有可信判定时 Promise reject，稳定 error code 为 `RATES_STOPPED`、`RATES_UNAVAILABLE`、`RATES_POLICY_CONFLICT` 和 `RATES_INVALID_ARGUMENT`。Rates 不隐式 fail-open，也不映射 HTTP/RPC 错误。

## Caller 与 global

`rates.use()` 默认把 caller plugin ID 编入 quota namespace。只有多个插件明确共享同一 quota contract 时才使用：

```ts
this.egress = this.rates.global.use('platform.tenant-egress', policy)
```

global registration 要求所有 owner 使用完全相同的 policy，但 handle cleanup 仍属于发起 caller。caller、Rates provider 或 backend generation 被停止/替换后，旧 handle 的新 consume 抛出 `RATES_STOPPED`。

## Backend

单进程 host 使用：

```ts
import { MemoryRatesBackendPlugin, RatesPlugin } from '@pluxel/rates'

host.add([MemoryRatesBackendPlugin, RatesPlugin, MessagingPlugin])
host.cfg(MemoryRatesBackendPlugin).set({ config: { maxIdentities: 10_000 } })
```

Memory 不淘汰有效 state；容量满时抛出带可选 `retryAfterMs` 的 `RatesUnavailableError`。进程重启会重置额度。

多实例 host 使用：

```ts
import { RatesPlugin } from '@pluxel/rates'
import { RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisRatesBackendPlugin, RatesPlugin, MessagingPlugin])
```

第三方 adapter 从 `@pluxel/rates/backend` 导入 `RatesBackend` 和 request contract。Redis adapter 对 canonical key 做 SHA-256，在一个 server-timed 单 key Lua 调用中完成 policy check、状态转移和 TTL。

维护约束见 [`DESIGN.md`](DESIGN.md)。
