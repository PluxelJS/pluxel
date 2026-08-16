# 数据库 ownership

Pluxel 管理的 plugin database 只使用 PostgreSQL 语义与 Drizzle。宿主未配置数据库时使用持久 PGlite；显式远端配置时
切换到真正 PostgreSQL，同一份 plugin schema、migration 和 query 不写 driver 分支。static application 也可以完全不使用
这项 capability，由普通 application module 统一拥有数据库。

先判断数据属于谁：

| 数据所有者                                       | 标准组织方式                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| 可独立发布、安装和替换的 plugin                  | `defineDatabase()` + `ctx.database.use()`，每个 owner 独立实例   |
| 同一作者控制的 static application 与全部内置插件 | 单独的 application database module，统一 schema、pool、migration |

后者不是“共享 plugin database”。它完全不使用 `ctx.database`，也不要求把连接或 migration 包装成 Plugin；代价是消费它的
插件成为该 application 的内部模块，不再具有独立的数据可移植性。

## 定义 schema

```ts
// database.ts — server only
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

export const database = defineDatabase({ schema: { notes } })
```

使用普通 `pgTable()`，不要使用 `pgSchema()`、plugin name prefix、`public.` 或 physical schema。schema module 是
server-only，Workbench contract 和 UI 都不能导入它。插件 package 直接依赖与 Pluxel 支持范围一致的 `drizzle-orm`，
不依赖 `pg`、PGlite 或其他 driver。

## 取得 owner-bound handle

```ts
private db!: PluginDatabaseHandle<typeof database>

override async init() {
	this.db = await this.ctx.database.use(database)
}

listNotes() {
	return this.db.read((db) => db.select().from(notes).orderBy(notes.createdAt))
}

createNote(title: string) {
	return this.db.transaction(async (tx) => {
		const [note] = await tx.insert(notes).values({ title }).returning()
		return note
	})
}
```

所有写入都放在 `transaction()`。callback 内是标准 Drizzle database/transaction；不要缓存 callback 参数、row lock，
也不要在 transaction 内等待网络或用户交互。一个 plugin 只能 `use()` 一个 definition；definition 可以作为 schema 模板
由多个 plugin 复用，但每次 `use()` 都绑定当前 plugin 的独立数据、role 与 operation queue，不能共享 handle 或 transaction。
跨 plugin workflow 通过 typed capability/RPC，并接受它是两个 transaction；真正必须原子的表归同一 owner。

## 选择 schema evolution

默认 `evolution: 'migrations'` 用于必须保留的权威数据。在定义所在 package 根目录运行：

```sh
pluxel database generate --name add-notes
pluxel database check
pluxel build
```

提交整个 `drizzle/`，包括 SQL、`meta/` 和 `pluxel-migrations.json`。已经提交的 SQL 不可重写；schema 变化总是生成
下一条 migration。production startup 只应用 checked artifact，不执行 push 或根据当前 schema 猜 DDL。

如果插件明确决定完全放弃旧结构和 migration history，使用新的 lineage：

```sh
pluxel database rebase --lineage 2026-v2 --name initial
pluxel database check
```

该命令在 staging 生成当前 schema 的全新 baseline，成功后才替换本地 `drizzle/`。部署时 runtime 创建新的隔离 database
instance，migration 全部成功后原子激活；旧 instance 与数据归档保留，新写入只进入新 instance。不要手工修改 lineage，
也不要把临时权限、锁或 SQL 错误当作 rebase 信号。

缓存、搜索索引、同步副本等可丢弃或可重新生成的数据可以免维护 migration history：

```ts
export const database = defineDatabase({
	schema: { notes },
	evolution: 'reset-on-schema-change',
})
```

这种定义只运行 `pluxel build`，不要创建或提交 `drizzle/`。构建器自动从当前 schema 生成 baseline；相同 schema 保留现有
数据，table、column、index 或 constraint 改变时创建空的 candidate instance，准备成功后原子替换 active instance 并归档
旧数据。该声明表示今后的任意 schema 变化都允许清空数据；需要保留或转换旧数据时必须使用默认 migration 策略。

Document 风格数据可以在稳定的 `id`、`version`、`jsonb data` 表中自行兼容多个 document version；JSON 字段变化不要求
SQL migration，但新增物理 index、constraint 或 column 仍属于 schema 变化。

插件测试使用 `@pluxel/test/vitest` preset。它会对 database declaration 运行与开发/生产相同的 artifact
transform：migration 策略读取并校验已提交历史，reset 策略生成临时 baseline。不要在测试里调用 internal helper 或手工构造
artifact；这样测试才能覆盖作者实际发布的 schema 与 evolution policy。

## Static application 共享数据库

当 fixed catalog、schema 和部署都由同一作者维护时，把 schema、Drizzle client、repositories 与 migration 放进普通的
`@app/database` package。最自然的入口是无参数 lazy `use()`：static application 中所有插件解析到同一个 ESM module，module-scoped
Promise 就是共享实例；第一个调用负责打开连接并执行一次 migration，并发调用直接复用。不要在 module import 时创建 pool，
也不要把 pool 绑定到第一个调用它的 Plugin effects，否则该 owner generation drain/HMR 会提前关闭全局数据库。

```ts
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

`openAndMigrate()` 由 application package 自己读取宿主配置、创建唯一 pool、构造 Drizzle 并运行统一 migration；业务插件不读取
连接字符串，也不各自调用 migrate：

```ts
import { useAppDatabase } from '@app/database'

override async init() {
	this.db = await useAppDatabase()
}
```

不要求把数据库放进 `defineStaticRuntime().prepare()`。lazy `use()` 让没有启用数据库插件的启动不创建 pool。如果数据库是整个
应用的 readiness 前提，`prepare()` 可以调用同一个入口做 eager preflight，不需要传 Context：

```ts
export default defineStaticRuntime({
	name: 'billing-app',
	plugins: [AccountsPlugin, BillingPlugin],
	async prepare() {
		await useAppDatabase()
	},
})
```

`closeAppDatabase()` 同样属于 application/deployment 或 test teardown，不由任一业务 plugin 调用。当前 static host 若希望把它
挂到 root shutdown，可以在可选 `prepare({ host })` 中只登记 `host.ctx.effects.defer(closeAppDatabase)`；自定义 platform
bootstrap 也可以在自己的 `finally` 中关闭。这项生命周期接线不改变插件侧无参数 `use()`。

两种方式的 schema、migration 和 cleanup owner 完全相同，区别只有失败时机：lazy 模式只阻止实际依赖数据库的 plugin，eager
模式在任何 plugin 启动前阻止整个 application。需要跨插件 join、foreign key 或原子 transaction 时使用 application-owned
database；需要独立安装、HMR lineage、Workbench `liveQuery` 和 per-plugin 隔离时使用前面的 plugin database。

## Workbench 实时读取

Contract 用 Standard Schema 描述 params/row，并选择稳定、唯一的 string/number key；server binding 提供相同 owner 的
database handle、完整 `dependsOn` 和显式 DTO query。UI 调用 `useQuery(params)`；写入仍调用 typed RPC，必要时在 RPC
返回后 `await resource.refresh()` 立即读取 committed state。详见维护者架构对应的作者示例和现有 workspace 插件。

## PGlite 与生产

PGlite 适合零配置开发、demo 和本机运行，但在 filesystem flush/fault-injection 保证完成前不要把它当作生产级掉电
durable 数据库。生产部署显式配置 PostgreSQL，并在真实 PG 环境测试 row lock、deadlock、pool exhaustion、连接中断和
并发 migration。数据库连接字符串、TLS、pool 与 data directory 是宿主 startup policy，不是 plugin config。
