# Direct-capability Workbench authoring

> 本文定义 Plugin 作者的最小 Workbench 调用面。所有动态交互直接使用 [`CONTROL_PLANE.md`](CONTROL_PLANE.md) 的同一 Cap’n Web/WS
> object graph；Workbench 不再在 Cap’n Web 上建立 Model/Query/Channel/Collection resource type system。
> Publication 与 MF renderer lifecycle 分别见 [`PUBLICATION.md`](PUBLICATION.md) 和 [`FEDERATION.md`](FEDERATION.md)。
> 完整 Plugin-facing 候选 API 调用点见 [`EXAMPLES.md`](EXAMPLES.md)。

## Workbench 只增加两个 UI 声明

| 声明         | 唯一职责                                                      | 不拥有的东西                                  |
| ------------ | ------------------------------------------------------------- | --------------------------------------------- |
| `View`       | target Plugin 拥有的 renderer + placement + 一个 root API     | transport、socket、Plugin lifecycle           |
| `Attachment` | required provider 的 renderer/API，由 consumer 选择 placement | provider discovery、arbitrary state、registry |

`ViewApi` 只是“这个 View 打开后拿到的 root capability”的角色名，不是第三种 Workbench resource。
它就是 Plugin 自己声明和实现的普通 Cap’n Web TypeScript interface/RpcTarget；Workbench 不再要求另一份 runtime contract。

Definition 只是一个 Plugin generation 原子发布的 frozen Views/Attachments record，不成为第四种 runtime entity。多页面复用使用普通 TypeScript
function 生成最终 View descriptors；没有 `Feature` address、install、registry、version、lease 或 protocol kind。

Collection 同样不是 Workbench 概念。它最多是领域里的 `Page<T>`/row 值，或由 server domain service 管理的对象。创建
一万个 collection/account 不会创建一万个 View、route、stub、Bridge、MF remote 或 publication entry。

## 作者只需要五条判断规则

Workbench 不提供抽象选择菜单。新增交互按固定顺序判断：

1. renderer 与 placement 都属于当前 Plugin：声明 `View`；
2. renderer 属于 direct required dependency、placement 属于当前 Plugin：声明 `Attachment`；
3. 领域读取、mutation 与 push：直接放进该 View/Attachment 已有的 Cap’n Web root；
4. 普通结果返回 bounded by-value data；只有对象确实需要独立调用、取消或撤销时才返回 child capability；
5. navigation、document chrome、notification 与文件 bytes 等 browser 行为：使用固定 host facade。

如果一个需求不满足第 2 条，就不应使用 Attachment；如果不满足第 4 条，就不应创建 child target。Definition、publication、opened-view lease、
MF registration 和 WS scheduling 都由 platform package 管理，不进入 Plugin 作者的日常 mental model。

## ViewApi 就是原生 Cap’n Web API

Plugin 只声明自己会实际使用的 TypeScript surface：

```ts
export interface SettingsViewApi {
	snapshot(): SettingsSnapshot
	update(input: SettingsInput): Promise<MutationAck>
	watch(notify: (revision: number) => void): SubscriptionApi
}
```

Server target 直接 `extends RpcTarget implements SettingsViewApi`；renderer props 中的 `api` 是上游 `RpcStub<SettingsViewApi>`。
Stub method 调用按 Cap’n Web 原生类型返回 `RpcPromise<Awaited<Result>>`，支持正常 `await` 与 promise pipelining。`LocalViewProps<Api>`
只是把 `api: RpcStub<Api>` 与固定 host facade 放进 Bridge props 的便捷投影，不是另一份 Server/Client contract。Workbench 不生成 proxy
DSL、不枚举 method、不要求 `capability.define/method/target/callback`，也不为 domain API 计算 schema hash。

Factory typing 只需表达异步准备这一种真实需求：

```ts
type ViewTargetFactory<Api> = (
	context: ViewOpenContext,
) => (RpcTarget & Api) | Promise<RpcTarget & Api>
```

Attachment 对 provider/target 使用同一规则。这个 generic 在 TypeScript 擦除后不存在，runtime 只检查 resolved value 确实是
`RpcTarget`，不会伪装成能检查 `Api` 的 method shape。异步 factory 用于 Plugin 自己的授权、数据库准备或 route object admission；Workbench
在 opened-view signal 与固定 deadline 内等待，失败或超时不返回部分 root。

责任边界：

- Cap’n Web 负责 invocation、serialization、callback、stream、promise pipelining、capability transfer 与 dispose；
- Workbench 负责哪个 owner 可以在何时取得哪个 root，以及 owner/view/socket close 后的撤销；
- Plugin 负责 domain input validation、authorization、业务不变量、stable result、分页上限与兼容策略；
- Plugin 可以使用 Valibot、Standard Schema、手写 parser 或已有 domain service，但这些都不是 Workbench dependency/conformance；
- platform 只实施 connection/message/in-flight/callback queue 等粗粒度限额，不理解 `snapshot/list/watch/run` 的语义。

同源 Remote Plugin 是 cooperative trusted code，不是 sandbox；强制每个方法声明 schema 不能把它变成 security boundary。另一方面，浏览器值仍可能被
DevTools、旧 UI 或错误代码构造，所以修改持久状态的 Plugin 方法必须在自己的 domain boundary 保住业务不变量，不能把 TypeScript 当成输入验证。

Cap’n Web 会暴露 `RpcTarget` 的 prototype methods。Target class 应只保留真正 RPC methods，把实现委托给 private service，并用 JavaScript
`#private` 隐藏非 RPC prototype member；TypeScript `private` 不能形成运行时边界。

Browser-safe API 文件只声明 pinned Cap’n Web `RpcCompatible` 支持的 by-value/capability shapes；普通 application-defined class、cyclic
value 或 server-only type 不跨边界。TypeScript/lint/import boundary 尽早拒绝不兼容 declaration，实际值仍由 Cap’n Web serializer 最终执行其原生
兼容性检查；Workbench 不为此增加 runtime schema DSL。Stub、`RpcPromise`、`[Symbol.dispose]` 与 target disposer 都沿用上游语义；Workbench
只额外保证 View close/withdrawal 即使遇到 retained duplicate 也会撤销 internal opened-view lease，不依赖 GC 或引用计数最终正确。

## 常见交互全部是 API shape

| Workbench 情境                  | Direct-capability shape                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| settings/config                 | `snapshot()` + `update()`/`reset()`                               |
| dashboard/live status           | `snapshot()` + `watch(observer)`                                  |
| paged list/CRUD                 | `list({ cursor, limit, filter })` + `get/create/update/remove`    |
| object document                 | `open(id)` 返回 child capability，或 bounded `get(id)`            |
| logs/events/live tail           | historical `list()` + callback/Cap’n Web stream                   |
| long-running operation          | command 返回 `TaskTarget`；`state/cancel/watch`                   |
| action progress                 | method 接收 narrow progress observer，或返回 `TaskTarget`         |
| upload/download/export          | API 签发 single-use HTTP ticket；`host.transfer` 传 bytes         |
| dialog/navigation/notification  | Bridge 获得固定 host facade；不进入 Plugin API                    |
| editable business document      | `host.document` 提供 params、dirty 与 title；无 close callback    |
| cross-plugin picker/settings UI | provider `Attachment`，必要时另外接收一个 exact target capability |

这张表是 recipe，不是十种 protocol entity。Cap’n Web 已经原生负责 method call、pipelining、callback、capability transfer 和 dispose；Workbench
只固定何时创建/撤销 object graph。

## Host facade 只承载 browser 交互

Renderer 不应把 browser document 行为绕回 server ViewApi。Profile 1 固定注入一个窄 facade：

```ts
type WorkbenchHostFacade = Readonly<{
	locale: string
	colorScheme: 'light' | 'dark'
	notify(input: NotificationInput): void
	confirm(input: ConfirmInput): Promise<boolean>
	navigation: WorkbenchNavigation | null
	document: WorkbenchDocument | null
	transfer: WorkbenchTransfer
}>

type WorkbenchNavigation = Readonly<{
	navigate(path: string): void
	openDocument(input: { path: string; title: string; meta?: string }): void
}>

type WorkbenchDocument = Readonly<{
	params: Readonly<Record<string, string>>
	setDirty(dirty: boolean): void
	setTitle(input: { title: string; meta?: string }): void
}>
```

`document` 只在 Shell document/tab 中存在。`setDirty()` 是幂等 marker；关闭时由 host 使用自己的确认 UI，不回调 remote
`beforeClose()`。`setTitle()` 只改当前 document chrome，不改 route identity/layout。`transfer` 只消费 ViewApi 签发的
single-use ticket，统一 upload/download 的 credential、progress、cancel、expiry 和 stable failure；不是 generic HTTP client。
`document.params` 必须来自同一次 `openView()` 返回的 server-derived params，不得由 Shell 再解析 browser location 或接收 remote 覆盖。

`navigation` 只接受当前 target declared route 的 canonical relative path。`navigate()` 替换当前 document，`openDocument()` 打开或聚焦独立
document；它们不能跳任意 host URL，也不能通过 title/meta 改变 route identity 或 server authority。

Ephemeral UI state 留在 renderer；持久业务状态走 ViewApi；document identity 由 canonical relative URL 表达。没有 `host.state` 或 generic
host key-value store，直到至少两个真实 fixture 证明它比这三种 owner 更清晰。

Bridge destroy 时 host 自动清除 dirty/title 和 active transfer。Facade 不暴露 Shell router/store、tab ID、raw `fetch`、socket 或
MF Runtime。

## Placement 只固定 tab、route 与分组 metadata

Workbench 只有 `tab` 和 `route` 两种 placement。Route 只接受静态整段与 `:param` 整段参数；parameterized route 必须
`navigation: false`，由集合页通过 `openDocument()` 打开。Exact route 总是优先于 parameterized route；两个可能匹配同一 canonical path 的
parameterized pattern 在 definition/publication 时拒绝，不能让注册顺序决定结果。

Navigation group 只是 route 上的 by-value layout metadata：stable group ID、label 与 optional icon。它不会获得 registry、owner、lease、API 或
MF expose；Shell 每次从当前 layout 派生分组。同一个 group ID 的 label/icon 必须完全一致，跨 Plugin 冲突使 candidate publication 明确失败，不能
静默选择先注册者。BotManager 等多个相关页面可以共享这项 metadata，但每个 View、route、capability 与 Plugin lifecycle 仍然独立。

## Remote value helper 是 client library，不是 wire protocol

多数管理页面需要 `loading | ready | stale | error`。`runtime/workbench/client` 固定提供一个 `createRemoteValue()`：

```ts
const settings = createRemoteValue({
	read: () => api.snapshot(),
	subscribe: (invalidate) => api.watch(invalidate),
})
```

它负责 current opened View 内的 initial read、latest request、invalidation coalescing、last-known-good 与 cleanup，但不会要求 server
实现统一的 cache/revision protocol。为避免 initial read/watch gap，语义固定为：

1. 有 `subscribe` 时先建立 subscription，再开始 initial `read`；
2. initial/active read 期间收到的任意多次 invalidation 合并为随后一次 latest reread；
3. 任意时刻最多一个 active read，sequence/epoch guard 保证旧结果不能覆盖更新结果；
4. dispose 会先拒绝新 read，再释放 subscription 与 pending result；
5. connection epoch 改变时废弃整个 helper，不复用旧 stub、snapshot authority 或 subscription，fresh root 重新 subscribe/read。

省略 helper 的 View 可以直接调用 typed stub；省略 `subscribe` 时 helper 只是具备 latest-result/cleanup 的一次 read resource。

Helper 不 resume 断开的 stub，不跨 epoch 保留 writable authority。Fresh session 必须重新取得 ViewApi，并由领域 client 决定重新读取哪些 snapshot。

## 列表不是 Collection 资源

FontManager、BotManager、catalog、history 和搜索都使用普通方法：

```ts
interface FontManagerViewApi {
	list(input: FontListInput): Promise<FontPage>
	install(input: InstallFontInput): Promise<FontSnapshot>
	remove(input: RemoveFontInput): Promise<MutationAck>
	watch(observer: FontCatalogObserver): SubscriptionApi
}
```

`FontPage` 必须有 stable item ID、cursor/limit 与 byte/row ceiling。通用 `Page<T>` 若能缩短调用点，可以作为普通
schema/type helper；它没有 runtime identity 或 lifecycle。Invalidation 后 client 重新读取当前 page；Profile 1 不先实现 generic
patch engine、canonical params cache、collection registry 或 per-row capability。后台客户端很少时，bounded page re-read 比一套通用
diff/revision state machine 更容易证明正确。

真正需要独立撤销、长生命周期操作或大对象行为时，方法可以返回 declared child capability；普通 list row 保持 by-value。Consumer 业务选择仍存入
consumer config/domain state，并在 server 通过 constructor-injected provider capability 验证，不存 Cap’n Web stub、provider string 或 Workbench
grant。

### Provider 管理对象，consumer 只拥有选择

FontManager 一类“父 Plugin 制造对象，依赖 Plugin 选择消费”的结构直接映射到现有 owner：

- provider domain service 拥有 row、容量、持久化、删除与 provider generation lifecycle；
- consumer domain service 只持久化 stable provider item ID 和自己的 selection policy；
- required Plugin dependency 在 server 直接注入 provider business capability，负责验证 ID 并完成实际消费；
- provider 拥有 picker renderer 时才声明 Attachment；provider API 列候选项，optional target API 写 consumer selection。

因此没有 global collection resolver、consumer 持有的 remote stub 或 per-row capability。Provider 删除 item 后如何处理旧选择，是领域的
`missing | fallback | rejected` policy，不是 Workbench lifecycle。

## Long task 与 stream 直接使用 child capability

```ts
interface RebuildTaskApi {
	state(): RebuildTaskSnapshot
	cancel(): void
	watch(observer: RebuildTaskObserver): SubscriptionApi
}

interface IndexViewApi {
	rebuild(input: RebuildInput): RebuildTaskApi
}
```

Task target 绑定 internal opened-view lease、Plugin generation 和 request admission；任一 owner withdrawal、View close 或 cancel 都停止新 work，并按 declared
deadline drain。瞬时日志/进度用 callback capability；只有真正需要 byte backpressure 才使用 Cap’n Web stream。历史日志仍由 bounded `list()` 读取。

因此不需要全局 Channel registry、SSE replay、task token lookup 或 polling。

## View declaration 不重复 API wiring

```ts
export const SettingsView = workbench.view<SettingsViewApi>({
	renderer: workbench.federation.react(import.meta.url, './ui/settings.tsx'),
	placements: [workbench.tab({ label: 'Settings' })],
})

export const ExampleWorkbench = workbench.define({
	views: { settings: SettingsView },
})
```

Server publication 为每个 declared View 绑定一个 target factory。Definition key 已关联 View，API phantom generic 已让 TypeScript 检查 factory，因此不再重复
`workbench.bind.view(SettingsView, ...)`：

```ts
ctx.workbench?.publish(ExampleWorkbench, {
	views: {
		settings: ({ signal }) => new SettingsViewTarget(service, signal),
	},
})
```

Factory 只接收固定、server-derived 的窄上下文：

```ts
type ViewOpenContext = Readonly<{
	principal: Readonly<{
		provider: string
		subject: string
	}>
	params: Readonly<Record<string, string>>
	signal: AbortSignal
}>

type AttachmentCaller = Readonly<{
	node: PluginNodeAddress
}>
```

`params` 由 server 对 declared route 匹配后产生，不信任 browser 传入的 params record。`principal` 是已验证的稳定身份投影，不含
raw claim、display metadata、cookie、request 或 auth provider target。`signal` 在 View close、owner withdrawal 或 socket epoch 结束时 abort。
`AttachmentCaller` 只额外提供给 provider factory：它是 platform-issued、server-only 的 exact consumer node address，内部有效期绑定该 consumer
generation。它不进入 browser contract，不暴露 Context、consumer instance、dependency facade 或 service locator，也不授予任意调用能力；provider
只可用它关联已有的 caller-owned domain state。Consumer、provider 或 opened View 任一撤销都会 abort 同一个 signal 并撤销 roots。

一个 API target 可以由普通 domain service 共享底层状态，但每次 `openView()` 仍创建 internal lease，并把生命周期绑定到直接返回的 API
root。Browser client 只建立本地 disposable handle，不取得额外 `ViewSessionTarget`，也不再调用一次 `api()`。未打开 View 不调用 factory、不创建
child target、不加载 remote。

## Attachment 只解决 foreign renderer ownership

Attachment 只在 required dependency provider 拥有 renderer/API、consumer 拥有 placement 时使用。Provider-only settings/picker：

```ts
export const FontsPicker = workbench.attachment<FontsPickerApi>({
	renderer: workbench.federation.react(import.meta.url, './ui/picker.tsx'),
})
```

如果 renderer 还必须修改 consumer-owned selection，Attachment 可以额外声明恰好一个 `targetApi`：

```ts
export const FontsPicker = workbench.attachment<FontsCatalogApi, FontSelectionApi>({
	renderer: workbench.federation.react(import.meta.url, './ui/picker.tsx'),
})
```

Consumer placement 与 publication：

```ts
export const CanvasWorkbench = workbench.define({
	attachments: {
		fonts: FontsPicker.place(workbench.tab({ label: 'Fonts' })),
	},
})

ctx.workbench?.publish(CanvasWorkbench, {
	attachments: {
		fonts: {
			provider: this.fonts,
			target: ({ signal }) => new FontSelectionTarget(this, signal),
		},
	},
})
```

Attachment renderer 只得到固定 `{ provider, target? }` stubs。没有 arbitrary resource record、alias、Port mapping、provider scan、priority、fallback
或第三个 authority role。`this.fonts` 必须是 committed direct required dependency handle，provider 则已在自己的原子 publication
中为 `FontsPicker` 绑定 provider factory；完整例子见 [`EXAMPLES.md`](EXAMPLES.md)。Provider-only Attachment 省略 target；foreign Attachment
placement 本身不让 consumer 产生 MF producer。

## BotManager 使用普通 TypeScript composition

Telegram、KOOK、Milky、Discord 各自拥有 manager、persistence、connections、ViewApi targets 和 publication。`platform-kit` 只导出普通函数：

```ts
const botViews = defineBotManagerViews<{
	overview: TelegramOverviewApi
	accounts: TelegramAccountsApi
}>({
	renderers: TelegramBotRenderers,
	labels: { service: 'Telegram', account: 'Bot' },
})

export const TelegramWorkbench = workbench.define({
	views: botViews,
})
```

Function 在 build/define 时返回 frozen final View record；runtime 不知道它是否来自共享 builder。Account 是 `list/open` 方法的数据，不是动态 Feature。
只有真正出现统一跨平台 account identity、transaction、failure 与 lifecycle owner 时，才建立中心 Plugin。

## Authoring acceptance

- settings、CRUD、live state、logs、task progress、files、cross-plugin picker 与多页面 BotManager 都不需要新 platform resource kind；
- 一个 local View 只有一个 root ViewApi；Attachment 只有 provider + optional target 两个 root API；
- API root/child capability owner-aware、可撤销；domain validation 与业务限额由 Plugin 实现；
- dynamic row/item 数不改变 layout/View/producer/socket inventory；
- multi-page source reuse 不产生 Feature runtime entity；
- renderer props 使用上游 `RpcStub<Api>`/`RpcPromise<T>` 投影，不建立第二套 Client API DSL；
- live helper 先 subscribe 后 read，route ambiguity/group metadata conflict 都在 publication 前确定失败；
- View factory 只获得 principal/route params/signal，不获得 raw request/session；browser 也不能注入 principal/params；
- View 未打开时 target factory/API/observer/remote allocation 为零；
- Workbench disabled 时 domain service、Plugin dependency 与 headless business API 仍独立工作。

## 否决条件

- 引入 Model/Query/Channel/Collection registry 或 resource namespace lookup；
- 为每种 UI 数据形态建立新的 transport/protocol kind；
- ViewApi 获得 raw session root、socket、MF Runtime 或 Shell private store；
- View factory 获得 raw request、cookie、auth provider target 或 browser-supplied params record；
- Workbench 强迫 Plugin 使用 Valibot、Standard Schema、method descriptor 或 generated validator；
- collection/account row 被提升为 View、Bridge、capability 或 publication entity；
- Attachment 接受任意 resource map、字符串 provider、第三 authority 或 optional dependency 猜测；
- BotManager 源码复用被升级成中心 runtime owner；
- 为客户端 cache 优化先引入 generic diff/revision/replay protocol。
