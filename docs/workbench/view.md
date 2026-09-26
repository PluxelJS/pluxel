---
title: 编写 React 管理页面
description: 从一个可读取、可刷新的页面开始，再按需添加分页和实时订阅。
---

需要自定义布局、分页或 React 组件时，使用 View。Plugin 提供服务端 API 和 React 页面，Workbench 负责登录与打开、关闭页面。
如果只有状态和几个按钮，先用更短的 [Content](./content.md)。

Workbench 为 View 提供占满当前编辑窗格的挂载容器。页面可使用 `height: 100%` 填满可用高度，
并自行管理内容滚动；Pane Kit 根据该窗格的实际宽度调整分栏。

开始前，宿主应已启用 Workbench，Plugin 能正常启动。下面分为五份文件：页面声明、服务端实现、查询声明、React 入口和页面组件。
`RpcTarget` 是可以由页面调用的服务端对象；`scope` 将 React 组件与它对应的页面 API 关联。

先完成[五份文件的最小页面](#默认路径snapshot--mutation)，再按[检查结果](#检查结果)验证。只有需要参数路由、订阅或其他客户端时才继续扩展；[依赖与构建](#依赖与构建)说明发布包必须满足的版本和模块身份。

## 默认路径：snapshot + mutation

将 browser-safe DTO、API 和静态 definition 放进 `src/workbench.ts`：

```ts
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export type OrdersSnapshot = Readonly<{
	revision: number
	openOrders: number
}>

export interface OrdersApi extends RpcTarget {
	snapshotDto(): Promise<OrdersSnapshot>
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
import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { OrdersWorkbench, type OrdersApi, type OrdersSnapshot } from './workbench.ts'

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
	async snapshotDto(): Promise<OrdersSnapshot> {
		const dto = await this.orders.snapshot()
		assertWorkbenchDto(dto, 'Orders snapshot')
		return dto
	}
	refresh(): Promise<void> {
		return this.orders.refresh()
	}
}
```

每次打开都创建一个新的 `OrdersTarget`。如果真实页面要按用户授权、按路由加载对象或持有订阅，
从 factory 参数取得 `principal`、`params`、`signal`，在这里检查权限并在关闭时清理资源。
此例没有订阅或长任务，因此不需要额外的空 disposer。

每个 renderer 声明一个 module-scoped scope 和资源：

```ts
// src/ui/overview.scope.ts
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
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
	if (orders.status === 'error' && orders.data === undefined) {
		return (
			<button
				type="button"
				onClick={() => {
					void orders.refetch().catch(() => {})
				}}
			>
				读取失败，点击重试
			</button>
		)
	}

	return (
		<>
			{orders.status === 'error' && <p role="alert">刷新读取失败，当前显示最近一次成功的数据。</p>}
			{refresh.status === 'error' && <p role="alert">操作失败，请重试。</p>}
			<button type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
				Refresh {orders.data.openOrders} orders (revision {orders.data.revision})
			</button>
		</>
	)
}
```

每次 Bridge mount 都有独立 renderer owner 和 private `QueryClient`；不同 open、principal、params 或 Plugin generation
不共享 query、mutation、cache 或 subscription。

`mutate()` 将失败交给 mutation state；显式 `refetch()` 返回的 Promise 需要处理 rejection，错误同时保留在 query state 中。

## 检查结果

运行应用，打开 Plugin 的 Orders 标签，应看到订单数量和 Refresh 按钮。点击后按钮在请求期间禁用，成功后重新读取并看到 revision 增加。
关闭再打开应重新读取；两个同时打开的页面不应共用操作状态。

查询选项、分页输入、错误代码和 Mantine Provider 见 [查询、写入与页面资源](./renderer-resources.md)。
认证、完整刷新和反向代理见 [使用与排查工作台](./operations.md)。

## 必须遵守的 renderer scope 边界

每个 renderer graph 只能有一个 server-definition value boundary。默认把它放在 `<entry>.scope.ts`：

```ts
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)
```

其他 page/panel 只能 import 这个 scope 或其 resources，不能再 import/re-export/dynamic import server definition。Toolchain 会把这条
唯一边界改写成 browser-only projection，避免 browser 执行 Plugin implementation。构建错误会指出违规 module、specifier 和
期望 descriptor；直接按错误中的 `createWorkbenchRenderer(Definition.entry)` 形状修复。

低层 `useWorkbench(exactDescriptor)` 只能在 renderer default entry 保留这唯一边界；它不是普通 snapshot 页面首选路径。

## 页面 API 与宿主边界

- 纯数据 RPC 方法使用 `*Dto` 后缀和显式返回类型，返回前用 `assertWorkbenchDto()` 校验可传输性；大列表使用 cursor/limit。
- DTO 生产、输入校验与授权规则见 [API 契约](../api/contracts.md#rpc-方法名表达返回值所有权)。
- mutation 只有页面需要 result 时才返回 DTO；否则返回 `void`，用 subscription 或 typed invalidation 刷新。
- API 不返回 Plugin、Context、database handle、native object、raw socket 或 Shell service。
- `host` 的外观、导航、文档与可选管理能力见[Host 能力](#host-能力)，不从 Shell 内部取得服务。
- route params 由 server match 后冻结；browser 不能提交 principal 或 authority object。

## 何时升级

- read model 会在外部变化：query 通过 `workbench.subscribe: ({ invalidate }) => api.watch(invalidate)` 订阅权威 invalidation。
  此时 mutation 若必然触发同一 subscription，不重复声明 invalidation。
- 按 input 读取：使用 `queryFamily()`，为每个 input 返回有界、可移植且领域可读的 `queryKey`；失效时明确选 `target(input)` 或 `all()`。
- callback/progress/cancel/lossless stream：由领域 API 返回具有自己 disposer 语义的 child `RpcTarget`。只有 server-side custom callback
  target 需要 `dup()` observer、释放每次 callback result，并在 open signal abort 时 unsubscribe。
- 复杂三栏布局：使用 `WorkbenchPaneLayout`/`WorkbenchPane`；不要读取 Shell router、store 或 raw socket。

普通 `scope.query()` 负责 browser-side subscription 的 retain、abort 和 dispose。不要为了普通 latest snapshot 手写 observer target。

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

浏览器地址跟随 `uiBasePath`：`/accounts` 在 `'/__pluxel/workbench'` 下对应 `/__pluxel/workbench/accounts`，不要求设置 `navigation`。
不同 Plugin/fork 路径重叠时，冲突入口改用带实例身份的完整地址；歧义短地址显示入口选择页。同一 Plugin 内静态路径优先于参数路径。
Shell 保留首页以及 `plugins`、`plugin-graph`、`security`、`logs`、`workbench`、`workbench-standalone` 及其子路径。
完整地址始终有效；publication 更新后重算短地址，冲突消失时恢复。固定跨插件链接应选择有业务辨识度的路径。

Server 会重新匹配 route，再把 frozen params 交给 factory。Browser 不能提交 principal 或 authority object。
Document renderer 可以用 `host.document?.params`、`setTitle()` 和 `setDirty()` 管理当前文档 chrome。

## Host 能力

`host` 是固定的受限 facade：

- `locale`、`colorScheme`；
- `notify()`、`confirm()`；
- 可空的 relative `navigation`；
- 可空的 parameterized `document`；

Renderer 不取得 generic HTTP client、任意 URL navigation、Shell router/store 或 raw WebSocket。需要三栏任务布局时，
从 `@pluxel/workbench/react` 使用 `WorkbenchPaneLayout` 和 `WorkbenchPane`；宿主负责 responsive drawer、
resize、focus 和 workspace persistence。

Pane Kit 的三段语义固定为 `navigation | primary | inspector`：两侧可由当前标签页头部的标准控件显示、隐藏或在窄屏
打开为 drawer；中间控件用于聚焦 primary 并恢复先前两侧。`primary` 始终可见，不能被隐藏。官方插件详情页中的
plugin rail、辅助栏和底部 dock 属于另一套宿主私有布局，不应被 View 当作 Pane Kit role 或自行复制其 chrome。

### 借用宿主管理操作

官方 Shell 向 View 提供可选的 `host.management`，共享当前已认证会话的 unary management
操作。自定义 Shell 必须在 `createWorkbenchViewHost({ management, ... })` 中显式绑定；
未绑定时该字段为 `null`，Renderer 应处理不可用状态。

这不转移会话所有权：没有 raw socket、订阅控制或 session disposal。关闭 View 后，
已缓存的 namespace 与独立保存的 method 都不能继续发起操作；已经接受的调用仍按原会话完成，
关闭不表示业务回滚。认证、权限检查和审计与 Shell 内建页面完全相同。

## 完整 View 参考：订阅后台变化

后台或其他页面会修改数据时，在前面的例子中加入 `watch()`，不再复制另一套页面。

1. `OrdersApi` 增加 `watch(observer: (revision: number) => void | Promise<void>): RpcTarget`。
2. Plugin 的领域服务提供 `subscribe(listener): Disposable`，每次提交后通知递增 revision。
3. factory 改成 `overview: ({ signal }) => new OrdersTarget(this, signal)`，target 保存本次 open 的 signal。
4. target 用现有 helper 接管远端 observer：

```ts
import { createWorkbenchWatch } from '@pluxel/workbench/server'

// OrdersTarget 中；orders.subscribe() 返回领域订阅的 Disposable。
watch(observer: (revision: number) => void | Promise<void>): RpcTarget {
	return createWorkbenchWatch({
		observer,
		signal: this.signal,
		subscribe: (notify) => this.orders.subscribe(notify),
	})
}
```

然后只修改原有资源声明，entry 与页面组件保持相同：

```ts
export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
	workbench: { subscribe: ({ invalidate }) => api.watch(invalidate) },
}))

export const refreshOrders = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.refresh(),
}))
```

`refresh()` 提交后必须触发同一权威通知，才可省略 `invalidates`。helper 用于最新状态失效提示，会合并中间 revision；逐条事件和可取消进度使用领域 capability。
观察者引用、callback result 和退订的完整规则见[服务端最新状态通知](./renderer-resources.md#服务端最新状态通知)。

## 依赖与构建

向 Workbench 发布 View/Attachment target 时，作者直接从 `capnweb` 导入 `RpcTarget`，并把宿主支持的精确版本
同时列为 peer 和 dev dependency。当前 Workbench 支持 `0.12.0`；官方包使用 `catalog:prod`。
Workbench 在打开页面时检查 target 是同一运行时的 `RpcTarget`，`pluxel build` 在发布产物前检查该包的
peer、dev 和实际安装版本。仅自建的 RPC session 不因使用同名库而受 Workbench 版本限制。
构建产物的 `pluxel.workbenchCapnweb` 事实让 Pluxel 静态应用和生产动态来源只对 target 发布包
桥接宿主模块；动态来源在加载时还检查实际版本，并给出包名、实际版和宿主支持版。即使版本相同，
绕过标准构建或采用其它加载器造成的第二份模块仍会在打开时被拒绝。

`RpcTarget` 是 Cap’n Web 的能力对象，不归 Workbench 所有。同一份 browser-safe API contract 和 target class 可以用
Cap’n Web 的 `new RpcStub(target)` 独立测试，也可在确有 CLI 或其他客户端需求时由另一条明确拥有的 Cap’n Web session 挂载。
复用的是 contract、target class 和底层领域 service，不是已经打开的 target 实例：每个 session/open 都必须创建 fresh
target，并由新的挂载方自己提供认证、授权、输入预算、取消和释放语义，不能假定 Workbench session 的保障仍然存在。
只有出现这种真实的第二消费者时，才将共用 DTO/API 从 `workbench.ts` 提取到中立 contract module 或独立 package subpath；
仅供 Workbench 使用时保持当前结构。
