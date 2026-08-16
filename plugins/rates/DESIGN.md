# Rates 插件设计

## 边界与作者模型

Rates 只做短周期 `identity + cost -> atomic allow/deny decision`。它不拥有 concurrency semaphore、queue/pacer、retry scheduler、长期计费账本、distributed lock 或 transport policy。

作者面只有 `RatePolicy -> rates.use(name, policy) -> limiter.consume(identity, { cost? })`。`RatesPlugin` 负责 public validation、caller/global registration、canonical identity、resolved policy、generation gate 和 error boundary；根入口导出的 `RatesBackend` 接收 opaque key、完整结构化 owner snapshot、resolved policy 与 cost，完成一次原子状态转移。

policy 是拒绝 accessor、symbol 和 unknown field 的 exact plain object。identity codec 保留 primitive 类型、tuple 位置和 record 字段名，拒绝包含未配对 surrogate 的 string，最多 16 个 part、1,024 UTF-8 bytes。raw identity 不能进入 error、log 或 metric；Redis storage key 必须使用稳定 digest。

## 算法与数值

- token bucket 使用 token-millisecond integer units，`limit / windowMs` 是 refill rate，`burst` 是容量；
- fixed window 按 Unix epoch 的 `windowMs` 整数倍对齐；
- sliding counter 保存 previous/current bucket，用 integer weighted units 直接求 retry；
- sliding log 保存有效 `{ at, cost }` event、head index 与 used，精确删除 `at <= now - windowMs` 的 event。

`MAX_WINDOW_MS` 为 2,147,483,647，全部公开数值和中间乘积必须是 safe integer。state 保存 observed time，clock 回退使用 `max(sourceNow, observedAt)` fail closed。policy fingerprint 不进入 backend key；有效 state 保存完整 resolved policy并拒绝 rolling mismatch，避免新旧部署分裂 bucket 后超发。

Decision 只以 `denied` 判别 allow/deny。coordinator 对第三方 backend 的 exact plain-object shape、safe-integer 数值和
resolved policy/cost bound 做固定字段校验，不让 malformed success 逃逸为可信判定。基础设施、容量、损坏 state 和 lifecycle failure 使用四个
稳定 `RatesError` code；backend 未知错误保留为 `RatesUnavailableError.cause`，不把 backend message 变成 contract。

## Memory

Memory 使用 `Map<canonicalKey, State>` 和每 state 恰好一个 node 的 indexed min-heap。查找为 O(1)，expiry 更新和清理为
O(log n)。普通 consume 最多增量清理 64 个到期 state，避免窗口边界的大批同时到期由单个请求无界承担；新 identity
遇到容量上限时，只继续检查 heap 顶到空出所需槽位或证明最早 state 仍有效，不扫描或淘汰有效 quota state。状态转移
在 async method 的第一个 `await` 前完成，同进程并发不会超发。stop/replacement 清空 Map 与 heap。

## Redis

Redis adapter 为四算法各维护一个 immutable module-level Lua definition。每次 consume 对 SHA-256 storage key 进行一次
roundtrip，并在脚本内读取 `TIME`、验证 Redis type/format/policy、完成 cleanup/refill/rollover、判定、写回和精确
`PEXPIRE`。O(1) 算法使用 Hash；sliding log 使用单个 ZSET，score -1 保存 metadata，epoch score 保存 event。sliding log
的 allow hot path 只验证 metadata、ZSET cardinality 与首尾边界；cleanup 只读取已到期 score 区间，全部到期时直接删除；
deny 以一次最多 10,000 条的 bounded range read 计算 retry，并校验 live event cost 总和。adapter keyspace 必须由 rates Lua
独占，外部 writer 修改 metadata/event 不属于完整性或安全边界；被读取的 event、metadata、cardinality 和边界损坏仍会
fail closed。这个边界避免为了证明任意外部篡改而把每次 allow 固定退化为 O(limit)。

EVALSHA 的 NOSCRIPT 只回退一次 EVAL。Hash/ZSET 跨算法 mismatch 返回结构化 conflict；未知 type、非法 metadata/event 或 decoder tuple fail closed。storage key 只包含 deployment prefix、codec version 与 digest，policy 不参与 digest。Hash/ZSET metadata 保存 canonical owner JSON，并在每次 transition 前与 request 的完整 owner snapshot 比对；owner mismatch 按损坏 state fail closed。

## Ownership 与验证

local registration 在进程内绑定 caller `PluginNodeSlot`，backend key 只使用 canonical node address JSON 的 SHA-256；global registration 跨 caller 共用 policy/state，其 owner 明确为 `null`，但 owner lease 仍登记在 caller effects。handle 同时检查 caller Context 和 Rates provider 的当前 registry generation，覆盖 caller stop、backend override、replacement、rollback 与 cached view。

Memory 与 Redis wiring 测试覆盖四算法、weighted cost、并发、policy conflict、corrupt reply、digest key 和 NOSCRIPT。CI 启动专用 Redis 7，运行真实 Lua、同 key 并发、rolling mismatch、SCRIPT FLUSH 与 scoped SCAN/UNLINK cleanup。Rates 不注册 Workbench extension，disabled Workbench 不改变行为或成本。
