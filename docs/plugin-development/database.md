---
title: 关系型数据库与数据管理
description: 使用 Drizzle ORM 定义插件专属数据表，支持托管数据库隔离与迁移演进。
---

当插件需要复杂的 SQL 查询、唯一性约束、外键或关系型事务时，可使用 `@pluxel/services/database` 提供的数据库扩展服务。Pluxel 统一基于 PostgreSQL 方言与 [Drizzle ORM](https://orm.drizzle.team/) 组织表结构，由宿主决定底层运行于正式的 PostgreSQL 还是轻量的内存/嵌入式 PGlite。

## 两种数据管理模式

| 模式                                      | 适用场景                                                 | 数据归属与隔离                                 |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| **托管插件数据库（Managed Database）**    | 插件作为独立模块分发，需要独立的数据表与迁移记录         | 每个插件拥有隔离的命名空间，生命周期与插件绑定 |
| **应用自管数据库（Application-Private）** | 应用由统一团队维护，多个业务表需要跨表 Join 或跨模块事务 | 由宿主全局管理连接池与全局 Drizzle 实例        |

## 托管插件数据库（Managed Database）

在托管模式下，每个插件使用 Drizzle 定义自身专属的数据表，并通过 `defineDatabase()` 声明数据库定义。

### 1. 定义数据表与 Schema

在服务端模块中定义 Drizzle 表结构：

```ts twoslash
// @filename: database.ts
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { defineDatabase } from '@pluxel/services/database'

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
import { Database, type PluginDatabaseHandle } from '@pluxel/services/database'
import { BasePlugin, Plugin } from '@pluxel/core'
import { notes, NotesDatabase } from './database.ts'

@Plugin({ displayName: 'Notes' })
export class NotesPlugin extends BasePlugin {
	private database!: PluginDatabaseHandle<typeof NotesDatabase>

	protected override async init() {
		// 获取已就绪的数据库句柄
		this.database = await this.ctx.require(Database).use(NotesDatabase)
	}

	listNotes() {
		return this.database.read((db) => db.select().from(notes).orderBy(notes.createdAt))
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

- **读操作（`database.read`）**：执行常规查询，支持传入回调获取 Drizzle 查询构建器；
- **写操作与事务（`database.transaction`）**：在回调中执行插入、修改或删除。如果回调抛出异常，事务会自动回滚；
- **生命周期保护**：当插件被热重载或停止时，旧的数据库句柄会自动安全关闭，防止新旧实例同时写入冲突。

## 数据库迁移（Migration Evolution）

定义数据库时，可以通过 `evolution` 选项选择数据表的演进策略：

```ts
export const NotesDatabase = defineDatabase({
	schema: { notes },
	evolution: 'migrations', // 生产环境：使用有序迁移文件
})
```

- **`migrations`（默认）**：适用于需要保留生产数据的环境。修改 Schema 后通过 CLI 生成迁移脚本并提交至版本库；
- **`reset-on-schema-change`**：适用于本地原型探索或自动化测试环境。每次检测到 Schema 变更时自动重建数据表，无需生成迁移脚本。

<span id="应用完全自管-sql"></span>

## 应用完全自管 SQL（Application-Private）

如果你的应用是一个紧密耦合的单体系统，且多个内部插件必须执行联表查询（JOIN）或跨模块事务，建议在宿主层统一建立 Drizzle 连接，并通过常规的依赖注入将数据源服务暴露给各内部插件使用。
