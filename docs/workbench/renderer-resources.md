---
title: 查询、写入与页面资源
description: 掌握 Workbench 前端基于 TanStack Query 的查询缓存、变更失效、分页与实时推送订阅机制。
---

在 View 或 Attachment 中，用 `createWorkbenchRenderer(Definition.entry)` 建立 scope，通过它声明查询、参数化查询和写入。每次打开页面拥有独立的 QueryClient 与订阅。

## 谁来触发数据更新

在声明 Query 和 Mutation 时，根据业务场景选择最适宜的刷新策略：

| 场景                             | 推荐实现方式                                            | 机制说明                                                   |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| 仅由当前页面的操作按钮修改数据   | `mutation` 中声明 `workbench: { invalidates: [query] }` | 写入结束时使指定查询失效，已开始执行的写入即使失败也会刷新 |
| 后台或其他客户端也会并发修改数据 | `query` 中声明 `workbench.subscribe`                    | 服务端数据发生变动时，向前端推送失效信号并自动刷新         |
| 查询参数随选中项或搜索关键字变化 | 使用 `queryFamily()` 动态构造查询                       | 为不同参数生成隔离缓存，支持按 key 精准失效                |

## 参数化查询（queryFamily）

当查询依赖前端动态参数（如订单 ID 或分页条件）时，使用 `queryFamily`：

```ts
// 声明带参数的查询
const orderQuery = overviewScope.queryFamily(({ api }, input: Readonly<{ id: string }>) => ({
	queryKey: ['orders', 'detail', input.id] as const,
	queryFn: () => api.orderDto(input.id),
}))

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

- 每次打开页面都有自己的缓存，同一页内的组件可以共享查询和订阅。
- 关闭页面会终止该次打开的 `AbortSignal` 并释放订阅。已经发出的 RPC 可能稍后完成；Workbench 负责消费和释放晚到的结果，页面只接收当前打开期间的更新。
- 查询结果进入缓存前会检查是否为可移植数据，并深度冻结为只读快照。

<span id="服务端最新状态通知"></span>

### 服务端最新状态通知

服务端可以用 `createWorkbenchWatch` 把插件的版本变化通知传给页面。以 [View 指南](./view.md) 的订单插件为例，在 `OrdersApi` 上增加 `watch(observer: (revision: number) => void | Promise<void>): RpcTarget`。插件用一个集合登记本地监听，在 `refresh()` 增加 revision 后逐个通知。

```ts
// OrdersPlugin 成员
private readonly listeners = new Set<(revision: number) => void>()

subscribe(notify: (revision: number) => void): Disposable {
	this.listeners.add(notify)
	return { [Symbol.dispose]: () => this.listeners.delete(notify) }
}

async refresh() {
	this.revision += 1
	for (const notify of this.listeners) notify(this.revision)
}
```

在 `OrdersTarget` 构造函数中增加参数 `private readonly signal: AbortSignal`。发布绑定用 `overview: ({ signal }) => new OrdersTarget(this, signal)` 传入本次打开的信号。将 `createWorkbenchWatch` 从 `@pluxel/workbench/server` 导入，并在 `OrdersTarget` 中实现方法。

```ts
watch(observer: (revision: number) => void | Promise<void>): RpcTarget {
	return createWorkbenchWatch({
		observer,
		signal: this.signal,
		subscribe: (notify) => this.orders.subscribe(notify),
	})
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

Workbench Shell 与 renderer 共享同一精确版本的 Mantine。插件可以从 `@mantine/core` 导入排版、按钮、表格和模态框组件。

每个 renderer 都是独立的 React root，Shell 的私有 Provider 不会跨 root 继承。Mantine renderer 在自己的 root 内使用
`WorkbenchMantineProvider`，与 Shell 共享尺寸、字体、颜色名称和组件默认值：

```tsx
import { WorkbenchMantineProvider } from '@pluxel/workbench/mantine'

export function OrdersPage() {
	const { host } = overviewScope.useWorkbench()
	return (
		<WorkbenchMantineProvider colorScheme={host.colorScheme}>
			<OrdersContent />
		</WorkbenchMantineProvider>
	)
}
```

Shell 不给 renderer 容器加内边距，画布类页面可以铺满。普通页面与 Shell 页面对齐：路由文档的最外层用 `p="lg"`，
左、右、底部 panel 用 `p="sm"`。

`@mantine/core`、`@mantine/hooks` 与 `@pluxel/workbench/mantine` 是 Workbench 固定的 MF2 singleton shared，组件和
hooks 在一个 document 内只加载一份。Mantine 基础 CSS 与 CSS 变量由 Shell 统一提供：强调色、表面和明暗跟随用户的
外观设置。`WorkbenchMantineProvider` 因此不输出 CSS 变量和全局 class；直接使用默认 `MantineProvider` 会在
`:root` 写入第二套变量，覆盖 Shell 外观。renderer 不应再次导入 `@mantine/core/styles.css`，producer build 会直接拒绝这种重复。

隔离测试没有 Shell 提供变量时，用 `<MantineProvider theme={workbenchTheme}>` 渲染组件。`host.colorScheme` 是可移植的宿主
外观事实，不暴露 Shell 私有 Provider。其他 UI library 仍由 producer 自己打包并管理 Provider/CSS。
