# PGlite 本机测试 Backend 收敛

> 本文是未实施边界的设计记录，不改变当前 API；当前事实以
> [`../DATABASE.md`](../DATABASE.md) 和 [`../../docs/runtime/database.md`](../../docs/runtime/database.md) 为准。

## 目标

PGlite 的职责是快速、零外部服务的本机 PostgreSQL 语义执行器，用于开发和自动化测试。它不是 SQLite drop-in replacement，也不是部署数据库。设计优先级是：保持 Plugin 作者模型单一、缩短常见测试路径、避免伪造并发；不为它补齐 production durability、容量或故障恢复承诺。

作者继续只看到一套 API：`defineDatabase()`、`ctx.database.use()`、`read()` 和 `transaction()`。同一份 PostgreSQL schema、migration 和 query 必须能在 PGlite 与 native PostgreSQL 上运行。

## 已确认的边界

- PGlite 自身是 single user/connection。把 Pluxel scheduler 的 `concurrency` 调大只会把排队移进 PGlite，不会提高单库 SQL 吞吐。
- `memory://` 是日常测试默认选择；filesystem data directory 只服务本机正常关闭后的便利重启。
- native PostgreSQL 仍是部署、连接池、锁、跨进程 migration、故障恢复和性能验收的唯一 backend。
- `relaxedDurability` 不应成为默认值。它只会将 sync 放到后台，增加关闭/崩溃时的直觉成本，而 `memory://` 测试并不从中获益。
- per-owner PGlite instance、worker sharding 或共享 data directory 的多实例都不是小优化：它们会引入第二套 registry、migration、资源预算和 lifecycle 模型。

## 当前实现的安全优化

每次 owner operation 仍使用标准 `SET TRANSACTION READ ONLY`、`SET LOCAL ROLE`、PG advisory lock、instance check 和既有 transactional outbox。可合并的 `search_path`、三个 timeout 以及写 transaction id 通过一次 `SELECT set_config(...)` 设置，避免为同一事务反复进入 PGlite。

一次 `memory://` 微基准只能说明方向，不能成为跨机器 SLA：在同一进程内，合并后 read operation 的固定 setup 明显缩短。真正的验收是 schema migration、owner isolation、rollback outbox、handle teardown 和 PostgreSQL integration suite 全部保持通过。

## 必须保持的不变量

1. 一个 Plugin generation 至多取得一个 owner-bound definition；stop/replacement 后旧 handle 不得接受新 operation，并在已接纳 operation drain 后结束。
2. 同名表必须按 canonical Plugin owner 隔离；作者不依赖 physical schema、role、connection 或 driver。
3. migration history 仍是 immutable prefix；lineage replacement 仍保留旧 active instance，直到 candidate 准备成功。
4. PGlite 的单连接 admission 继续可观测且公平。它是 lifecycle/resource control，不是可调连接池。
5. PGlite benchmark 不导出 PostgreSQL production 结论。

## 尚未实施：删除 runtime-managed invalidation/outbox

当前 `@pluxel/runtime/internal` 仍导出 table invalidation helper，底层使用 trigger、outbox 和 polling。用户文档已经要求 Workbench/业务 API 由 Plugin 自己定义 snapshot 与 `watch()`；因此这层 infrastructure 值得在单独的破坏性设计中重新评估，但不能作为普通性能重构顺手删除。

若未来决定删除，必须先完成以下 gate：

1. 审计所有已发布的 `@pluxel/runtime/internal` consumers，而不只搜索本仓库。
2. 明确 replacement 是无、还是 application-owned domain watch；不得把 table event 偷换成新的作者 API。
3. 将导出的 internal helper 按发布策略废弃/移除，并给出版本边界。
4. 对已有 PGlite/PG data directory 制定显式迁移方案，说明旧 trigger、outbox rows、mixed-runtime deployment 和 rollback 的处理方式。
5. 只在 migration 经过 staging、restart 和 rollback 验证后，才删除 system tables/trigger function。

在这些 gate 完成前，保留 outbox 是正确的兼容性成本；不能通过启动时静默 DROP trigger 来“简化”。

## 验收矩阵

| 目标                                                       | PGlite `memory://` | native PostgreSQL |
| ---------------------------------------------------------- | ------------------ | ----------------- |
| schema、migration、CRUD、owner isolation、handle lifecycle | 必须               | 必须              |
| 单连接 admission 与常见 operation 热路径                   | 必须               | 不以此推断        |
| pool、row lock、deadlock、跨进程 migration                 | 不适用             | 必须              |
| connection loss、durability、备份/恢复、目标硬件性能       | 不适用             | 必须              |

新的性能优化必须先用固定输入的 microbenchmark 找到 hot path，再以行为测试验证；不得用放大 `concurrency`、放宽 durability 或增加 worker 数量代替证据。
