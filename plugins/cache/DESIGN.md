# 缓存插件设计

## 设计目标

缓存 API 只要求作者理解四件事：

1. 注入的 `Cache` 已按 caller plugin 自动隔离；
2. `local` 永远同步，顶层 `get/set/getOrLoad` 永远返回 Promise；
3. TTL 决定有效期，SIEVE 决定容量满时淘汰谁；
4. 普通 namespace 继承 provider 配置，只有 `scope()` 才绑定独立策略。

`@pluxel/cache` 是普通 Pluxel plugin。所有 caller 共享一个 local coordinator 和同一个 async backend，但默认
有效 key 自动包含 `ctx.caller.pluginInfo.id`：

```text
plugin:AccountsPlugin:user:1
plugin:BillingPlugin:user:1
```

`cache.global` 显式移除 caller value namespace 隔离，供确认 value contract 相同的插件共享。global handle 仍绑定发起
caller Context；caller stop/replacement 后旧 handle 撤销，最后一个 owner 停止后释放进程内 registration。backend value
继续按 TTL 独立存续。

## 同步与异步边界

```text
cache.local            同步、纯进程内
cache.get/set/...      Promise、local + backend + loader
cache.global.local     同步 global local cache
cache.global.get/...   异步 global 分层缓存
cache.scope(name)      caller-local 二级 scope
```

local 只有同步 `get/set/delete/clear/getOrCompute`。它不会暗中访问 backend 或执行 Promise。

顶层只有 Promise API：`get/set/delete/clear/getOrLoad`。backend 即使是默认内存实现也保持异步 contract，host
切换到 Redis/数据库实现时 consumer 不改签名。

两种 `set` 都显式支持 per-value TTL：

```ts
cache.local.set(key, value, { ttlMs: 5_000 })
await cache.set(key, value, { ttlMs: 5_000 })
```

省略 `ttlMs` 时继承 namespace 配置。

## Provider 默认配置与 scope

`CachePlugin` 的 Pluxel config 是所有默认 caller namespace 与 global namespace 的共同策略源：

- `ttlMs`：默认 value TTL；
- `maxEntries`：每个有效 namespace 的 local 容量；
- `maxInFlight`：不同 key 的最大异步工作数；
- `readPolicy`：默认异步读取策略；
- `backendFailure`：`getOrLoad()` 遇到 backend failure 时 required-fail 或显式 bypass。

普通 consumer 不重复配置。只有确实需要独立容量、TTL、读取顺序或批量失效时才使用 scope：

```ts
const responses = cache.scope('responses', {
	ttlMs: 30_000,
	maxEntries: 5_000,
	readPolicy: 'cache-and-refresh',
})
```

scope 只覆盖传入字段，其他字段继承父 namespace 的有效配置；root scope 的父配置就是 provider defaults。

`scope()` 同步拷贝、校验并冻结 normalized policy。同一 caller + name + policy 返回同一 handle；显式传入不同 policy
立即抛 `CachePolicyConflictError`。只写 `scope(name)` 可以取得已经绑定的 scope，供 decorator invalidation 使用；尚未
绑定时继承 parent policy。policy 必须是拒绝 accessor、symbol 和 unknown field 的 exact plain object。

local scope registration 属于 caller effects。caller stop、Cache/backend replacement 或 Cache stop 后，旧 handle 的新操作
稳定抛 `CacheStoppedError`。进程内 local entries 随最后 owner 清理，Redis/backend value 不主动删除。

## Key model

公开 key 支持 primitive、最多 16 项的 primitive tuple，以及 primitive-value plain record。框架使用版本化 canonical
encoding：primitive 保留类型与 `-0`，tuple 保留位置，record 按字段名 code-unit order 排序；拒绝 nested object、accessor、
symbol、非 plain object 和非 finite number。canonical key 最多 1,024 UTF-8 bytes。

decorator 的零/多参数默认 key 使用同一 bounded codec；包含 object、function 或其他非 key 参数时必须显式提供 `key()`。
cache key 不是 secret protection contract，credential/token 不得作为 key。

## 唯一 eviction：SIEVE

不公开 LRU/FIFO/随机淘汰选择。SIEVE 是唯一算法：

- entry 保存在 map + 双向 FIFO queue；
- hit 只设置 visited bit，不移动节点；
- eviction hand 扫描 queue，遇到 visited entry 清位并跳过，淘汰首个未访问 entry；
- 查找 O(1)，scan 清位工作具备摊销上界；
- 读路径写放大低，并能避免一次顺序扫描冲掉热点。

减少策略选择也意味着 scope policy conflict 只需检查容量，不存在同一个 namespace 使用不同 eviction 的问题。

TTL 与 SIEVE 正交。TTL 使用绝对 `expiresAt` 并在读取时惰性删除，不创建 per-entry timer；`ttlMs: 0` 表示不
过期。

## Async read policy

只保留三种可以清楚解释、可组合的策略：

### `cache-first`

默认。`local -> backend -> loader`。适合大多数读多写少场景。

### `cache-and-refresh`

若存在有效 local value，立即返回它，同时在后台通过同一个 single-flight 通道读取 backend；backend miss 且调用
的是 `getOrLoad` 时再执行 loader。刷新成功会更新 local，失败只增加 `refreshErrors`。

它不是无限期 stale-while-revalidate：已超过 TTL 的 local value 仍视为 miss。这样不需要再引入 stale window、最大陈旧时间
等第二组过期概念。

### `remote-first`

跳过 local 读取，始终先访问 backend；backend miss 时 `getOrLoad` 执行 loader。backend 结果仍写回 local，供
后续 cache-first 或同步观察。

每次调用可以覆盖 `readPolicy`，但稳定策略优先放在 provider config 或 scope。更复杂的流程，例如超时后降级
local、双读比对、条件刷新，应由作者显式组合 `local` 与顶层 Promise API。

### Backend failure

`getOrLoad()` 的 `backendFailure` 只有两种 scope policy：

- `required`（默认）：backend read/write failure reject，不伪造 hit；
- `bypass`：backend read failure 作为 miss 继续 loader，loader 成功后的 backend write failure 只记录统计并发布 local。

`bypass` 不吞 loader/database/external error，也不改变显式 `get/set/delete/clear` 的严格失败语义。它必须显式选择，因为
backend outage 时绕过 Redis 可能放大 database/source 流量。同 scope 所有调用共享该策略，避免 same-key single-flight
由首个请求偶然决定失败语义。

## Single-flight 与 mutation ordering

同一个 owner namespace、scope 和 encoded key 最多有一个异步工作：

1. 多个 backend get 合并；
2. 多个 get-or-load 合并 backend 与 loader；
3. cache-and-refresh 复用相同 single-flight；
4. `set/delete/clear` 通过 mutation barrier 等待读取，迟到结果不会复活已失效值；
5. subscriber AbortSignal 只取消当前等待，不取消其他 subscriber 的共享工作。

达到 `maxInFlight` 时抛出 `CacheBusyError`，不创建无界等待队列。rejected result 和 `undefined` 不缓存。
async set 先成功写 backend，再发布 local。

## Decorator

`@Cached` 使用 caller-local async method scope；`@Memoized` 使用 caller-local local-cache method scope。decorator 通过
Pluxel `pluginMethodDecorator(Cache, ...)` 声明 required dependency，constructor 仍必须包含 `Cache`。

一个 primitive 参数直接作为 key；零参数使用固定 key；多个 primitive 参数使用稳定 tuple encoding。配置 `name`
后可通过 `cache.scope(name).delete(key)` 或 `.local.delete(key)` 主动失效。decorator 不提供 global 模式，跨插件
共享必须在业务代码中显式使用 `cache.global`。

`@Cached` 可以直接装饰返回数据库 DTO 的 Promise method。它只隐藏短期 cache-aside；数据库 `refreshedAt`、外部 API、
refresh claim/CAS、stale-if-error 和长期 freshness 仍属于 method 调用的 repository。不要增加 database/external-specific
decorator，也不要缓存 transaction handle、Response、stream、函数或 credential。`undefined` 不缓存；负缓存使用 `null`
或显式 domain result。

## Backend 多态与 raw 边界

`CachePlugin` required-depend 抽象 `CacheBackend`。默认 catalog 使用 `MemoryCacheBackendPlugin`，形成较小的同步
local hot set 与较大的异步内存 backend；外部 package 用 `@Plugin(CacheBackend, ...)` 提供 Redis、数据库或其他实现。
Pluxel graph 负责 provider 选择、失败传播、replacement 与 cleanup，cache consumer 永远只依赖 `Cache`。

`CacheBackend` 只有异步 `get/set/delete/clear?`。序列化、Redis command、数据库 schema、连接池和 timeout 由实现
plugin 管理。`MemoryCacheBackendPlugin` 同样使用 SIEVE，并有独立的 backend 容量配置。

### Memory backend 快照恢复

内存 backend 可以选择使用 runtime `PersistenceService` 保存版本化快照；默认 `off`，因此未启用时不创建
namespace、timer、序列化副本或持久状态：

- `best-effort`：恢复或保存失败时告警并继续使用空/当前内存状态；ephemeral persistence 可以跨 plugin replacement
  恢复，但不能承诺跨进程重启；readonly persistence 只尝试恢复，不保存更新；
- `durable`：init 阶段要求 persistence 同时 durable、writable，不满足时诚实启动失败；快照读取或解码失败同样使
  provider 启动失败；
- `flushIntervalMs`：合并连续 mutation 的快照写入；stop/replacement 取消 timer 并 flush 最新 revision。

快照保存 async memory backend 的有效 key、Node structured-clone value 和绝对 `expiresAt`。停机时间因此计入 TTL；
恢复时先丢弃过期 entry，再按快照顺序写入当前容量的 SIEVE，容量缩小时自然淘汰。快照使用 atomic put，mutation
发生在进行中的 put 期间会形成更高 revision，旧写入完成后继续写最新状态，不会让晚到快照复活已删除 key。

持久化启用且可写时，`set()` 会拒绝 Node structured-clone codec 无法序列化的值。每个 value 在 set 时生成序列化
副本，避免对象之后被外部修改成不可序列化形态而令后台 flush 随机失败。live memory value 仍保持原有引用语义，
重启后恢复的是 set 时的快照值。

同步 local bucket 不进入持久化。它是每个 caller/scope 的小型 hot set；持久化它会复制 async backend 状态并引入
异步 hydration 边界。Memory backend init 完成恢复后，所有 local API 仍保持纯同步。

这项能力只用于 warm start，不提供数据库 durability、跨进程一致性或 write-through 成功保证。`durable` 表示 host
必须提供 durable persistence capability，并不把 cache mutation 提升为业务事务。

普通 consumer 不暴露 raw backend access，因为它会绕过 namespace、local、single-flight、统计与 replacement revoke。
backend-specific raw key、codec、connection 与 schema 属于 adapter package。

本包只保证进程内 single-flight；跨实例锁必须由 adapter/loader 使用具备 fencing/lease 语义的方案。

## Lifecycle 与统计

caller/provider stop/replacement 会撤销旧 handle 并抛出 `CacheStoppedError`。统计包括 local/backend hit、miss、load、
deduplicated waiter、capacity rejection、backend read/write error、background refresh/error、eviction、entry 与 in-flight
数量，不记录原始 key 或 value。

Workbench 不属于 cache capability。现有 host-owned dependency override UI 根据 `CachePlugin(CacheBackend)` 自动发现
所有 `@Plugin(CacheBackend, ...)` provider。选择实现后，runtime commit 会重启被修改 plugin 及其 dependent closure，
使缓存 consumer 获得新 caller-bound view。headless host 直接在 catalog/runtime state 中选择实现，业务 API 完全相同。

## Package boundary

`@pluxel/cache` 只依赖 Pluxel runtime，不依赖 Redis client 或数据库 driver。`@pluxel/redis` 依赖轻量 cache contract
并自带 `RedisCacheBackendPlugin`。因此 Redis consumer 只安装一个完整 Redis package，而 memory-only cache consumer
不会携带 node-redis。
