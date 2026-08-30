---
title: 插件管理界面
description: 用 Direct View API、Attachment 和 Cap’n Web 为 Plugin 提供管理界面。
---

Workbench 用于给 Plugin 增加管理页面、设置页、诊断页和对象编辑器。Plugin 直接声明页面和一个
Cap’n Web API；宿主负责认证、WebSocket session、布局、浏览器模块加载和页面生命周期。

Workbench-enabled host 固定使用 Cap’n Web over WebSocket、Module Federation 2.0 和 React Bridge。
Plugin 不选择 transport、loader 或 renderer。Headless host 可以完全不安装 Workbench，所以业务能力仍应通过
普通 Plugin API 提供，不能依赖某个页面曾经打开。

## 如何选择

- 页面由当前 Plugin 自己拥有：使用 `workbench.view<Api>()`。
- 页面和 API 由 provider 拥有，但是否出现、出现在哪里由 consumer 决定：使用 Attachment。
- 同一页面编辑不同对象：使用一个 parameterized route，不为每个对象创建 entry。
- 列表、collection、bot account、字体等动态数据：放进 Plugin API 返回值，不建立动态 Workbench 定义。
- 只需要跨 Plugin 的服务端能力：继续使用 constructor dependency，不添加 UI composition。

## 最小完整示例

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

### 3. 编写零 props renderer

`src/ui/overview.tsx` 默认导出零 props component：

```tsx
import { useRemoteValue, useWorkbench } from '@pluxel/runtime/workbench/react'
import { OrdersWorkbench, type OrdersSnapshot } from '../workbench.js'

export default function OrdersOverview() {
	const { api, host } = useWorkbench(OrdersWorkbench.overview)
	const snapshot = useRemoteValue<OrdersSnapshot>(
		{
			read: async () => {
				using remote = await api.snapshot()
				return Object.freeze({
					revision: remote.revision,
					openOrders: remote.openOrders,
				})
			},
			subscribe: (invalidate) => api.watch(() => invalidate()),
		},
		[api],
	)

	if (snapshot.state === 'loading') return <p>Loading…</p>
	if (snapshot.state === 'error') return <p>Unavailable</p>

	return (
		<button
			onClick={async () => {
				using next = await api.refresh()
				host.notify({ message: `Revision ${next.revision}` })
			}}
		>
			Refresh {snapshot.value.openOrders} orders
		</button>
	)
}
```

`useWorkbench()` 必须接收这个 renderer 对应的 exact descriptor。View 得到 `{ api, host }`；Attachment
根据声明得到 `{ provider, host }` 或 `{ provider, consumer, host }`。不传基础设施 props，也不按字符串查找 API。

Cap’n Web awaited object result 可能携带 transport disposer。需要放进 React state 的 DTO 先复制，再释放 remote result；
不要把已经释放的 proxy 存入 state。`useRemoteValue()` 是一个很小的 snapshot owner，不是平台查询语言或持久缓存。

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
[插件间 UI 组合](./composition.md)。最小形状是：

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

## API 设计准则

围绕实际界面设计一个直接 `RpcTarget`：

- 读取复杂状态优先返回 bounded immutable snapshot；大列表使用 cursor/limit；
- mutation 返回界面下一步需要的 snapshot 或稳定可分支结果，避免随后再请求一次；
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

## 生命周期和故障

同一 document 只有一条 `/__pluxel/runtime/session` WebSocket。认证 challenge、Management、Workbench layout、
Plugin API 和 observer 都复用这个 Cap’n Web session。认证或 publication epoch 失效、socket broken 时，页面要求完整
reload；不会在原 document 内切换 transport、重连一部分功能或复用旧 API root。

MF2 manifest 和 JS/CSS 仍通过 HTTP 获取；浏览器写入 `HttpOnly` cookie 还有一个 single-use cookie-commit POST。
这些端点不承载 Workbench RPC。

Plugin stop/replacement 会撤销 publication，并使当前 socket epoch 失效。Shell 销毁所有 active Bridges、释放 opened
handles，再要求整页 reload。开发期 UI candidate 只有在 Manifest/expose/shared/Bridge 验证成功后才提交；失败不会替换
当前完整版本。

## Vite 与反向代理

Static/dynamic Vite adapter 在 Vite 自己的 Node listener 上接入 Runtime HTTP/Upgrade，并先让 Vite HMR socket 匹配；开发者
不需要为 Workbench 再启动或代理一个端口。

生产反向代理只需保留同源路径并正确转发 WebSocket Upgrade：Workbench document、`/__pluxel/` HTTP endpoints、MF assets
和 `/__pluxel/runtime/session` 应到达同一个 Runtime deployment。Runtime 不相信 `Forwarded` / `X-Forwarded-*` 推断
physical TLS 或 locality；remote Management 必须使用 TLS passthrough、HTTPS upstream，或直接由 Pluxel listener 终止 TLS，
反代也不应从 loopback 地址回源。多实例部署还需要让 control socket、OIDC callback 和短期 cookie ticket 命中签发它们的
实例。

## 验证清单

- Workbench disabled 时 Plugin 核心 API 与 headless 行为正常；
- Definition、binding 和 renderer descriptor 的类型保持 exact；
- 每次打开创建 fresh target，关闭、abort 和 replacement 会清理 subscription/task；
- RPC 输入预算、领域授权和稳定失败码有 Plugin 自己的测试；
- awaited DTO 在进入 React state 前已复制并释放 remote result；
- parameterized route 的 params 由 server 匹配；
- Attachment provider/consumer owner 与 placement 正确；
- production build 包含标准 `mf-manifest.json`、所有 exposes 和动态类型；
- Vite HMR 与 Runtime session Upgrade 都由同一 listener 正确分流；
- 反向代理保留 Upgrade、同源 cookie 和短期 handoff 的实例归属；
- 页面没有备用 API transport 或 reconnect 分支。

插件间组合范式与完整 API 示例见[组合模式](./composition.md)。
