---
title: 查询、写入与页面资源
description: 查询选项、刷新策略、错误处理、数据边界和 UI Provider 的按需参考。
---

先完成 [View 教程](./view.md)中的读取和按钮，再在需要分页、自动刷新或错误恢复时查本页。
`scope` 把一组查询和写入绑定到某一个页面声明；每次打开页面都有独立的缓存、订阅和操作状态。

## 先确定谁触发刷新

| 状态如何变化           | 写法                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| 只由本页按钮修改       | mutation 声明 `workbench: { invalidates: [query] }`              |
| 后台或其他页面也会修改 | query 用 `workbench.subscribe` 订阅服务端通知                    |
| 通知已经覆盖本次写入   | mutation 不再重复声明 invalidation                               |
| 查询参数随用户选择变化 | 使用 `queryFamily()`，用 `target(input)` 或 `all()` 指定刷新范围 |

查询与写入的声明可放在模块顶层；当前页面的 API、缓存和结果只能通过该页面的 Hook 取得。
关闭页面后旧 controls 失效，再次打开会创建一份新状态。

## 按参数查询

下面假设页面 API 另外提供 `order(id)` 和 `rename(input)` 方法：

需要按输入读取时使用 `queryFamily((context, input) => options)`，并用 `query.useQuery(input)`。Factory 为每个输入生成具体、
领域可读的 `queryKey`；Key 会先验证和 canonicalize，结构相等的 portable key 共享同一 query。
`query.target(input)` 只失效该 key，`query.all()` 失效当前 family 的已有 keys。Invalidation target 是当前 scope 的 opaque typed
value，不是 global cache key；不能交给另一个 renderer scope。

Options factory 是同步、确定且无副作用的声明函数：Hook 解析资源和 mutation 预检 family target 时都可能再次执行它。
不要在 factory 中读取时间、发起 I/O、注册 subscription 或修改外部状态；这些行为分别留给 `queryFn`、
`workbench.subscribe` 和 `mutationFn`。同一个 canonical `queryKey` 必须始终描述同一份读取语义。

```ts
const orderQuery = overviewScope.queryFamily(({ api }, input: Readonly<{ id: string }>) => ({
	queryKey: ['orders', 'detail', input.id] as const,
	queryFn: ({ signal }) => {
		signal.throwIfAborted()
		return api.order(input.id)
	},
}))

type RenameOrderInput = Readonly<{ id: string; name: string }>

const renameOrder = overviewScope.mutation(({ api }) => ({
	mutationFn: (input: RenameOrderInput) => api.rename(input),
	workbench: {
		invalidates: (input: RenameOrderInput) => [orderQuery.target({ id: input.id })],
	},
}))
```

Workbench roots（`api` / `provider` / `consumer`）只由外层 factory 捕获。`queryFn` 接收 query-core 原生的
安全 context：规范化后的 `queryKey` 与 `signal`；不会混入 Pluxel 自定义参数。`signal` 首先用于本地取消和阻止晚到
结果提交；除非领域 API 明确提供本地 cancellation adapter，不要把 `AbortSignal` 当 RPC DTO 传输。

无输入的具体 query 本身就是 exact invalidation target；query family 必须显式选择 `target(input)` 或 `all()`，避免一个
family 在代码中含糊地代表“某个 key”还是“全部 key”。

## 数据与订阅如何清理

每次打开 React 页面都会创建独立的 `QueryClient`，保存此次打开的 API、订阅与关闭状态。即使相同 View 或 route 同时打开多次，也不会跨 open handle、params、
principal、session 或 Plugin generation 共享 data/error/invalidation。这个 client 随 renderer owner 清理，不向 Remote 暴露 raw
`QueryClient`、raw cache 或全局 client。

Query 把 API result 放入 cache 前会验证 portable data、深拷贝、深冻结，并恰好释放一次 top-level transport result。显式
`undefined` field、class instance、accessor、cycle、binary 或 capability 都不能进入 cache。带 subscription 的 query 先订阅再读取；
同 key 的 observers 共享一个 read/subscription，read 期间多次 invalidation 只触发一次 follow-up read。后台失败保留最近成功 data 并
标记 stale/error。`workbench.subscribe` 一旦保留 callback，就必须同步返回或异步 resolve 到 `Disposable`；API
方法通常声明返回 child `RpcTarget`，其 browser-side `RpcPromise` / `RpcStub` 满足该清理契约。

renderer scope 负责 browser-side subscription 的 retain、abort 与 dispose。只有服务端自定义 callback target 才需要自己
`dup()` observer、释放每次 callback result，并在 open signal abort 时 unsubscribe；普通 latest snapshot 不应复制这段样板。

## Query 与 mutation 契约

| 选项或操作                   | 当前语义                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                    | TanStack-compatible boolean；Workbench 默认 `true`。`false` 时当前 observer 不自动读取或持有 subscription，但当前 Hook 的显式 `refetch()` 仍执行一次读取。                                                                                                    |
| `staleTime`                  | TanStack-compatible 毫秒数；无 subscription 时默认 `0`，有 `workbench.subscribe` 时默认 `Infinity`。显式 invalidation 始终覆盖 freshness。                                                                                                                    |
| `retry`                      | TanStack-compatible retry；Workbench 默认 `false`。predicate 签名为 `(failureCount, error) => boolean`；renderer boundary failure 不 retry。                                                                                                                  |
| `retryDelay`                 | TanStack-compatible delay；接受非负毫秒数或 `(failureCount, error) => number`，省略时沿用 query-core backoff。                                                                                                                                                |
| query `signal`               | 由 query-core 通过 `queryFn` context 提供；读取被替代、query deactivate 或 renderer close 时 abort。底层若不观察 signal 仍可 settle，Workbench 仍会 detach/dispose 晚到结果并阻止其提交。                                                                     |
| mutation `signal`            | 由外层 mutation factory 捕获，只在 per-open renderer owner close 时 abort。Hook unmount 和 `reset()` 不会伪装取消已接受的写入。                                                                                                                               |
| `mutate()` / `mutateAsync()` | `mutate()` 用于 event handler 的 fire-and-observe，失败进入 Hook state，不向外泄漏 rejected Promise；pending 时的重复调用保留当前 pending state。`mutateAsync()` 用于需要 result 或显式流程编排的调用，并会 reject pending duplicate。两者经过同一 pipeline。 |
| mutation `reset()`           | 只把 settled success/error state 清回 idle；pending 时不取消，也不重置。                                                                                                                                                                                      |

Query result 提供 `status`、`data`、`error`、`isPending`、`isFetching`、`isStale` 和 instance-bound
`refetch()` / `invalidate()`。`refetch()` 返回本次显式读取的 Promise；`invalidate()` 同步标 stale，只为 active observers
调度读取。Controls 只在产生它的 Hook 仍挂载时有效：卸载后 `refetch()` reject、`invalidate()` throw；同一个
`queryFamily` Hook 切换 input 后，旧 input 的 result controls 也立即失效。Module-scoped resource 不提供无法判定 open
handle 的命令式刷新。

`useMutation()` 是 per-hook single-flight：普通 event handler 直接调用 `mutation.mutate(input)`，再从 Hook state 呈现结果；只有
需要返回值或显式 `await` / `catch` 的流程才使用 `mutateAsync()`。Pending 时第二次 `mutateAsync()` 稳定失败，不自动
queue 或猜测幂等性。Hook 卸载后不能从旧 controls 启动新 mutation：`mutate()` throw、`mutateAsync()` reject，`reset()`
no-op；卸载前已接受的 mutation 仍按 owner lifetime settle。若 mutation result 只是下一份 snapshot 的重复副本，领域 API 应返回 `void`，并用权威 subscription 或
`workbench.invalidates` 刷新 query；只有 UI 确实消费的 domain result 才返回 portable DTO。

静态 freshness 关系写 `workbench: { invalidates: [query] }`，只有 target 依赖 mutation input 时才使用 callback；callback
复用并显式标注 `mutationFn` 的 variables type，避免把 freshness mapping 悄悄放宽成 `any`。若
mutation commit 必然通过同一权威 subscription 通知当前 snapshot，就省略该 mutation 的
`workbench.invalidates`；若通知可能丢失、延后，或 RPC reject/detach failure 后仍必须刷新，则声明 invalidation。
Framework 会 coalesce 同期 invalidation，但作者仍应只声明真实 freshness authority，避免 subscription 与 invalidation
无条件触发双重刷新。Targets 会在调用远端方法前完成 scope/key 验证；owner 仍 active 时，在 mutation settle 后标
stale，即使 RPC reject 或 result detach 失败也一样。Mutation success 不等待 invalidated query 的读取完成。

Query/mutation options 是公开类型明确列出的受控 allowlist，不承诺透传 TanStack Query 的全部 options。
TanStack 原生 query/mutation 字段保持顶层；Workbench 自有的 subscription 和 typed invalidation 只出现在
`workbench` namespace。Factory 返回的顶层与 `workbench` 对象在 TypeScript 中都是 exact；未知字段会在作者
typecheck 时拒绝，非 TypeScript 调用方或绕过类型的值仍会由 Runtime fail-fast 校验。

## 稳定错误与恢复

| `code`                               | 作者应如何处理                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `WORKBENCH_RENDERER_CLOSED`          | 当前 open 已结束；停止更新，后续交给新的 open 重建。                                               |
| `WORKBENCH_RENDERER_HOOK_INACTIVE`   | 丢弃已卸载 Hook 或旧 family input 的 controls；从当前 render 重新取得 controls。                   |
| `WORKBENCH_RENDERER_SCOPE_MISMATCH`  | 修正 descriptor、scope、resource 或 invalidation target 的 wiring，不要在 scopes 间复用 resource。 |
| `WORKBENCH_RESOURCE_KEY_INVALID`     | 修正 `queryKey` / `target(input)`，只返回有界 portable key。                                       |
| `WORKBENCH_RESOURCE_LIMIT_EXCEEDED`  | 缩小 queryKey，或减少 active query keys / mutation targets；不要盲目 retry。                       |
| `WORKBENCH_MUTATION_PENDING`         | 等待当前 Hook 的 mutation settle，再接受下一次写入。                                               |
| `WORKBENCH_NON_PORTABLE_VALUE`       | 让 API 返回普通 portable DTO；移除 `undefined`、class、accessor、cycle、binary 与 capability。     |
| `WORKBENCH_PORTABLE_VALUE_TOO_DEEP`  | 扁平化 DTO，避免把深层对象图当作 snapshot。                                                        |
| `WORKBENCH_PORTABLE_VALUE_TOO_LARGE` | 分页、裁剪字段或按 key 拆分读取。                                                                  |
| `WORKBENCH_TRANSPORT_DISPOSE_FAILED` | 修复 top-level transport result 的 disposer/ownership，并检查错误的 `cause`。                      |

低层 `useWorkbench(exactDescriptor)`、`useRemoteValue()` / `createRemoteValue()` 和
`detachWorkbenchPortableValue()` 仍是高级 escape hatch：适用于单组件自管 read owner、callback/progress/cancel、lossless event
或 capability handle。手工 await DTO 时，必须用 detach helper 建立 ownership continuation；不要把 transport-owned result、
capability 或已经释放的 proxy 放入 React state。

每个 renderer 由 React Bridge 挂载为独立 React root。若 renderer 使用 Mantine、router、i18n 等依赖 Context 的 UI
library，应在自己的 root 内安装 Provider，并由 producer import 所需样式；Shell 的私有 Provider 不会跨 root 继承，也不是
Workbench API。例如 Mantine renderer 的入口可以直接写成：

```tsx
import { MantineProvider } from '@mantine/core'

export function OrdersPage() {
	const { host } = overviewScope.useWorkbench()
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<OrdersContent />
		</MantineProvider>
	)
}
```

这里的 Provider 属于 renderer root，不能从 Shell 继承；但 `@mantine/core` 与 `@mantine/hooks` 是 Workbench 固定的 MF2
singleton shared，组件和 hooks 在一个 document 内只加载一份。Mantine 基础 CSS 也由 Shell 统一加载，renderer 不应再次导入
`@mantine/core/styles.css`，producer build 会直接拒绝这种重复。`host.colorScheme` 只是可移植的宿主外观事实，不暴露 Shell
私有 Provider 或 theme object。其他 UI library 仍由 producer 自己打包并管理 Provider/CSS。
