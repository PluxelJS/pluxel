# 请求频率控制

`@pluxel/rates` 提供短周期 admission control。consumer required-depend `Rates`，在 `init()` 中把稳定业务名和 policy 绑定为 limiter，业务 hot path 只传 identity 与可选 cost：

```ts
private login!: RateLimiter

protected override init() {
	this.login = this.rates.use('login', {
		algorithm: 'sliding-window-log',
		limit: 10,
		windowMs: 60_000,
	})
}

async authenticate(tenantId: string, ip: string) {
	const decision = await this.login.consume({ tenantId, ip })
	if (decision.denied) return rejectLogin(decision.retryAfterMs)
	return verifyCredentials()
}
```

选择算法时，持续 refill 和独立 burst 使用 `token-bucket`，便宜的 epoch 固定窗口使用 `fixed-window`，固定空间的近似滚动窗口使用 `sliding-window-counter`，低频高价值操作的精确滚动窗口使用 `sliding-window-log`。Rates 不提供 queue、等待、pacer、长期套餐额度或 transport policy。

默认 namespace 包含 caller Plugin node identity；跨插件共享明确 quota contract 时使用 `rates.global.use()`。identity 可为 primitive、tuple 或 primitive plain record，由框架 canonical encode；name、string identity 和 record 字段名必须是 well-formed Unicode（不含未配对 surrogate）。不需要手工拼接 key，也不能放入 credential 等 secret。

成功判定只有 `denied: false` 与 `denied: true`。deny 不扣减本次 cost，并提供至少 1ms 的 `retryAfterMs`；backend、容量、损坏 state 或 lifecycle 无法产生可信判定时 Promise reject。应用在统一 HTTP、RPC 或 queue 边界决定 429、503、重试或显式降级。

单进程装配 `MemoryRatesBackendPlugin -> RatesPlugin`；多实例装配 `RedisPlugin -> RedisRatesBackendPlugin -> RatesPlugin`。完整 API、错误字段和 host 配置见 [`../plugins/rates/README.md`](../plugins/rates/README.md)。
