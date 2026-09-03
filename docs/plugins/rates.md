---
title: 请求频率控制
description: 按调用方、身份和成本执行原子的请求准入判定。
---

> `@pluxel/rates` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/rates` 只负责一件事：根据一次请求的身份和成本，原子地判断是否放行。它不负责排队、等待、长期套餐额度或计费，也不会替 HTTP 或 RPC 层选择响应状态。

## 第一个 limiter

业务 Plugin 依赖抽象能力 `Rates`，在 `init()` 中用稳定业务名和策略创建 limiter，处理请求时只需传入身份和可选成本：

```ts twoslash
import { Rates, type RateLimiter } from '@pluxel/rates'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Messaging' })
export class MessagingPlugin extends BasePlugin {
	private messages!: RateLimiter

	constructor(private readonly rates: Rates) {
		super()
	}

	protected override init(): void {
		this.messages = this.rates.use('send-message', {
			algorithm: 'sliding-window-counter',
			limit: 100,
			windowMs: 60_000,
		})
	}

	async send(tenantId: string, userId: string): Promise<void> {
		const decision = await this.messages.consume({ tenantId, userId })
		if (decision.denied) {
			throw new Error(`Rate limited; retry after ${decision.retryAfterMs}ms`)
		}
		await this.deliver(userId)
	}

	private async deliver(_userId: string): Promise<void> {}
}
```

`use()` 会同步复制、校验、归一化并冻结 policy。相同 caller、name 和归一化 policy 会返回同一个 handle；同名但 policy 不同会同步抛出 `RatesPolicyConflictError`。因此 name 应是静态业务标识，不能由 request、tenant 或用户输入生成。

## identity 与 cost

`consume(identity, { cost? })` 的 `cost` 默认为 `1`，也可以表达一次操作消耗多个单位：

```ts no-twoslash
const decision = await limiter.consume({ tenantId, modelId }, { cost: estimatedTokens })
```

identity 支持以下形状：

- primitive：`string | number | bigint | boolean`；
- 最多 16 项的 primitive tuple；
- 最多 16 个字段、字段值均为 primitive 的 plain record。

框架会做带类型的 canonical encoding，所以字符串 `"1"`、数字 `1` 和 bigint `1n` 不会碰撞，record 字段顺序也不影响 identity。字符串和字段名必须是 well-formed Unicode；最终 canonical encoding 不得超过 1024 UTF-8 bytes。不要使用 access token、cookie 或其他 credential 作为 identity。

cost 必须是正的 safe integer，并且不能超过 policy 容量：token bucket 对应 `burst`，其他算法对应 `limit`。无效 identity 或 cost 会让 `consume()` reject `RatesInvalidArgumentError`。

## 选择算法

| 需求                           | `algorithm`              | 语义                                                       |
| ------------------------------ | ------------------------ | ---------------------------------------------------------- |
| 平滑补充额度，并允许独立 burst | `token-bucket`           | `limit / windowMs` 持续 refill；`burst` 默认等于 `limit`   |
| 最低成本的固定周期限制         | `fixed-window`           | 窗口与 Unix epoch 对齐，边界附近可能连续放行两个窗口的额度 |
| 固定空间的近似滚动窗口         | `sliding-window-counter` | 用当前与前一窗口加权估算，状态为 O(1)                      |
| 精确滚动窗口                   | `sliding-window-log`     | 保存窗口内事件；精确但成本更高，`limit` 最大为 10,000      |

所有 `limit`、`windowMs` 和 `burst` 都必须是正 safe integer；实现还会检查乘积和状态 TTL 是否安全。policy 只接受精确 plain object，未知字段、getter、symbol 字段或不合法组合都会以 `RATES_INVALID_ARGUMENT` 拒绝。

## 读取判定结果

成功完成 backend 判定时，结果只有 allow 或 deny 两种：

```ts no-twoslash
const decision = await limiter.consume(userId)

if (decision.denied) {
	decision.remaining
	decision.retryAfterMs
	decision.resetAt
} else {
	decision.remaining
	decision.resetAt
}
```

- `remaining`：本次判定之后，当前可立即消费的完整 cost-1 单位数；
- `retryAfterMs`：被拒绝时，至少等待多久才可能允许同样的 cost；
- `resetAt`：如果没有后续 consume，恢复完整容量的 epoch milliseconds。

deny 是可信业务结果，不是异常。backend 无法给出可信结果时 Promise 会 reject；Rates 不会隐式 fail-open，也不会把异常伪装成 deny。

## caller 隔离与共享额度

普通 `rates.use()` 默认把 quota 绑定到 caller 的结构化 Plugin node address。两个不同 Plugin 即使使用相同 name 和 identity，也不会共享额度。

只有多个 Plugin 明确实现同一个平台级 quota contract 时，才使用 `global`：

```ts no-twoslash
this.egress = this.rates.global.use('platform.tenant-egress', {
	algorithm: 'token-bucket',
	limit: 1_000,
	windowMs: 60_000,
	burst: 100,
})
```

所有 owner 对同一个 global name 必须注册完全相同的归一化 policy，否则抛出 `RatesPolicyConflictError`。global 只共享 backend state；handle 的生命周期仍归创建它的 caller 所有。

caller、`RatesPlugin` 或 backend generation 停止或被替换后，旧 handle 的新调用抛出 `RatesStoppedError`。已经提交给 backend 的 in-flight 判定不会被事后撤销。

## host 选择 backend

单进程 host 可使用内存 backend：

```ts no-twoslash
import { MemoryRatesBackendPlugin, RatesPlugin } from '@pluxel/rates'

await host.commit((change) => {
	change.start(MemoryRatesBackendPlugin, {
		initialConfig: { maxIdentities: 10_000 },
	})
	change.start(RatesPlugin)
	change.start(MessagingPlugin)
})
```

内存 backend 重启后额度会重置，也不会淘汰仍有效的 state。达到 `maxIdentities` 时，它会抛出 `RatesUnavailableError`，其中可能带 `retryAfterMs`。

多进程共享额度可改用 `@pluxel/redis` 提供的 adapter：

```ts no-twoslash
import { RatesPlugin } from '@pluxel/rates'
import { RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'

await host.start([RedisPlugin, RedisRatesBackendPlugin, RatesPlugin, MessagingPlugin])
```

consumer 仍只依赖 `Rates`。Redis adapter 使用 Redis server time，并在单 key Lua 调用中校验 policy、更新状态和 TTL，避免多个实例间的读写竞态。

上面的 `host` 是 `createRuntimeTestHost()` 作者 fixture。`start()` 立即提交并等待 lifecycle 稳定；同一 application boundary 的
多项原子 setup 使用同步 `commit()` callback，首次配置使用 `initialConfig`。production static/dynamic host 通过自己的
ConfigService 与 RuntimeState 表达相同配置和启动策略。

## 稳定错误契约

所有 Rates 自有错误都继承 `RatesError`，可按 `code` 处理：

| code                     | class                       | 含义                                                          |
| ------------------------ | --------------------------- | ------------------------------------------------------------- |
| `RATES_STOPPED`          | `RatesStoppedError`         | handle 或 provider generation 已停止                          |
| `RATES_UNAVAILABLE`      | `RatesUnavailableError`     | backend 没有给出可信判定；可能含 `retryAfterMs` 与 `cause`    |
| `RATES_POLICY_CONFLICT`  | `RatesPolicyConflictError`  | 同一 registration 已有不同 policy；含 `active` 与 `requested` |
| `RATES_INVALID_ARGUMENT` | `RatesInvalidArgumentError` | name、policy、identity 或 cost 非法；含 `argument`            |

transport 层应显式映射这些事实。例如 deny 可以映射为 HTTP 429，而 `RATES_UNAVAILABLE` 应按产品选择 fail-closed、降级或返回服务错误；不要在 capability 内偷偷吞错后放行。
