---
title: 数据库与数据归属
description: 根据数据归属选择 Plugin 数据库或应用数据库，并管理 Drizzle schema 与迁移。
---

先判断数据是否必须跟随 Plugin 独立安装、替换和迁移，再选择数据库组织方式。不要仅因为代码写在 Plugin class 中，就默认使用 `ctx.database`。

| 数据与生命周期要求                                             | 正确组织方式                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Plugin 可以独立发布、安装或替换，数据也属于这个 Plugin         | `defineDatabase()` + `ctx.require(Database).use()`，每个 Plugin 使用独立实例 |
| 需要 Plugin 独立 lineage 或旧 generation handle 撤销           | `defineDatabase()` + `ctx.require(Database).use()`                           |
| fixed catalog、schema 和部署由同一个应用团队控制               | application-private database package                                         |
| 没有共享数据库，整个应用 就无法成立                            | host `prepare()` + root-bound typed accessor                                 |
| 只有部分内置 Plugin 依赖共享数据库，其他 Plugin 应继续运行     | application-private provider Plugin + constructor dependency                 |
| 多个内置 Plugin 的表必须 join、使用 foreign key 或共享原子事务 | application-private database package                                         |

Managed Plugin database 统一使用 PostgreSQL dialect 和 Drizzle。Plugin 作者只依赖 `drizzle-orm`，不选择 driver；部署宿主在 native PostgreSQL 与 PGlite 之间选择，同一份 schema、migration 和 query 不编写 driver 分支。

Application-private database 由应用自行选择 PostgreSQL、SQLite、ORM 和 migration 方案。它不是“多个 Plugin 共用一份 Plugin database”：使用它的 Plugin 是应用内部模块，不再拥有独立的数据可移植性，也不会自动获得 Pluxel 的 per-plugin lineage、隔离、旧 handle 撤销或 owner-scoped invalidation。

发布与否只是常见线索，不是最终判断。私有 Plugin 如果仍要被独立启停、替换并保留自己的数据，应该使用 managed database；公开 Plugin 如果不拥有结构化数据，则不需要数据库。

## Managed Plugin database

选择 managed database 后，正式部署使用 native PostgreSQL；本机开发和测试使用 PGlite。两者的能力与验证边界见[backend 选择](../host/configuration.md#选择-native-postgresql-或-pglite)。

宿主通过 `database({ backend: pglite(...) })` 或 `database({ backend: postgres(...) })` 显式安装；默认服务组合不安装数据库，见 [宿主配置](../host/configuration.md)。插件包安装 `drizzle-orm`，driver 由宿主提供。下面的 schema 与插件文件放在同一个插件包内。

## 定义 Plugin schema

```ts twoslash
// @filename: database.ts
// 仅服务端
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

使用普通 `pgTable()`。不要使用 `pgSchema()`、Plugin name prefix、`public.` 或 physical schema；owner isolation 由 database instance 和 runtime namespace 管理。

schema module 是 server-only。Workbench API/browser bundle 不能导入它。Plugin package 依赖受支持的 `drizzle-orm`，不依赖 `pg`、PGlite 或其他 driver。

`defineDatabase()` 必须作为 module-level `const` 的直接 initializer，显式 `evolution` 必须写在直接 object literal 中。不要把它包进 function、branch 或 config factory；compiler 必须静态看到 package 唯一的 definition，才能注入对应 artifact。

`use()` 在返回前完成 active instance 选择和 migration prepare。handle 绑定当前 Plugin owner/generation，stop/replacement 后旧 handle 失效。

读操作放进 `read()`，写操作放进完整 `transaction()` callback。callback 内是标准 Drizzle database/transaction；不要缓存 callback 参数或 row lock，也不要在 transaction 中等待网络、用户交互或 worker task。

一个 Plugin 只能 `use()` 一个 definition。definition 可以作为 schema 模板由多个 Plugin 复用，但每个 owner 都有独立数据、role 和 operation queue；不能跨 Plugin 共享 handle 或 transaction。

`PluginPart` 也不拥有第二个 definition；它的表和 migration 都归属根 Plugin 的这一个 definition。Part 只帮助组织代码和资源，不创造新的数据边界。

## Migration evolution

每个 definition 只走一条表演进流程；不要在两者之间混用 artifact 或命令：

| `evolution`              | 改表后的作者动作                                           | repository 中的 artifact                                    |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `migrations`（默认）     | 修改 schema → `generate --name` → `check` → 提交 → `build` | 提交 `drizzle/`；history 只能追加                           |
| `reset-on-schema-change` | 修改 schema → `build`/测试                                 | 不创建 `drizzle/`；`generate`、`check`、`rebase` 会明确拒绝 |

### 保留权威数据

默认 `evolution: 'migrations'`。在 definition 所在 package root 运行：

```sh
pluxel database generate --name add-notes
pluxel database check
pluxel build
```

提交整个 `drizzle/`，包括 SQL、`meta/` 和 `pluxel-migrations.json`。已经提交的 SQL 不可重写；schema 变化生成下一条 migration。

production startup 只应用 build 时检查过的 artifact，不执行 schema push，也不根据当前 TypeScript schema 临时猜 DDL。
普通 `pgTable()` 之间生成的外键在插件独立 schema 内解析；生成器不会把指向本插件表的引用固定到 PostgreSQL 的 `public` schema。显式声明的其他 schema 引用不会被改写。

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

这种 definition 只运行 `pluxel build`，不创建或提交 `drizzle/`；`generate`、`check`、`rebase` 会明确拒绝它。构建器从当前 schema 生成 baseline：相同 schema 保留数据，table/column/index/constraint 改变时建立空 candidate，准备成功后替换 active instance 并归档旧数据。

这个声明意味着未来任何 schema 变化都允许清空数据。需要保留或转换旧数据时必须使用 migrations。

## 跨 Plugin 数据关系与扩展

独立发布的 Plugin 不能修改另一个 Plugin 的表模型：不要向其 `pgTable()` 加列、生成 `ALTER TABLE`、添加 foreign key/index，也不要把对方 table object 当作自己的 schema import。表结构和 migration 是 owner 可独立替换的存储 contract；允许第三方修改会把安装顺序、卸载、rebase 和 rollback 耦合在一起。

| 需求                                                                                | 正确做法                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 为另一个 Plugin 的实体保存本 Plugin 专属数据                                        | extension Plugin 自己拥有表，以 provider 公开的稳定 entity ID 关联，并通过 typed capability 验证或操作该实体 |
| 需要 join、foreign key、跨表原子 transaction，或 provider 必须直接查询/索引扩展字段 | 将整组表放进同一 application-private database，由同一个应用团队迁移                                          |
| 需要可插拔的自定义字段                                                              | provider 只在存在具体产品需求时发布自己的领域 extension protocol；不要增加通用“改别人表”的能力               |

第一种方式的两个写入是两个 transaction；需要一致性时，extension 应设计可重试、幂等的领域流程，而不是绕过 owner boundary。若这个代价不能接受，说明这些表本来就不应是独立 Plugin 数据。

不要通过猜测 physical schema、连接字符串或 owner prefix 跨界读另一个 Plugin 的表。Workbench target 也只能调用所属 Plugin 的领域 service，再返回 detached DTO；它不是跨 owner 数据库入口。

## Document 风格数据

可以在稳定的 `id`、`version`、`jsonb data` 表中兼容多个 document version。JSON 字段内部变化不一定需要 SQL migration，但新增物理 index、constraint 或 column 仍是 schema evolution。

如果数据只是少量加密 JSON 且不需要 query/index，先评估 [Vault](./vault.md)；不要为一个 token 建完整关系表，也不要拿 Vault documents 替代需要查询的数据库。

## 在 Workbench 中读取数据库状态

Workbench 不提供数据库专用查询协议。Plugin 在自己的 Direct View API 中返回 bounded browser-safe snapshot，
需要更新时公开普通 `watch(invalidate)` capability；查询、分页、DTO 投影和 mutation 都留在 Plugin service/target：

```ts no-twoslash
interface NotesApi extends RpcTarget {
	listDto(input: { cursor: string | null; limit: number }): Promise<NotesPage>
	updateDto(input: UpdateNoteInput): Promise<UpdateNoteResult>
	watch(invalidate: () => void): RpcTarget
}
```

Target 内部可以使用 owner-bound database handle，但不能把 handle、Drizzle row 或 transaction 暴露给 browser。DTO
显式转换 `Date`、`BigInt`、Buffer 等 server values，并限制 rows/bytes。Mutation commit 后由 Plugin 自己触发 invalidation；
Workbench 不解析 table identity，也不成为 database lifecycle owner。完整用法见 [插件管理界面](../workbench/index.md)。

## 测试与发布检查

`@pluxel/test/vitest` 会对 database declaration 运行与开发/生产相同的 artifact transform：migration strategy 校验已提交 history，reset strategy 生成临时 baseline。

日常测试使用 `memory://` PGlite；部署门禁增加真实 PostgreSQL integration suite。PGlite 覆盖语义与生命周期，native PostgreSQL suite 覆盖并发、锁、连接池和故障行为。

至少验证：

- first startup 与 restart；
- read/transaction callback；
- migration failure 阻止 Plugin running；
- required dependent 被 blocked、无关 Plugin 继续；
- stop/replacement 后旧 handle 失效；
- package artifact 包含 `dist/database/migrations/` 的 checked SQL/manifest。

不要在测试里调用 internal helper 或手工构造 migration artifact，否则测试没有覆盖作者真正发布的 schema。

应用共享数据库的装配见[Application-private database](../host/configuration.md#application-private-database)；后端、连接池与部署验证见[Host backend 选择](../host/configuration.md#选择-native-postgresql-或-pglite)。
