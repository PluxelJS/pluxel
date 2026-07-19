# Redis 插件设计

## 目标与边界

`@pluxel/redis` 拥有 Redis connection capability，并附带常用的 Redis cache/rates adapter 与 Lua authoring primitive：

```text
Redis consumer -> Redis abstract token -> selected Redis provider -> node-redis/platform client
```

Redis raw capability 不提供 caller namespace、distributed lock、queue abstraction 或业务 schema。cache namespace 与
single-flight 仍由 `@pluxel/cache` 拥有，rates namespace 与 decision 仍由 `@pluxel/rates` 拥有；本包内 adapter 只桥接
两侧 contract。

## API

公开作者面只有：

- `Redis`：required dependency token；
- `Redis.client`：原生 node-redis compatible client；
- `defineRedisScript()` / `Redis.scripts`：typed Lua definition、EVALSHA 与 NOSCRIPT fallback；
- `RedisPlugin`：credential-free standalone provider；
- `RedisCacheBackendPlugin`：内置 `CacheBackend` adapter；
- `RedisRatesBackendPlugin`：内置四算法 `RatesBackend` adapter；
- `RedisConfig`：连接与有界 queue 配置；
- `RedisClient`：client type；
- `RedisNotRunningError` / `RedisConnectionError`：明确 lifecycle failure。

不包装普通 node-redis command。额外 facade 会制造第二套 Redis API，并阻碍 transaction、stream、pub/sub 与新命令。

## Lua scripts

script definition 是 immutable module-level value，包含稳定 name、source、SHA1、可选 key count 与 reply decoder。
`Redis.scripts.use(definition)` 按 definition identity 缓存 runner；`run()` 校验 key count，先执行 EVALSHA，只有错误前缀
为 NOSCRIPT 时才回退 EVAL。其他 Redis、network、auth 或 decoder error 不被吞掉。

`readOnly: true` 使用 EVALSHA_RO/EVAL_RO，为 Redis 7+ Cluster/replica routing 保留明确语义；默认 false 保持旧 server
兼容。helper 不根据 Lua source 猜测 read/write 属性。

script registry 按 bound caller Context 缓存，不使用共享的可变“当前 caller”。默认 provider 的 client 虽然相同，
Vault/platform provider 仍可以安全地按 caller 返回不同 client 或 routing view。

这比启动时强制 SCRIPT LOAD 更适合 standalone、reconnect、failover 与 Cluster：script cache 是 server/node-local 且
可能随时被清除，lazy EVALSHA fallback 才是持续正确的执行语义。helper 不建立另一套 global registry，也不包装普通
command。

## Lifecycle

`RedisPlugin.init()` 创建 client 后立即用 owner effects 登记幂等 cleanup，再监听 error 并连接。initial connect 在
`connectTimeoutMs` 内未 ready 或直接失败时抛出 `RedisConnectionError`，plugin 不进入 running。stop/replacement
先撤销 holder，再 graceful close；close 失败才 destroy。

holder 是嵌套共享对象，而不是直接改写 plugin field。Pluxel caller view 使用轻量 prototype binding，嵌套 holder
保证所有 caller view 观察同一 lifecycle generation，旧 provider cleanup 后统一抛出 `RedisNotRunningError`。

node-redis 负责 established connection 的 reconnect。`disableOfflineQueue` 与 `commandQueueMaxLength` 控制断线和压力
期间的行为，避免 Redis provider 自己再维护一套 command queue。

`Redis` extends `ForkablePlugin`。多 endpoint/database 使用正常 Pluxel fork 与 dependency override，而不是在一个
provider 内维护 connection name -> client map；每个 fork 因而拥有独立 config、lifecycle、failure 与 replacement 边界。

## Secret

普通 config 只能保存无 credential endpoint。默认 provider 不读取环境变量，也不隐式安装 Vault；宿主拥有部署和
secret policy。需要 secret、Sentinel、Cluster 或平台 binding 时实现另一个 `@Plugin(Redis, ...)` provider，并由该
provider 使用宿主已经安装的安全能力。

错误日志不记录 config 或 command argument。node-redis error 作为结构化 error 进入 owner logger。

## Package composition

`@pluxel/redis` 依赖 node-redis 与轻量 `@pluxel/cache`，并从显式 `@pluxel/rates/backend` subpath 实现 adapter。依赖方向是：

```text
@pluxel/cache <- @pluxel/redis
CachePlugin   <- RedisCacheBackendPlugin -> Redis

@pluxel/rates <- @pluxel/redis
RatesPlugin   <- RedisRatesBackendPlugin -> Redis
```

Redis consumer 只安装一个 Redis package，就同时拥有 raw capability、Lua helper 与可选 cache/rates integration；
memory-only consumer 仍不安装 node-redis。adapter 源码是本包内唯一同时知道 backend contract 与 `Redis` 的模块。

Workbench 只投影 constructor dependency selection，不属于 Redis capability，也不影响 headless 生命周期。
