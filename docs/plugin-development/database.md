---
title: 关系型数据库与数据管理
description: 使用 Drizzle ORM 定义插件专属数据表，支持托管数据库隔离与迁移演进。
---

插件按 Drizzle 方言选择服务。PostgreSQL 插件使用 `Pg` 和 `pgTable()`，SQLite 插件使用 `Sqlite` 和 `sqliteTable()`。两种方言各自导出 `defineDatabase()`。应用在 Host 的 `services` 中选择驱动，每个插件和 fork 各自持有数据。[Host 装配示例](../host/configuration.md#数据库服务后端选择)

## 两种数据管理模式

| 模式                                      | 适用场景                                                 | 数据归属与隔离                                 |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| **托管插件数据库（Managed Database）**    | 插件作为独立模块分发，需要独立的数据表与迁移记录         | 每个插件拥有隔离的命名空间，生命周期与插件绑定 |
| **应用自管数据库（Application-Private）** | 应用由统一团队维护，多个业务表需要跨表 Join 或跨模块事务 | 由宿主全局管理连接池与全局 Drizzle 实例        |

## 托管插件数据库（Managed Database）

用 `defineDatabase()` 导出本插件的 Drizzle 表和关联。Drizzle Kit 可以直接加载这份声明。`Pg.use()` 和 `Sqlite.use()` 都要求插件制品包含对应方言的迁移历史。同一代插件并发打开相同定义时，调用共享一次初始化；初始化失败后可重试。需要在插件上保存句柄时，从所选方言入口导入 `PluginDatabaseHandle<typeof NotesDatabase>`。

### 1. 定义数据表与 Schema

下例给 PostgreSQL 插件定义表，并在读写回调中使用同一份 Drizzle schema。

```ts twoslash
// @filename: database.ts
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { defineDatabase } from '@pluxel/services/pg'

export const notes = pgTable(
	'notes',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		title: text('title').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('notes_created_at_idx').on(table.createdAt)],
)

export const NotesDatabase = defineDatabase({
	schema: { notes },
})

// @filename: NotesPlugin.ts
import { Pg, type PluginDatabaseHandle } from '@pluxel/services/pg'
import { BasePlugin, Plugin } from '@pluxel/core'
import { notes, NotesDatabase } from './database.ts'

@Plugin({ displayName: 'Notes' })
export class NotesPlugin extends BasePlugin {
	private database!: PluginDatabaseHandle<typeof NotesDatabase>

	protected override async init() {
		this.database = await this.ctx.service(Pg).use(NotesDatabase)
	}

	listNotes() {
		return this.database.read((db) => db.query.notes.findMany({ orderBy: notes.createdAt }))
	}

	createNote(title: string) {
		return this.database.transaction(async (tx) => {
			const [note] = await tx.insert(notes).values({ title }).returning()
			return note
		})
	}
}
```

### 2. 读写与事务规范

- `database.read()` 在只读事务中运行回调。`db.select().from(notes)` 和 `db.query.notes.findMany()` 都使用当前插件的数据库。需要 `with` 关联查询时，把表和对应的 Drizzle `relations()` 一起放入 `defineDatabase({ schema })`。
- `database.transaction()` 在回调成功时提交，抛错或 reject 时回滚。回调中的 `tx.query` 也绑定同一份 schema。
- 插件停止或被热替换时，Host 等待已接纳的操作结算。旧句柄会拒绝新调用。

需要 PostgreSQL 扩展时可声明 `defineDatabase({ schema, requirements: { extensions: ['citext'] } })`。Host 为各插件和 fork 复用数据库里已安装的扩展，缺失时使用 Host 连接安装，权限问题会在首次 `use()` 时报告。

### SQLite

SQLite 的表和关联可以在本地 SQLite 与 D1 之间共用。把表导出给 Drizzle Kit，同时放入 `defineDatabase({ schema })`，这样 Drizzle 的 `db.query` 才能推导表和关联。

```ts
// database.ts
import { defineDatabase } from '@pluxel/services/sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
	id: integer().primaryKey(),
	title: text().notNull(),
})
export const NotesDatabase = defineDatabase({ schema: { notes } })
```

本地 SQLite 和 D1 都通过 `ctx.service(Sqlite)` 访问。下面的插件函数在两种 Host 上都使用原生 `db.batch()`。批次中任一写入失败时，两条写入会一起回滚。

```ts
import type { Context } from '@pluxel/core'
import { Sqlite } from '@pluxel/services/sqlite'
import { notes, NotesDatabase } from './database'

export async function addTwoNotes(ctx: Context, first: string, second: string) {
	const handle = await ctx.service(Sqlite).use(NotesDatabase)
	return handle.run((db) =>
		db.batch([
			db.insert(notes).values({ title: first }).returning(),
			db.insert(notes).values({ title: second }).returning(),
		]),
	)
}
```

`handle.run()` 的回调直接获得绑定当前 schema 的 Drizzle 客户端。表查询、关联查询和 `returning()` 都保留类型推导。`await db.run(...)` 的原始回执随驱动变化，公共类型为 `unknown`。请在回调内执行查询并等待结果，跨调用只保存 handle。插件停止时，Host 等待已接纳的调用完成，旧 handle 拒绝新操作。

需要在同一事务中根据查询结果继续读写时，先检查 `handle.supportsInteractiveTransactions`。为 `true` 时可在 `handle.run()` 内使用原生 `db.transaction()`。本地 libSQL 支持该能力。D1 上可以用 SQL 条件表达分支，用 `db.batch()` 原子提交预先确定的语句。[D1 批处理](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

## 数据库迁移（Migration Evolution）

默认 `evolution: 'migrations'` 保留已有数据。在插件包目录修改表定义后运行以下命令，并把整个 `drizzle/` 目录提交到版本库。

```sh
vp exec pluxel database generate
vp exec pluxel database check
```

CLI 从声明的导入路径选择 Drizzle Kit 方言，并校验现有 journal。PostgreSQL 与 SQLite 分别生成各自的 SQL、journal 和 schema snapshot。`pluxel-migrations.json` 只记录数据代号 `lineage`。手写 SQL 沿用 Drizzle 的 `--> statement-breakpoint` 分隔顶层语句，保证 PGlite 也能执行。

PG 和本地 SQLite 在首次 `use()` 时按 journal 顺序执行待处理迁移。D1 在部署时先用 `migrateD1()` 执行迁移，Worker 的 `use()` 核对相同 owner、lineage 和已应用历史。[D1 装配与部署](../host/configuration.md#cloudflare-d1)

发布新版本时，用上一版插件包中 `dist/database/migrations` 的解包路径运行 `vp exec pluxel database check --against <上一版迁移目录>`。同一 lineage 中，已发布的 SQL 原文、标记和顺序必须保留。需要主动从空数据开始时，在生成新版本前运行 `vp exec pluxel database rebase --lineage <新代号>`。PG 在新实例准备成功后切换并归档旧数据。本地 SQLite 使用与 owner 和 lineage 对应的文件，切回已有 lineage 会重新打开原文件。D1 的新 lineage 需要绑定独立数据库。

可重新生成的数据可以声明 `evolution: 'reset-on-schema-change'`。构建时自动生成 Drizzle baseline。PG 按 schema 变化切换实例。本地 SQLite 按 schema 派生的 lineage 选择文件。D1 在部署 baseline 时传入相同的 evolution。

<span id="应用完全自管-sql"></span>

## 应用完全自管 SQL（Application-Private）

如果你的应用是一个紧密耦合的单体系统，且多个内部插件必须执行联表查询（JOIN）或跨模块事务，建议在宿主层统一建立 Drizzle 连接，并通过常规的依赖注入将数据源服务暴露给各内部插件使用。
