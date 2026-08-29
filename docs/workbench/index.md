---
title: 管理工作台
description: 为 Plugin 提供可关闭、可撤销，并由宿主管理访问权限的管理界面。
---

Workbench 是由宿主管理的可选管理界面。Plugin 声明浏览器安全的 Contract、服务端 Extension 和绑定业务实现的 Binding；宿主决定是否启用 Workbench，以及它的访问策略、页面布局和静态资源服务方式。

这三层分别回答“浏览器可以调用什么”“Plugin 提供哪些页面与资源”和“请求最终由谁处理”。拆开后，Plugin 停止或被替换时，界面入口和调用能力也能一起撤销。

需要试验配置 schema 时使用独立的[配置 Playground](/playground)；普通文档只展示稳定的代码和渲染结果。

```text
Contract（browser-safe protocol）
   ↓ referenced by
Extension（server declaration + browser entry）
   ↓ bound in Plugin Context
Binding（RPC / events / live query implementation）
   ↓ mount
Workbench host（layout / grants / transport / lifecycle）
```

## 查看 Plugin 依赖与影响范围

宿主启用 Workbench 后，Plugin 详情页以当前 Plugin 为中心，把关系分成“必须依赖”“可选集成”和“被依赖”。必须依赖决定当前
Plugin 能否启动；可选集成不阻塞启动，但 provider 进入、离开或替换当前有效图时，当前 generation 仍会由 Core 重新建立。
每行只显示对端 Plugin 的 `displayName`；缺失、未解析、未生效、停止等需要处理的状态留作紧凑标记，正常运行与直接解析不重复占用空间。
“被依赖”标题汇总当前生效与尚未生效的 incoming relation，并在同一列表中用“必须 / 可选”区分类型。完整 canonical identity
保留在悬停提示和依赖图定位链接中；缺少 status node 时以 requirement export name 代替展示名，只有存在 status node 的对端才可进入
Plugin 详情。

存在多个兼容实现、抽象 provider 或当前节点覆盖时，“必须依赖”行内直接提供实现选择。“跟随默认”是显式选项，不是不可修改的结果；
选择具体实现只覆盖当前 Plugin，重新选择“跟随默认”会清除该覆盖。候选项只在详情区域实际显示时读取，不会扩大依赖图 snapshot。
当前 Plugin 若本身可以提供抽象依赖，另以“提供方默认”设置供其他 consumer 跟随的全局默认，两种方向不会混在同一个控件中。

详情页把三类状态严格分开：

- “自动启动”是持久策略，只决定宿主下次启动时是否主动运行 Plugin；修改它不会偷偷启动或停止当前进程中的 generation；
- “启动 / 停止 / 重启”是本次进程的运行操作，不改自动启动策略；宿主重启后，本次运行意图会清空；
- “运行中 / 已停止”是 Runtime 提交后的只读事实。操作进行中只显示协调状态，不会在响应前乐观伪造运行结果。

Runtime 会在同一 coordinator 中保存本次进程意图，因此 HMR、配置变化和依赖切换不会把明确停止的 Plugin 意外拉起。启动 consumer
会为本次进程自动激活它的 required provider closure，但不会替 provider 打开自动启动；明确停止 provider 会阻断并停止依赖它的
consumer。关闭自动启动不会停止当前 generation，停止当前 generation 也不会关闭自动启动。自动启动策略与本次运行状态因而可以独立审计。
Headless 管理客户端使用 `client.plugins.setAutoStart()` 修改持久策略，使用 `client.plugins.applyLifecycleCommands()` 执行本次进程的
`start | stop | restart`；两者都返回协调后的 control snapshot 与同一结构化 apply report。

内置“依赖图”页面位于 `/plugin-graph`，提供两个视图：

- “有效图”只显示当前 committed graph 的 node 和 edge；没有可见关系的 Plugin 通过画布中的数量入口按需查看；
- “声明关系”同时显示未请求运行、unavailable、尚未生效的关系，以及缺失 provider/未解析 requirement 的空心占位节点。

关系图方向固定为 provider → consumer，便于沿箭头查看 downstream 影响。只对存在 edge 的连通分量执行分层布局，彼此无关的
关系组独立排布；没有可见 incoming/outgoing relation 的 Plugin 不参与缩放，避免少量真实关系因孤立状态节点而不可读。Required 使用实线，Optional 使用虚线；未生效关系降低
透明度，协调问题同时显示图标和边框，不能只靠颜色判断。自动启动关闭、当前停止和代码不可用是彼此独立的事实；页面不会把停止状态
猜成失败。可按 Plugin 名称或 canonical reference 搜索，切换 Required/Optional filter，点击 node/edge 在不压缩关系图的浮层中查看
inspector，并从有 status 的 endpoint 返回 Plugin 详情。关系组按二维画布宽高比紧凑排布，默认完整适配；拖动画布平移、滚轮以指针
位置为中心缩放，方向键平移，`0` 或适应按钮恢复全图。选择 node/edge 后只突出直接相关的 endpoint 和 relation，降低无关关系的视觉
权重；当前筛选未显示的 Plugin 不常驻占用画布高度，而是在与 inspector 互斥的浮层中按状态优先级查看和搜索。关系图是只读审计视图，
不提供节点拖动、手动连线或图编辑能力。

依赖 snapshot 按需加载。刷新失败但已有成功数据时，页面保留 last-known-good 并显示 stale 提示；没有任何 snapshot 时显示错误页，
可手动重试。Headless 管理界面或自定义 browser client 也可通过 `RuntimeManagementClient.dependencies.graph()` 取得同一只读 snapshot；
provider selection、fork、自动启动策略与本次生命周期操作继续使用各自的 Management mutation，不通过 graph snapshot 修改。

## 最小完整路径

### 四个文件边界

```text
browser-contracts.ts  RPC、DTO、event payload type
workbench-contract.ts resources、views、placements、Port
plugin.ts             Extension、Binding 和业务实现
ui/index.tsx          browser client 与 React Views
```

Contract module 只能依赖 browser-safe type/schema 和 `@pluxel/runtime/workbench/contract`。它不能导入 Plugin implementation、database schema、Node builtin、secret 或 server SDK。

下面的单个 Twoslash block 用四个 virtual file 展示完整最小路径：Contract、Extension、Binding 和 browser View 一起检查。生产项目仍按同样边界拆成真实文件。

```tsx twoslash
// @filename: browser-contracts.ts
export interface OrdersCommands {
	refresh(): Promise<{ accepted: true }>
	close(orderId: string): Promise<void>
}

export type OrderEvents = {
	refreshed: { at: number }
}

// @filename: workbench-contract.ts
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { OrderEvents, OrdersCommands } from './browser-contracts.ts'

export const OrdersUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<OrdersCommands>(),
		activity: workbenchContract.events<OrderEvents>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.route('/orders', {
					title: 'Orders',
					icon: workbenchContract.icons.Receipt,
					order: 40,
				}),
			],
		},
	},
})

// @filename: plugin.ts
import { RpcTarget } from 'capnweb'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { OrdersUi } from './workbench-contract.ts'
import type { OrdersCommands, OrderEvents } from './browser-contracts.ts'

class OrdersRpc extends RpcTarget implements OrdersCommands {
	constructor(private readonly plugin: OrdersPlugin) {
		super()
	}

	refresh() {
		return this.plugin.refresh()
	}

	close(orderId: string) {
		return this.plugin.close(orderId)
	}
}

const OrdersWorkbench = workbench.extension({
	contract: OrdersUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	refresh(): { accepted: true } {
		return { accepted: true }
	}

	close(_orderId: string): void {}

	protected override init() {
		this.ctx.workbench?.mount(OrdersWorkbench, {
			commands: workbench.bind.rpc(() => new OrdersRpc(this)),
			activity: workbench.bind.events<OrderEvents>(({ emit }) => {
				const timer = setInterval(() => emit('refreshed', { at: Date.now() }), 30_000)
				return () => clearInterval(timer)
			}),
		})
	}
}

// @filename: ui/index.tsx
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { OrdersUi } from '../workbench-contract.ts'

const ui = createWorkbenchUi(OrdersUi)

function Overview() {
	const { commands, activity } = ui.useResources()
	const connection = activity.useConnectionState()

	return (
		<section>
			<p>Events: {connection.state}</p>
			<button onClick={() => commands.refresh()}>Refresh</button>
		</section>
	)
}

export default ui.define({ Overview })
```

Contract 只描述 browser-safe resource shape 和 View placement；Extension 只声明 browser entry；Binding 在 Plugin Context 中绑定 owner；`ui.define()` 精确实现远端 View。Workbench disabled 时不会执行 RPC factory 或 event producer。

#### Resource 选择

| Resource                           | 用途                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `rpc<T>()`                         | mutation、命令式读取和显式 action                    |
| `liveQuery({ params?, row, key })` | database-derived、可增量刷新的 row snapshot          |
| `events<TEvents>()`                | server push event stream，不保存 authoritative state |

RPC generic 引用独立 browser-safe interface，不引用实现 class。这个 generic 只生成浏览器与服务端之间的 TypeScript 方法类型；运行时 Contract 只记录 resource kind，不携带参数或结果 schema。opaque grant、host access 和 Contract fingerprint 控制资源访问，RPC 方法仍必须自行校验不可信输入并执行领域权限检查。

`workbench.entry()` 必须使用 module URL 和 literal relative path，build pipeline 才能提取并生成 browser remote。Extension 不写 owner address；owner 从最终 `ctx.workbench?.mount()` 的 Context 推导。`liveQuery` 需要 database handle、完整 `dependsOn` 和显式 browser DTO；下面的 Resource contract 章节给出该变体。

## Resource contract

### RPC

前面的 `browser-contracts.ts` 已定义 `OrdersCommands`。server implementation 可以持有 Plugin capability，但只暴露 interface 中的方法：

```ts no-twoslash
import { RpcTarget } from 'capnweb'
import * as v from 'valibot'

const OrderId = v.pipe(v.string(), v.minLength(1))

class OrdersRpc extends RpcTarget implements OrdersCommands {
	constructor(private readonly plugin: OrdersPlugin) {}

	async refresh() {
		await this.plugin.refresh()
		return { accepted: true as const }
	}

	close(orderId: string) {
		return this.plugin.closeOrder(v.parse(OrderId, orderId))
	}
}
```

`workbenchContract.rpc<T>()` 不会在运行时验证 `T`。浏览器传入的每个值都应视为不可信数据；RPC 方法使用 Valibot、其他 Standard Schema 或等价逻辑显式校验，再执行领域授权。参数和结果还必须能由 Cap'n Web transport 序列化，不能返回 Plugin、Context、Error object、database handle 或 native object。

### Live query

browser `useQuery(params?)` 返回：

- `loading`：尚无 snapshot；
- `ready`：当前 rows 可用；
- `stale`：仍有旧 rows，但 refresh/stream 出错；
- `error`：没有可用 snapshot。

UI 不应在 `stale` 时清空已有数据。mutation 完成后可以：

```ts no-twoslash
await commands.close(orderId)
await orders.refresh()
```

key 必须是 row 中稳定唯一的 string/number field。params 与 row 都使用 Standard Schema 验证。

### Events

event resource 适合通知、progress 和 transient activity，不是 authoritative store。订阅：

```tsx no-twoslash
useEffect(() => {
	return activity.subscribe('refreshed', ({ at }) => {
		console.log('refreshed', at)
	})
}, [activity])
```

producer 获得 abort signal，owner stop、grant revoke 或 browser disconnect 时必须结束。不要保存无界 event history；需要恢复/查询的状态写入 database，再通过 live query 读取。

## 高级 UI 组合

### Typed Port：跨 Plugin UI

Provider 提供 renderer，consumer 决定 placement。先定义 Port：

```ts no-twoslash
export const FetchSettingsPort = workbenchContract.port({
	id: 'fetch.settings',
	version: 1,
	resources: {
		settings: workbenchContract.rpc<FetchSettingsCommands>(),
	},
})
```

consumer 放置 outlet：

```ts no-twoslash
const ConsumerWorkbench = workbench.portOutlet({
	id: 'FetchSettings',
	port: FetchSettingsPort,
	placement: workbenchContract.tab({ label: 'Fetch' }),
})

this.ctx.workbench?.mount(ConsumerWorkbench, {
	settings: workbench.bind.rpc(() => new FetchSettingsRpc(this)),
})
```

provider Contract 接受 Port：

```ts no-twoslash
export const FetchUi = workbenchContract.define({
	views: {
		FetchSettings: {
			accepts: FetchSettingsPort,
		},
	},
})
```

renderer 中使用：

```tsx no-twoslash
const ui = createWorkbenchUi(FetchUi)

function FetchSettings() {
	const { settings } = ui.usePort(FetchSettingsPort)
	return <FetchSettingsForm commands={settings} />
}

export default ui.define({ FetchSettings })
```

renderer 从 consumer committed direct required dependencies 中按 Port ID + exact version 唯一解析。零个 renderer 显示 unavailable，多个显示 ambiguity；不按注册顺序猜测。

Provider stop/replacement 会立即撤销旧 grant。Provider 不能决定 consumer placement，也不能隐式投影自己的完整 resource namespace。

### Route 与 native tabs

参数化 route 必须从导航隐藏：

```ts no-twoslash
Account: {
	placements: [
		workbenchContract.route('/accounts/:accountId', {
			title: 'Account',
			navigation: false,
		}),
	],
}
```

Shell View 可以通过 `useWorkbenchHost()` 使用 navigation：

```tsx no-twoslash
const host = useWorkbenchHost()

host.navigation?.openTab({
	path: '/accounts/notifications',
	title: 'notifications',
	meta: 'Bot',
})
```

普通页面切换使用 `navigate(path)`；只有独立业务对象才 `openTab()`。standalone View 的 navigation 是 `null`。route 只能指向当前 Workbench target 已注册路径，不能导航任意宿主 URL。

Shell 的中央 editor 支持递归拆分。用户可以拖拽 Tab 在当前组排序、移到其他组，或投放到编辑区四边创建新 split；空组会自动
收拢。每个 pane 独立渲染自己的 Tab path 和 tab-scoped state，地址栏只跟随当前聚焦 pane。`openTab()` 的完整路径 identity
仍在整个 workspace 内唯一，因此同一业务文档已在其他 pane 打开时会直接聚焦原 Tab，而不会创建冲突副本。插件不需要也不能
感知 group、拖拽或底层 Worksplit。

### Pane layout

需要 navigation/primary/inspector 三栏时使用宿主 Pane Kit，不自行安装 Worksplit 或维护第二套 breakpoint/localStorage：

```tsx no-twoslash
import { WorkbenchPane, WorkbenchPaneLayout } from '@pluxel/runtime/workbench/ui'

function OrdersWorkspace() {
	return (
		<WorkbenchPaneLayout id="orders" label="Orders workspace">
			<WorkbenchPane id="list" role="navigation" title="Orders" defaultSize={252}>
				<OrderList />
			</WorkbenchPane>
			<WorkbenchPane id="editor" role="primary" title="Editor" minSize={420}>
				<OrderEditor />
			</WorkbenchPane>
			<WorkbenchPane id="details" role="inspector" title="Details" defaultSize={320}>
				<OrderDetails />
			</WorkbenchPane>
		</WorkbenchPaneLayout>
	)
}
```

响应式变化由容器宽度驱动，并保持 pane 内容 mounted。每种 role 最多一个，且必须有一个 primary。

## 生命周期与测试

### Disabled 与 replacement 语义

`workbench: false` 或省略配置表示零 backend 初始化：不创建 registry、compiler、watcher、route、transport 或 UI persistence。启用时只使用 `{ enabled: true, ... }`，不保留另一种 disabled object。

Workbench disabled 时 `ctx.workbench` 不存在，`ctx.workbench?.mount()` 会跳过调用和 bindings 参数求值。Plugin
不先判断 enabled 再执行一套不同业务逻辑，也不会为 disabled Plane 创建 null service。

Management Plane 与 Remote View Plane 分离。`@pluxel/runtime/web` 的 framework-neutral client 可以发现 runtime、查询和变更 Plugin/config/dependency/fork/group/logging/agent/security；它不加载 React、Mantine、layout、artifact 或 Workbench session。UI 需要把未知 RPC failure 投影成人类可读文案时可使用 `rpcErrorMessage(error, fallback)`；它只选择 `Error.message`、string 或 fallback，不提供可分支的稳定错误码。Workbench enabled 时自动安装 management；headless host 通过顶层 `management` object 单独安装，两个字段都省略时没有管理 route。宿主 Plugin 分类配置在 `management.pluginGroups`；访问由物理 loopback recovery 和唯一 running authentication provider 决定。未认证入口使用独立的 `/__pluxel/admin-access` server document，因此不会在认证前加载 Workbench shell、RPC、SSE 或 remote bundle。

HMR replacement 会撤销旧 layout binding、RPC factory、events/live query 和 grant，再以新 generation mount。浏览器只能访问当前 target 获得的 opaque grant，不能按 Plugin namespace 读取其他 resource。events producer 的 cleanup 由 owner 撤销和浏览器断连共享同一资源归属路径；两者交错时 cleanup 只执行一次，detached channel 的迟到 send/emit 会被忽略。

### Artifact 与测试

`pluxel build` 从 literal `workbench.entry()` 生成独立 browser remote；server package 不把 UI code 混进 Node entry。

至少测试：

- Contract module browser-safe；
- disabled host 下 Plugin 核心能力正常；
- mount 在 running 后出现，stop/replacement 后撤销；
- RPC 方法显式校验不可信参数，并覆盖不可序列化或非法输入；
- liveQuery params/rows 通过 Contract 中的 Standard Schema；
- events disconnect/abort 能停止 producer；
- Port 零/一/多 renderer 行为；
- production build 生成 remote artifact。
