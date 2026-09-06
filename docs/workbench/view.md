---
title: View：Plugin-owned React 页面
description: 用 Direct View 的 fresh API root、renderer scope、query 和 mutation 构建自定义 Plugin UI。
---

当页面需要自定义布局、分页、progress/cancel、high-rate stream 或任意 React 组件时，使用 View。Plugin 拥有 API 和 renderer，
宿主只提供 placement、认证 session、受限 host facade 与页面生命周期。

默认从 snapshot query + mutation invalidation 开始。只有确实需要 server push、callback、progress/cancel 或 lossless stream 时，
才增加 child `RpcTarget` 或低层 remote API。

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

在 `init()` 中 publish 一次；每次打开都返回 fresh target：

```ts
override init() {
	this.ctx.workbench?.publish(OrdersWorkbench, {
		overview: ({ principal, params, signal }) =>
			new OrdersTarget(this.orders.authorizedFor(principal), { params, signal }),
	})
}
```

target 只把当前页面需要的领域 API 投影为 `RpcTarget`。按 principal 或 route admission 在 factory 中完成；target 持有的 task、observer
或 subscription 必须随 `signal` 或自身 disposer 清理。

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

page 直接使用同一 scope/resource，不传递 API root 或 cache：

```tsx
import { ordersQuery, overviewScope, refreshOrders } from './overview.scope.ts'

export function OrdersPage() {
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()

	if (orders.status === 'pending') return <p>Loading…</p>
	if (orders.status === 'error' && orders.data === undefined) return <p>Unavailable</p>

	return (
		<button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
			Refresh {orders.data.openOrders} orders
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

`query`/`mutation` 的完整选项、stable renderer error code、portable DTO 约束、Mantine root、placement、lifecycle 和 proxy
部署要求见[完整 Workbench 参考](./index.md)。Provider-owned 页面需要由 consumer 放置时，使用
[Attachment：跨 Plugin UI](./composition.md)。
