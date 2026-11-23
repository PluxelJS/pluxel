---
title: 编写 React 管理页面（View）
description: 使用 React 与 Cap'n Web RPC 编写功能完整的 Workbench 页面，支持查询、提交与服务端实时推送。
---

当管理页面需要复杂交互、表格分页、图表展示或实时流式数据时，可使用 **View** 视图。开发者使用 React 编写前端组件，后端插件通过 Cap'n Web 暴露强类型的 RPC 接口，Workbench 负责处理权限校验、窗口挂载与生命周期注销。

页面有三个入口。Definition 声明页面和 RPC 类型，插件在 `init()` 发布每次打开时创建的 Target，React renderer 默认导出页面组件。下面把 scope、查询和组件放在一个 renderer 文件里。

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
export const OrdersWorkbench = workbench.define(import.meta.url, {
	overview: workbench.view<OrdersApi>({
		renderer: './ui/overview.tsx',
		placement: { kind: 'tab', label: '订单管理', order: 20 },
	}),
})
```

### 2. 服务端实现 RPC Target

在插件中实现 `OrdersApi`，并在 `init()` 阶段发布：

```ts
import type { Workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { assertWorkbenchDto } from '@pluxel/workbench/server'
import { OrdersWorkbench, type OrdersApi, type OrdersSnapshot } from './workbench.ts'

const WorkbenchRef = defineServiceRef<Workbench>()

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	private revision = 0

	protected override init() {
		// 每次前端打开页面时，创建一个新的 Target 会话实例
		this.ctx.service(WorkbenchRef)?.publish(OrdersWorkbench, {
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

### 3. 编写 renderer

在 `src/ui/overview.tsx` 中，通过模块级 `createWorkbenchRenderer(OrdersWorkbench.overview)` 绑定页面。组件通过这个 scope 使用查询、写入和宿主能力。每次打开页面独立持有相应的缓存和订阅。

```tsx
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { OrdersWorkbench } from '../workbench.ts'

const overviewScope = createWorkbenchRenderer(OrdersWorkbench.overview)
const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))
const refreshOrders = overviewScope.mutation(({ api }) => ({
	mutationFn: () => api.refresh(),
	workbench: { invalidates: [ordersQuery] },
}))

function OrdersPage() {
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()

	if (orders.status === 'pending') return <p>正在加载订单数据…</p>
	if (orders.status === 'error') {
		return <button onClick={orders.invalidate}>加载失败，重试</button>
	}

	return (
		<section>
			<h2>订单列表（版本 {orders.data.revision}）</h2>
			<p>待处理订单数 {orders.data.openOrders}</p>
			<button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
				刷新
			</button>
			{refresh.status === 'error' && <p>刷新失败，请重试。</p>}
		</section>
	)
}

export default overviewScope.render(OrdersPage)
```

多个组件共用查询时，可以把 scope 和资源声明移到单独的模块，各组件导入所需资源。纯展示 renderer 可以直接默认导出零参数组件。

<span id="检查结果"></span>

## 检查结果

启动应用并访问 `/__pluxel/workbench`：

1. 在插件目录打开 Orders 的详情，选择“订单管理”选项卡。
2. 点击“刷新”。操作期间按钮禁用，完成后订单列表显示递增的版本号。

---

<span id="host-能力"></span>

## Host 能力

在 React 组件中，除了调用当前插件的服务端 `api` 外，还可以调用宿主提供的全局能力（例如触发宿主通知、导航至其他标签页）：

```tsx
function RevisionNotice({ revision }: { revision: number }) {
	const { host } = overviewScope.useWorkbench()
	return (
		<button onClick={() => host.notify({ message: `当前订单版本 ${revision}` })}>
			显示当前版本
		</button>
	)
}
```

在 Shell 中，`host.navigation.openDocument({ path, title })` 打开当前插件声明的页面。要打开应用目录中某个节点的内置插件详情，直接传入该节点的地址，例如 `host.navigation?.openDocument({ plugin: node.address, title: node.label.text })`。地址保留包入口、导出和 fork 身份。

---

<span id="依赖与构建"></span>

## 依赖与构建

- Shell 与插件共享固定版本的 React、ReactDOM、Mantine、React Bridge 和 Workbench 浏览器入口。页面通过 `scope.query` 和 `scope.mutation` 使用 Workbench 内部的 TanStack Query 缓存。插件自行引入的其他前端库由 producer 打包。
- Renderer 中绑定 scope 的模块直接导入自己的 definition。构建工具将该值引用投影为当前条目的浏览器 descriptor。其他模块按需导入 scope、资源或 TypeScript 类型。
