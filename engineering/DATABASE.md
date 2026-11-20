# 数据库：owner handle 与数据换代

`@pluxel/services/database` 为 Plugin 提供 owner 隔离的 PostgreSQL 数据库能力，查询使用原生 Drizzle。应用显式安装；`servicesPreset()` 不包含它。配置、偏好和有界状态使用 [TinyBase](TINYBASE.md)。公开调用见[数据库指南](../docs/plugin-development/database.md)。

## Author boundary

Plugin 用 `pgTable()` 定义 schema，再用 `defineDatabase({ schema })` 声明 evolution policy 和 migration。definition 不携带 owner；每个 Plugin 最多使用一个 definition。

`init()` 中的 `ctx.service(Database).use(definition)` 绑定当前 Context owner、准备 migration，返回仅含 `read(callback)` 与 `transaction(callback)` 的 handle。共享 definition 只共享结构。作者不取得 driver、pool、长期 session、physical schema 或独立 commit API。

每个 owner 的 immutable database instance 拥有独立 physical schema 和 NOLOGIN role，registry 只标记一个 active instance。handle 固定绑定取得时的 instance；每次 operation 在 transaction 内确认它仍 active，并设置 role、`search_path` 和 statement/lock/idle timeout。`read()` 同时设置 read-only。这些限制防止误接线；Plugin 仍与 Host 同进程。

应用自管数据库可以直接使用 application-private Drizzle client、pool 和 migration。若数据库是整个应用的启动前提，应用在 `prepare()` 中打开、迁移，按 root Context 绑定实例并向 root effects 登记关闭；Plugin 通过接收 Context 的 typed accessor 获取它。若只有部分 Plugin 依赖，则使用 constructor-injected provider Plugin，让 graph 拥有失败传播和 cleanup。自管数据库不取得 runtime 的 per-plugin role、lineage、outbox 或 owner invalidation，也不从 host config/Core FS 推导原生路径。

## Backend ownership

`database({ backend })` 接收 lazy adapter factory。开发和测试使用 `@pluxel/services/database/pglite`，部署使用 `/database/postgres`；通用入口不加载 driver，两个工厂互不引用，Services 只声明 optional peers。未安装能力时，`ctx.service(Database)` 抛出标准缺失错误。

内置工厂保留原生 `pg.PoolConfig | Pool`、`PGliteOptions | PGlite`。配置创建的资源归 Host，传入实例仅借用；adapter 关闭会移除自己安装的 PostgreSQL error listener，保留借用实例和其他 listener。借用资源须存活到所有 Host 排空，期间保持 pool 并发上限不变。自定义 `DatabaseBackend` / `DatabaseAdapter` 沿用同一 owner、migration 和 drain 流程，由 factory 明确 adapter 的关闭语义。

没有 Plugin 调用 `use()` 时，不初始化 driver、migration 或 outbox。PGlite 为 root-scoped 单实例，可使用 `memory://`；持久目录支持正常关闭后的开发重启。PostgreSQL 使用有界共享 pool，scheduler 并发读取实际 `pool.options.max`，PGlite 固定为 1。原生参数示例见 [Host 配置](../docs/host/configuration.md#选择-native-postgresql-或-pglite)。

## Schema evolution

默认 `evolution: 'migrations'` 用于需要保留的数据。schema source 属于作者，`drizzle/` 是有序、不可改写的部署制品：

```text
pluxel database generate
  → drizzle/*.sql + drizzle/meta/* + pluxel-migrations.json
pluxel database check
  → history、checksum 和 schema drift 检查
pluxel database rebase --lineage <id>
  → staging 中生成 baseline，成功后原子替换本地制品
pluxel build
  → 校验后嵌入 server declaration；Plugin 包另复制到 dist/database/migrations
```

manifest 的 `lineage` 表达数据换代意图。同 lineage 的 migration history 必须保持为已应用 history 的不可变前缀，runtime 只执行缺失项。lineage 改变时，runtime 创建隔离 candidate、从头应用 baseline，成功后在一个 transaction 中归档旧 instance 并激活 candidate。失败保留原 active instance；旧数据保留，Plugin role 的旧 schema access 被撤销。runtime 不根据 SQL 操作或数据库错误猜测数据含义。

可重新生成的数据显式使用 `evolution: 'reset-on-schema-change'`。production compiler 每次从空 schema 生成 baseline，去除随机 snapshot identity 后，从规范化 Drizzle snapshot 计算稳定 lineage，仅向 `dist` 发布 SQL 和 manifest。作者无需提交 `drizzle/`；generate/check/rebase 会拒绝 reset definition。schema fingerprint 未变时复用 active instance，变化时沿同一 candidate/promotion/archive 流程得到空数据。SQL 排版和工具输出变化不改变 lineage，reset baseline 也不作为追加 migration history。这是持续允许 schema 变化丢弃数据的声明。

远端 PostgreSQL 的普通 operation 取得 per-owner shared advisory lock，migration/promotion 取得 exclusive lock；不同 owner 按 pool 上限并行。PGlite 的 operation 和 promotion 经单连接 scheduler 串行结算。

active metadata 保存 artifact fingerprint 和 runtime trigger version。PGlite 启动时一次加载，完全匹配的 Plugin 直接取得 handle；PostgreSQL 为多进程正确性每 owner 查询 active metadata，但不重复执行 role/schema/grant/trigger DDL。extension 必须由 `requirements.extensions` 声明，权限不足或缺失时在 acquisition 阶段失败。

## Invalidation and outbox

写入仅通过 `transaction()`。owner table 的 statement trigger 在同一 transaction 写 pending outbox，rollback 一并撤销。commit 后 dispatcher 发布 durable invalidation log；进程轮询 checkpoint，只唤醒相交的 active query。PGlite 使用相同的持久恢复路径和进程内调度。

table invalidation 是内部能力。Plugin 自行执行有界查询、返回 DTO，并在需要时把 invalidation 转成业务 observer；Workbench 不持有数据库 replica 或通用 query/patch 协议。

## Resource control

scheduler 按 owner 公平轮询，限制每 owner pending 数和排队时间。stop 先关闭新 operation admission，再等待已接纳的运行中及排队 operation，最后撤销内部 invalidation listener。同 lineage replacement 复用 active instance，新 lineage 创建新 instance。archive 的清理与配额属于宿主，Plugin 无权删除备份。

acquire 与缓存 handle 的 read/transaction 都进入 Core root/owner invocation lease；Host 排空操作后才关闭 adapter。

## Host composition 与实现归属

`@pluxel/services/database` 拥有 definition、Database 服务声明、owner handle、scheduler、migration/outbox coordinator；`database({ backend })` 安装 owner 服务。应用负责选择并安装 driver。schema artifact 编译归 Rolldown，见 [Toolchain](TOOLCHAIN.md#database-migrations)。

## 实现与验证

实现位于 `packages/services/src/database/`。回归入口为 `packages/services/tests/database-host.test.ts`、`services/database-service.test.ts`、`vite/database.test.ts` 和 `packages/rolldown/tests/database/artifact.test.ts`。

关键场景是 lazy/disabled 零 driver、owner/fork 隔离、缓存 handle 撤回、排队 stop、migration 失败保留 active instance、原子 promotion 和 rollback 无 outbox。PGlite 覆盖本地单连接行为；生产并发、锁、deadlock、pool exhaustion 和 connection loss 在真实 PostgreSQL 验证。
