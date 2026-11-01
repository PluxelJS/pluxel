---
title: 插件状态
description: 在每个 Plugin node 的原生 TinyBase Store 中保存偏好与有界业务记录。
---

用户偏好、开关和小型结构化业务记录使用 Host 托管的 TinyBase。部署配置继续用 [`configs.use()`](./configuration.md)，凭据用 [Vault](./vault.md)，文件和二进制用 [FS](./fs.md)。大量记录、复杂 SQL 或多进程事务使用 [SQL 数据库](./database.md)，可选择 Services 托管或应用完全自管。

每个 Core 与 Host 都内建 FS 和 TinyBase；插件直接使用固定的 `ctx.tinybase`，无需安装服务。[后端选择](../host/configuration.md#选择文件后端)决定是否跨 Host 保留数据。插件不选择存储目录、driver 或持久策略。

## 打开并使用原生 Store

以下是完整的 Plugin 示例。初始化失败沿现有 init 失败路径传播；Store 连接和关闭排空由 Host 管理：

```ts twoslash
// @filename: preferences.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { createStore, type Store } from 'tinybase'
import * as v from 'valibot'

const Preference = v.object({ theme: v.picklist(['system', 'light', 'dark']) })

@Plugin()
export class PreferencesPlugin extends BasePlugin {
	private readonly state = this.ctx.tinybase
	private store!: Store

	protected override async init(): Promise<void> {
		this.store = await this.state.open(createStore().setValues({ theme: 'system' }))
		v.parse(Preference, this.store.getValues())
	}

	getTheme() {
		return v.parse(Preference, this.store.getValues()).theme
	}

	async setTheme(input: unknown): Promise<void> {
		const preference = v.parse(Preference, input)
		this.store.setValue('theme', preference.theme)
		await this.state.flush()
	}
}
```

`open()` 不传参数时由 Core 创建普通 Store；传入时返回同一 native 实例。也可在 open 前使用原生 `setTablesSchema()`、`setValuesSchema()` 或 [Valibot schematizer](https://tinybase.org/api/schematizers/schematizer-valibot/) 配置 schema。Valibot 仍从上游直接导入，不需要第二套 Pluxel 校验接口。

open 完成前不使用或公开该 Store；成功后创建原生 Queries/listeners，并在 `ctx.effects` 中登记相应 `destroy()` 或 `delListener()`。不要给托管 Store 添加 Persister 或 Synchronizer。原生临时 Store 不需交给 Host。

每个 Plugin node 一份 Store，Part 共用 owning Plugin 的实例；fork 的数据独立。重复或并发 open 共用恢复结果，同代换入另一 Store 明确失败。实例必须新建且无已挂载监听或未结束事务，不可跨 Host/generation 重用；不接受 MergeableStore。

## 初值、保存与确认

只有快照不存在时才使用初值；已有快照替换全部 Tables/Values，合法空状态也会保留。恢复会检查格式、owner、内容和原生 schema 的保真结果；损坏或 schema 丢失字段时初始化失败，源文件不被重写。业务领域校验在 open 后、公开能力前完成。

原生 mutation 同步改变内存和订阅。Host 在 Plugin 成功发布后自动保存完整 transaction，停止时排空。初始化失败不自动写回候选；init 内显式 `await state.flush()` 则是真实提交，即使随后 init 失败也不会撤销。

需要向调用者确认保存时，await `flush()` 并传播失败。它等待调用时最后一个完整事务被后端确认，可与更新快照合并；不保证每个中间状态落盘，也不回滚已经可见的内存 mutation。未 open、未结束事务、已故障或已撤回时拒绝。没有持久确认承诺的同步方法可使用普通 mutation，由 Host autosave 与关闭排空。

如果领域要求“保存前不可见”，在领域内部区分 candidate 与 applied view，并串行执行保存及发布；不能把同步 native Store 当作提交后才可见的事务。Wretch 的[管理设置](../plugins/wretch.md)使用这条契约。

## 失败、容量与依赖

快照只接受 string、boolean 和有限 number；嵌套记录可由领域编码为 string，不能把任意对象直接作为 cell。Host 默认每份完整快照最多 8 MiB，可通过 Host 的 `config.tinybase.maxSnapshotBytes` 调整。超限或 IO 错误可从 `flush()`、启动和关闭报告观察，Host 内部诊断可查询 owner、revision 与失败状态。

快照和 writer 失败使用公开的 `TinyBaseError`，例如 `SNAPSHOT_INVALID`、`BUDGET_EXCEEDED` 与 `SAVE_FAILED`；底层失败保留在 `cause`。插件的 Valibot 领域校验仍抛原生校验异常，不把无效数据改成默认值。

保存失败后 writer 阻断后续保存，不在 shutdown 隐式重试。内存仍可能包含候选，后端结果也可能未知；调用方应保留失败状态，由 Host 停止并显式恢复 writer，再启动新代。FS 后端只读时无法打开托管 Store；InMemory 只能确认内存写入。停止不会删除已有数据。

Core 持有精确的 `tinybase` runtime dependency；应用直接使用原生 TinyBase 时声明自己的 dependency。使用共享 Store 的插件声明同版 peer 与 devDependency；原生能力始终从 `tinybase` 或其子路径导入。只声明 `configs.use()` 的插件无需再打开 Store 或添加 TinyBase 依赖。[版本与打包约束](../development/plugin-package.md)包含实际版本接纳规则。

## 隔离验证

将上面的插件保存为 `preferences.ts`。测试通过真实 `createTestHost()` 使用默认内存后端，结束时释放 Host：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { PreferencesPlugin } from './preferences'

await using host = await createTestHost()
const preferences = await host.start(PreferencesPlugin)
await preferences.setTheme({ theme: 'dark' })
```

跨 Host 恢复测试使用同一临时 Passthrough 目录，关闭第一个 Host 后再创建第二个，分别检查内容、合法空状态和失败不覆盖。隔离 Host 不证明在线应用已接纳修改；在线操作使用[开发控制台](../development/dev-console.md)。
