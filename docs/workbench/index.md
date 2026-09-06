---
title: 插件管理界面
description: 用 Content、Direct View API、Attachment 和 Cap’n Web 为 Plugin 提供管理界面。
---

Workbench 用于给 Plugin 增加说明、轻量运维界面、管理页面和对象编辑器。文档、状态、按钮与一次性表单使用
host-rendered Content；自定义布局和复杂交互使用完整 View。宿主负责认证、WebSocket session、布局、内容交付和页面生命周期。

> 编写新功能时，先从一个[标准配方](#如何选择)开始。此页保留完整 API、生命周期和部署参考；不要为了普通页面先引入
> callback capability、`queryFamily` 或低层 remote-value API。

Workbench-enabled host 固定使用 Cap’n Web over WebSocket。完整 View/Attachment 固定使用 Module Federation 2.0 和
React Bridge；Content 由 Shell 直接渲染，不生成 Plugin JavaScript。Plugin 不选择 transport、loader 或 renderer。
Headless host 可以完全不安装 Workbench，所以业务能力仍应通过
普通 Plugin API 提供，不能依赖某个页面曾经打开。

> 本页的 renderer scope、query 与 mutation API 只用于 Plugin-owned View/Attachment。官方 Shell 的 Management 页面是
> host-private 实现：它按 authenticated document session 管理普通 DTO snapshot。两者虽然共用一条 Cap’n Web socket，
> 但不共享 QueryClient、cache、resource owner 或公共 facade。

## 内置依赖管理

插件概览用同一张「依赖管理」卡片展示必须依赖、可选集成、提供的能力和被依赖关系。依赖抽象能力时，
依赖行同时显示需求与实际实现，例如 `Cache → CachePlugin`。

- **当前插件使用**：只设置当前插件的这条必须依赖。具体插件的「默认实例」使用该插件的默认节点；
  抽象能力的「跟随全局默认」使用该能力的全局默认实现。手动指定实现或 Fork 后，显示「当前插件指定」。
- **提供的能力 / 全局默认实现**：设置该抽象能力的默认提供者，影响所有未单独指定实现的消费者。
  当前插件就是该默认实现时，显示「全局默认提供者」。

单独指定的实现优先于默认选择；恢复默认会移除当前插件的覆盖。修改依赖可能重启受影响的插件及其下游。
修改后，工作台刷新依赖图和已打开的依赖编辑器，未打开的编辑器在下次打开时读取最新设置。

## 内置 Plugin 目录诊断

目录行显示包名或源码位置，旁边只保留一个更新方式 badge，例如“源码 HMR”“入口 HMR”或“部署更新”。来源取自插件定义，
不会因为没有 HMR 信息而变成“未知来源”；静态内置插件也可能使用构建模块，来源与是否 HMR 是两件事。

Plugin 详情默认只展示简短说明（有则显示）、状态和来源。来源旁可以复制插件引用；执行方式、制品、更新边界、启动策略与
最近更新放在默认折叠的“调试信息”中，没有更新记录时不显示空占位。“复制诊断信息”可一次复制引用、执行和更新事实、
运行状态及问题代码，便于排查；不会复制 Vite module ID、绝对文件路径或包安装目录。

工作台分别显示当前运行状态、本插件上次更新记录和所属更新批次。一次应用或插件批次更新可以已提交，
同时只有部分插件的生命周期失败；正常插件不会因此标红。具体错误按插件节点归属，包含失败阶段、原因和阻塞它的依赖；
同一插件的不同 fork 分别记录。资源清理异常也属于上次更新历史，不能据此推断新实例没有运行。

“未报告生命周期”表示该次更新没有这个节点的完整执行报告，不代表启动成功。已修复的运行问题不会改写历史；
是否已恢复应看当前状态。调试信息保留所属批次的范围、结果和序号，便于关联同次更新。提交前失败会说明保留旧定义，
应用重载失败后成功创建补偿宿主会说明使用上一应用定义恢复。

管理协议 v5 将最近更新拆成 `recentUpdate.batch` 和 `recentUpdate.lifecycle`，替代旧的扁平记录。
升级时需要同时更新宿主与 Workbench，重启开发宿主并刷新工作台页面；旧版管理客户端会因协议不匹配而拒绝连接。
自定义客户端应从 `batch` 读取更新结果，仅从本节点的 `lifecycle.issues` 读取历史生命周期错误；
`lifecycle: null` 表示未报告，`{ issues: [] }` 表示该批未报告此节点的生命周期异常，两者都不能替代当前运行状态。

“目录 HMR”表示应用模块图变化时热替换插件目录；入口或应用配置边界变化仍需重建应用。外部包通常显示“入口 HMR”：
替换插件入口可以触发更新，但不会监听包内部源码；只有确认源码在监听图中时才显示“源码 HMR”。制品信息无法确定时显示“未报告”，
不从扩展名或包路径猜测。

正常切换插件、日志等路由不会重建整个工作台。切到另一插件时只重置对应插件的表单和视图，同一插件子路由保留工作台状态；
会话失效或插件发布更新导致的完整刷新仍遵循原有生命周期规则。

单个页面渲染失败会在对应编辑区显示错误与“重试”，其他编辑区和工作台导航保持可用。标签、分栏和布局变化会合并保存到浏览器本地，
切到后台或离开页面时补写待保存的布局；这不保存未提交的插件配置或表单草稿。

目录搜索支持以下字段；多个 token 使用 AND：

- 普通关键词：名称、定义位置、导出名、canonical reference 和 execution 词；
- `@包名`：只匹配 definition address 中的 package name；
- `ref:关键词`：只匹配 canonical reference；
- `exec:关键词`：只匹配制品、更新方式和最近结果，例如 `hmr`、`entry-only`、`bundle`、`restored-previous` 或“失败”。

## 如何选择

- 普通、非敏感的 Plugin 配置：直接声明 `configs.use()`，使用 Workbench 已有的标准 Config UI，不再创建 Content 或 View。
- 展示说明、bounded live state、按钮或一次性 Valibot 表单：使用 [Content 标准配方](./content.md)。
- Secret 不进入普通 config。Config 只保存 Vault 引用；Plugin 已有明确的 provisioning/rotation 契约，且一次表单即可完成时，
  用 Content action 写入 Vault。多步骤 enrollment、OAuth、progress 或 recovery state machine 使用完整 View。
- 需要自定义布局、progress/cancel、分页、high-rate stream 或任意组件：使用 [View 标准配方](./view.md)。
- 页面和 API 由 provider 拥有，但是否出现、出现在哪里由 consumer 决定：使用 [Attachment：跨 Plugin UI](./composition.md)。
- 同一页面编辑不同对象：使用一个 parameterized route，不为每个对象创建 entry。
- 列表、collection、bot account、字体等动态数据：放进 Plugin API 返回值，不建立动态 Workbench 定义。
- 只需要跨 Plugin 的服务端能力：继续使用 constructor dependency，不添加跨 Plugin UI。

例如 Redis 的连接状态和 PING、S3 的 Vault credential replacement 都适合 Content；Agent session 的 streaming、goal、
subagent 与 abort 则是完整 View。Content 不复制通用 Config UI，也不把一次性 secret form 扩展成通用 Vault editor。

三个配方各自只描述一个默认路径；本页以下内容是它们共享的完整契约与高级用法参考。

## Host-rendered Content

Content 的 Markdown、数据和控件都由 Shell 渲染。Plugin 声明 Valibot schema 与 slot，Markdown 决定它们出现的位置：

```ts
// src/workbench.ts
import { v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { formMeta, numberMeta } from 'valibot-form'

const Status = v.object({
	connection: v.pipe(v.picklist(['connected', 'unavailable']), formMeta({ title: '连接状态' })),
	queued: v.pipe(v.number(), v.integer(), v.minValue(0), formMeta({ title: '待处理数量' })),
})

const ProbeInput = v.object({
	timeoutMs: v.pipe(
		v.number(),
		v.integer(),
		v.minValue(100),
		v.maxValue(30_000),
		formMeta({ title: '超时（ms）' }),
		numberMeta({ step: 100 }),
	),
})

export const ServiceWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './overview.md', {
			status: workbench.data(Status),
			refresh: workbench.action({ label: '刷新' }),
			probe: workbench.action({ label: '测试连接', input: ProbeInput, form: 'embedded' }),
		}),
		placement: workbench.tab({ label: '概览' }),
	}),
})
```

```md
# Service

::slot[status]

::slot[refresh]

::slot[probe]
```

Plugin 只实现一次完整读取和 action handlers。领域状态变化时调用 `dataChanged()`；Framework 会合并通知、重新执行
`load()`，再通过现有 Cap’n Web session 把最新完整状态推给 Shell：

```ts
override init() {
	this.ctx.workbench?.publish(ServiceWorkbench, {
		overview: ({ signal, dataChanged }) => {
			this.serviceEvents.addEventListener('change', dataChanged, { signal })
			return {
				load: () => ({ status: this.inspectService() }),
				actions: {
					refresh: async () => {
						await this.refreshService()
						return { ok: true, message: '刷新完成' }
					},
					probe: async ({ timeoutMs }) => {
						await this.probeService(timeoutMs)
						return { ok: true, message: '连接正常' }
					},
				},
			}
		},
	})
}
```

Markdown 在 build time 编译，浏览器不会运行 Markdown parser 或插入 raw HTML。支持普通段落、标题、强调/删除线、
列表、引用、分隔线、代码、bounded GFM table，以及安全的 `https:`、`mailto:` 和本文 fragment link。HTML、图片、
相对链接、JSX 风格标签、task list 与 frontmatter 会使构建失败；`{name}` 一类 MDX expression 只按普通文本处理，
不会执行。

`:slot[key]` 只能在普通 paragraph 中放 inline scalar data；`::slot[key]` 放 block data 或 action。每个声明必须恰好出现一次，
unknown、missing、duplicate、nested 或 inline action 都会使构建失败。Data schema 用于只读展示，不允许 default、transform、lazy、
undefined-producing wrapper 或 password；action input 必须是 host form 支持的 Valibot object，默认用 dialog，`form: 'embedded'`
固定展开。Shell 只提交 raw portable data，Runtime 会在 handler 前再次执行 authoritative Valibot validation。

需要防止误触时给 action 添加确认文案，例如
`workbench.action({ label: '删除', confirm: '确定删除这条记录吗？' })`。Shell 会显示危险样式并在提交前调用 host confirm。
这只是 UX guard，不是授权边界：Framework 会在执行时重新确认 owner generation；handler 仍须根据 open 时认证的
`principal` 重新授权，并在写入前重新检查当前领域状态，不能信任确认框、旧 data 或客户端提交的前置条件。

`load()` 一次返回所有 data keys，并可直接返回领域已有的递归只读 detached snapshot；Framework 不会修改它。`actions` 与声明的
action keys 都必须 exact。含 data 的 Content 执行 Action 后，Framework 会在同一个 `run()` 调用中再 load 一次，所以按钮和表单
不需要自建 snapshot、watch、invalidate 或 RPC target；action-only Content 直接返回 action outcome。`dataChanged()` 没有 payload，表示
“当前 read model 可能已变化”；它提供 latest-state push，不保证逐事件交付。`signal` 是整个 opened Content 的 lifetime signal，
关闭、session 失效或 Plugin replacement 时用于清理领域订阅。

只有 action 的 Content 不调用 `subscribe()`，打开后可直接执行按钮或表单；只有声明了 data，Shell 才建立一个 observer 并执行
initial `load()`。

纯 Markdown Content 省略 slots，并继续 `publish(ServiceWorkbench)`，不创建 root、不占 opened-entry quota，也不生成 MF
producer/Bridge。需要 lossless events、独立并发状态、progress/cancel、server pagination 或任意 React UI 时使用完整 View。

## 完整 View 参考：server push 与 custom callback

下面的例子刻意包含 `watch()` 和 server-side callback target，用于说明跨调用 observer 的 ownership。它不是普通
snapshot + mutation 页面的起点；没有已证实的实时更新需求时，使用[View 标准配方](./view.md)。

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
	#revision = 1
	#openOrders = 0
	readonly #listeners = new Set<(revision: number) => void>()

	override init() {
		this.ctx.workbench?.publish(OrdersWorkbench, {
			overview: ({ signal }) => new OrdersTarget(this, signal),
		})
	}

	snapshot() {
		return Object.freeze({ revision: this.#revision, openOrders: this.#openOrders })
	}

	refresh() {
		this.#revision += 1
		for (const listener of this.#listeners) listener(this.#revision)
		return this.snapshot()
	}

	subscribe(listener: (revision: number) => void) {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
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

每次 Bridge mount 都会创建独立 renderer owner，以 query-core 创建这次 open 私有的 `QueryClient`，并持有 exact
roots/host、subscription 和 close state。即使相同 View 或 route 同时打开多次，也不会跨 open handle、params、
principal、session 或 Plugin generation 共享 data/error/invalidation。这个 client 随 renderer owner 清理，不向 Remote 暴露 raw
`QueryClient`、raw cache 或全局 client。

Query 把 API result 放入 cache 前会验证 portable data、深拷贝、深冻结，并恰好释放一次 top-level transport result。显式
`undefined` field、class instance、accessor、cycle、binary 或 capability 都不能进入 cache。带 subscription 的 query 先订阅再读取；
同 key 的 observers 共享一个 read/subscription，read 期间多次 invalidation 只触发一次 follow-up read。后台失败保留最近成功 data 并
标记 stale/error。`workbench.subscribe` 一旦保留 callback，就必须同步返回或异步 resolve 到 `Disposable`；API
方法通常声明返回 child `RpcTarget`，其 browser-side `RpcPromise` / `RpcStub` 满足该清理契约。

renderer scope 负责 browser-side subscription 的 retain、abort 与 dispose。只有服务端自定义 callback target 才需要自己
`dup()` observer、释放每次 callback result，并在 open signal abort 时 unsubscribe；普通 latest snapshot 不应复制这段样板。

### Query 与 mutation 契约

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

### 稳定错误与恢复

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

## Attachment

Attachment 让 provider 复用一套设置或选择界面，同时让 consumer 保留 placement ownership。完整样例见
[Attachment：跨 Plugin UI](./composition.md)。最小形状是：

```ts
// provider package
export const HttpWorkbench = workbench.define({
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})

// consumer package
export const ReportsWorkbench = workbench.define({
	http: HttpWorkbench.settings.place(workbench.tab({ label: 'HTTP' })),
})
```

Provider 发布 Attachment factory；consumer 发布 placement，并在 binding 中传入 constructor-injected provider Plugin。
Provider 的 renderer 和 API 始终由 provider package 拥有。Consumer 不复制 provider UI，也不创建无意义的转发 API。
Provider renderer 同样为 Attachment descriptor 创建专用 scope；其 query/mutation context 会按声明精确推导为
`{ provider, host }` 或 `{ provider, consumer, host }`，每次 placement open 拥有独立 renderer owner。

## API 设计准则

围绕实际界面设计一个直接 `RpcTarget`：

- 读取复杂状态优先返回 bounded immutable snapshot；大列表使用 cursor/limit；
- mutation 只在界面下一步确实需要时返回 bounded DTO；否则返回 `void`，并声明 typed query invalidation；
- 需要实时更新时由 Plugin 自己提供 `watch(invalidate)`、observer 或 task capability；
- 长任务返回有明确 progress/cancel/dispose 语义的 child `RpcTarget`；
- 只有真实信任边界和领域不变量需要 runtime validation，不为每个内部方法重复声明 schema；
- API 不返回 Plugin、Context、database handle、native object、raw socket 或 Shell service。

Workbench 不替 Plugin 自动生成分页、事件、collection 或数据库协议。普通 helper 能清楚解决的问题留在
Plugin package 内，等出现多个独立真实调用方再考虑抽象。

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

## 生命周期和故障

同一 document 只有一条 `/__pluxel/runtime/session` WebSocket。认证 challenge、Management、Workbench layout、
Plugin API 和 observer 都复用这个 Cap’n Web session。认证或 publication epoch 失效、socket broken 时，页面要求完整
reload；不会在原 document 内切换 transport、重连一部分功能或复用旧 API root。

MF2 manifest 和 JS/CSS 仍通过 HTTP 获取；Content plan 则随现有 `openEntry()` RPC 返回，不增加浏览器 artifact
fetch。浏览器写入 `HttpOnly` cookie 还有一个 single-use cookie-commit POST。这些端点不承载 Workbench RPC。

Plugin stop/replacement 会撤销 publication，并使当前 socket epoch 失效。Shell 销毁所有 active Bridges、释放 opened
handles，再要求整页 reload。开发期 Content/topology 可以先发布，缺失 producer 在后台构建；未就绪或失败的 View/Attachment
placement 会保留在原位置并显示构建中或构建失败状态，producer 成功提交后触发 reload。Production/static build 仍要求
Content/MF candidate 全部验证并原子提交后才生效。

Bridge destroy 也会关闭 per-open renderer owner：私有 `QueryClient`、subscription 与 active mutation lifetime 一次清理。Pending
`refetch()` / `mutateAsync()` 会以 closed error 及时拒绝；无法取消的 RPC 可以在后台 settle，但晚到的 fulfilled DTO 仍会
detach/dispose，且不会再更新已关闭页面。Portable/scope/key/limit/closed 与 mutation-pending 错误提供稳定 code；Plugin
自己的领域/RPC error 保持原样。

Plugin 启停命令的 `ok: true` 表示运行意图与 graph commit 已应用，不保证每个 `init()` 或 drain 都成功。Workbench 会继续读取
`report.core.summary.lifecycleReport`：目标 Plugin 有结构化 lifecycle issue 时直接显示该 issue 的安全 message；只有 report 没有
可解释当前节点的 issue、但观察状态尚未达到目标时，才显示“运行状态仍未收敛”的协调提示。

## Vite 与反向代理

Static/dynamic Vite adapter 在 Vite 自己的 Node listener 上接入 Runtime HTTP/Upgrade，并先让 Vite HMR socket 匹配；开发者
不需要为 Workbench 再启动或代理一个端口。

生产反向代理只需保留同源路径并正确转发 WebSocket Upgrade：Workbench document、`/__pluxel/` HTTP endpoints、MF assets
和 `/__pluxel/runtime/session` 应到达同一个 Runtime deployment。Runtime 不相信 `Forwarded` / `X-Forwarded-*` 推断
physical TLS 或 locality。内建 production Node launcher 只监听 HTTP，因此默认只通过 loopback/SSH tunnel 管理，不通过普通
TLS 反代开放 remote Management，反代也不应从 loopback 地址回源。需要 remote Management 的平台集成必须提供自身能证明
HTTPS 的 application carrier。多实例部署还需要让 control socket、OIDC callback 和短期 cookie ticket 命中签发它们的实例。

## 验证清单

- Workbench disabled 时 Plugin 核心 API 与 headless 行为正常；
- Definition、binding 和 renderer descriptor 的类型保持 exact；
- Content-only Plugin 不生成 MF producer/Bridge；纯 Markdown Content 没有 server-side opened lease；
- Content 的 HTML、图片、不安全链接、错误 slot topology 和超预算内容在 build/RPC 边界被拒绝；
- data/action schema、binding keys、load result 和 action input 在 publication/RPC 边界 fail closed；
- live data 按 sequence 应用，失败保留最近成功状态并可手动 retry；
- 每次打开创建 fresh target，关闭、abort 和 replacement 会清理 subscription/task；
- 每次打开还创建独立 renderer owner；并行 View 不共享 query/mutation/cache/invalidation；
- query 的 subscribe-before-read、coalescing、canonical keyed identity、stale failure 与 typed invalidation 有测试；
- mutation per-hook single-flight，并在 RPC/detach failure 后仍执行已声明 invalidation；
- RPC 输入预算、领域授权和稳定失败码有 Plugin 自己的测试；
- awaited DTO 在进入 React state/cache 前已验证、深复制、深冻结并释放 top-level remote result；
- parameterized route 的 params 由 server 匹配；
- Attachment provider/consumer owner 与 placement 正确；
- production build 对完整 View 包含标准 `mf-manifest.json`、所有 exposes 和动态类型，对 Content 包含已验证的 immutable plan；
- Vite HMR 与 Runtime session Upgrade 都由同一 listener 正确分流；
- 反向代理保留 Upgrade、同源 cookie 和短期 handoff 的实例归属；
- 页面没有备用 API transport 或 reconnect 分支。

跨 Plugin UI 的完整范式与 API 示例见[Attachment：跨 Plugin UI](./composition.md)。
