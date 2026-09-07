---
title: 编写 React 管理页面
description: 从一个可读取、可刷新的页面开始，再按需添加分页和实时订阅。
---

需要自定义布局、分页或 React 组件时，使用 View。Plugin 提供服务端 API 和 React 页面，Workbench 负责登录与打开、关闭页面。
如果只有状态和几个按钮，先用更短的 [Content](./content.md)。

开始前，宿主应已启用 Workbench，Plugin 能正常启动。下面分为四份文件：页面声明、服务端实现、查询声明和 React 入口。
`RpcTarget` 是可以由页面调用的服务端对象；`scope` 将 React 组件与它对应的页面 API 关联。

## 默认路径：snapshot + mutation

将 browser-safe DTO、API 和静态 definition 放进 `src/workbench.ts`：

```ts
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export type OrdersSnapshot = Readonly<{
	revision: number
	openOrders: number
}>

export interface OrdersApi extends RpcTarget {
	snapshot(): Promise<OrdersSnapshot>
	refresh(): Promise<void>
}

export const OrdersWorkbench = workbench.define({
	overview: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.tab({ label: 'Orders', order: 20 }),
	}),
})
```

Definition 是固定 flat record。entry key 是稳定 declaration identity；`workbench.entry()` 的路径必须是相对当前 module 的 literal。
不要按 item、principal 或运行时状态增删 entry。

接着在 `src/OrdersPlugin.ts` 提供服务端实现。这个最小例子用内存计数，实际项目把读取和刷新替换为自己的业务方法：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { OrdersWorkbench, type OrdersApi } from './workbench.ts'

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	private revision = 0

	protected override init() {
		this.ctx.workbench?.publish(OrdersWorkbench, {
			overview: () => new OrdersTarget(this),
		})
	}

	async snapshot() {
		return { revision: this.revision, openOrders: 0 }
	}

	async refresh() {
		this.revision += 1
	}
}

class OrdersTarget extends RpcTarget implements OrdersApi {
	constructor(private readonly orders: OrdersPlugin) {
		super()
	}
	snapshot() {
		return this.orders.snapshot()
	}
	refresh() {
		return this.orders.refresh()
	}
}
```

每次打开都创建一个新的 `OrdersTarget`。如果真实页面要按用户授权、按路由加载对象或持有订阅，
从 factory 参数取得 `principal`、`params`、`signal`，在这里检查权限并在关闭时清理资源。
此例没有订阅或长任务，因此不需要额外的空 disposer。

`RpcTarget` 是 Cap’n Web 的能力对象，不归 Workbench 所有。同一份 browser-safe API contract 和 target class 可以用
`createLocalRpcClient()` 独立测试，也可在确有 CLI 或其他客户端需求时由另一条明确拥有的 Cap’n Web session 挂载。
复用的是 contract、target class 和底层领域 service，不是已经打开的 target 实例：每个 session/open 都必须创建 fresh
target，并由新的挂载方自己提供认证、授权、输入预算、取消和释放语义，不能假定 Workbench session 的保障仍然存在。
只有出现这种真实的第二消费者时，才将共用 DTO/API 从 `workbench.ts` 提取到中立 contract module 或独立 package subpath；
仅供 Workbench 使用时保持当前结构。

每个 renderer 声明一个 module-scoped scope 和资源：

```ts
// src/ui/overview.scope.ts
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
}))

export const refreshOrders = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.refresh(),
	workbench: { invalidates: [ordersQuery] },
}))
```

entry 保持零 props，只把 page 绑定到 scope：

```tsx
// src/ui/overview.tsx
import { OrdersPage } from './orders-page.tsx'
import { overviewScope } from './overview.scope.ts'

export default overviewScope.render(OrdersPage)
```

最后创建 `src/ui/orders-page.tsx`，显示查询结果并调用刷新：

```tsx
import { ordersQuery, refreshOrders } from './overview.scope.ts'

export function OrdersPage() {
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()

	if (orders.status === 'pending') return <p>Loading…</p>
	if (orders.status === 'error' && orders.data === undefined) return <p>Unavailable</p>

	return (
		<button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
			Refresh {orders.data.openOrders} orders (revision {orders.data.revision})
		</button>
	)
}
```

每次 Bridge mount 都有独立 renderer owner 和 private `QueryClient`；不同 open、principal、params 或 Plugin generation
不共享 query、mutation、cache 或 subscription。

## 必须遵守的 renderer scope 边界

每个 renderer graph 只能有一个 server-definition value boundary。默认把它放在 `<entry>.scope.ts`：

```ts
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)
```

其他 page/panel 只能 import 这个 scope 或其 resources，不能再 import/re-export/dynamic import server definition。Toolchain 会把这条
唯一边界改写成 browser-only projection，避免 browser 执行 Plugin implementation。构建错误会指出违规 module、specifier 和
期望 descriptor；直接按错误中的 `createWorkbenchRenderer(Definition.entry)` 形状修复。

低层 `useWorkbench(exactDescriptor)` 只能在 renderer default entry 保留这唯一边界；它不是普通 snapshot 页面首选路径。

## 何时升级

- read model 会在外部变化：query 通过 `workbench.subscribe: ({ invalidate }) => api.watch(invalidate)` 订阅权威 invalidation。
  此时 mutation 若必然触发同一 subscription，不重复声明 invalidation。
- 按 input 读取：使用 `queryFamily()`，为每个 input 返回有界、可移植且领域可读的 `queryKey`；失效时明确选 `target(input)` 或 `all()`。
- callback/progress/cancel/lossless stream：由领域 API 返回具有自己 disposer 语义的 child `RpcTarget`。只有 server-side custom callback
  target 需要 `dup()` observer、释放每次 callback result，并在 open signal abort 时 unsubscribe。
- 复杂三栏布局：使用 `WorkbenchPaneLayout`/`WorkbenchPane`；不要读取 Shell router、store 或 raw socket。

普通 `scope.query()` 负责 browser-side subscription 的 retain、abort 和 dispose。不要为了普通 latest snapshot 手写 observer target。

## 页面 API 与宿主边界

- 返回 bounded immutable snapshot；大列表使用 cursor/limit。
- mutation 只有页面需要 result 时才返回 DTO；否则返回 `void`，用 subscription 或 typed invalidation 刷新。
- API 不返回 Plugin、Context、database handle、native object、raw socket 或 Shell service。
- `host` 只提供 locale、color scheme、notify/confirm、relative navigation 和 parameterized document facade。
- route params 由 server match 后冻结；browser 不能提交 principal 或 authority object。

## 检查结果

运行应用，打开 Plugin 的 Orders 标签，应看到订单数量和 Refresh 按钮。点击后按钮在请求期间禁用，成功后重新读取并看到 revision 增加。
关闭再打开应重新读取；两个同时打开的页面不应共用操作状态。

查询选项、分页输入、错误代码和 Mantine Provider 见 [查询、写入与页面资源](./renderer-resources.md)。
认证、完整刷新和反向代理见 [使用与排查工作台](./operations.md)。

## Placement 与参数化 route

Tab 适合 Plugin 详情中的固定页面：

```ts
workbench.tab({
	label: 'Settings',
	icon: workbench.icons.Settings,
	group: { id: 'operations', label: 'Operations' },
	order: 30,
})
```

Route 适合全局导航或独立 document：

```ts
account: workbench.view<AccountApi>({
	renderer: workbench.entry(import.meta.url, './ui/account.tsx'),
	placement: workbench.route('/accounts/:accountId', {
		title: 'Account',
		frame: 'shell',
	}),
})
```

Parameterized route 不进入固定 navigation。Manager 使用：

```ts
host.navigation?.openDocument({
	path: `/accounts/${encodeURIComponent(account.id)}`,
	title: account.displayName,
	meta: 'Bot account',
})
```

Server 会重新匹配 route，再把 frozen params 交给 factory。Browser 不能提交 principal 或 authority object。
Document renderer 可以用 `host.document?.params`、`setTitle()` 和 `setDirty()` 管理当前文档 chrome。

## Host 能力

`host` 是固定的受限 facade：

- `locale`、`colorScheme`；
- `notify()`、`confirm()`；
- 可空的 relative `navigation`；
- 可空的 parameterized `document`；

Renderer 不取得 generic HTTP client、任意 URL navigation、Shell router/store 或 raw WebSocket。需要三栏任务布局时，
从 `@pluxel/runtime/workbench/react` 使用 `WorkbenchPaneLayout` 和 `WorkbenchPane`；宿主负责 responsive drawer、
resize、focus 和 workspace persistence。

Pane Kit 的三段语义固定为 `navigation | primary | inspector`：两侧可由当前标签页头部的标准控件显示、隐藏或在窄屏
打开为 drawer；中间控件用于聚焦 primary 并恢复先前两侧。`primary` 始终可见，不能被隐藏。官方插件详情页中的
plugin rail、辅助栏和底部 dock 属于另一套宿主私有布局，不应被 View 当作 Pane Kit role 或自行复制其 chrome。

## 完整 View 参考：server push 与 custom callback

下面的例子刻意包含 `watch()` 和 server-side callback target，用于说明跨调用 observer 的 ownership。它不是普通
snapshot + mutation 页面的起点；没有已证实的实时更新需求时，使用[本页的默认路径](#默认路径snapshot--mutation)。

### 1. 声明 API 和 View

把 browser-safe API、DTO 和 definition 放在 `src/workbench.ts`：

```ts
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export type OrdersSnapshot = Readonly<{
	revision: number
	openOrders: number
}>

export interface OrdersObserver {
	(revision: number): void | Promise<void>
}

export interface OrdersApi extends RpcTarget {
	snapshot(): OrdersSnapshot
	refresh(): OrdersSnapshot
	watch(observer: OrdersObserver): RpcTarget
}

export const OrdersWorkbench = workbench.define({
	overview: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.tab({ label: 'Orders', order: 20 }),
	}),
})
```

Definition 必须是固定的 flat record。Entry key 是稳定 declaration identity 的一部分；不要从运行时数据生成 key。
`workbench.entry()` 的路径必须相对当前 module，构建工具会据此生成 MF2 producer 和 Bridge expose。

### 2. 发布 fresh target

在 Plugin 的 `init()` 中发布 definition：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import { OrdersWorkbench, type OrdersApi, type OrdersObserver } from './workbench.js'

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	private revision = 1
	private openOrders = 0
	private readonly listeners = new Set<(revision: number) => void>()

	override init() {
		this.ctx.workbench?.publish(OrdersWorkbench, {
			overview: ({ signal }) => new OrdersTarget(this, signal),
		})
	}

	snapshot() {
		return Object.freeze({ revision: this.revision, openOrders: this.openOrders })
	}

	refresh() {
		this.revision += 1
		for (const listener of this.listeners) listener(this.revision)
		return this.snapshot()
	}

	subscribe(listener: (revision: number) => void) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
}

class OrdersTarget extends RpcTarget implements OrdersApi {
	constructor(
		private readonly plugin: OrdersPlugin,
		private readonly signal: AbortSignal,
	) {
		super()
	}

	snapshot() {
		return this.plugin.snapshot()
	}

	refresh() {
		return this.plugin.refresh()
	}

	watch(observer: OrdersObserver) {
		return new OrdersSubscription(this.plugin, observer as RpcStub<OrdersObserver>, this.signal)
	}
}

class OrdersSubscription extends RpcTarget {
	readonly #observer: RpcStub<OrdersObserver>
	readonly #unsubscribe: () => void
	readonly #signal: AbortSignal
	readonly #onAbort = () => this[Symbol.dispose]()
	#active = true

	constructor(plugin: OrdersPlugin, observer: RpcStub<OrdersObserver>, signal: AbortSignal) {
		super()
		this.#observer = observer.dup()
		this.#unsubscribe = plugin.subscribe((revision) => {
			try {
				const result = this.#observer(revision)
				void (async () => {
					try {
						await result
					} catch {
						this[Symbol.dispose]()
					} finally {
						result[Symbol.dispose]()
					}
				})()
			} catch {
				this[Symbol.dispose]()
			}
		})
		this.#signal = signal
		if (signal.aborted) this[Symbol.dispose]()
		else signal.addEventListener('abort', this.#onAbort, { once: true })
	}

	[Symbol.dispose]() {
		if (!this.#active) return
		this.#active = false
		this.#signal.removeEventListener('abort', this.#onAbort)
		this.#unsubscribe()
		this.#observer[Symbol.dispose]()
	}
}
```

每次打开 View 都会调用 factory，所以必须返回新的 `RpcTarget`。`principal`、server-matched `params` 和
`signal` 都在 factory context 中；按用户授权或按 route 打开对象时就在这里 admission。

`OrdersSubscription` 对需要跨调用保留的 observer 调用 `dup()`，在每次 callback settle 后释放 invocation result，并在自己的
`[Symbol.dispose]()` 中 unsubscribe 和释放 observer。这样 View close、socket close 和 Plugin replacement 都走同一清理路径。

Bindings 必须与 definition 的 key 完全一致。一个 Plugin generation 只调用一次 `publish()`；`PluginPart` 把 UI
需求交给 owning Plugin 聚合。

### 3. 声明 renderer scope 与 resources

普通 snapshot/watch 页面先在 renderer-specific `src/ui/overview.scope.ts` 声明 scope。这个 module 是当前 renderer graph
唯一直接 value-import definition 的边界；scope 和 resource 都是 module-scoped immutable declaration，不保存当前 API root
或 React state：

```ts
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { OrdersWorkbench } from '../workbench.js'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))

export const refreshOrders = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.refresh(),
}))
```

Renderer-specific scope module 优先与 descriptor entry 同名：`overview` 使用 `overview.scope.ts`，scope symbol 使用
`overviewScope`。这样 entry、scope 与 build error 能直接互相定位；resource 则继续使用领域名称。

这里 `api.refresh()` 提交后会通过领域 `watch()` 推送 subscription 通知，所以 mutation 不再重复声明
`workbench.invalidates`。如果 query 没有 subscription，或该 contract 不覆盖这项写操作，再由 mutation 显式声明
invalidation；不要为同一次提交同时建立两条刷新路径。

Toolchain 会把这条 exact definition import 改写为 browser-only projection，同时保留 `RpcStub<OrdersApi>` 的准确类型；原始
definition module 不会在浏览器执行。Indirect/re-export/dynamic definition import、绑定错误 entry、一个 scope 绑定多个 descriptor，
或跨 renderer 复用同一 scope 都会在 build 时拒绝。共享 UI 应保持为普通 props/data component，不 import renderer scope。
只使用低层 `useWorkbench(exactDescriptor)` 的高级 renderer 可以改在 default entry 保留唯一 direct definition import；两条路径都
不允许 graph 中出现第二个 definition value boundary。

按输入读取与定向刷新见[页面资源参考](./renderer-resources.md#按参数查询)。

### 4. 绑定 entry 并渲染 page

默认 entry 保持零 props，只负责把 page 绑定到 scope：

```tsx
// src/ui/overview.tsx
import { OrdersPage } from './orders-page.js'
import { overviewScope } from './overview.scope.js'

export default overviewScope.render(OrdersPage)
```

Renderer graph 内的 page/panel 可以直接 import scope 和 resources，不需要层层传递 `api`、`host` 或 cache：

```tsx
// src/ui/orders-page.tsx
import { ordersQuery, overviewScope, refreshOrders } from './overview.scope.js'

export function OrdersPage() {
	const { host } = overviewScope.useWorkbench()
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()

	if (orders.status === 'pending') return <p>Loading…</p>
	if (orders.status === 'error' && orders.data === undefined) return <p>Unavailable</p>

	return (
		<>
			{orders.status === 'error' ? <p>Showing stale data.</p> : null}
			<button
				disabled={refresh.isPending}
				onClick={() => {
					void refresh
						.mutateAsync()
						.then((next) => host.notify({ message: `Revision ${next.revision}` }))
						.catch(() => host.notify({ message: 'Refresh failed', tone: 'error' }))
				}}
			>
				Refresh {orders.data.openOrders} orders
			</button>
		</>
	)
}
```
