---
title: 编写 React 管理页面（View）
description: 使用 React 与 Cap'n Web RPC 编写功能完整的 Workbench 页面，支持查询、提交与服务端实时推送。
---

当管理页面需要复杂交互、表格分页、图表展示或实时流式数据时，可使用 **View** 视图。开发者使用 React 编写前端组件，后端插件通过 Cap'n Web 暴露强类型的 RPC 接口，Workbench 负责处理权限校验、窗口挂载与生命周期注销。

## 架构组成（五件套）

开发一个完整的 View 通常包含以下五个部分：

1. **页面契约声明（`src/workbench.ts`）**：定义 DTO 数据类型、RPC 接口与视图路由；
2. **服务端 Target 实现（`src/OrdersPlugin.ts`）**：继承 `RpcTarget`，实现具体的业务数据读取与操作逻辑；
3. **渲染器作用域（`src/ui/overview.scope.ts`）**：定义基于 TanStack Query 封装的查询（Query）与操作（Mutation）；
4. **React 页面组件（`src/ui/orders-page.tsx`）**：纯前端组件，渲染界面并响应用户交互；
5. **视图入口（`src/ui/overview.tsx`）**：将页面组件绑定至渲染器作用域并默认导出。

---

<span id="默认路径snapshot--mutation"></span>

## 默认路径：snapshot + mutation

### 1. 声明页面与 RPC 契约

在 `src/workbench.ts` 中定义前端可调用的接口与视图元数据：

```ts
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

// 数据快照类型
export type OrdersSnapshot = Readonly<{
	revision: number
	openOrders: number
}>

// 前端可调用的 RPC 接口
export interface OrdersApi extends RpcTarget {
	snapshotDto(): Promise<OrdersSnapshot>
	refresh(): Promise<void>
}

// 声明工作台视图
export const OrdersWorkbench = workbench.define({
	overview: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.tab({ label: '订单管理', order: 20 }),
	}),
})
```

### 2. 服务端实现 RPC Target

在插件中实现 `OrdersApi`，并在 `init()` 阶段发布：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { OrdersWorkbench, type OrdersApi, type OrdersSnapshot } from './workbench.ts'

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	private revision = 0

	protected override init() {
		// 每次前端打开页面时，创建一个新的 Target 会话实例
		this.ctx.workbench?.publish(OrdersWorkbench, {
			overview: () => new OrdersTarget(this),
		})
	}

	async snapshot() {
		return { revision: this.revision, openOrders: 12 }
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

	async refresh(): Promise<void> {
		await this.orders.refresh()
	}
}
```

### 3. 定义查询与变更（Query & Mutation）

在 `src/ui/overview.scope.ts` 中创建渲染器作用域，声明对服务端 API 的调用：

```ts
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

export const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)

// 声明数据查询
export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))

// 声明操作变更：操作成功后自动使 ordersQuery 失效并重新拉取
export const refreshOrders = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.refresh(),
	workbench: { invalidates: [ordersQuery] },
}))
```

### 4. 编写 React 界面组件

在 `src/ui/orders-page.tsx` 中编写交互界面：

```tsx
import { ordersQuery, refreshOrders } from './overview.scope.ts'

export function OrdersPage() {
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()

	if (orders.status === 'pending') {
		return <p>正在加载订单数据...</p>
	}

	if (orders.status === 'error') {
		return (
			<div>
				<p>加载失败，请重试</p>
				<button onClick={() => orders.refetch()}>重试</button>
			</div>
		)
	}

	return (
		<div style={{ padding: 16 }}>
			<h2>订单列表（版本：{orders.data.revision}）</h2>
			<p>当前待处理订单数：{orders.data.openOrders}</p>
			<button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
				{refresh.isPending ? '正在刷新...' : '手动刷新'}
			</button>
		</div>
	)
}
```

### 5. 视图入口绑定

在 `src/ui/overview.tsx` 中导出页面：

```tsx
import { OrdersPage } from './orders-page.tsx'
import { overviewScope } from './overview.scope.ts'

export default overviewScope.render(OrdersPage)
```

---

<span id="检查结果"></span>

## 检查结果

启动应用并访问 `/__pluxel/workbench`：

1. 在左侧应用栏中可看到“订单管理”入口；
2. 点击打开后，将呈现订单数据与操作按钮；
3. 点击“手动刷新”，按钮进入加载状态，执行完成后界面数据与版本号自动更新。

---

<span id="host-能力"></span>

## Host 能力

在 React 组件中，除了调用当前插件的服务端 `api` 外，还可以调用宿主提供的全局能力（例如触发宿主通知、导航至其他标签页）：

```tsx
const { host } = overviewScope.useWorkbench()

// 弹出全局提示通知
host.notify({ title: '操作完成', message: '已同步最新订单' })
```

---

<span id="依赖与构建"></span>

## 依赖与构建

- 插件前端依赖的 React、Mantine、TanStack Query 等基础库由 Workbench Shell 在运行时统一提供，构建工具会自动配置模块联邦（Module Federation）与外部化。
- 服务端模块与前端 UI 组件应当严格解耦，前端组件只能引用 `workbench.ts` 中暴露的类型与 Schema，避免将服务端的 Node.js 逻辑打包进浏览器产物中。
