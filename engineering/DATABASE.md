# Database Architecture

插件数据库是 `@pluxel/runtime` 的常驻 capability。PostgreSQL 是唯一 SQL dialect，Drizzle 是唯一作者查询界面；
未配置宿主使用 root-scoped lazy PGlite，显式配置时使用共享的有界 `pg` pool。

## Author boundary

插件用普通 `pgTable()` 定义一份 schema，再调用 `defineDatabase({ schema })`。definition 是不可变、可复用的 schema、
evolution policy 与 migration 声明，不携带数据 owner；`ctx.database.use()` 在 plugin `init()` 中从 immutable Context 绑定
owner、完成 migration prepare，并返回只暴露 `read(callback)` 与 `transaction(callback)` 的 handle。共享 definition 只复用
结构，不共享数据、handle 或 transaction。作者不取得 driver、pool、长期 session、physical schema 或独立 commit API。

以上边界只约束 Pluxel-managed plugin database。同一作者控制 fixed catalog、schema 与部署的 static application 可以完全绕过
该 capability，用普通 application module scope 自己的 Drizzle client、pool 与统一 migration。默认使用无参数 lazy `use()`；
`prepare()` 只在数据库失败必须阻止任何 plugin 启动时调用同一入口做 eager preflight。runtime 不为这种数据库提供 per-plugin
role/instance、lineage、outbox 或 `liveQuery`。

每个插件最多一个 definition。runtime 为 owner 下的每个 immutable database instance 分配独立 physical schema 与
NOLOGIN role；system registry 只把一个 instance 标为 active。handle 固定绑定取得时的 instance，每次 operation 都在
transaction 中确认 instance 仍 active，再设置 instance role、`search_path`、statement/lock/idle timeout；read operation
另外设置 read-only。相同 table name 因此可安全存在于不同插件和不同 instance。第三方代码仍与宿主同进程，这些边界
防止误接线，不构成恶意代码 sandbox。

## Backend ownership

- 配置省略：在 host persistence root 下 lazy 创建一个共享 PGlite；
- `{ driver: 'pglite', dataDir }`：显式本地位置，测试可使用 `memory://`；
- `{ driver: 'postgres', connectionString, pool, tls }`：共享远端 pool；
- `false`：完全关闭，任何 `use()` 都使对应 plugin 启动失败。

没有 plugin 调用 `use()` 时不初始化 driver、migration、outbox 或 live-query backend。PGlite 是开发和本机默认；
在 filesystem flush 与 fault-injection 验收完成前，不把它描述为生产级掉电 durable。生产并发、锁、deadlock、
pool exhaustion 和 connection-loss 门禁必须运行在真正 PostgreSQL。

## Schema evolution

`evolution: 'migrations'` 是默认值，适合必须保留的权威数据。schema source 是作者事实，`drizzle/` 是有序、不可变、
可 review 的 deployment artifact：

```text
pluxel database generate
  -> drizzle/*.sql + drizzle/meta/* + pluxel-migrations.json
pluxel database check
  -> Drizzle history check + checksum rewrite check + schema drift check
pluxel database rebase --lineage <id>
  -> staging 中生成全新 baseline，成功后原子替换本地 artifact
pluxel build
  -> validated artifact embedded in server declaration
     and copied to dist/database/migrations for plugin package builds
```

manifest `lineage` 是插件唯一的存储换代意图。同 lineage 必须保持 migration history 为不可变前缀，runtime 一次读取
已应用 history，只执行缺失 migration；lineage 改变时创建隔离 candidate instance，从头应用新 baseline，全部成功后才在
同一 transaction 中把旧 instance 归档并激活 candidate。失败不会改变原 active instance；runtime 不从 DROP、ALTER 或
数据库错误推测数据意义。旧 instance 保留且撤销 plugin role 的 schema access，不自动删除。

可丢弃或可重新生成的数据显式声明 `evolution: 'reset-on-schema-change'`。production compiler 每次从空 schema 生成临时
baseline，以去掉随机 snapshot identity 后的规范化 Drizzle schema snapshot 计算稳定 lineage，并只把 SQL 与 manifest 发布到
`dist`。作者不创建或提交 `drizzle/`；相同 physical schema 继续复用 active instance，schema fingerprint 改变时才走相同的
candidate prepare、atomic promotion 与 archive 流程并得到空数据。SQL 格式或 toolchain 输出变化不改变 schema lineage，
runtime 也不把 reset baseline 当作可追加 history。该策略是对未来 schema 变化均允许丢数据的持续声明，不是自动 data
migration。

远端 PG 的普通 operation 取得 per-owner shared advisory lock，migration/promotion 取得 exclusive lock；不同 owner 按 pool
上限并行。PGlite 继续共享一个 root instance，由单连接 scheduler 串行 operation 与 promotion。active instance 保存
artifact fingerprint 与 runtime trigger version：PGlite 启动时一次加载全部 active metadata，完全匹配的 plugin 直接取得
handle；远端 PG 为多进程正确性每 owner 查询 active metadata，但不会重复 role/schema/grant/trigger DDL。扩展必须通过
`requirements.extensions` 声明；缺失权限或 extension 会在 capability acquisition 时诚实失败。

## Invalidation and live query

写操作只能在 `transaction()` 中发生。每个 owner table 的 statement trigger 在同一 transaction 写 pending outbox；
rollback 会一起回滚。commit 后 dispatcher 以 durable log 发布 table invalidation，本进程轮询 checkpoint 并仅唤醒
相交的 active query。PGlite 使用同一持久路径和进程内调度；durable log 才是恢复事实。

Workbench `liveQuery` 是经授权、runtime-validated 的 DTO 查询，不是 table replica。完整协议、ordered patch、
last-known-good 与 grant lifecycle 见 [`WORKBENCH.md`](WORKBENCH.md)。

## Resource control

PGlite 的所有 operation 经单连接 scheduler；远端 PG 的 admission concurrency 等于 pool 上限。scheduler 按 owner
轮询、公平取队列，限制每 owner pending 数并使排队超时。owner stop 先拒绝新 operation，再等待已接纳的运行中和排队
operation 排空；live-query subscription 由 Workbench 绑定 cleanup 撤销。同 lineage replacement 复用 active instance，
新 lineage replacement 得到新 instance。archive 会占用宿主存储，但 plugin 无权删除宿主备份或绕过配额策略。
