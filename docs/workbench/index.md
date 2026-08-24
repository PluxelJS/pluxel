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

	override init() {
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

Management Plane 与 Remote View Plane 分离。`@pluxel/runtime/web` 的 framework-neutral client 可以发现 runtime、查询和变更 Plugin/config/dependency/fork/group/logging/agent/security；它不加载 React、Mantine、layout、artifact 或 Workbench session。UI 需要把未知 RPC failure 投影成人类可读文案时可使用 `rpcErrorMessage(error, fallback)`；它只选择 `Error.message`、string 或 fallback，不提供可分支的稳定错误码。Workbench enabled 时 management 自动以 private policy 安装；headless host 通过顶层 `management` object 单独安装，两个字段都省略时没有管理 route。访问策略与宿主 Plugin 分类分别配置在 `management.access`、`management.pluginGroups`。

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
