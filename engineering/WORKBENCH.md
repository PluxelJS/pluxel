# Workbench Architecture

Workbench 是 optional、host-owned 的前端扩展能力，不是插件业务 API，也不拥有插件数据库生命周期。

## Management 与 Remote View 边界

`@pluxel/runtime/web` 是 framework-neutral Level 1 Management Client：先通过 version 1 discovery 取得 capability set，再按
`plugins/config/dependencies/forks/groups/logging/agentTools/logs/security` domain 调用。它不导出 root RPC stub、`withRpc`、
layout/artifact API 或虚假的 `dispose()`；每次 RPC/HTTP 调用是短生命周期请求。所有响应在 browser boundary 从 `unknown`
严格校验、clone 并 deep-freeze，unknown field、危险 key、非法 address 和超预算数据都拒绝。

官方 Workbench App 也消费这一个 client，并在 App 内维护带 TTL、in-flight dedupe 和 last-known-good 的只读 overview resource；
server state 只来自同一 management use case，不存在第二份 writable Plugin state。`@pluxel/runtime/web/react` 只提供 Management Client Context。
尚未标准化的 layout/session/artifact/grant transport 只从 `@pluxel/runtime/web/internal` 供官方 View host 使用，不能被当成第三方
兼容承诺。

Workbench Plane 与 Management Plane 分开安装。`workbench: { enabled: true }` 同时安装 management；Workbench disabled 时只有顶层
`management` object 才安装 headless management。两者都省略时没有管理 route、validation backend、catalog layout state、Workbench
backend 或 browser transport。宿主分类属于 `management.pluginGroups`；访问不再是 host config，而由 Runtime 的 physical-peer gate 与
唯一 running authentication provider 决定。未认证入口是独立 server-rendered `/__pluxel/admin-access` document，不进入 React router，
因此认证前不会启动 discovery、RPC、SSE、layout 或 remote bundle。

宿主内置的 `/agent-tools` 页面管理 runtime-owned Toolset 与 Agent assignment。页面不是 command registry，也不拥有
命令生命周期；它通过宿主 RPC 编辑持久化策略并投影当前动态 catalog。Workbench 关闭后，Agent carrier 继续使用
`ctx.root.agentTools.catalog(agentId)` 解析相同策略。

## Authoring model

| 层        | 公开入口                             | 内容                                         |
| --------- | ------------------------------------ | -------------------------------------------- |
| Contract  | `@pluxel/runtime/workbench/contract` | browser-safe RPC、live query、events、Views  |
| Extension | `@pluxel/runtime/workbench`          | Contract + server-only UI entry              |
| Binding   | `@pluxel/runtime/workbench`          | RPC factory、database query、events producer |

Contract 不包含 Plugin node address、Context、Drizzle table、provider 或 Node API。Extension 不重复 owner；
`ctx.workbench?.mount()` 从 immutable plugin Context 推导 owner，并把 registration 与 cleanup 绑定到 owner effects。
`PluginPart` Context 共享 owning Plugin 的 Workbench authority，但不能直接 mount Extension；父 Plugin 必须聚合唯一 contribution，
因此一个 Plugin node 始终只有一个 layout/grant owner。

Plugin config projection 可以包含 General 与多个 PluginPart path section。Workbench 把 section 渲染为 tabs，并把 nested
field patch 提交给同一个 Plugin node config owner；server 每次重新校验完整 composite record，revision、persistence 与 update notification
都不按 tab/Part 分裂。Workbench disabled 时 Part config validation 不创建 backend、route 或 browser state。

## Host-owned dependency selection

Workbench 的插件详情页可以投影 constructor dependency，但这不是 plugin extension。若参数 token 是未装饰的抽象
`BasePlugin`，host 从 catalog 中查找所有 `@Plugin(Token, ...)` provider，并允许选择具体实现。选择结果属于
RuntimeState；provider default 与 consumer dependency override 是不同的显式 mutation。selection 不自动启用、fallback 或改写 provider；disabled/
unavailable/incompatible target 以稳定 code 拒绝，用户必须独立 enable 可用 provider。成功 commit 会重启被修改 plugin 及其 dependent closure，
保证旧 caller-bound capability view 不会继续调用先前实现。

“创建并选择 Fork”使用一次 `ensurePluginFork` mutation，把 ensure、enable 与 stable requirement-address override 放入同一个 RuntimeState
patch；任一 admission/persistence 失败都不会留下 orphan fork。详情页为当前 requirement 的全部 fork option 提供显式删除入口；删除先拒绝
inbound override，再停止并清理 config/logging metadata，业务 persistence 不由 generic remove purge。

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
ctx.workbench?.mount(NotesWorkbench, {
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

## Remote View Pane Kit

Remote View 使用公共 Pane Kit 声明一至三栏的任务布局，不导入宿主 split 实现：

```tsx
import { WorkbenchPane, WorkbenchPaneLayout } from '@pluxel/runtime/workbench/ui'

export function Simulator() {
	return (
		<WorkbenchPaneLayout id="simulator" label="Simulator workspace">
			<WorkbenchPane
				id="scenario"
				role="navigation"
				title="Scenario"
				defaultSize={260}
				minSize={220}
			>
				<ScenarioList />
			</WorkbenchPane>
			<WorkbenchPane id="conversation" role="primary" title="Conversation" minSize={390}>
				<Conversation />
			</WorkbenchPane>
			<WorkbenchPane
				id="inspection"
				role="inspector"
				title="Inspection"
				defaultSize={300}
				minSize={248}
			>
				<Inspection />
			</WorkbenchPane>
		</WorkbenchPaneLayout>
	)
}
```

每种 role 最多一个，并且必须恰好有一个始终可见的 `primary`。其余 pane 默认可折叠，也可设
`collapsible={false}`；默认 inspector 在 medium/compact 变 drawer，navigation 只在 compact 变 drawer。
`useWorkbenchPaneLayout()` 只提供 `show/hide/toggle/reset` 和当前 `mode/activeDrawer`，不暴露 raw split handle、
router、Tab store 或 `WorkspaceController`。

宿主按 Pane Kit 容器宽度响应，一次只允许一个 drawer，并处理 Escape、scrim、focus trap 与焦点恢复。同一 pane DOM 在
宽窄切换时保持挂载，表单草稿、composer 和 resource subscription 不会丢失。Shell 的用户布局按当前原生 Tab 和 View
identity 隔离，只在用户 commit 后写入；standalone 不写宿主工作区状态。

## Host application projection

Workbench backend 安装时接收 host 已校验的 nullable product snapshot，并通过既有 runtime `/meta` read model 的
`application.product` 返回。Shell 初始化时读取该 snapshot：有值时投影 display name、publisher、copyright、legal links 与页面标题；
为 `null` 时由 UI 使用唯一的 Pluxel 默认标识。外部法律链接使用独立 navigation 与 `noopener`/`noreferrer`，所有作者字符串均按
text 渲染。

Product 不表示 verified build 或 release identity。Workbench 不从 package metadata、runtime config、application name 或发行
sidecar 推导它，也不创建 product service、额外 HTTP route、polling 或 browser registry。Workbench disabled/headless 时 backend
与该 projection 都不存在。

## Plugin catalog classification

插件目录分类属于 Management catalog layout，不进入 `@Plugin`、`PluginNodeInfo`、Extension 或 Contract。宿主通过
`management.pluginGroups[].definitions` 注册 definition family 分类；未命中宿主规则且拥有可信 `packageName` 的动态插件按精确包名自动分类。
用户只能在已注册分类与未分组区之间移动、排序插件，不能创建、重命名或删除分类。

Management plane 在 `management` namespace 持久化相对默认分类的 assignment 与排序偏好；它与 RuntimeState、Workbench
各自拥有独立状态。disabled/stopped Plugin 仍按 catalog source 分类；management 未安装时不创建分类 service 或偏好文件。宿主 exact 规则和
偏好使用结构化 definition address，目录展示的 variants 和 extension/resource owner 仍使用 node address；不使用 class/display name。
新 fork 自动继承 family 分类，同一 definition 的 variants 不能拆到不同 group。完整身份、匹配和持久化规则见
[`PLUGIN_CATALOG.md`](PLUGIN_CATALOG.md)。

## Address-keyed non-materializing read model

Management catalog layout、config、status、preference 与 Workbench bundle/artifact 查询只接收 canonical `PluginDefinitionAddress`/
`PluginNodeAddress`，内部 Map 使用 Core canonical index key。它们不保存 Core slot，也不为 read 调用 `internDefinition`/`internNode`。disabled
definition、durable disabled/orphan fork 和 invalid lookup 不会创建 Core definition/node record、Context、effects、Workbench mount 或 artifact
lease；只有 Core materialization 和 running owner 的显式 `ctx.workbench?.mount()` 可以创建对应生命周期状态。

runtime-common status overview 是 management RPC、Workbench 目录与分类的 shared projection path。每次 projection 对 pinned catalog/RuntimeState 只建立一次
enabled/fork/issue 索引，再按 address 投影 running/source facts；management/Workbench service 不得各自扫描并 intern 同一 node。持久化、跨边界 descriptor、
artifact bundle 与 directory lookup 始终按 canonical node key 索引。WorkbenchRegistry 和 dev compiler 仅可在已经 running/materialized 的 mount lease
内部持有现成 slot，用于 generation watch 与 Core graph relation；不得由 read lookup 创建 slot，并须在 owner withdrawal 时释放 slot、grant、bundle 与 lease。

Management RPC 是 untrusted transport boundary：server 方法接收 `unknown` 并验证 structured address、action、object/index/forkId/field input。status、
config、dependency/provider、fork 与 dependency query 使用封闭 discriminated union；malformed payload 返回 `invalid_input` 和明确的 `unchanged`
state，合法 empty 与 invalid query 不可混为 `[]`/`null`。public Management Client 只在这一边界解包 query union；unexpected programming/
transport exception 保持 reject，不存在 `internal_error` 或按 message 猜测 code 的 catch-all。

成功的 status、config、dependency/provider 与 fork mutation 都返回同一 address-only、deep-frozen `PluginApplyReport`。Workbench 可以按
封闭 status/code 做交互提示，但不得把 report 降级成 boolean：drain/start issue、blocked reconciliation 与 committed/unchanged facts 仍可由
调用者检查。fork metadata persistence 失败时 UI 根据 `retained | disabled-retained | unknown` 刷新并允许幂等重试。

## Plugin identity 与可读路径

Workbench 不定义自己的 Plugin ID codec。catalog DTO 同时投影 Core node `address`、可复制 `reference`、相对 `route` 和
catalog-scoped `label`；内部 Map/React key 使用 Core canonical index key。Plugin 详情和 View 路径直接嵌入 v1 route：

```text
/plugins/v1/package/OrdersPlugin/@acme/orders
/workbench/v1/fork/east/package/OrdersPlugin/@acme/orders/settings
```

route parser 返回 consumed segment count，后续 View path 不依赖 JSON segment 或 magic delimiter。browser state reader/writer
只接受 v3，并用当前 route parser 校验持久化的 Plugin/Workbench path；非法 path 丢弃，其他 snapshot version 恢复默认状态。
不提供旧 URL redirect，也不按 label、顺序或 class name 猜测。identity 规范见 [`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md)。

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
打开同一路径会跨全部 editor group 聚焦并更新原 Tab，不会复制；`title`、`meta`、Tab 归属和 editor grid 随
Workbench 状态持久化恢复。
`routeParams` 只包含当前 route 的解码后整段参数，静态 route 和非 route placement 得到空对象。

每个 editor group 的 Tab strip 在当前 Tab 后提供统一的 `+`。它创建一个沿用当前 path、title 和 meta 的宿主本地 navigation instance，
但不复制 dirty flag 或 tab-scoped state；随后点击普通导航会替换这个干净 instance，从而保留原 Tab。这个操作不进入
plugin host facade，也不改变 `navigate()` / `openTab()` 的职责边界。分组 route 和插件目录因此只提供普通导航，不为每个条目
重复渲染“在新工作标签打开”按钮；集合页打开具体业务对象仍使用显式 `host.navigation.openTab()`。

Workbench 至少有一个原生 Tab 时显示 Tab strip；单个 Tab 也可以被关闭并回到首页。普通导航遵循当前工作区的
`auto` 策略（未保存的当前 Tab 会保留并打开新 Tab）。

Tab 可以在组内拖拽排序、跨组移动，或投放到任一 editor group 的四边以创建横向/纵向递归 split；最后一个 Tab
移出或关闭后，空 group 从布局树自动收拢。拖拽和 resize 都不改变 Remote View contract，Tab catalog、dirty state、
tab-scoped state、group 归属、browser history 镜像和持久化仍由 Workspace Controller 原子管理。浏览器 URL 只镜像当前
聚焦 group 的 active Tab；host-owned document renderer 按各 Tab path 独立渲染，因此多个 pane 可以同时显示不同内置页或
Remote View。窄屏只临时最大化当前 group，并提供 group 切换入口，不卸载或改写其余布局。

Workspace Controller 由 Router 之上的 App 根 Provider 持有，不由会随 route tree 重建的 Shell 或 route provider 持有。持久化 v4
使用 `tabs + editor.groups + editor.layout`，每个 Tab 恰好属于一个 group，每个 layout leaf 恰好引用一个 group；v3 的扁平 Tab
状态恢复为单 group，而不是丢弃用户文档。`openTab()` 必须先原子写入
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
- events producer cleanup 在 owner withdrawal 与 browser disconnect 交错时至多执行一次；detached channel 标记为 closed，
  迟到 send/emit 被丢弃；
- rollback 重新 mount 并签发新 lease，不复活旧 lease；
- disabled Workbench 不安装 Context capability，不执行 query、不订阅 outbox，也不创建 browser cache、route 或 transport；
- active variants、rows 与 serialized bytes 受 server quota 限制；idle variant 按 LRU 回收，并发 invalidation 合并重跑；
- RPC、live query、events、bundle 和 Port 错误进入明确状态或 View error boundary。

## Host route ownership

`workbench.uiBasePath` 定义 shell 的浏览器 navigation 边界，默认 `/` 以保持专用 Workbench host 的现有行为。需要同时
提供业务 Dashboard 的宿主选择非根绝对路径；dynamic/static Vite middleware 只在该路径及其子路径接管 HTML，浏览器
router 从服务端 HTML meta 读取同一 base path。packaged shell 的 JS/CSS 使用 runtime 固定的 `/dist/public/` asset
namespace；Workbench disabled 时 route middleware 不接管该 namespace。输入在 runtime 信任边界统一规范化并拒绝 URL
authority、query、hash、反斜杠、NUL 与解码后的 dot segment，避免 route ownership 与文件解析产生歧义。

## Static distribution capability

`variant: 'workbench'` 决定 distribution 是否携带 shell/remotes；application `configure()` 返回的 `workbench`
决定本次启动是否安装 Plane。`variant: 'headless'` 不能在启动时提升。Workbench 关闭不影响数据库、业务 HTTP、
ConfigService 或插件运行时启停。
