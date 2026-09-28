# Cache 维护约束

作者用法与策略定义见 [缓存指南](../../docs/plugins/cache.md)。实现位于 [src/index.ts](src/index.ts)，
backend contract 位于 [src/backend.ts](src/backend.ts)。

## Owner、scope 与存储身份

进程内 namespace 按 caller 的 opaque `PluginNodeSlot` 隔离；backend prefix 使用结构化
`PluginNodeAddress` canonical bytes 的 SHA-256：`cache:v3:plugin:<owner-address-sha256>:<canonical-key>`。
value envelope 保存完整 owner address 并在读取时比对。global owner 为 `null`；hash 不替代 owner 校验。
错接 key、旧裸值、损坏 envelope 或 owner mismatch 必须失败，不提供旧格式 reader。

所有 caller 共享 coordinator / backend；global 共享 value namespace 和 single-flight，但每个 handle 保留
caller effects。最后一个 owner 停止后清理 local registration，backend 值不主动删除。
caller、Cache 或 backend stop/replacement 撤销旧 handle，后续操作抛 `CacheStoppedError`。

`scope()` 同步复制、校验、冻结 normalized policy，只覆盖显式字段；同 caller + name + policy 复用 handle，
显式不同 policy 抛 `CachePolicyConflictError`。`scope(name)` 取得既存 scope，未绑定时才继承父策略。
policy 必须是拒绝 accessor、symbol、unknown field 的 exact plain object。

key codec 保留 primitive 类型、`-0` 与 tuple 位置，record 字段按 code-unit order 排序；上限和合法输入见用户指南。
canonical key 直接追加 managed prefix，不做 URI 二次转义。key 不得包含 credential/token。

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

## Single-flight 与 mutation ordering

同一个 owner namespace、scope 和 encoded key 最多有一个异步工作：

1. 多个 backend get 合并；
2. 多个 get-or-load 合并 backend 与 loader；
3. cache-and-refresh 复用相同 single-flight；
4. `set/delete/clear` 通过 mutation barrier 等待读取，迟到结果不会复活已失效值；
5. subscriber AbortSignal 只取消当前等待，不取消其他 subscriber 的共享工作。

达到 `maxInFlight` 时抛出 `CacheBusyError`，不创建无界等待队列。rejected result 和 `undefined` 不缓存。
async set 先成功写 backend，再发布 local。

## Decorator 与 backend 边界

`@Cached` / `@Memoized` 通过 `pluginMethodDecorator(Cache, ...)` 使用 caller-local method scope，constructor
仍须包含 `Cache`。零参数为固定 key，单 primitive 直接作为 key，多参数使用同一 bounded tuple codec；
其他参数必须显式 `key()`。decorator 不提供 global 模式，也不拥有 repository freshness/transaction。

`CachePlugin` required-depend `CacheBackend`。backend 仅提供异步 `get/set/delete/clear`：
`undefined` 只表示 miss，hit 不得为 `undefined`；value 原样 round-trip；TTL 是剩余毫秒，`0` 为不失效；
`delete/clear` 幂等，`clear(prefix)` 不越过 managed prefix，失败必须 reject。
owner envelope 由 coordinator 生成/校验，adapter 不解释它。序列化、连接、schema、timeout 属于 adapter。

同步 local 不访问 backend。异步 API 即使使用 memory backend 也保持 Promise contract。
`getOrLoad()` 的 bypass policy 不改变显式 get/set/delete/clear 的严格失败语义。
普通 consumer 不获得 raw backend 入口，以免绕过 namespace、single-flight、统计与撤销。

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

本包只保证进程内 single-flight；跨实例锁必须由 adapter/loader 使用具备 fencing/lease 语义的方案。

## 统计、治理与依赖

统计只记录 hit/miss/load、deduplication、capacity rejection、backend/refresh error、eviction、entry 与 in-flight
数量，不记录原始 key/value。Cache 不发布专用 Workbench Definition；Host 根据 constructor dependency
选择 backend，override commit 重启 Cache 与 dependent closure，确保 consumer 获得新 caller-bound view。

Cache 不依赖 Redis client 或数据库 driver。`@pluxel/redis` 通过 Cache peer contract 提供
`RedisCacheBackendPlugin`，memory-only consumer 不携带 node-redis。
