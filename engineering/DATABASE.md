# 数据库：owner handle 与数据换代

托管数据库有 `Pg` 和 `Sqlite` 两个方言服务。Host 通过安装器选择驱动，插件直接使用绑定其 schema 的 Drizzle。配置、偏好和有界状态使用 TinyBase。[数据库指南](../docs/plugin-development/database.md) · [TinyBase](TINYBASE.md)

## Author boundary

插件用所选方言的 `defineDatabase({ schema })` 声明表和演进方式。声明可以由 Drizzle Kit 直接求值。Host 接纳的定义必须包含经构建器校验的迁移历史。两个方言共用 owner 的首次打开、失败重试和调用排空逻辑，每代插件在同一服务上只能打开一个定义。两个入口都用 `PluginDatabaseHandle<typeof definition>` 表达句柄与 schema 的关系。

`init()` 中的 `ctx.service(Pg).use(definition)` 绑定当前 Context owner、准备 migration，返回仅含 `read(callback)` 与 `transaction(callback)` 的 handle。每个 handle 用 definition 的表和 relations 创建 Drizzle client，同一 Host 的 client 共用底层连接资源。共享 definition 只共享结构。作者不取得 driver、pool、长期 session、physical schema 或独立 commit API。

每个 owner 的 immutable database instance 拥有独立 physical schema 和 NOLOGIN role，registry 只标记一个 active instance。handle 固定绑定取得时的 instance；每次 operation 在 transaction 内确认它仍 active，并设置 role、`search_path` 和 statement/lock/idle timeout。`read()` 同时设置 read-only。这些限制防止误接线；Plugin 仍与 Host 同进程。

应用自管数据库可以直接使用 application-private Drizzle client、pool 和 migration。若数据库是整个应用的启动前提，应用在 `prepare()` 中打开、迁移，按 root Context 绑定实例并向 root effects 登记关闭；Plugin 通过接收 Context 的 typed accessor 获取它。若只有部分 Plugin 依赖，则使用 constructor-injected provider Plugin，让 graph 拥有失败传播和 cleanup。自管数据库不取得 runtime 的 per-plugin role、lineage、outbox 或 owner invalidation，也不从 host config/Core FS 推导原生路径。

## Backend ownership

应用从 `@pluxel/services/pg/pglite` 或 `@pluxel/services/pg/postgres` 导入安装器，直接放进 Host 的 `services`。两者都提供同一个 owner 服务 `Pg`，同时安装会触发 Host 的 `DUPLICATE_SERVICE`。插件入口 `@pluxel/services/pg` 只声明服务和 schema API。两个安装器各自按需加载自己的驱动，Services 将两个原生驱动声明为 optional peer。

`postgres()` 接受原生 `pg.PoolConfig | Pool`，`pglite()` 接受 `PGliteOptions | PGlite`。配置创建的资源归 Host，传入实例仅借用。adapter 关闭时移除自己安装的 PostgreSQL error listener。借用资源须存活到所有 Host 排空，期间保持 pool 并发上限不变。

没有 Plugin 调用 `use()` 时，不初始化 driver、migration 或 outbox。PGlite 为 root-scoped 单实例，可使用 `memory://`；持久目录支持正常关闭后的开发重启。PostgreSQL 使用有界共享 pool，scheduler 并发读取实际 `pool.options.max`，PGlite 固定为 1。原生参数示例见 [Host 配置](../docs/host/configuration.md#选择-native-postgresql-或-pglite)。

## Schema evolution

默认 `evolution: 'migrations'` 保留数据。构建端读取 Drizzle Kit 的 `drizzle/meta/_journal.json` 和 SQL 原文，使用 Drizzle 的 `readMigrationFiles()` 得到有序的 `MigrationMeta[]`。随插件交付的 `pluxel-migrations.json` 只记录 lineage。开发、发布和已发布历史比对见 [Toolchain](TOOLCHAIN.md#database-migrations)。

Host 为每个物理实例在 `pluxel_system` 下维护独立的 Drizzle 迁移表。业务表的位置由事务的 `search_path` 选择，插件 role 仅获得业务 schema 的授权。首次准备实例时，Drizzle 创建该实例的迁移记录并执行 SQL。同 lineage 追加迁移前，Host 按写入顺序读取原记录，逐项核对时间戳和原始 SQL 的 SHA-256。已应用的历史必须是交付制品的前缀。

准备事务持有 owner 锁，并负责设置 schema、迁移、授权、安装 trigger 和更新 active instance。`PgDialect.migrate()` 使用已绑定到外层事务的 session，其嵌套事务通过同一连接的 savepoint 执行。任一步骤失败，表结构、数据、迁移记录和实例切换一起回滚。

lineage 改变时，Host 准备新实例，成功后归档旧实例并撤销旧 role 的 schema 权限。可重新生成的数据通过 `evolution: 'reset-on-schema-change'` 使用同一执行路径，baseline 的时间戳固定为 0，以规范化 schema snapshot 的摘要决定 lineage。相同 schema 重建时复用数据，即使工具输出的 SQL 排版不同。

远端 PostgreSQL 的普通 operation 取得 per-owner shared advisory lock，migration/promotion 取得 exclusive lock；不同 owner 按 pool 上限并行。PGlite 的 operation 和 promotion 经单连接 scheduler 串行结算。

active metadata 保存 artifact fingerprint 和 runtime trigger version。PostgreSQL 和 PGlite 均按 owner 查询 registry。已匹配的实例复用授权、schema 和 trigger。每次读写在同一事务中检查 active instance 并设置操作上下文，多个 Host 共用原生客户端时也能拒绝已换代的句柄。缺少的扩展由 Host 在数据库级锁下安装，默认放入 `pluxel_extensions`。已有扩展保留实际 namespace，owner 获得所声明扩展的 schema USAGE。位于其他插件私有 schema 的扩展由管理员显式迁出。

## Invalidation and outbox

写入仅通过 `transaction()`。owner table 的 statement trigger 在同一 transaction 写 pending outbox，rollback 一并撤销。commit 后 dispatcher 发布 durable invalidation log；进程轮询 checkpoint，只唤醒相交的 active query。PGlite 使用相同的持久恢复路径和进程内调度。

table invalidation 是内部能力。Plugin 自行执行有界查询、返回 DTO，并在需要时把 invalidation 转成业务 observer；Workbench 不持有数据库 replica 或通用 query/patch 协议。

## Resource control

scheduler 只跟踪有等待者的 owner，按轮次分配空出的并发槽，限制每个 owner 的排队数量和时间。Core 在停止时等待已接纳的运行中与排队操作，随后撤销该代订阅。PostgreSQL 的 outbox 发布事务按提交顺序分配可见游标，业务事务按 owner 并行。同 lineage replacement 复用 active instance，新 lineage 创建新 instance。archive 的清理与配额属于宿主。

acquire 与缓存 handle 的 read/transaction 都进入 Core root/owner invocation lease；Host 排空操作后才关闭 adapter。

并发的首次 acquisition 共用 driver 和元数据初始化。初始化失败会把错误交回调用方，下一次显式 `use()` 重新执行失败阶段。已经打开的 adapter 继续由 Host 持有。

## Host composition 与实现归属

`@pluxel/services/pg` 拥有 definition、`Pg` 服务声明和 owner handle。Services 内部协调调度、迁移和 outbox。应用通过所选驱动的入口安装服务。schema artifact 编译归 Rolldown，见 [Toolchain](TOOLCHAIN.md#database-migrations)。

## SQLite 与 D1

`@pluxel/services/sqlite` 拥有 SQLite schema 定义和 `Sqlite` 服务。Host 的 `libsql()` 和 `d1()` 安装器注册同一个 token，两个驱动共用 owner 调用寿命、定义校验和 Drizzle journal 前缀检查。每代插件复用首次成功打开的 handle。回调直接借用实际驱动的 Drizzle 客户端，两端支持原生查询和原子 batch。驱动在打开时声明是否支持交互式事务，`handle.supportsInteractiveTransactions` 将该能力同步给调用方与类型系统。

本地 libSQL 按 canonical owner 与 lineage 选择持久文件。历史匹配时只读打开。需要追加迁移时获取 SQLite 写锁，在锁内复核历史并调用 `SQLiteAsyncDialect.migrate()`。重建表时由迁移连接在事务外切换外键设置，提交前执行 `foreign_key_check`，业务连接开启外键。新 lineage 首次使用时从空文件开始，切回已有 lineage 时校验并复用文件。

D1 的部署入口在 Node 中校验原发布目录，仅在需要迁移时将已核验的 journal 和 SQL 原文交给 `drizzle-orm/d1/migrator`。每个物理库的部署任务串行执行。库内的一条身份记录保存 owner、lineage 与 evolution，Drizzle 的迁移表记录已执行的 SQL。Worker 首次借用时在一次 batch 中核对身份与迁移历史。切换 lineage 时部署者提供新数据库。[装配和部署](../docs/host/configuration.md#cloudflare-d1)

## 实现与验证

两个公开方言入口在 `packages/services/src/pg.ts` 和 `sqlite.ts`。`database/owner.ts` 管理插件代内的首次打开和操作寿命，`database/artifact.ts`、`database/history.ts` 分别校验交付制品和库内账本。驱动实现按 `database/pg/` 与 `database/sqlite/` 组织。Host、插件、Worker 回归位于 `packages/services/tests/`，迁移构建和 standalone 发行物回归位于 `packages/rolldown/tests/`。

关键场景是 lazy/disabled 零 driver、owner/fork 隔离、缓存 handle 撤回、排队 stop、migration 失败保留 active instance、原子 promotion 和 rollback 无 outbox。PGlite 覆盖本地单连接行为；生产并发、锁、deadlock、pool exhaustion 和 connection loss 在真实 PostgreSQL 验证。

## 现有 v2 数据库的一次性切换

使用旧版 Pg 且需要保留数据的应用，在停止所有使用该库的 Host 后，按 `pluxel_system.database_instances` 的 `owner_id`、`state = 'active'` 逐个转换。保留数据库备份，以及这个 owner 最后一次成功使用的发布包 `dist/database/migrations/`。旧账本只存迁移 id 与裁去首尾空白后的 SQL 哈希，原始字节、时间戳和顺序需要从当时发布的制品取得。先归档旧制品，再把源码中的 v2 清单改为只含 `lineage`，生成同 lineage 的新版制品。

管理员用完整 owner id、旧版与新版制品目录核对已执行前缀。旧 reset 制品只含一个 baseline，保留相同 schema lineage 时使用时间戳 `0`。把维护函数保存为应用工作目录内的临时文件 `cutover.mjs`。转换在一个事务中完成，输入不匹配或目标记录表已经存在时会报错并回滚。

```js
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const json = async (dir, file) => JSON.parse(await readFile(join(dir, file), 'utf8'))
const hash = (value) => createHash('sha256').update(value).digest('hex')

export async function convert(db, owner, previousDir, nextDir) {
	const old = await json(previousDir, 'pluxel-migrations.json')
	assert.equal(old.version, 2)
	assert.equal(old.lineage, (await json(nextDir, 'pluxel-migrations.json')).lineage)
	const reset = old.evolution === 'reset-on-schema-change'
	if (reset) assert.equal(old.migrations.length, 1)
	const oldEntries = reset
		? [{ tag: old.migrations[0].id, when: 0 }]
		: (await json(previousDir, 'meta/_journal.json')).entries
	const nextEntries = (await json(nextDir, 'meta/_journal.json')).entries
	const next = readMigrationFiles({ migrationsFolder: nextDir })
	if (reset) {
		assert.equal(next.length, 1)
		assert.equal(next[0].folderMillis, 0)
	}
	assert.deepEqual(
		old.migrations.map((m) => m.id),
		oldEntries.map((e) => e.tag),
	)
	const history = []
	for (const [i, m] of old.migrations.entries()) {
		assert.equal(m.file, basename(m.file))
		assert.equal(m.file, m.id + '.sql')
		const source = await readFile(join(previousDir, m.file), 'utf8')
		assert.equal(hash(source.trim()), m.checksum)
		const when = oldEntries[i].when
		assert.ok(Number.isSafeInteger(when) && when >= 0 && (i === 0 || when > oldEntries[i - 1].when))
		const rawHash = hash(source)
		if (!reset) {
			assert.equal(nextEntries[i]?.tag, m.id)
			assert.deepEqual([next[i]?.folderMillis, next[i]?.hash], [when, rawHash])
		}
		history.push({ when, rawHash })
	}
	await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pluxel/database/' + owner}, 0))`,
		)
		const {
			rows: [active],
		} = await tx.execute(
			sql`SELECT instance_id, lineage FROM pluxel_system.database_instances WHERE owner_id = ${owner} AND state = 'active' FOR UPDATE`,
		)
		assert.equal(active?.lineage, old.lineage)
		const { rows } = await tx.execute(
			sql`SELECT migration_id, checksum FROM pluxel_system.database_migrations WHERE instance_id = ${active.instance_id}`,
		)
		assert.deepEqual(
			new Map(rows.map((r) => [r.migration_id, r.checksum])),
			new Map(old.migrations.map((m) => [m.id, m.checksum])),
		)
		const name = sql.identifier('drizzle_' + active.instance_id.replaceAll('-', ''))
		await tx.execute(
			sql`CREATE TABLE pluxel_system.${name} (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
		)
		for (const { when, rawHash } of history)
			await tx.execute(
				sql`INSERT INTO pluxel_system.${name} (hash, created_at) VALUES (${rawHash}, ${when})`,
			)
	})
}
```

在同目录的 `run-cutover.mjs` 中使用原应用的管理员连接。PostgreSQL 的 `Pool()` 从标准 PG 环境变量读取配置。

```js
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { convert } from './cutover.mjs'

const [owner, previousDir, nextDir] = process.argv.slice(2)
const pool = new Pool()
try {
	await convert(drizzle({ client: pool }), owner, previousDir, nextDir)
} finally {
	await pool.end()
}
```

运行 `vp exec node run-cutover.mjs '<owner_id>' <旧制品目录> <新制品目录>`。持久 PGlite 使用 `drizzle-orm/pglite` 和原 `dataDir`，在 `finally` 中 `await client.close()`。完成转换后，用新 Host 打开同一 owner，确认实例 UUID 相同、原有业务行可读，并核对本次追加的迁移。验证后移除临时模块。
