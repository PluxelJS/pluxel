# Workbench Architecture

Workbench 是 optional、host-owned 的前端扩展能力，不是插件业务 API，也不拥有插件数据库生命周期。

## Authoring model

| 层        | 公开入口                             | 内容                                         |
| --------- | ------------------------------------ | -------------------------------------------- |
| Contract  | `@pluxel/runtime/workbench/contract` | browser-safe RPC、live query、events、Views  |
| Extension | `@pluxel/runtime/workbench`          | Contract + server-only UI entry              |
| Binding   | `@pluxel/runtime/workbench`          | RPC factory、database query、events producer |

Contract 不包含 plugin ID、Context、Drizzle table、provider 或 Node API。Extension 不重复 owner；
`ctx.workbench.mount()` 从 immutable plugin Context 推导 owner，并把 registration 与 cleanup 绑定到 owner effects。

## Host-owned dependency selection

Workbench 的插件详情页可以投影 constructor dependency，但这不是 plugin extension。若参数 token 是未装饰的抽象
`BasePlugin`，host 从 catalog 中查找所有 `@Plugin(Token, ...)` provider，并允许选择具体实现。选择结果属于
RuntimeState；host 启用目标 provider、应用 runtime dependency override 并 commit graph。commit 会重启被修改 plugin
及其 dependent closure，保证旧 caller-bound capability view 不会继续调用先前实现。

因此 memory/Redis backend、不同数据库 provider 或应用自定义 capability provider 不需要各自注册管理 UI。关闭
Workbench 后，static/dynamic/headless host 仍通过同一 constructor dependency 与 runtime state 完成选择。

```ts
export const NotesUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<NotesCommands>(),
		notes: workbenchContract.liveQuery({
			params: v.object({ search: v.optional(v.string()) }),
			row: v.object({ id: v.string(), title: v.string(), createdAt: v.string() }),
			key: 'id',
		}),
	},
	views: {},
})
```

服务端 Binding 显式声明 database owner、依赖表和查询。查询只返回 contract DTO；Date、BigInt、Buffer、
Drizzle row 等 server value 必须先投影成可序列化数据。

```ts
ctx.workbench.mount(NotesWorkbench, {
	commands: workbench.bind.rpc(() => new NotesRpc(this)),
	notes: workbench.bind.liveQuery({
		database: this.db,
		dependsOn: [notes],
		query: async (db, params) => {
			const rows = await db.select().from(notes).orderBy(notes.createdAt)
			return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
		},
	}),
})
```

`dependsOn` 必须完整，且只能包含同一 database definition 的 table。写操作不进入 `liveQuery`；浏览器 mutation
始终调用 typed RPC，RPC 在 server transaction commit 后返回。

## Browser facade

```tsx
const ui = createWorkbenchUi(NotesUi)

export function Overview() {
	const { commands, notes } = ui.useResources()
	const result = notes.useQuery({ search: '' })
	// loading | ready | stale | error
}
```

facade 同时提供 `getSnapshot()`、`subscribe()` 和 `refresh()`。每组 canonical params 拥有独立 lease、generation
和 revision。snapshot/patch 都经过 Standard Schema 校验；stable key 重复、revision gap、generation mismatch 或
patch 校验失败会重新取得完整 snapshot。query 失败保留 last-known-good rows 并进入 `stale`。

服务端在依赖表 transaction commit 后重跑完整 query，以 stable key 生成 `upserted`、`removed` 和完整 `order`。
完整 order 保证仅排序变化或分页窗口成员变化仍能正确重建结果。并发 invalidation 会合并，不把 SQL、table identity、
commit token 或 outbox revision 暴露给浏览器。

## Route navigation groups

多个独立插件的 route 属于同一运维领域时，可在 `workbenchContract.route()` 的
`navigation.group` 中声明稳定 group ID、标题和图标。宿主把它们折叠为一个一级活动入口，
并在当前分组内渲染二级导航；子项和默认入口都沿用 route `order`。分组只影响宿主布局，
不合并 route owner、resource grant 或 bundle；插件停止或撤销 mount 后，对应子项随 global layout 自动移除。

## Cross-plugin UI

Port 是跨插件 UI resource 注入的唯一路径。provider 声明无 placement renderer，并在 UI 中调用
`ui.usePort(Port)`。consumer resources 与 Port 一对一同名时使用 `workbench.portOutlet()` 只声明 Port 和
placement；需要重命名、组合或部分映射时使用显式 `workbenchContract.define({ outlets })`。一个 View 需要多个
owner 的数据时组合多个获授权 resource snapshot，不建立跨插件 SQL join。

## Security and lifecycle

- transport 只接受 opaque grant，不接受 plugin/resource namespace；
- owner stop/replacement 撤销 database query subscription 和 resource grant；
- rollback 重新 mount 并签发新 lease，不复活旧 lease；
- disabled Workbench 不执行 query、不订阅 outbox，也不创建 browser cache、route 或 transport；
- active variants、rows 与 serialized bytes 受 server quota 限制；idle variant 按 LRU 回收，并发 invalidation 合并重跑；
- RPC、live query、events、bundle 和 Port 错误进入明确状态或 View error boundary。

## Static distribution capability

`variant: 'workbench'` 决定 distribution 是否携带 shell/remotes；application `configure()` 返回的 `workbench`
决定本次启动是否安装 Plane。`variant: 'headless'` 不能在启动时提升。Workbench 关闭不影响数据库、业务 HTTP、
ConfigService 或插件运行时启停。
