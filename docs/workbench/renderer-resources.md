---
title: 查询、写入与页面资源
description: 掌握 Workbench 前端基于 TanStack Query 的查询缓存、变更失效、分页与实时推送订阅机制。
---

在 Workbench 的 View 视图中，前端数据流深度集成了经过定制的 TanStack Query 基础设施。每个打开的页面窗口自动拥有私有的 QueryClient，当页面关闭时，相关的网络请求、缓存与实时订阅会自动完整注销。

## 谁来触发数据更新

在声明 Query 和 Mutation 时，根据业务场景选择最适宜的刷新策略：

| 场景 | 推荐实现方式 | 机制说明 |
| --- | --- | --- |
| 仅由当前页面的操作按钮修改数据 | `mutation` 中声明 `workbench: { invalidates: [query] }` | 操作成功后，自动触发前端重新拉取指定 Query |
| 后台或其他客户端也会并发修改数据 | `query` 中声明 `workbench.subscribe` | 服务端数据发生变动时，向前端推送失效信号并自动刷新 |
| 查询参数随选中项或搜索关键字变化 | 使用 `queryFamily()` 动态构造查询 | 为不同参数生成隔离缓存，支持按 key 精准失效 |

## 参数化查询（queryFamily）

当查询依赖前端动态参数（如订单 ID 或分页条件）时，使用 `queryFamily`：

```ts
// 声明带参数的查询
const orderQuery = overviewScope.queryFamily(
	({ api }, input: Readonly<{ id: string }>) => ({
		queryKey: ['orders', 'detail', input.id] as const,
		queryFn: ({ signal }) => api.orderDto(input.id),
	}),
)

// 声明操作变更并指定失效特定目标
const renameOrder = overviewScope.mutation(({ api }) => ({
	mutationFn: (input: { id: string; name: string }) => api.rename(input),
	workbench: {
		// 精确使对应 ID 的查询缓存失效
		invalidates: (input) => [orderQuery.target({ id: input.id })],
	},
}))
```

在组件中使用：

```tsx
function OrderDetail({ id }: { id: string }) {
	const order = orderQuery.useQuery({ id })
	// ...
}
```

<span id="数据与订阅如何清理"></span>
## 数据与订阅如何清理

- **隔离的生命周期**：每次在 Workbench 中打开一个标签页，都会分配一个全新的渲染上下文与独立的 QueryClient。不同标签页之间不会意外共享临时脏状态；
- **自动垃圾回收**：当用户关闭页面标签时，底层会立即向服务端发送断开信号，注销对应的 RPC 会话，并取消所有在途的异步拉取请求；
- **浅冻结防护**：查询成功返回的 DTO 数据会被深冻结为只读对象，防止组件在渲染时意外就地篡改缓存数据。

<span id="服务端最新状态通知"></span>
### 服务端最新状态通知

对于需要在服务端数据变动时自动推送更新的场景，服务端可借助 `createWorkbenchWatch` 将本地事件连接到客户端：

```ts
import { createWorkbenchWatch } from '@pluxel/workbench/server'

class OrdersTarget extends RpcTarget implements OrdersApi {
	// 暴露 watch 方法供客户端订阅
	watch(observer: (revision: number) => void | Promise<void>): RpcTarget {
		return createWorkbenchWatch({
			observer,
			signal: this.signal,
			subscribe: (notify) => this.orders.subscribe(notify),
		})
	}
}
```

客户端在前端 Query 中直接接入该监听：

```ts
export const ordersQuery = overviewScope.query(({ api }) => ({
	queryKey: ['orders', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
	// 订阅服务端数据变动，自动触发查询刷新
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
	},
}))
```

## UI 组件库支持（Mantine）

Workbench Shell 原生预置了 [Mantine](https://mantine.dev/)（v7）设计体系与常用组件。在插件的 React 组件中，你可以直接导入并使用 Mantine 的基础排版、按钮、表格与模态框组件，组件样式会自动契合 Workbench 的整体深浅色主题风格。
