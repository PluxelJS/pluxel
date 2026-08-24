---
title: 数据库与数据归属
description: 根据数据归属选择 Plugin 数据库或应用数据库，并管理 Drizzle schema 与迁移。
---

先判断数据是否必须跟随 Plugin 独立安装、替换和迁移，再选择数据库组织方式。不要仅因为代码写在 Plugin class 中，就默认使用 `ctx.database`。

| 数据与生命周期要求                                                   | 正确组织方式                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Plugin 可以独立发布、安装或替换，数据也属于这个 Plugin               | `defineDatabase()` + `ctx.database.use()`，每个 Plugin 使用独立实例 |
| 需要 Plugin 独立 lineage、旧 generation handle 撤销或 Workbench 查询 | `defineDatabase()` + `ctx.database.use()`                           |
| fixed catalog、schema 和部署由同一个应用团队控制                     | application-private database package                                |
| 没有共享数据库，整个 static application 就无法成立                   | host `prepare()` + root-bound typed accessor                        |
| 只有部分内置 Plugin 依赖共享数据库，其他 Plugin 应继续运行           | application-private provider Plugin + constructor dependency        |
| 多个内置 Plugin 的表必须 join、使用 foreign key 或共享原子事务       | application-private database package                                |

Managed Plugin database 统一使用 PostgreSQL dialect 和 Drizzle。Plugin 作者只依赖 `drizzle-orm`，不选择 driver；部署宿主在 native PostgreSQL 与 PGlite 之间选择，同一份 schema、migration 和 query 不编写 driver 分支。

Application-private database 由应用自行选择 PostgreSQL、SQLite、ORM 和 migration 方案。它不是“多个 Plugin 共用一份 Plugin database”：使用它的 Plugin 是应用内部模块，不再拥有独立的数据可移植性，也不会自动获得 Pluxel 的 per-plugin lineage、隔离、旧 handle 撤销或 `liveQuery`。

发布与否只是常见线索，不是最终判断。私有 Plugin 如果仍要被独立启停、替换并保留自己的数据，应该使用 managed database；公开 Plugin 如果不拥有结构化数据，则不需要数据库。

## Managed Plugin database

选择 managed database 后，正式部署使用 native PostgreSQL；PGlite 用于本地开发、自动化测试、demo 和简单低负载运行。两者统一的是 PostgreSQL 作者 contract，不是性能、并发和 durability 等价。

## 定义 Plugin schema

```ts twoslash
// @filename: database.ts
// 仅服务端
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

## Application-private database

当 fixed catalog、schema 和部署都由同一团队维护时，把 schema、client、repositories、migration 和 connection lifecycle 放进普通 application-private package，例如 `@app/database`。这个 package 自己声明 ORM 和 driver dependency；不要只把依赖安装在 workspace root，再让子包隐式使用。

Static application 应在 `configure()` 返回 `database: false`，使误用 `ctx.database` 的内置 Plugin 直接启动失败；production freezer 同时设置 `managedDatabaseDrivers: []`，避免把未使用的 PGlite 与 `pg` package 复制进发行物。两处配置分别约束运行时 capability 与构建闭包，必须保持一致。

内置 Plugin 优先消费 repository 或 application service。只有确实需要构造查询时才暴露 ORM client；不要让每个 Plugin 各自读取 DSN、创建 pool 或运行 migration。

### 整个应用依赖数据库

如果没有数据库，整个 static application 就没有可运行的核心功能，数据库是 host-owned root resource：static `prepare()` 必须在 Plugin graph 启动前完成连接、migration 和必要 preflight；失败直接终止本次 host startup。成功实例按 root Context 绑定，关闭登记到 root effects，不能归属任一 consumer Plugin。

Application package 导出接收 Context 的 typed accessor，不把数据库投影成 `ctx.database`，也不使用进程级 module singleton：

```ts no-twoslash
// @app/database — application-private server module
import type { Context } from '@pluxel/runtime'
import { openDatabase, migrate, type AppDatabase, type DatabaseOptions } from './internal.js'

const active = new WeakMap<object, AppDatabase>()

export async function prepareAppDatabase(ctx: Context, options: DatabaseOptions): Promise<void> {
	const root = ctx.root
	if (active.has(root)) return
	const database = await openDatabase(options)

	try {
		await migrate(database)
		active.set(root, database)
		root.effects.defer(
			async () => {
				if (active.get(root) === database) active.delete(root)
				await database.close()
			},
			{ tag: 'AppDatabase', phase: 'shutdown' },
		)
	} catch (error) {
		if (active.get(root) === database) active.delete(root)
		await database.close()
		throw error
	}
}

export function appDatabaseFor(ctx: Context): AppDatabase {
	const database = active.get(ctx.root)
	if (!database) throw new Error('Application database has not been prepared')
	return database
}
```

`appDatabaseFor(ctx)` 的参数既保留 root 隔离和完整返回类型，也在调用点诚实表达 application-private dependency。不要用 declaration merging 增加 `ctx.appDatabase`；static application 的泛型不能反向改变独立编译 Plugin 的 Context shape。

Static entry 对部署路径保持唯一 authority，同时供 Runtime persistence 和 application database 使用：

```ts no-twoslash
import { resolve } from 'node:path'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { prepareAppDatabase } from '@app/database'

function storagePaths({ env, deployment }) {
	const root = resolve(env.APP_DATA_ROOT ?? `${deployment?.root ?? '.'}/data`)
	return {
		runtimePersistence: resolve(root, 'runtime'),
		applicationDatabase: resolve(root, 'application.sqlite'),
	}
}

export default defineStaticRuntime({
	name: 'application',
	plugins: [BillingPlugin, AuditPlugin],
	configure(startup) {
		return {
			persistence: storagePaths(startup).runtimePersistence,
			database: false,
		}
	},
	async prepare({ host, startup }) {
		await prepareAppDatabase(host.ctx, {
			filename: storagePaths(startup).applicationDatabase,
		})
	},
})
```

Plugin 在 `init()` 或之后同步取得已准备实例：

```ts no-twoslash
override init() {
	this.database = appDatabaseFor(this.ctx)
}
```

不要读取已移除的 `ctx.config.persistence`，也不要从 `ctx.root.persistence` 猜 filesystem path。前者会把 host config 泄露给 Plugin；后者是 `namespace/get/put` 操作抽象，backend 可能是 memory、readonly 或 custom，并不保证存在 SQLite 可以打开的目录。SQLite path、DSN、TLS 和 pool options 都从 static `startup` 的 env、bindings 或 deployment facts 解析。

`prepare()` 不是通用 service lifecycle：这里只表达“数据库是整个应用的硬 readiness 前提”。数据库 package 负责领域初始化，root effects 负责 acquisition rollback、正常 stop 和 shutdown；consumer replacement 不能关闭共享实例。

### 只有部分 Plugin 依赖数据库

如果数据库失败时无关 Plugin 仍应运行，把数据库建模为 application-private provider Plugin，并让 consumer 通过 constructor 声明 required dependency。provider 在 `init()` 打开和迁移数据库，并立即把关闭登记到自己的 effects；provider failure 只阻塞 dependents。不要同时保留 root `prepare()` 和 provider Plugin 两套所有权。

这条路径可以使用 SQLite 或其他数据库，但应用必须自行负责 migration 并发、连接恢复、备份、durability 和 shutdown。不要把 application client 包装成 `ctx.database`，否则会让调用者误以为它具备 managed Plugin database 的 owner isolation 与 replacement 语义。

## Managed database 的 Workbench live query

`liveQuery` 只接受 managed Plugin database handle。Workbench contract 用 Standard Schema 描述 params/row，并选择稳定唯一的 string/number key。server binding 提供同 owner database handle、完整 `dependsOn` 和显式 DTO query：

```ts no-twoslash
notes: workbench.bind.liveQuery({
	database: this.database,
	dependsOn: [notes],
	query: (db) => db.select({ id: notes.id, title: notes.title }).from(notes),
})
```

mutation 仍走 typed RPC；query 只返回 browser-safe DTO。完整 Contract/Binding 边界见 [管理工作台](../workbench/index.md)。

## 选择 native PostgreSQL 或 PGlite

| 部署或验证目标                                   | Backend                |
| ------------------------------------------------ | ---------------------- |
| 正式部署、持续负载或多个 Plugin 频繁访问数据库   | native PostgreSQL      |
| 本地开发、自动化测试、demo、简单低负载的单机运行 | PGlite                 |
| row lock、deadlock、pool exhaustion、连接中断    | 必须验证 native PG     |
| 多进程并发 migration、advisory lock 和故障恢复   | 必须验证 native PG     |
| throughput、latency、容量规划或生产硬件性能验收  | 必须使用目标 native PG |

PGlite 是执行真实 PostgreSQL 语义的本地 backend，不是 query mock；它适合快速验证 schema、migration、CRUD、owner isolation 和 Plugin lifecycle。但是 Pluxel 会把共享 PGlite 上的所有 database operation 串行调度，因此一个 host 中的 Plugin 会共同受到单连接吞吐上限影响。不要用 PGlite benchmark 推断 native PostgreSQL 性能。

在 filesystem flush 与 fault-injection 验收完成前，不把 PGlite 作为 production durability baseline。资源受限但仍需正式部署时，优先在目标设备上调低 native PostgreSQL connection/pool budget 并实测，而不是假设 PGlite 更快或更可靠。真正无法承载 native PostgreSQL 的设备，需要把整个 Node host、存储和故障模型一起重新评估。

连接字符串、TLS、pool 与 PGlite data directory 是 host startup policy，不是 Plugin config。Plugin schema/query 不根据 backend 分支。

## 测试与发布检查

`@pluxel/test/vitest` 会对 database declaration 运行与开发/生产相同的 artifact transform：migration strategy 校验已提交 history，reset strategy 生成临时 baseline。

日常测试可以使用 `memory://` PGlite；生产门禁增加真实 PostgreSQL integration suite。PGlite 覆盖语义与生命周期，native PostgreSQL suite 覆盖并发、锁、连接池和故障行为。

至少验证：

- first startup 与 restart；
- read/transaction callback；
- migration failure 阻止 Plugin running；
- required dependent 被 blocked、无关 Plugin 继续；
- stop/replacement 后旧 handle 失效；
- package artifact 包含 `dist/database/migrations/` 的 checked SQL/manifest。

不要在测试里调用 internal helper 或手工构造 migration artifact，否则测试没有覆盖作者真正发布的 schema。
