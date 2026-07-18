# 缓存

`@pluxel/cache` 用普通 required plugin dependency 提供缓存能力。`cache.local` 永远同步；顶层
`cache.get/set/getOrLoad` 永远返回 Promise，并执行 `local -> backend -> loader`。consumer 始终依赖抽象 `Cache`。

默认 caller namespace、method decorator、global access、consumer 示例和 backend plugin contract 见
[`../plugins/cache/README.md`](../plugins/cache/README.md)。
consumer 使用 `cache.local` 或顶层 Promise API 时已经按 `ctx.caller` 的 plugin identity 隔离。不同插件共享同一个
provider 和 backend，但相同业务 key 不会互相污染。只有确实消费同一个 value contract 时才使用
`cache.global`。

`@Cached` 适合异步 method，`@Memoized` 适合同步 local method。`cache.scope()` 只是可选的 caller-local 二级 scope，
用于覆盖 provider 默认 TTL、容量、异步读取策略和批量失效。淘汰算法固定为 SIEVE，TTL 可以由 provider、scope
或单次 `set(..., { ttlMs })` 提供。

同一进程内，相同 owner namespace、可选 scope 和 encoded key 的 backend read 与 read-through loader 会自动合并。
这避免多个插件同时 miss 时重复请求 Redis、数据库或上游 API。它不声称提供跨进程锁；多实例部署需要在 adapter
或领域 loader 中选择具备 fencing 语义的协调方案。

## 选择 memory 或 Redis backend

默认纯内存组合是 `MemoryCacheBackendPlugin -> CachePlugin -> consumer`。Redis 组合是：

```text
RedisPlugin -> RedisCacheBackendPlugin -> CachePlugin -> consumer
```

Redis 组合的最小安装：

```ts
import { CachePlugin } from '@pluxel/cache'
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, AccountsPlugin])
```

`@pluxel/cache` 不安装 Redis SDK。`@pluxel/redis` 同时提供原生 client 与 `RedisCacheBackendPlugin`，后者负责
cache prefix、Lua 原子 value/TTL read、serialization 与 clear。

Workbench 使用已有“依赖注入”卡片读取 `CachePlugin` 的 `CacheBackend` constructor dependency。catalog 中存在 memory
和 Redis provider 时，可以直接选择给 `CachePlugin` 注入哪一个；选择会持久化并通过正常 graph commit 重启受影响
依赖链。cache plugin 不需要专属 Workbench extension，关闭 Workbench 时 headless host 仍能用同一 graph contract 选择。

只消费 cache 的插件依赖 `@pluxel/cache`。需要 Redis command、transaction、stream 或 pub/sub 的插件依赖
`@pluxel/redis` 的独立 `Redis` capability，不通过 `Cache` 获取 raw client。Redis package 已经自带可选 cache backend，
无需再安装第三个 adapter package。

## 可选的 memory backend 恢复

`MemoryCacheBackendPlugin` 默认不会读写 Persistence。需要进程重启后的 cache warm start 时，可将它的
`persistence.mode` 设为 `durable`；host 必须配置真正 durable、writable 的 Persistence，否则 provider 启动失败。
容许降级时使用 `best-effort`，但 ephemeral Persistence 只能在同一进程中保留数据，不能承诺重启恢复。

快照使用绝对 TTL、合并写入和 atomic put，恢复时丢弃过期条目并按当前容量重新进入 SIEVE。它只恢复异步 memory
backend；同步 `cache.local` 不 hydration，仍保持纯同步。详细配置与可序列化 value 范围见
[`../plugins/cache/README.md`](../plugins/cache/README.md#memory-backend-重启预热)。
