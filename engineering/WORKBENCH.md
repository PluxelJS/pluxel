# Workbench 架构

Workbench 是 host-owned 的插件管理界面。它只投影已经存在的 Plugin 状态和操作，不成为业务能力、
领域状态或 Plugin dependency 的替代品。一个 Workbench-enabled host 固定使用以下交付路径：

- Cap’n Web over WebSocket 承载认证、Management、layout、View API 和双向通知；
- Shell 自己渲染 build-time 编译的 Content portable plan、live data 与固定控件；
- 完整 View/Attachment 才通过 Module Federation 2.0 与 React Bridge 交付 Plugin-owned UI。

这些路径是固定产品契约，不提供可替换 transport、loader 或 renderer SPI。Workbench 可以在 headless
部署中整体不安装。Content-only Plugin 不生成 MF producer，也不需要 React Bridge；只要一个 definition 含 View 或
Attachment renderer，就必须满足完整 MF/Bridge contract，不能退化成另一种 loader。

Shell 首页可以通过 Management metadata 显示 browser-safe host platform snapshot：JavaScript runtime/version、`std-env` 检测到的
deployment provider、CI、mode 与 OS platform。该 snapshot 是诊断提示而非 capability guarantee；尤其 provider detection 不等于当前
request 必然运行于该 provider。不得向 browser 投影完整 environment、变量名、路径、token、certificate 或 secret。

## 平台边界

Workbench 只定义五个作者概念：

| 概念       | 作用                                                    | 所有者                                    |
| ---------- | ------------------------------------------------------- | ----------------------------------------- |
| Definition | 一组固定的 Content、View、Attachment 和 placement       | Plugin definition                         |
| Content    | Shell 渲染的 Markdown、live data、按钮和一次性表单      | 发布它的 Plugin                           |
| View       | Plugin 自己放置、自己提供 API 和界面的页面              | 发布它的 Plugin                           |
| Attachment | provider 提供界面和 provider API，consumer 决定是否放置 | provider declaration + consumer placement |
| Placement  | `tab()` 或 `route()` 的产品位置                         | Content/View owner 或 Attachment consumer |

Workbench 不定义数据库查询模型、领域事件模型、集合注册表、动态 feature registry 或通用 schema 层。
Content 承载说明、bounded latest state、短 action 和一次性 Valibot form；Shell 拥有 renderer 与 transport adapter。
自定义布局、lossless stream、分页、progress/cancel 或任意组件使用完整 View，并由 Plugin 公开直接的 `RpcTarget`。

普通 Plugin 配置已经由 ConfigService 和标准 Config UI 从 `configs.use()` schema 投影，不应再复制成 Content。
Secret 不进入普通 config；config 只保存 Vault reference。只有 Plugin 已经拥有明确的 credential provisioning/rotation
契约且一次表单即可完成时，才用 Content action 写入 Vault。多步骤 enrollment、OAuth、progress 或 recovery state
machine 使用完整 View；Workbench 不提供无领域 schema 的通用 Vault record editor。

`collection`、bot account、font family、document row 等始终是 Plugin 领域对象。它们可以由一个 manager
View 管理，也可以由 Attachment 选择，但不会因数量变化而创建 Workbench entry、MF producer、socket 或
平台 identity。

业务代码必须在 Workbench disabled 时仍能运行。跨 Plugin 的服务端协作继续使用 constructor dependency；
Attachment 只复用 provider 的界面，不建立新的业务依赖机制。

## 公开作者面

本节只固定平台概念、包边界与 server-side ownership；作者可复制的 options、默认值、错误行为和完整示例以
[`docs/workbench/index.md`](../docs/workbench/index.md) 为唯一权威，Attachment/manager/collection 的选择指南以
[`docs/workbench/composition.md`](../docs/workbench/composition.md) 为唯一权威。Shell 的 React 状态分层与 Management query
实现属于 [`engineering/FRONTEND.md`](./FRONTEND.md)，不能从“共用一条 WebSocket”推导为共用 renderer resource owner。

```ts
workbench.define({ ... })
workbench.content({ document, placement })
workbench.markdown(import.meta.url, './guide.md', slots?)
workbench.data(schema)
workbench.action({ label, input?, form?, confirm? })
workbench.view<Api>({ renderer, placement })
workbench.attachment<ProviderApi, ConsumerApi?>({ renderer })
attachment.place(placement)
workbench.entry(import.meta.url, './ui.tsx')
workbench.tab({ ... })
workbench.route('/path/:param', { ... })
ctx.workbench?.publish(definition, bindings)
ctx.workbench?.publish(staticContentDefinition)
useWorkbench(exactDescriptor)
useRemoteValue({ read, subscribe? })
createWorkbenchRenderer(exactDescriptor)
scope.query((roots) => ({ queryKey, queryFn, workbench? }))
scope.queryFamily((roots, input) => ({ queryKey, queryFn, workbench? }))
scope.mutation((roots) => ({ mutationFn, workbench? }))
```

入口职责固定为：

- `@pluxel/runtime/workbench`：browser-safe definition builder 和类型；
- `@pluxel/runtime/workbench/react`：renderer scope、query/mutation、低层 exact descriptor hook、host facade 和 Pane Kit；
- `@pluxel/runtime/workbench/client`：conforming Shell 使用的 session/opened-handle client，以及手动 portable DTO detach；
- `@pluxel/runtime/capnweb`：固定版本的 `RpcTarget`、`RpcStub` 和 WebSocket session bridge。

Plugin author 不取得 raw socket、MF Runtime、Shell router/store、Bridge wrapper props 或 server registry。
Toolchain 生成的 Bridge wrapper ABI 固定在 `@pluxel/runtime/internal/workbench-react`；它与其他 internal readers
只供构建器和 Shell 使用，不进入作者 API。

## Definition 与源码组织

一个有 Workbench 内容的 Plugin 使用下列文件：

```text
src/workbench.ts       browser-safe API、DTO 和固定 definition
src/index.ts           Plugin、领域实现和 publish()
src/*.md               可选 Content source
src/ui/*.scope.ts      每个 renderer 的 exact scope 与 resource declarations
src/ui/*.tsx           可选完整 View 的 React renderer/page
```

`workbench.ts` 可以从 package 的 `./workbench` subpath 导出，供依赖者引用 Attachment descriptor。它不能
导入 Plugin instance、Context、database handle、Node builtin 或 secret。`workbench.entry()` 的第二个参数必须
是 module-relative literal；`workbench.markdown()` 的 source 同样必须是 module-relative literal。两者只是 toolchain
可追踪的源码 provenance，不是运行时 dynamic import 或文件读取。

Definition 是 flat、frozen、固定键集合：

```ts
export const OrdersWorkbench = workbench.define({
	manager: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.route('/orders', {
			title: 'Orders',
			navigation: { label: 'Orders' },
		}),
	}),
})
```

Entry key 与 owning `PluginDefinitionAddress` 构成 declaration identity。Attachment placement 还包含 consumer
definition 和 provider Attachment identity。源码路径、class name、`displayName`、MF remote name 和数组顺序都不参与
这项 identity。

Definition 只声明固定拓扑。运行期 item 可见性、权限和业务状态进入 `RpcTarget` 返回值；不得通过动态增删 entries、
按 principal 生成 definition 或每个 item 发布一个 View 表达。

## Publication 与 target 生命周期

Plugin 在 `init()` 中最多发布一次。Bindings 包含 View、Attachment 与 interactive Content，且键必须与所有需要 binding 的
entry 完全一致；纯 Markdown Content 不接收 binding：

```ts
this.ctx.workbench?.publish(OrdersWorkbench, {
	manager: ({ principal, params, signal }) =>
		new OrdersTarget(this.orders.authorizedFor(principal), { params, signal }),
})
```

`publish()` 从当前 Plugin Context 推导 owner，并把 publication 绑定到 generation effects。`PluginPart` 不能直接
发布；owning Plugin 聚合 Part 需要的 entries。Publication 只有在 owner generation committed/running 时进入 layout，
stop、replacement、rollback 或 shutdown 都沿同一 effects 路径撤销。

Factory 只在用户实际打开入口时运行。View/Attachment 每次返回 fresh `RpcTarget`；interactive Content 返回 exact
`load/actions` binding，由 Framework 创建唯一的 per-open root。Open context 由平台构造：

- `principal` 来自当前已认证 socket epoch；
- `params` 由 server 对 declared route 重新匹配并冻结；
- `signal` 在 View close、socket close、owner withdrawal 或超时时 abort。

Factory 不取得 raw request、auth provider、consumer Context 或 service locator。`RpcTarget` 可以引用 Plugin 已有的
领域 service，但 target 自己的 observer、subscription、task 和缓存必须随 `signal` 或 target disposer 清理。

Workbench 不要求 API 另外声明方法 schema。TypeScript interface 约束调用面，Cap’n Web 负责对象图和 capability
传输；Plugin 仍负责它真正需要的输入预算、领域授权和稳定失败码。内部管理页并不等于可信调用方。

## Content

Content 用于运行中 Plugin 的说明、bounded live state、短 action 和一次性 Valibot form，不向作者暴露 API root：

```ts
const Status = v.object({
	connected: v.boolean(),
	queued: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

export const ServiceWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './overview.md', {
			status: workbench.data(Status),
			refresh: workbench.action({ label: '刷新' }),
		}),
		placement: workbench.tab({ label: '概览' }),
	}),
})

this.ctx.workbench?.publish(ServiceWorkbench, {
	overview: ({ dataChanged }) => ({
		load: () => ({ status: this.inspect() }),
		actions: {
			refresh: async () => {
				await this.refresh()
			},
		},
	}),
})
```

Markdown 在 build time 编译为不可变、有界的 portable AST。普通节点保持原有安全 allowlist；`:slot[key]` 是 inline scalar
data，`::slot[key]` 是 block data 或 action。每个 declaration 必须恰好放置一次；unknown、missing、duplicate、nested、带
attributes 或 inline action 都 fail build。浏览器再次验证 plan；Shell 不运行 Markdown parser、不插入 raw HTML，也不加载
Plugin JavaScript。

Runtime publication 将真实 Valibot schema 投影成 portable presentation，并校验 artifact/declaration/binding exact match。
Data schema 是 transform-free display validation；action input 是 object/object-intersection form schema，默认 dialog，
`form: 'embedded'` 固定展开。Server 在 handler 前执行 portable-data budget 与 authoritative Valibot parse；schema、closure、
handler 和 secret 都不会发到浏览器。

`load()` 的作者返回类型递归只读，允许直接复用 detached domain snapshot；Runtime 仍重新校验并投影 portable value，
不会要求 Plugin 为 transport 制造可变深拷贝。Action input 则是 Runtime 完成 authoritative parse 后交给 handler 的 fresh value，
保持 Valibot `InferOutput` 的原始可变性。

每次 interactive Content open 由 Framework 创建一个 root。含 data 时，`subscribe()` 先 retain Browser callback，再 initial
`load()`；action-only Content 不订阅。`dataChanged()` 只置 dirty，Framework 串行 load、合并中间通知，并推送带递增 sequence 的
latest full state。手动 load 与 action 共用一个有界 lane；含 data 时，action 在 handler 已开始后总会 post-load；action-only 返回
`data: null`。Shell 只应用较新的 sequence，
后续读取失败保留最近成功 data 并标记 stale。Observer failure 会关闭对应 opened-entry lease、abort author lifetime signal 并释放
quota，不影响 session 其他 entry。

`confirm` 是可选确认文案。Shell 用它显示危险样式并在提交前调用 host confirm，但它只防止误触，不是授权边界。
Framework 在执行时重新确认 owner generation；handler 仍必须根据 open 时认证的 `principal` 重新授权，并在写入前重新检查
当前领域状态，不能信任确认框、旧 data 或客户端提交的前置条件。

纯 Markdown Content 没有 slot/binding/root，只做短 owner admission并返回 pinned plan；它不占 opened-entry quota。Interactive
Content 与 View 共用已有 quota、owner lease、session epoch 和 disposal。两者都不是 package 未运行时仍可访问的离线页面。
需要 lossless events、多个独立 loading state、progress/cancel、server pagination 或任意 renderer 时使用完整 View。

## View

View 同时拥有 renderer、placement 和一个 API root：

```ts
export interface OrdersApi extends RpcTarget {
	snapshot(): OrdersSnapshot
	refresh(): Promise<OrdersSnapshot>
	watch(invalidate: () => void): RpcTarget
}

export const OrdersWorkbench = workbench.define({
	overview: workbench.view<OrdersApi>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.tab({ label: 'Orders' }),
	}),
})
```

普通 snapshot/watch View 使用 renderer-specific scope 声明 query 和 mutation。Scope module 是 renderer graph
唯一可以 value-import exact definition 的位置；模块级 scope/resource 都是 frozen declaration，不保存当前 API root、cache
或 subscription。为让文件与符号可预测，scope module 和 scope symbol 应跟随 descriptor entry：`<entry>.scope.ts` 与
`<entry>Scope`；resource 再按领域语义命名：

```tsx
// src/ui/overview.scope.ts
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

默认 entry 只把 page 绑定到 scope，保持 generated Bridge 的零 props ABI：

```tsx
// src/ui/overview.tsx
import { OrdersPage } from './orders-page.js'
import { overviewScope } from './overview.scope.js'

export default overviewScope.render(OrdersPage)
```

Renderer graph 内的 page/panel 直接复用同一个 scope/resource：

```tsx
// src/ui/orders-page.tsx
import { ordersQuery, overviewScope, refreshOrders } from './overview.scope.js'

export function OrdersPage() {
	const { host } = overviewScope.useWorkbench()
	const orders = ordersQuery.useQuery()
	const refresh = refreshOrders.useMutation()
	// ...
}
```

`render()` 为每次 Bridge mount 创建独立 renderer owner 和基于 query-core 的私有 `QueryClient`，持有本次
exact roots、host、subscription 和 close state；Bridge destroy 时从一条路径清理。即使相同 descriptor、route 或
Attachment 同时打开，也不会跨 open handle、principal、params、session 或 owner generation 共享状态。私有 client
随 renderer owner 清理；Workbench 不暴露 raw `QueryClient`、query key/cache 或 global client。

Query 的结果进入 cache 前统一通过 portable detach：只接受有界的 `null`、boolean、finite number、string、dense array 和 plain
object，不接受显式 `undefined`、class、accessor、cycle、capability 或 binary。Framework 深拷贝、深冻结并恰好释放一次
top-level transport result；late result 也会释放但不会提交。带 `workbench.subscribe` 的 query 先订阅再读取，以
invalidation 为 freshness
authority；并发 read single-flight，read 中的多次通知合并为一次 follow-up read。后台读取失败保留最近成功 data 并标 stale/error。
`workbench.subscribe` 若保留 callback，必须同步返回或异步 resolve 到 `Disposable`；领域 API 通常返回 child
`RpcTarget`，browser-side `RpcPromise` / `RpcStub` 提供该 disposer。

无输入的 `scope.query(factory)` 和按输入构建的 `scope.queryFamily((context, input) => options)` 都必须产生
领域稳定的具体 `queryKey`。Workbench roots（`api` / `provider` / `consumer`）只由外层 factory 捕获；
`queryFn` 只接收 query-core 原生安全 context，例如 `signal` 和规范化后的 `queryKey`，不混入 Pluxel 自定义参数。
Query/mutation options 是公开类型明确列出的受控 allowlist，不承诺透传 TanStack Query 的全部 options。TanStack
原生字段保持顶层；Workbench 自有扩展只使用 `workbench.subscribe` 和 `workbench.invalidates`。Factory 返回类型必须
对顶层与 `workbench` 字段保持 compile-time exact，Runtime 对绕过类型的未知字段继续 fail-fast。
Options factory 必须同步、确定且无副作用；Hook resolution 和 family target preflight 都可以重复执行它。I/O、subscription
注册与 mutation 副作用分别只发生在 `queryFn`、`workbench.subscribe` 和 `mutationFn`。
Workbench 默认 `enabled: true`、无 subscription 时 `staleTime: 0`、有 subscription 时 `staleTime: Infinity`，并默认
`retry: false`；这些 owner-aware defaults 是公开契约，不等同于透传 query-core 的全局默认。Query signal 会随读取替换、
deactivate 或 owner close 而 abort；mutation factory 的 signal 只随 owner close abort，Hook unmount/reset 不取消已接受的写入。

同一 owner 内相同 key 的 observers 共享 read/subscription。Hook result 包含 `status/data/error`、
`isPending/isFetching/isStale` 以及 instance-bound `refetch()` / `invalidate()`；resource declaration 不提供无法判定 open
handle 的命令式操作。这些 controls 只属于产生它的 active Hook/当前 family input；卸载或 input replacement 后旧 controls
以 `WORKBENCH_RENDERER_HOOK_INACTIVE` 失败，不能在 cache GC 后复活脱离 typed invalidation sidecar 的 observer。Concrete query 本身就是 scope-typed exact invalidation target；query family 显式提供
`query.target(input)` / `query.all()`。静态关系声明为 `workbench: { invalidates: [query] }`，需要 mutation input 时才
使用 callback；input-derived callback 显式复用 mutation variables type，不能放宽成 `any`。Targets 在调用远端方法前验证，owner 仍 active 时在 settle
后标记 stale。RPC reject 或 result detach failure 仍 invalidates；owner 已关闭时 cache 已被销毁。Mutation 每个 Hook
single-flight。事件处理器用 `mutate()` 并从 Hook state 观察结果；需要返回值或流程编排时使用
`mutateAsync()`。Pending 时第二次调用不会覆盖当前 state，`mutateAsync()` 会以稳定 code 失败；Runtime 不猜测写操作的幂等性
或执行顺序。若 mutation result 只是下一份 snapshot 的重复副本，领域 API 返回 `void`，由权威 subscription 或 typed invalidation
触发 query 重读；只有 UI 确实消费的 domain result 才返回 portable DTO。

如果 query 的权威 subscription 已覆盖某项 mutation，并保证在 commit 后通知，就不再为同一 query 声明
`workbench.invalidates`；两条路径会把一次提交放大成重复读取。没有 subscription 的 query，或 subscription 没有覆盖该写操作，
才使用 mutation invalidation。

Descriptor 同时完成 TypeScript 推导和运行时 identity 校验。`createWorkbenchRenderer()`、scope hook 与 invalidation target 都会拒绝
scope mismatch。低层 `useWorkbench(exactDescriptor)`、`useRemoteValue()` / `createRemoteValue()` 和
`detachWorkbenchPortableValue()` 继续作为高级 escape hatch：适用于单组件自管读取、callback/progress/cancel、lossless event 或
其他不应放入 query cache 的 capability protocol。它们不接受字符串 key，也没有可枚举的全局 API namespace。

参数化 route 只声明一次：

```ts
account: workbench.view<AccountApi>({
	renderer: workbench.entry(import.meta.url, './ui/account.tsx'),
	placement: workbench.route('/accounts/:accountId', { title: 'Account' }),
})
```

一个 manager 可以调用 `host.navigation?.openDocument()` 打开不同 `accountId`。所有 account 共用同一个 descriptor、
Bridge expose 和 producer；每个实际打开的 document 才获得独立 API root 和 abort signal。

## Attachment

Attachment 解决唯一一种跨 Plugin UI 组合：provider 拥有界面，consumer 决定把它放在哪里。它不自动投影
provider 的其他 View，也不扫描 dependency graph 寻找任意 renderer。

Provider 声明并发布：

```ts
export const HttpWorkbench = workbench.define({
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})

this.ctx.workbench?.publish(HttpWorkbench, {
	settings: ({ consumer, signal }) =>
		new HttpSettingsTarget(this.settings.forConsumer(consumer.node), signal),
})
```

Consumer 通过正常 constructor dependency 取得 provider，并放置 Attachment：

```ts
export const ReportsWorkbench = workbench.define({
	http: HttpWorkbench.settings.place(workbench.tab({ label: 'HTTP' })),
})

this.ctx.workbench?.publish(ReportsWorkbench, {
	http: { provider: this.http },
})
```

Renderer 为 `HttpWorkbench.settings` 创建专用 scope，并通过 `scope.useWorkbench()` 得到 `{ provider, host }`。Provider factory
只获得 exact consumer node address，用它索引 provider 自己已经拥有的 per-consumer state；它不能取得 consumer instance 或
Context。

如果 consumer 也拥有必须由这个界面修改的状态，Attachment 声明第二个 API generic：

```ts
workbench.attachment<CatalogApi, SelectionApi>({ renderer })
```

Placement binding 再提供 `consumer: () => new SelectionTarget(...)`，renderer 得到
`{ provider, consumer, host }`。两个 roots 分别保留自己的 owner、授权和清理路径，不能互相转发成一个万能 facade。

## Manager、collection 与 bot 场景

FontManager 类需求采用稳定 topology：

- manager View 管理字体、collection、分页和 CRUD；
- provider API 返回 catalog/snapshot，并提供需要的 watch；
- consumer 只持久化 stable collection ID 和自己的 fallback policy；
- picker Attachment 同时读取 provider catalog 与 consumer selection；
- 服务端渲染仍直接调用 constructor-injected FontManager dependency。

创建、改名或删除 collection 只改变 FontManager domain state。删除后 consumer 保存的 ID 可以投影为 `missing`，
由 consumer 决定保留、清除还是 fallback；provider 不越权批量改写 consumers。只有产品确实需要多个并行独立
editor 时，才增加一个 parameterized View，仍不为每个 collection 建 entry。

BotManager 同理：一个平台 Plugin 可以声明 overview、accounts、diagnostics 和可选 account document。Telegram、KOOK、
Discord 等平台只在确实共享普通 TypeScript builder 时复用 declaration 生成函数；它们继续拥有独立 Plugin lifecycle、
persistence、factories 和 failure boundary。Bot account 是 row，不是 Plugin 或 Workbench identity。

更完整的作者样例见 [`../docs/workbench/composition.md`](../docs/workbench/composition.md)。

## 页面唯一的 Cap’n Web session

Workbench document 创建一个物理 WebSocket：

```text
/__pluxel/runtime/session
```

同一 socket 上的 bootstrap 状态是封闭联合：

1. 未认证时只返回 authentication capability；
2. password、TOTP 或 OIDC challenge 在同一 Cap’n Web object graph 中完成；
3. 认证完成后再次 bootstrap，得到 Management capability；Workbench-enabled host 同时返回 Workbench session；
4. layout、openEntry、Management mutation、logs follow、Content push 和 Plugin API 都复用这条 socket。

浏览器写入 `HttpOnly` cookie 需要一个 same-origin、single-use cookie-commit POST；它只提交短期 ticket，不承载
业务 API 或 RPC。MF manifest 和 JS/CSS 使用普通 HTTP。除此之外，Workbench 不建立另一种 API transport。

一个 document 不做 feature reconnect。认证 authority、publication inventory 或 socket epoch 失效时，server 先发送
`epoch-invalidated`，随后关闭物理连接；Shell 销毁 active Bridges、释放 opened handles，并要求完整 document reload。
同一 document 不创建第二条 session，不重建部分 roots，也不恢复旧 workspace 上的 remote instance。

Node production 与 static/dynamic Vite 使用同一个 runtime carrier seam。Vite 保留 listener 和 HMR Upgrade 优先权，
Runtime 只接管匹配的 control/business Upgrade。反向代理必须保持同源 cookie、WebSocket Upgrade 和短期 handoff 的
实例归属；Runtime 不从 forwarding headers 推导 physical TLS 或 locality。

## Layout 与打开流程

`WorkbenchSessionApi` 只有两个操作：

```ts
layout({ target })
openEntry({ layoutRevision, target, descriptor, location? })
```

Layout 是 capability-free 的 immutable snapshot，只包含目标、placement、declaration/openable identity、owner revisions，
以及 discriminated federated View 或 Content reference。它不携带 Plugin API root、Content plan 或可遍历的服务字典。

打开流程固定为：

1. Shell 从当前 layout 选择 entry；
2. `openEntry()` 校验 revision、target、descriptor 和 route，并做 owner admission；
3. 纯 Markdown Content 返回 pinned plan 并立即释放短 admission；
4. interactive Content 返回 pinned plan、portable presentation 和 fresh framework root；含 data 时 Shell subscribe，action-only
   Content 直接渲染；
5. local View 返回 fresh API root；Attachment 返回 provider root，并按声明可选返回 consumer root；
6. federated branch 通过 pinned manifest/expose 加载并校验 Bridge；
7. Shell 创建 per-open host facade，render Bridge；
8. close 时先 destroy Bridge，再关闭 host facade，最后 dispose opened handle。

任一步失败都释放 candidate roots，不发布半激活 entry。每个 session 最多 64 个 retained interactive entries，factory 默认
15 秒超时；纯 Markdown Content 不占 quota，也不执行 factory。Layout revision 改变、target 不可用和 quota/factory failure 使用
封闭 code 返回；编程或 transport failure 继续 reject。

## Content artifact

Content plan 是独立的 content-addressed artifact，不注入 server JavaScript，也不伪装成 MF producer。Production topology 为：

```text
dist/workbench/
  pluxel-workbench-content.json
  content/<definition-digest>/<content-set-digest>/content-plan.json
```

Inventory、definition digest、content-set digest、canonical path 和内容在加载时全部复核。Plugin package 可以只保留预编译
Content artifact；production Runtime 不依赖发布包中的 `src/*.md`。Static assembly、dynamic distribution discovery 和 dev
compiler 都向同一个 Runtime Content artifact store 提交验证后的 immutable Content set。

同一 definition 同时含 Content 与 federated renderer 时，两类 candidate 必须作为一个 revision 原子提交。Prepare 或 commit
任一步失败都回滚已提交部分并保留完整 last-known-good tuple；成功后才通过 session epoch invalidation 触发 full reload。
浏览器通过现有 `openEntry()` RPC 取得 plan，不增加任意 artifact HTTP fetch。

## MF2 交付与 React Bridge

Toolchain 在 TypeScript 擦除前读取 `workbench.define()` 和 literal `workbench.entry()`，把同一 Plugin definition
的所有 View/Attachment renderer 合并为一个 producer。每个 declaration 生成一个稳定 `./views/<key>` expose 和
一个 Bridge wrapper。Content 不进入 producer；generated Bridge 只投影 renderer declaration identity，不导入含 server schema/handler 的
完整 definition。作者不手写 remote name、expose、shared、public path 或 manifest URL。

使用 renderer scope 的 source graph 必须包含唯一的 `createWorkbenchRenderer(ExactDefinition.entry)`，通常位于专用
`*.scope.ts(x)`；只有该 module 可以直接 value-import 当前 definition，其他 page/panel 通过 scope/resource 间接取得 API，
跨 renderer shared component 只接收普通 props/data。低层 `useWorkbench(exactDescriptor)` renderer 仍可在 default entry 保留
唯一 direct definition import，但同一 graph 不能再有第二个 boundary。Semantic lowering 把 exact import 改写为 browser-only
descriptor projection，并保留 View/Attachment 的 exact API types；renderer JS 不执行 server definition module。
Indirect/re-export/dynamic definition import、错误 entry 或跨 renderer 复用 scope 都在 build 时拒绝。

生产产物以 `mf-manifest.json` 为唯一浏览器模块事实；Snapshot 由标准 Manifest 生成。Host 只保存
`Plugin definition + build revision -> immutable artifact root/manifest URL` 的冻结 inventory，不复制 Manifest 的 assets、shared
或 types 字段。Manifest、remote entry、expose inventory、dynamic types 和 shared versions 必须全部验证后才能提交。
提交时 Host 对 producer root 的全部 regular files 建立 digest inventory，并只服务这份冻结集合；Manifest 的 assets
字段不是 remote entry 内部 import closure 的完整文件清单，不能被误作 HTTP 白名单，也不需要解析生成的 JavaScript 补全。

固定 singleton shared 包括：

- `react`、`react/jsx-runtime`、`react/jsx-dev-runtime`；
- `react-dom`、`react-dom/client`；
- `@mantine/core`、`@mantine/hooks`；
- `@module-federation/bridge-react`；
- `@pluxel/runtime/workbench`、`/client`、`/react`。
- `@pluxel/runtime/internal/workbench-react`。

版本必须精确匹配并使用 `loaded-first`。Shell 先建立 winner，再按需注册 remote；不接受第二份 React 或 Mantine，
也不允许 Plugin 局部覆盖 share policy。Producer 对固定 shared 使用 `import: false`，不携带 fallback。Router、编辑器和
领域 library 等未进入固定 profile 的依赖继续由 producer 自己 bundle。

Bridge wrapper 是 toolchain 生成的内部 ABI。它把 opened handle 与 host facade 放进每个 Bridge instance 独立的
React Context，然后调用零 props renderer。Remote 不读取官方 Shell private Context。Bridge destroy 是释放 portal、effect、
subscription 和 document chrome 的唯一 UI lifecycle 边界。

每个 Bridge application 是独立 React root，因此 UI library 的 Context 不能从 Shell 跨 root 继承。Mantine renderer 必须在
自己的 renderer root 内创建 `MantineProvider`，但 Provider 和全部 Mantine component/hook 实现来自 Shell 提供的 singleton
shared module；`@mantine/core` 基础 CSS 同样只由 Shell 加载，producer build 会拒绝重复导入。Router、i18n 或其他 Context
library 仍由 producer 自己拥有 Provider、module 和 CSS。Remote 可以从 `host.locale`、`host.colorScheme` 等固定 portable fact
初始化或同步表现，但不能读取 Shell 的私有 Provider 或 theme object。共享 module instance 不会改变 React Context 的祖先边界。

开发期 renderer 变化先发布 definition topology 与 Content artifact；缺失或过期的 producer 不阻塞 Runtime 启动，
对应 View/Attachment placement 仍保留在 layout 中，并由 Shell 显示 `building` 状态。producer runtime build 使用持久
Vite cache 在后台补齐，成功提交后通过 session epoch invalidation 触发整页 reload；失败会把同一 placement 更新为
`failed` 状态并显示安全错误 message，下一次变更或启动会重试。
开发期 producer 可以省略 dynamic type artifact，Manifest/Snapshot/shared/expose 运行时合约仍验证。

Production/static assembly 不走后台降级路径：producer candidate 必须一次性通过 Manifest、Snapshot、dynamic types
和 shared version 验证后才能提交。不做页内 remote replacement，不把新 roots 接到旧 Bridge，也不在加载失败时尝试其他
build revision。

## Host facade 与 Pane Kit

`scope.useWorkbench()` 或低层 `useWorkbench(exactDescriptor)` 返回的 `host` 只包含固定行为：

- `locale`、`colorScheme`；
- `notify()`、`confirm()`；
- 可空的 relative `navigation`；
- 参数化 document 的 params、dirty marker 和 title；

Remote 不取得 generic HTTP client、raw socket、Shell store 或 unrestricted URL navigation。复杂页面可以使用
`WorkbenchPaneLayout` / `WorkbenchPane` 声明 navigation、primary、inspector 三栏；宿主拥有 resize、drawer、focus
和 workspace persistence。

官方 Shell 把当前标签页的 Pane Kit 操作投影为头部的 navigation toggle、primary focus/restore 和 inspector toggle。
这是同一份 per-tab visibility state 的另一种入口，不新增 Remote layout state；primary 仍不可隐藏。Plugin detail 的
plugin rail、assist 与 bottom dock 是 host-private 四区 chrome，不映射为 Pane Kit role。

## 资源所有权与清理

下列事件会使整个 socket epoch 或已经打开的 handle 失效：

- authentication/logout/revoke；
- Plugin owner 或 Attachment provider stop/replacement；
- publication、部署 producer inventory 或 Content artifact inventory 改变；
- physical WebSocket broken；
- entry close。

Content validation 或 Bridge activation failure 只拒绝本次 activation，并释放已经取得的资源；它们不会凭空创建 handle，
也不会单独使 socket epoch 失效。

Owner withdrawal 先关闭 invocation admission、abort open signal，再等待已接纳调用并 drain generation effects。
Opened handle 对 Cap’n Web 返回的顶层 object graph 负责；renderer 若手工 await object DTO，使用
`detachWorkbenchPortableValue()` 完成 portable-data 校验、深拷贝和 transport result 释放。不能把 transport-owned result
直接放入 React state，也不能用 Plugin 自己的宽松 clone 绕过普通对象、`undefined`、accessor、cycle 与容量约束。
Observer/callback 需要跨调用保留时必须 `dup()`，subscription target 的 disposer 负责释放 callback 和领域 unsubscribe。

Renderer query/mutation owner 仍遵守同一边界：Bridge teardown 使私有 QueryClient、subscription 和 active Hook state inactive，pending
`refetch()` / `mutateAsync()` 及时 closed-reject；无法取消的 RPC 可以继续 settle，但晚到的 fulfilled DTO 必须
detach/dispose，不能再更新 React。Framework 自身的 portable、scope、key、limit、closed 与 mutation-pending failure 使用
稳定 error code；领域/RPC error 保持原样。

## 验证不变量

实现或修改 Workbench 时至少验证：

- 一个 document 只有一个 physical session 和一个 MF Runtime；
- auth challenge、ready bootstrap、Management、View API 和 logs follow 使用同一 socket；
- definition/bindings exact，descriptor identity 不可伪造；
- 纯 Markdown Content 没有 binding、RPC root、MF producer、Bridge 或 retained-root quota；
- Content plan 只包含二次验证后的 portable AST/slot topology，Shell 不解析 Markdown 或插入 raw HTML；
- interactive Content 的 presentation、binding、load data 和 action input 在各自 trust boundary exact validation；
- `dataChanged()` coalescing、sequence ordering、stale/retry 和 observer fatal close 均有并发/lifecycle tests；
- 每次 open 都返回 fresh roots，close/timeout/replacement 会 abort 并清理；
- 同一 descriptor 并行打开时 renderer QueryClient、subscription、mutation 和 invalidation 完全隔离；
- query subscribe-before-read、single-flight/coalescing、stale-data failure、canonical key 与 typed invalidation 均有测试；
- mutation per-hook single-flight，且 reject/detach failure 后仍执行已声明 invalidation；
- portable DTO 同步/Promise detach 都深冻结并在成功、失败和 late settle 时释放 top-level transport result；
- provider-only 与 provider+consumer Attachment 都保持正确 owner；
- Manifest/expose/shared/Bridge 不匹配会在 commit 或 activation 前失败；
- Bridge destroy 发生在 opened handle dispose 之前；
- mixed Content/MF candidate 原子提交；失败保留完整当前 revision，成功后完整 reload；
- dynamic rows 数量不改变 definition、producer 或 socket 数；
- headless host 不初始化 Workbench backend，但 Plugin 业务能力仍正常。

## 实现入口

- `packages/runtime/src/workbench/definition.ts`
- `packages/runtime/src/workbench/client-protocol.ts`
- `packages/runtime/src/workbench/client.ts`
- `packages/runtime/src/workbench/portable-value.ts`
- `packages/runtime/src/workbench/react.tsx`
- `packages/runtime/src/workbench/renderer-scope.tsx`
- `packages/runtime/src/workbench/react-internal.tsx`
- `packages/runtime/src/workbench/federation.ts`
- `packages/runtime/src/services/workbench/WorkbenchRegistry.ts`
- `packages/runtime/src/services/workbench/WorkbenchContentArtifactService.ts`
- `packages/runtime/src/services/workbench/WorkbenchContentPresentation.ts`
- `packages/runtime/src/services/workbench/WorkbenchContentTarget.ts`
- `packages/runtime/src/services/workbench/WorkbenchSessionTarget.ts`
- `packages/runtime/src/web/session/`
- `packages/rolldown/src/workbench/semantic-lowering.ts`
- `packages/rolldown/src/workbench/content-compiler.ts`
- `packages/rolldown/src/vite/workbench-ui.ts`
- `packages/workbench-app/src/app/workbench/WorkbenchContentRenderer.tsx`
