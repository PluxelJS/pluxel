---
title: 数据库与数据归属
description: 根据数据归属选择 Plugin 数据库或应用数据库，并管理 Drizzle schema 与迁移。
---

# 数据库与数据归属

Pluxel 的数据库能力统一使用 PostgreSQL 语义和 Drizzle。宿主没有配置远端 PostgreSQL 时可以使用持久化 PGlite；同一份 schema、迁移和查询不需要为不同驱动编写分支。

先回答“数据属于谁”：

| 数据所有者                           | 标准组织方式                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| 可独立发布、安装和替换的 Plugin      | `defineDatabase()` + `ctx.database.use()`，每个 Plugin 使用独立实例 |
| 同一团队控制的静态应用与全部内置模块 | 应用私有数据库模块，统一管理 schema、连接池和迁移                   |

应用数据库不是“多个 Plugin 共用一份 Plugin 数据库”。使用它的 Plugin 会成为该应用的内部模块，不再拥有独立的数据可移植性。

## 定义 Plugin schema

```ts twoslash
// @filename: database.ts
// server only
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { defineDatabase } from '@pluxel/runtime/database'

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
import type { PluginDatabaseHandle } from '@pluxel/runtime/database'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { notes, NotesDatabase } from './database.ts'

@Plugin({ displayName: 'Notes' })
export class NotesPlugin extends BasePlugin {
	private database!: PluginDatabaseHandle<typeof NotesDatabase>

	override async init() {
		this.database = await this.ctx.database.use(NotesDatabase)
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

使用普通 `pgTable()`。不要使用 `pgSchema()`、Plugin name prefix、`public.` 或 physical schema；owner isolation 由 database instance 和 runtime namespace 管理。

schema module 是 server-only。Workbench contract/browser bundle 不能导入它。Plugin package 依赖受支持的 `drizzle-orm`，不依赖 `pg`、PGlite 或其他 driver。

同一个 Twoslash block 同时验证 schema definition、相对 import、handle 泛型和 query/transaction 的返回类型。`use()` 在返回前完成 active instance 选择和 migration prepare。handle 绑定当前 Plugin owner/generation，stop/replacement 后旧 handle 失效。

读操作放进 `read()`，写操作放进完整 `transaction()` callback。callback 内是标准 Drizzle database/transaction；不要缓存 callback 参数或 row lock，也不要在 transaction 中等待网络、用户交互或 worker task。

一个 Plugin 只能 `use()` 一个 definition。definition 可以作为 schema 模板由多个 Plugin 复用，但每个 owner 都有独立数据、role 和 operation queue；不能跨 Plugin 共享 handle 或 transaction。

## 跨 Plugin 数据关系

跨 Plugin workflow 通过 typed capability/RPC，并接受它是两个 transaction。真正必须满足 foreign key、join 或原子 transaction 的表应该归同一 owner。

不要通过猜测 physical schema、连接字符串或 owner prefix 跨界读另一个 Plugin 的表。Workbench live query 同样会验证 database handle 与 tables 属于同一个 owner。

## Migration evolution

### 保留权威数据

默认 `evolution: 'migrations'`。在 definition 所在 package root 运行：

```sh
pluxel database generate --name add-notes
pluxel database check
pluxel build
```

提交整个 `drizzle/`，包括 SQL、`meta/` 和 `pluxel-migrations.json`。已经提交的 SQL 不可重写；schema 变化生成下一条 migration。

production startup 只应用 build 时检查过的 artifact，不执行 schema push，也不根据当前 TypeScript schema 临时猜 DDL。

### 明确重建 lineage

如果产品明确放弃旧结构和 history，生成新 lineage：

```sh
pluxel database rebase --lineage 2026-v2 --name initial
pluxel database check
```

命令在 staging 生成当前 schema 的全新 baseline，成功后才替换本地 `drizzle/`。部署时 runtime 创建隔离 candidate instance，全部 migration 成功后原子激活；旧 instance 与数据归档保留。

不要手工修改 lineage，也不要把临时权限、锁、连接中断或 SQL error 当作 rebase 信号。

### 可丢弃数据自动 reset

缓存、搜索索引和可重新生成的同步副本可以声明：

```ts no-twoslash
export const SearchDatabase = defineDatabase({
	schema: { documents },
	evolution: 'reset-on-schema-change',
})
```

这种 definition 只运行 `pluxel build`，不创建或提交 `drizzle/`。构建器从当前 schema 生成 baseline：相同 schema 保留数据，table/column/index/constraint 改变时建立空 candidate，准备成功后替换 active instance 并归档旧数据。

这个声明意味着未来任何 schema 变化都允许清空数据。需要保留或转换旧数据时必须使用 migrations。

## Document 风格数据

可以在稳定的 `id`、`version`、`jsonb data` 表中兼容多个 document version。JSON 字段内部变化不一定需要 SQL migration，但新增物理 index、constraint 或 column 仍是 schema evolution。

如果数据只是少量加密 JSON 且不需要 query/index，先评估 [Vault](./vault.md)；不要为一个 token 建完整关系表，也不要拿 Vault documents 替代需要查询的数据库。

## Static application database

当 fixed catalog、schema 和部署都由同一作者维护时，把 schema、Drizzle client、repositories 与 migration 放进普通 application-private package，例如 `@app/database`。

自然入口是无参数 lazy `use()`：

```ts no-twoslash
// @app/database — application-private server module
import { openAndMigrate, type AppDatabase } from './internal.js'

let active: Promise<AppDatabase> | undefined

export function useAppDatabase(): Promise<AppDatabase> {
	if (active) return active
	const task = openAndMigrate()
	active = task
	void task.catch(() => {
		if (active === task) active = undefined
	})
	return task
}

export async function closeAppDatabase(): Promise<void> {
	const task = active
	active = undefined
	if (!task) return
	const database = await task.catch(() => undefined)
	await database?.close()
}
```

业务 Plugin 只消费 application module，不各自读取 DSN 或 migrate：

```ts no-twoslash
override async init() {
	this.database = await useAppDatabase()
}
```

不要在 module import 时创建 pool，也不要把全局 pool 绑定第一个调用它的 Plugin effects，否则该 Plugin replacement 会关闭其他 consumer 的数据库。

如果数据库是整个应用的 readiness 前提，static runtime `prepare()` 可以 eager 调同一个 `useAppDatabase()`；否则保持 lazy，只阻止真正依赖数据库的 Plugin。`closeAppDatabase()` 属于 application/deployment teardown。

## Workbench live query

Workbench contract 用 Standard Schema 描述 params/row，并选择稳定唯一的 string/number key。server binding 提供同 owner database handle、完整 `dependsOn` 和显式 DTO query：

```ts no-twoslash
notes: workbench.bind.liveQuery({
	database: this.database,
	dependsOn: [notes],
	query: (db) => db.select({ id: notes.id, title: notes.title }).from(notes),
})
```

mutation 仍走 typed RPC；query 只返回 browser-safe DTO。完整 Contract/Binding 边界见 [管理工作台](../workbench/index.md)。

## PGlite 与生产 PostgreSQL

PGlite 适合零配置开发、demo 和本机运行。生产部署应显式配置 PostgreSQL，并在真实 PG 环境验证 row lock、deadlock、pool exhaustion、连接中断和并发 migration。

连接字符串、TLS、pool 与 data directory 是 host startup policy，不是 Plugin config。Plugin schema/query 不根据 driver 分支。

## 测试与发布检查

`@pluxel/test/vitest` 会对 database declaration 运行与开发/生产相同的 artifact transform：migration strategy 校验已提交 history，reset strategy 生成临时 baseline。

至少验证：

- first startup 与 restart；
- read/transaction callback；
- migration failure 阻止 Plugin running；
- required dependent 被 blocked、无关 Plugin 继续；
- stop/replacement 后旧 handle 失效；
- package artifact 包含 `dist/database/migrations/` 的 checked SQL/manifest。

不要在测试里调用 internal helper 或手工构造 migration artifact，否则测试没有覆盖作者真正发布的 schema。
