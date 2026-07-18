# Rates 插件设计草案

> 当前目录只记录实现前的 contract 思考，没有 package manifest、源码入口或可消费 API。

## 问题边界

Rates 是 admission control，不是普通 cache：

```text
Cache: key -> opaque value + TTL + eviction
Rates: identity + cost -> atomic allow/deny decision
Pacer: invocation -> timers, scheduling, queueing, batching
```

单进程限流状态可以复用 TTL 和紧凑 map 等实现技巧，但不能照搬 cache eviction：淘汰仍在有效窗口中的 limiter 会让
identity 提前获得新额度。Memory provider 只能清理已过期状态；达到 `maxIdentities` 后应拒绝新 identity 或显式返回
unavailable，不能用 SIEVE/LRU 静默重置额度。分布式实现也不能组合 `cache.get()` 与 `cache.set()`；多个进程会同时读到
旧值并超发。Rates backend 的最小语义必须是一次原子 consume。

## 候选作者 API

```ts
const decision = await rates.consume('send-message', {
	limit: 100,
	windowMs: 60_000,
	cost: 1,
	algorithm: 'token-bucket',
})

decision.allowed
decision.remaining
decision.retryAfterMs
decision.resetAt
```

尚未通过真实 consumer 验证前，不固定 decorator、错误抛出策略或算法集合。首版应优先返回 decision，让 HTTP、RPC、
queue consumer 自己决定返回 429、延迟执行还是丢弃；便捷的 `require()`/decorator 可以在稳定后建立在同一 decision
contract 上。

## Caller namespace

默认有效 identity 应包含 bound `ctx.caller.pluginInfo.id`，不同 consumer 使用同一 Rates provider 时互不污染。
`scope(name)` 只建立 caller-local 二级策略/identity 前缀；确认共享同一配额 contract 时显式使用 `.global`。不能依赖
可变的全局“当前调用方”。

业务 identity 仍由 consumer 提供，例如 tenant、user、API credential 或 IP。插件 caller namespace 解决 package
ownership，不替代业务维度。

## Provider 多态

建议依赖图：

```text
MemoryRatesBackendPlugin -> RatesPlugin -> consumer
RedisPlugin -> RedisRatesBackendPlugin -> RatesPlugin -> consumer
```

- `@pluxel/rates` 最终自带单进程 memory provider；
- `@pluxel/redis` 最终直接导出 Redis provider，下游无需第三个 adapter package；
- consumer 只依赖抽象 `Rates`；host/Workbench 通过正常 dependency override 选择 memory 或 Redis；
- replacement 必须重启 `RatesPlugin` 及 dependent closure，确保 caller-bound view 不继续引用旧 provider。

Memory provider 需要 `maxIdentities` 和过期状态回收。容量满时先清理已过期 identity；仍然满则 fail closed/返回
unavailable，防止攻击者用高基数 key 挤掉已有配额状态。Redis provider 通过 key TTL 回收，但仍要约束 key 长度、prefix
和 metrics cardinality。

Redis provider 应使用 `defineRedisScript()`，在一次 Lua 调用中读取时间状态、补充/清理额度、扣减、设置 TTL 并返回
decision。普通 cache single-flight 只能减少同进程重复请求，不能代替跨实例原子性。

## 算法候选

首版倾向只实现 token bucket，并在真实需求明确后再增加 fixed/sliding window：

- token bucket 支持 burst、稳定补充速率和 O(1) 状态，memory/Redis 行为容易对齐；
- fixed window 简单但边界突发明显；
- 精确 sliding log 在高基数下存储成本高，若增加应明确 bounded/coarse variant。

算法不能假装可在同一 key 上无损切换。backend state 应包含 format/algorithm version，scope 的稳定配置发生冲突时应
报错或使用不同 identity 前缀。

## 与 Persistence、Cache、Pacer 的关系

- Memory rates 默认进程内并在重启后重置。Cache 式 Persistence snapshot 不能提供 crash-safe quota continuity；若将来
  提供近似恢复也必须显式标成非安全优化，安全或计费场景应选择 Redis/数据库原子 provider。
- durable quota 需要数据库 transaction/CAS 或 Redis Lua provider，不通过普通 cache snapshot 实现。
- debounce、throttle、batch、concurrency queue 属于将来的 local pacer/flow capability，不塞进 Rates。
- TanStack Pacer 可作为算法和 API 研究来源；如复用实现，优先隔离 `@tanstack/pacer-lite`，不把 beta/client-first 类型
  暴露成 Pluxel contract。
- 函数闭包和等待中的 Promise 不能持久化。可恢复任务需要独立 jobs/queue 协议，包含 serializable payload、lease、
  ack、retry、idempotency 与 fencing。

## 实现前必须验证

1. 同 key 高并发 consume 不超发，memory 与 Redis decision 字段一致；
2. caller/global namespace 隔离和 cached handle 在 replacement 后撤销；
3. Redis server time、clock skew、script reload、cluster hash slot 与 TTL 清理；
4. cost、limit、window 的整数边界以及算法/配置冲突；
5. provider failure 是 fail-closed 还是显式返回 unavailable，不能静默放行；
6. 不记录原始高基数 identity，只暴露 bounded metrics。
