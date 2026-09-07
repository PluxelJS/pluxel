# Redis 插件设计

## 目标与边界

`@pluxel/redis` 拥有 Redis connection capability，并附带常用的 Redis cache/rates adapter 与 Lua authoring primitive：

```text
Redis consumer -> Redis abstract token -> selected Redis provider -> named connection catalog
                                                             \-> node-redis/platform clients
```

Redis raw capability 不提供 caller namespace、distributed lock、queue abstraction 或业务 schema。cache namespace 与
single-flight 仍由 `@pluxel/cache` 拥有，rates namespace 与 decision 仍由 `@pluxel/rates` 拥有；本包内 adapter 只桥接
两侧 contract。

cache adapter 不重新编码 managed canonical key，也不解释 loader/database 语义。它只添加 Redis keyspace prefix、保存
opaque defined value、原子返回 value + remaining TTL，并对 exact managed prefix 执行有界 clear。`undefined` 只表示 miss，
`null` 是合法 hit，adapter failure 必须 reject。

Cache coordinator 的 opaque value 已包含完整结构化 owner envelope；Redis adapter 原样 round-trip。Rates adapter 的 Hash/ZSET
metadata 直接保存 structured owner address，并在 Lua transition 内校验；两者的物理 key 都只暴露 address-derived digest，
digest 不替代 payload 中的完整 owner。

cache/rates `keyPrefix` 必须是 well-formed Unicode，避免不同的未配对 surrogate 在 Redis UTF-8 transport 上折叠为同一
byte prefix。

rates sliding log 的常规 allow 不全量读取 event ZSET：脚本以 metadata、cardinality 和首尾 event 验证结构，cleanup 只读取
到期 score 区间，全部到期直接删除；deny 用一次最多 10,000 条的 bounded range read 计算 retry，并核对 live event cost
总和。rates storage key 必须由 adapter Lua 独占，外部 writer 不属于完整性边界；被读取的非法 metadata/event 仍会
fail closed。这样正常 allow 保持与 `limit` 无关的读取量，deny 不使用在同一 Lua invocation 内反复跳过 offset 的伪分页。

## API

公开作者面只有：

- `Redis`：required dependency token；
- `Redis.connection(id)` / `connectionIds()`：有界 named connection catalog；
- `RedisConnection.client`：原生 node-redis compatible client；
- `defineRedisScript()` / `RedisConnection.scripts`：typed Lua definition、EVALSHA 与 NOSCRIPT fallback；
- `RedisPlugin`：credential-free standalone provider；
- `RedisCacheBackendPlugin`：内置 `CacheBackend` adapter；
- `RedisRatesBackendPlugin`：内置四算法 `RatesBackend` adapter；
- `RedisConfig`：连接与有界 queue 配置；
- `RedisClient`：client type；
- `RedisNotRunningError` / `RedisConnectionNotFoundError` / `RedisConnectionError`：稳定的 lifecycle 与 selection failure。

不包装普通 node-redis command。额外 facade 会制造第二套 Redis API，并阻碍 transaction、stream、pub/sub 与新命令。

## Lua scripts

script definition 是 immutable module-level value，包含稳定 name、source、SHA1、可选 key count 与 reply decoder。
`RedisConnection.scripts.use(definition)` 按 definition identity 缓存 runner；`run()` 校验 key count，先执行 EVALSHA，只有错误前缀
为 NOSCRIPT 时才回退 EVAL。其他 Redis、network、auth 或 decoder error 不被吞掉。

`readOnly: true` 使用 EVALSHA_RO/EVAL_RO，为 Redis 7+ Cluster/replica routing 保留明确语义；默认 false 保持旧 server
兼容。helper 不根据 Lua source 猜测 read/write 属性。

connection handle 按 bound caller Context 与 connection ID 缓存，不使用共享的可变“当前 caller”。handle 同时检查 consumer owner
与 provider generation；其 script registry 因而也不会跨 consumer 或 connection 串线。

这比启动时强制 SCRIPT LOAD 更适合 standalone、reconnect、failover 与 Cluster：script cache 是 server/node-local 且
可能随时被清除，lazy EVALSHA fallback 才是持续正确的执行语义。helper 不建立另一套 global registry，也不包装普通
command。

## Lifecycle

`RedisPlugin.init()` 对 1–64 个唯一 ID 并行创建 client，每个资源创建后立即登记幂等 cleanup，再监听 error 并连接。任何
initial connect 在 `connectTimeoutMs` 内未 ready 或直接失败时，startup signal 会取消 sibling，等待全部 settle 后抛出
`RedisConnectionError`；plugin 不进入 running，也不会留下部分 catalog。stop/replacement 先撤销 catalog 和 owner handles，再
graceful close；close 失败才 destroy。

runtime lookup 使用 `Map<connectionId, state>`，选择为 O(1)。每个 caller Context 只在首次选择时登记一个 effects cleanup，重复选择
返回稳定 handle；旧 caller facade 仍会在 cleanup 前先由 Core generation gate 拒绝。`RedisNotRunningError` 保护已撤销的 handle，
不替代 captured node-redis client 自身的 closed-client 错误语义。

node-redis 负责 established connection 的 reconnect。`disableOfflineQueue` 与 `commandQueueMaxLength` 控制断线和压力
期间的行为，避免 Redis provider 自己再维护一套 command queue。

`Redis` 是普通 abstract capability token；多 endpoint/database 是 `RedisPlugin` 自己拥有的 bounded domain collection，不产生额外
Plugin identity、config owner、HMR generation 或 dependency edge。Cache/Rates adapter 通过各自配置的 `connectionId` 选择连接；
其他 consumer 也把 ID 作为自己的显式领域配置。需要独立故障域的服务由独立部署表达。

## Secret

普通 config 只能保存无 credential endpoint。默认 provider 不读取环境变量，也不隐式安装 Vault；宿主拥有部署和
secret policy。需要 secret、Sentinel、Cluster 或平台 binding 时实现另一个 `@Plugin(Redis, ...)` provider，并由该
provider 使用宿主已经安装的安全能力。

错误日志不记录 config 或 command argument。node-redis error 作为结构化 error 进入 owner logger。

## Package composition

`@pluxel/redis` 依赖 node-redis，并通过 peer dependency 消费 `@pluxel/cache` 与 `@pluxel/rates` 的
provider contract。依赖方向是：

```text
@pluxel/cache <- @pluxel/redis
CachePlugin   <- RedisCacheBackendPlugin -> Redis

@pluxel/rates <- @pluxel/redis
RatesPlugin   <- RedisRatesBackendPlugin -> Redis
```

Redis consumer 只安装一个 Redis package，就同时拥有 raw capability、Lua helper 与可选 cache/rates integration；
memory-only consumer 仍不安装 node-redis。adapter 源码是本包内唯一同时知道 backend contract 与 `Redis` 的模块。

Workbench 继续用 host-owned dependency selection 选择 Redis provider。默认 standalone provider另外发布一张固定
host-rendered Content，以 bounded rows 读取全部 connection state，并提供一个按 ID 选择、带有界 transient payload 的原生 `PING`
action。动态连接数量不改变 Workbench definition、entry 或 socket。状态变化复用既有 Workbench Cap'n Web session 调用
`dataChanged()`；Content 不复制 endpoint 持久配置，不保留 payload，也不暴露
credential、任意 Redis command 或 key browser。Workbench disabled 时不注册额外 Redis event listener，且不影响 Redis
capability 或 lifecycle。
