# Workbench Architecture

Workbench 是 optional、host-owned 的前端扩展能力，不是插件业务 API，也不拥有插件数据库生命周期。

宿主内置的 `/agent-tools` 页面管理 runtime-owned Toolset 与 Agent assignment。页面不是 command registry，也不拥有
命令生命周期；它通过宿主 RPC 编辑持久化策略并投影当前动态 catalog。Workbench 关闭后，Agent carrier 继续使用
`ctx.root.agentTools.catalog(agentId)` 解析相同策略。

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

`useResources()` / `usePort()` 返回普通冻结 record。安全边界是服务端 layout 下发的 opaque grant，而不是会观察任意
属性读取的 Proxy；未提供的属性遵循 JavaScript 语义返回 `undefined`，使 React、DevTools、序列化器和检查器可以安全反射。

服务端在依赖表 transaction commit 后重跑完整 query，以 stable key 生成 `upserted`、`removed` 和完整 `order`。
完整 order 保证仅排序变化或分页窗口成员变化仍能正确重建结果。并发 invalidation 会合并，不把 SQL、table identity、
commit token 或 outbox revision 暴露给浏览器。

Remote View 的运行环境由当前 target snapshot 显式注入，包含 opaque grants、locale、theme、dialog 和受限 host
commands；它不读取全局 Extension context。浏览器 host 直接索引服务端 layout，不再把 placement 转换进第二套 registry。
catalog、module、route 和 contribution 因而共享同一个 revision 与清理所有者。

## Host application projection

Workbench backend 安装时接收 host 已校验的 nullable product snapshot，并通过既有 runtime `/meta` read model 的
`application.product` 返回。Shell 初始化时读取该 snapshot：有值时投影 display name、publisher、copyright、legal links 与页面标题；
为 `null` 时由 UI 使用唯一的 Pluxel 默认标识。外部法律链接使用独立 navigation 与 `noopener`/`noreferrer`，所有作者字符串均按
text 渲染。

Product 不表示 verified build 或 release identity。Workbench 不从 package metadata、runtime config、application name 或发行
sidecar 推导它，也不创建 product service、额外 HTTP route、polling 或 browser registry。Workbench disabled/headless 时 backend
与该 projection 都不存在。

## Plugin catalog classification

插件目录分类属于 Workbench host layout，不进入 `@Plugin`、PluginInfo、Extension 或 Contract。宿主通过
`workbench.pluginGroups` 注册产品分类；未命中宿主规则且拥有可信 `packageName` 的动态插件按精确包名自动分类。
用户只能在已注册分类与未分组区之间移动、排序插件，不能创建、重命名或删除分类。

Workbench backend 持久化相对默认分类的 assignment 与排序偏好，不再把完整开放式 group 写进 RuntimeState。
disabled/stopped plugin 仍按 catalog source 分类；Workbench disabled 时不创建分类 service 或偏好文件。完整身份、匹配、
冲突和迁移规则见 [`PLUGIN_CATALOG.md`](PLUGIN_CATALOG.md)。

## Route navigation groups

多个独立插件的 route 属于同一运维领域时，可在 `workbenchContract.route()` 的
`navigation.group` 中声明稳定 group ID、标题和图标。宿主把它们折叠为一个一级活动入口，
并在当前分组内渲染二级导航；子项和默认入口都沿用 route `order`。分组只影响宿主布局，
不合并 route owner、resource grant 或 bundle；插件停止或撤销 mount 后，对应子项随 global layout 自动移除。

## Native document tabs

需要从集合页打开多个独立工作对象时，Contract 使用整段参数声明非导航 route：

```ts
workbenchContract.route('/accounts/:accountId', {
	title: 'Account',
	navigation: false,
})
```

参数名必须是字母开头的 ASCII identifier，同一路径不能重复；参数化 route 必须显式设置
`navigation: false`，不能成为静态导航入口。精确 route 优先于参数化 route，宿主会拒绝两个能匹配
同一路径的参数化模式，避免插件注册顺序改变结果。

Remote View 通过 host facade 导航当前 target 已注册的 shell route，并读取当前 route 参数。普通页面切换使用
`navigate()`；只有需要保留当前页面的独立业务文档才使用 `openTab()`：

```tsx
const host = useWorkbenchHost()
const navigation = host.navigation
if (!navigation) return null

navigation.navigate('/settings')

navigation.openTab({
	path: '/accounts/notifications',
	title: 'notifications',
	meta: 'Telegram Bot',
})

const accountId = host.routeParams.accountId
```

两种操作的 path 都是插件相对路径，不是任意宿主 URL。`host.navigation` 只在 shell 中可用，standalone View 得到
`null`；宿主只接受当前 target route table 中的 shell route，未注册路径会失败，`openTab()` 还会拒绝空标题。`navigate()` 使用当前 Tab，并遵循 dirty-state
自动保留策略。规范化后的完整宿主路径是 `openTab()` document target 的唯一 identity：再次
打开同一路径会聚焦并更新原 Tab，不会复制；`title`、`meta` 和 Tab 集合随 Workbench 状态持久化恢复。
`routeParams` 只包含当前 route 的解码后整段参数，静态 route 和非 route placement 得到空对象。

Tab strip 在当前 Tab 后提供统一的 `+`。它创建一个沿用当前 path、title 和 meta 的宿主本地 navigation instance，
但不复制 dirty flag 或 tab-scoped state；随后点击普通导航会替换这个干净 instance，从而保留原 Tab。这个操作不进入
plugin host facade，也不改变 `navigate()` / `openTab()` 的职责边界。分组 route 和插件目录因此只提供普通导航，不为每个条目
重复渲染“在新工作标签打开”按钮；集合页打开具体业务对象仍使用显式 `host.navigation.openTab()`。

Workbench 至少有一个原生 Tab 时显示 Tab strip；单个 Tab 也可以被关闭并回到首页。普通导航遵循当前工作区的
`auto` 策略（未保存的当前 Tab 会保留并打开新 Tab）。

Workspace Controller 由 Router 之上的 App 根 Provider 持有，不由会随 route tree 重建的 Shell 或 route provider 持有。`openTab()` 必须先原子写入
document tab 和 navigation intent，route commit 再在同一 Controller 中消费 intent；连续 navigation intent 按提交顺序消费，
命中已有 document instance 时只聚焦，不把它重写成普通 navigation instance。

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
