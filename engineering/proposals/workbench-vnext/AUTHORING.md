# Workbench authoring contract

> 本文定义 Workbench vNext 的 Plugin-facing API。Publication lifecycle 见
> [`PUBLICATION.md`](PUBLICATION.md)，传输与认证见 [`CONTROL_PLANE.md`](CONTROL_PLANE.md)，
> 完整调用点见 [`EXAMPLES.md`](EXAMPLES.md)。

## 最小模型

Workbench 只增加两个 UI 声明：

| 声明         | renderer owner           | placement owner | 打开后的 API                           |
| ------------ | ------------------------ | --------------- | -------------------------------------- |
| `View`       | 当前 Plugin              | 当前 Plugin     | 一个 local `Api` root                  |
| `Attachment` | direct required provider | consumer        | provider root + optional consumer root |

`ViewApi` 只是 Plugin 自己声明的 Cap’n Web root interface，不是 Workbench resource kind。Definition
只是源码期 frozen exact record；普通 TypeScript builder 生成 final entries，不获得 runtime identity。

新增交互按以下顺序判断：

1. renderer 和 placement 都属于当前 Plugin：使用 `View`；
2. renderer/API 属于 required dependency、placement 属于当前 Plugin：使用 `Attachment`；
3. snapshot、mutation、list、watch、task 和 stream：放入已有 root；
4. 普通结果返回 bounded by-value data；对象确实需要独立调用、取消或撤销时才返回 child capability；
5. navigation、document chrome、notification 与文件 bytes 使用固定 host facade。

没有第三种 UI declaration。Collection、account、row、task 名称属于 Plugin domain，不自动成为
Workbench entity。

## Direct Cap’n Web API

Plugin 的每个 capability interface 都显式扩展 pinned `RpcTarget`，实现 class 也直接继承它：

```ts
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'

export interface SubscriptionApi extends RpcTarget {}

export interface SettingsApi extends RpcTarget {
	snapshot(): SettingsSnapshot
	update(input: SettingsInput): Promise<SettingsResult>
	watch(invalidate: () => void): SubscriptionApi
}

export class SettingsTarget extends RpcTarget implements SettingsApi {
	constructor(
		private readonly settings: SettingsService,
		private readonly signal: AbortSignal,
	) {
		super()
	}

	snapshot() {
		return this.settings.snapshot()
	}

	update(input: SettingsInput) {
		return this.settings.update(input, { signal: this.signal })
	}

	watch(invalidate: RpcStub<() => void>) {
		const callback = invalidate.dup()
		let unsubscribe: (() => void) | undefined
		try {
			unsubscribe = this.settings.subscribe(() => {
				using pending = callback()
			})
			return new SubscriptionTarget(unsubscribe, callback, this.signal)
		} catch (error) {
			unsubscribe?.()
			callback[Symbol.dispose]()
			throw error
		}
	}
}
```

Target 应只在 prototype 暴露实际 RPC methods；实现细节委托 private service，并用 JavaScript
`#private` 隐藏不应成为 RPC 的 prototype member。

API method 声明 target 的自然返回类型：同步读取返回 value，需要 I/O 的操作返回 Promise，独立
对象返回 child `RpcTarget`。不要为了 browser 调用统一把全部方法包装成 Promise；上游
`RpcStub<Api>` 会根据 `Awaited<server return>` 自动产生可 await/pipeline 的 RPC result，child target
resolve 为 `RpcStub`。具体 client 类型始终从 `RpcStub<Api>` 推导，不声明第二份 Client interface。

Cap’n Web 的 object result 带顶层 `[Symbol.dispose]()`，它会释放该 response 中 transfer 的全部
stubs。直接调用 API 的代码用 `using result = await api.method()`，或把 ownership 交给明确负责
cleanup 的 helper；primitive result 不需要释放。不要分别释放 object result 内的 member stub 后再
释放 result。

`SubscriptionApi` 是没有业务 method 的 child capability。`SubscriptionTarget` 只实现幂等
`[Symbol.dispose]()`：取消 domain observer、释放 retained callback，并响应 opened-view signal。
Client 通过 dispose 返回的 stub/RpcPromise 取消 subscription，不再额外调用 `close()`。Server 若在
`watch()` call settle 后保留 callback capability，必须先用上游 `dup()` 取得自己的引用，并在
subscription disposer 中释放；普通 callback invocation 不需要这一步。

每次 callback invocation 自身也返回 `RpcPromise`。需要确认送达/失败时 await 并处理；只发送
invalidation 的 fire-and-forget 路径使用 `using pending = callback()`，不能以 `void callback()` 丢弃
result ownership。

Factory 类型只表达 target 创建与异步 admission：

```ts
type ViewTargetFactory<Api extends RpcTarget> = (context: ViewOpenContext) => Api | Promise<Api>

type ViewOpenContext = Readonly<{
	principal: Readonly<{ provider: string; subject: string }>
	params: Readonly<Record<string, string>>
	signal: AbortSignal
}>
```

`params` 由 server 对 declared route 重新匹配后生成；browser 不能直接提交 params record。
`signal` 在 View close、owner withdrawal 或 connection epoch 结束时 abort。异步 factory 必须在平台
deadline 内全有或全无，late target 立即 dispose。每次 factory call 返回 fresh、尚未作为 Workbench root export 的
wrapper；可共享的是 wrapper 后面的 domain service/cache，不是 root instance。

责任边界固定为：

- Cap’n Web：invocation、serialization、promise pipelining、callback、stream、capability transfer 与 dispose；
- Workbench：root admission、owner、opened-view lease、withdrawal、平台 envelope 与粗粒度 quota；
- Plugin：领域校验、授权、业务不变量、稳定 result/error、分页/操作上限与 API 演进。

Workbench 不要求 `capability.*define`、Valibot、Standard Schema、method descriptor 或 generated client。
Plugin 可复用自己的 parser/service，也必须在会修改持久状态或读取敏感数据的方法中守住领域边界。
TypeScript 类型不是浏览器输入验证。

Browser-safe API 只能使用 pinned Cap’n Web 支持的 by-value/capability shapes。应用 class、cyclic value
与 server-only object 不跨边界；lint/type tests 提前发现问题，最终兼容性由 Cap’n Web serializer 判定。

## 常见 API shape

| 场景                       | 推荐 shape                                                        |
| -------------------------- | ----------------------------------------------------------------- |
| settings                   | `snapshot()` + `update()`/`reset()`                               |
| live status                | `snapshot()` + `watch(invalidate)`                                |
| paged CRUD                 | `list({ cursor, limit, filter })` + by-ID mutations               |
| independent document       | parameterized `View`，或 method 返回 scoped child capability      |
| history + live tail        | bounded `list()` + callback；需要 byte backpressure 时使用 stream |
| long operation             | method 返回 `TaskApi { state, cancel, watch }`                    |
| upload/download/export     | root 签发 single-use ticket，`host.transfer` 传 bytes             |
| provider-owned embedded UI | `Attachment<ProviderApi, ConsumerApi?>`                           |

这些是 API recipe，不是 platform protocol kinds。列表 row 保持 by-value；创建 10,000 个 row
不会增加 publication、View、route、Bridge、MF expose 或 socket。

可预期的业务失败使用 closed result，programming/lifecycle failure 使用 rejection：

```ts
type UpdateResult =
	| Readonly<{ ok: true; value: Snapshot }>
	| Readonly<{ ok: false; code: 'conflict'; current: Snapshot }>
	| Readonly<{ ok: false; code: 'rejected' }>
```

UI 不解析 exception text 或 WebSocket close reason 判断业务状态。

## Host facade

Browser 行为不绕回 server root。Renderer 取得固定、窄且可由不同 Shell 实现的 facade：

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

Navigation 只接受当前 target declared route 的 canonical relative path。Parameterized route 自动是
document route，不进入 navigation。Exact route 优先于 parameterized route；可能匹配同一路径的
patterns 在 publication 前拒绝。

`document` 只在 document/tab 中存在。Host 自己处理 close confirmation；remote 不提供
`beforeClose()`。Bridge destroy 时自动清理 dirty/title 和 active transfer。Facade 不暴露 raw
`fetch`、socket、MF Runtime、Shell router/store、workspace ID 或 generic key-value state。

Ephemeral UI state 留在 renderer，持久业务状态走 Plugin API，document identity 使用 canonical URL。

## Declaration、publication 与 renderer

```ts
export const ExampleWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})

ctx.workbench?.publish(ExampleWorkbench, {
	settings: ({ signal }) => new SettingsTarget(settings, signal),
})
```

`workbench.entry()` 只记录 module-relative source provenance。Toolchain 生成 producer、expose 与
Bridge wrapper；作者不填写 remote name、manifest URL、share scope 或 renderer adapter。

Definition 必须是 module/build-time 可确定的 final record。Runtime config、principal、database state
或 optional provider 不能增删 entry，也不存在 `visibleWhen`/`enabledWhen`。临时业务不可用通过已打开
root 的 snapshot/result 表达；确实需要另一套页面 topology 时建立另一静态 Plugin definition/build。

Entry 默认导出零 props React component：

```tsx
export default function SettingsPanel() {
	const { api, host } = useWorkbench(ExampleWorkbench.settings)
	const settings = useRemoteValue({
		read: () => api.snapshot(),
		subscribe: (invalidate) => api.watch(invalidate),
	})

	// ...
}
```

Descriptor 同时提供静态 API projection 与运行时 identity check：

- local View 返回 `{ api, host }`；
- provider-only Attachment 返回 `{ provider, host }`；
- provider+consumer Attachment 返回 `{ provider, consumer, host }`。

不提供无 descriptor 的 `useWorkbench<Api>()`，也不导出 `LocalViewProps`、`AttachmentProps`、
raw Provider 或 public Bridge props。Generated wrapper 把 opened handle 写入每个 Bridge instance
独立的 Context，再渲染零 props component。Context 只保存当前 epoch 稳定的 descriptor、stubs 与
host service；领域 snapshot 不进入 Context。

## Remote value helper

`createRemoteValue()`/`useRemoteValue()` 是 client convenience，不是 wire protocol。语义固定为：

1. 有 subscription 时先 subscribe，再执行 initial read；
2. 每次 read 只把 bounded by-value payload 发布到 local store，并在发布前 dispose 顶层 object result；
3. active read 期间的 invalidation 合并为随后一次 latest read；
4. 任意时刻最多一个 active read，旧 sequence/epoch 结果不能覆盖新状态；
5. dependencies 变化时 dispose 旧 subscription，再建立新 read identity；
6. dispose 拒绝新 read，并显式 dispose subscription RpcPromise/stub；
7. connection break 终止整个 page，helper 不实现 reconnect 或跨 document cache。

Server 只看到 Plugin 自己声明的 `snapshot/list/watch`。Helper 不要求统一 revision/query key，
不跨 View cache，不 resume 旧 stub，也不创造 Query/Collection runtime entity。

## Attachment

Attachment 只用于 provider-owned renderer：

```ts
export const FontsWorkbench = workbench.define({
	collectionPicker: workbench.attachment<FontCollectionCatalogApi, FontCollectionSelectionApi>({
		renderer: workbench.entry(import.meta.url, './ui/collection-picker.tsx'),
	}),
})

export const CanvasWorkbench = workbench.define({
	fonts: FontsWorkbench.collectionPicker.place(workbench.tab({ label: 'Fonts' })),
})

ctx.workbench?.publish(CanvasWorkbench, {
	fonts: {
		provider: this.fonts,
		consumer: ({ signal }) => new FontSelectionTarget(settings, this.fonts, signal),
	},
})
```

`this.fonts` 必须是 constructor-injected、committed direct required dependency。Runtime 不接收
provider string，不扫描候选，也不做 priority/fallback/version negotiation。

Provider factory 额外获得 server-only `AttachmentConsumer { node }`，用于关联 provider 已拥有的
consumer-bound state。它不暴露 consumer Context、instance、dependency facade 或 service locator。
Provider、consumer 或 opened View 任一撤销都会撤销两侧 roots。

Provider-only Attachment 省略第二个 generic 和 consumer factory；hook 的类型与 runtime record
都没有 `consumer` property。Collection picker 的完整 owner 与 API 见
[`FONT_COLLECTION_EXAMPLE.md`](FONT_COLLECTION_EXAMPLE.md)。

## 动态对象与多页面 Plugin

Manager 默认用一个 local View 的 bounded list 与 by-ID CRUD。只有产品确实需要同时打开多个独立
document 时，才增加一个 parameterized View；只有实际打开的 document 创建 scoped root。

BotManager 遵循同一规则：

- 每个平台 Plugin 自己拥有 accounts、connections、manager roots 和 publication；
- overview/accounts/diagnostics topology 可由普通 TypeScript function 生成 final entries；
- 平台 auth、admission 和 factory 有差异时直接显式 publication，不用通用 binder 隐藏差异；
- provider UI 嵌入另一 Plugin 时使用 Attachment；其他 Plugin 选择 account 时使用 provider catalog +
  consumer selection Attachment；
- 实际发送消息继续调用 constructor-injected Plugin dependency，不经过 Workbench。

不存在中心 BotManager、Feature registry 或 dynamic account publication。源码 helper 只有在至少两个
实现中删除明显重复、且不隐藏 owner/failure/lifecycle 差异时才保留。
