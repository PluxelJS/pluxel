# Plugin-facing API examples

> 本文只展示 Workbench vNext 的候选 Plugin authoring surface，不是当前 API。语义必须保持，helper 的 exact naming 由
> [`DELIVERY_PLAN.md`](DELIVERY_PLAN.md) Slice A–D 冻结。规范边界仍以 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) 和
> [`AUTHORING.md`](AUTHORING.md) 为准。

## 先看最终调用面

Plugin 作者只处理四件事：

1. 用普通 TypeScript interface 描述 Plugin 自己的 Cap’n Web API；
2. 用 `workbench.view<Api>()` 绑定 renderer 和 placement；
3. 在 Plugin `init()` 中用一个与 definition 同 key 的 flat binding record 原子 `publish()`；
4. 零 props React renderer 用 `useWorkbench(exactDescriptor)` 取得上游 `RpcStub<Api>` 和固定 host facade。

只有 provider 的 renderer/API 需要被 required consumer 放置时，才增加 `workbench.attachment()`。下列名称是候选 API，但有意
保持与未来 package boundary 一致：

```ts
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { useRemoteValue, useWorkbench } from '@pluxel/runtime/workbench/react'
```

Browser-safe type/definition 不 import Plugin class、database、Node builtin 或 server service。一个中等规模 Plugin 可以使用：

```text
src/
  workbench/
    api.ts             # plain TypeScript RPC interfaces/domain values
    definition.ts      # Views/Attachments + renderer references
    targets.ts         # server RpcTarget implementations
  ui/
    settings.tsx       # MF React Bridge renderer source
  index.ts             # Plugin class + one publish()
```

`@pluxel/runtime/workbench` 根入口在 vNext 必须保持 browser-safe、无副作用，因为同一 `definition.ts` 会被 Node Plugin 与 MF remote
共同 import。Server publication 不是另一个 module helper，只存在于 Plugin Context 的 `ctx.workbench.publish()`。

## 例一：最小 settings View

### Browser-safe API types

```ts
// workbench/api.ts
export type SettingsSnapshot = Readonly<{
	revision: number
	enabled: boolean
	endpoint: string
}>

export type SettingsUpdate = Readonly<{
	expectedRevision: number
	enabled: boolean
	endpoint: string
}>

export type SettingsUpdateResult =
	| Readonly<{ ok: true; value: SettingsSnapshot }>
	| Readonly<{
			ok: false
			code: 'conflict' | 'rejected'
			current: SettingsSnapshot
	  }>

export interface SubscriptionApi {
	close(): void
}

export interface SettingsApi {
	snapshot(): SettingsSnapshot
	update(input: SettingsUpdate): Promise<SettingsUpdateResult>
	watch(notify: (revision: number) => void): SubscriptionApi
}
```

这些只是 Cap’n Web 可以传输的 TypeScript shapes。Server target 实现这里写出的返回类型；进入 renderer 后，Cap’n Web 把方法投影为返回
`RpcPromise` 的 `RpcStub<SettingsApi>`。`watch()` 的 function 自动成为反向 capability，返回的 server `RpcTarget` 自动成为 child stub；Workbench
不注册 callback/subscription kind。Plugin 若需要检查 endpoint、revision 或权限，在自己的 service/target 中完成。

### View definition

```ts
// workbench/definition.ts
import { workbench } from '@pluxel/runtime/workbench'
import type { SettingsApi } from './api.ts'

export const ExampleWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer: workbench.entry(import.meta.url, '../ui/settings.tsx'),
		placement: workbench.tab({
			label: 'Settings',
			order: 20,
		}),
	}),
})
```

Definition 没有 Plugin address、socket URL、RPC namespace、remote name 或 manifest URL。Owner 由最终调用 `publish()` 的 Plugin
Context 推导；producer/expose 由 toolchain 生成。

### Server target 与 publication

```ts
// workbench/targets.ts
import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { SettingsApi, SettingsUpdate, SubscriptionApi } from './api.ts'

class SubscriptionTarget extends RpcTarget implements SubscriptionApi {
	#close: (() => void) | undefined

	constructor(close: () => void) {
		super()
		this.#close = close
	}

	close() {
		this[Symbol.dispose]()
	}

	[Symbol.dispose]() {
		this.#close?.()
		this.#close = undefined
	}
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

	update(input: SettingsUpdate) {
		return this.settings.update(input, { signal: this.signal })
	}

	watch(notify: (revision: number) => void) {
		return new SubscriptionTarget(this.settings.subscribe((revision) => void notify(revision)))
	}
}
```

```ts
// index.ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ExampleWorkbench } from './workbench/definition.ts'
import { SettingsTarget } from './workbench/targets.ts'

@Plugin({ displayName: 'Example' })
export class ExamplePlugin extends BasePlugin {
	private readonly settings = new SettingsService()

	protected override init() {
		this.ctx.workbench?.publish(ExampleWorkbench, {
			settings: ({ signal }) => new SettingsTarget(this.settings, signal),
		})
	}
}
```

`ExampleWorkbench.settings` 的 phantom generic 让 TypeScript 检查 factory target 与 renderer hook projection。Runtime 只检查 exact key、owner、resolved
`RpcTarget`、build revision 和 lifecycle，不反射 methods，也不包装 domain validator。Factory 可以同步返回 target，也可以在 opened-view
signal/deadline 内异步完成 Plugin 自己的授权或准备；未打开 View 时不调用 factory。

### React renderer

```tsx
// ui/settings.tsx
import { useRemoteValue, useWorkbench } from '@pluxel/runtime/workbench/react'
import { ExampleWorkbench } from '../workbench/definition.ts'

export default function SettingsPanel() {
	const { api, host } = useWorkbench(ExampleWorkbench.settings)
	const settings = useRemoteValue({
		read: () => api.snapshot(),
		subscribe: (invalidate) => api.watch(invalidate),
	})

	if (settings.state !== 'ready') return <p>{settings.state}</p>

	const snapshot = settings.value
	return (
		<section>
			<p>{snapshot.endpoint}</p>
			<button
				onClick={async () => {
					const result = await api.update({
						expectedRevision: snapshot.revision,
						enabled: !snapshot.enabled,
						endpoint: snapshot.endpoint,
					})
					if (!result.ok) host.notify({ message: `Update failed: ${result.code}` })
				}}
			>
				Toggle
			</button>
		</section>
	)
}
```

这里的 descriptor 同时推导 `api` 的上游 `RpcStub<SettingsApi>` 类型，并在运行时拒绝错误 View/expose 串线；
`api.snapshot()`/`api.update()` 是上游 `RpcPromise`。`useRemoteValue()` 只是
React/client convenience：它先建立 `watch` 再执行 initial `snapshot`，合并 read 期间的 invalidation，并防止旧 read 覆盖新结果；server 仍然
只看到 `snapshot/update/watch`。不用该 hook 时，renderer 可直接调用 typed stub。

MF Bridge 内部仍然需要 host props，但 toolchain 生成的 wrapper 会把它们止于平台边界，等价于：

```tsx
// generated internal module; not a public Plugin API
function GeneratedBridge(internal: OpenedViewBridgeProps) {
	return (
		<InternalWorkbenchProvider value={internal.runtime}>
			<SettingsPanel />
		</InternalWorkbenchProvider>
	)
}
```

Context 每次 opened View/Bridge instance 独立，保存 epoch-stable descriptor、stub 与 host service，不保存 settings snapshot。这样既使用了
Bridge 的 application props ABI，又不把 `LocalViewProps` 变成每个 Plugin component 的永久签名。

## 例二：参数化 Account document

Dynamic account 不发布成新 View。一个 parameterized route 复用同一 View/expose，server 在打开时生成窄 target：

```ts
export const AccountWorkbench = workbench.define({
	account: workbench.view<AccountApi>({
		renderer: workbench.entry(import.meta.url, '../ui/account.tsx'),
		placement: workbench.route('/accounts/:accountId', {
			title: 'Account',
		}),
	}),
})

ctx.workbench?.publish(AccountWorkbench, {
	account: async ({ params, principal, signal }) => {
		const account = await manager.admit(params.accountId, { principal, signal })
		return new AccountTarget(account, {
			accountId: params.accountId,
			principal,
			signal,
		})
	},
})
```

Browser 只提供 canonical target-relative path；server 对 declared route 重新匹配后才把 frozen `params` 交给 factory。Renderer
不能伪造另一个 account authority。Document chrome 是 host 行为，不绕回 RPC：

```tsx
host.navigation?.openDocument({
	path: `/accounts/${encodeURIComponent(account.id)}`,
	title: account.displayName,
	meta: 'Bot account',
})
```

Host 只接受 definition 已声明的 relative route。`title/meta` 是初始 chrome，不参与 identity 或 authorization；真正的 `accountId` 仍由 server
rematch path 后交给 target factory。

```tsx
import { useEffect, useState } from 'react'
import { useRemoteValue, useWorkbench } from '@pluxel/runtime/workbench/react'
import { AccountWorkbench } from '../workbench/definition.ts'

export default function AccountEditor() {
	const { api, host } = useWorkbench(AccountWorkbench.account)
	const account = useRemoteValue({ read: () => api.snapshot() })
	const [draft, setDraft] = useState<AccountInput>()

	useEffect(() => {
		host.document?.setDirty(draft !== undefined)
		return () => host.document?.setDirty(false)
	}, [draft, host.document])

	useEffect(() => {
		if (account.state === 'ready') {
			host.document?.setTitle({ title: account.value.displayName, meta: 'Bot account' })
		}
	}, [account, host.document])

	// host owns close confirmation; there is no remote beforeClose callback.
}
```

## 例三：Font manager 的列表、任务和文件

Font row 是 bounded by-value data，不是 Workbench Collection 或 per-row capability。`UploadTicket` 和 `CompletedUpload`
也是 platform transfer service 签发/验证的 opaque domain values。

```ts
type FontRow = Readonly<{
	id: string
	family: string
	style: string
	bytes: number
}>

type FontPage = Readonly<{
	items: readonly FontRow[]
	nextCursor: string | null
}>

type InstallTaskSnapshot = Readonly<{
	state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
	progress: number
}>

export interface InstallTaskApi {
	state(): InstallTaskSnapshot
	cancel(): void
	watch(notify: (snapshot: InstallTaskSnapshot) => void): SubscriptionApi
}

export interface FontsManagerApi {
	list(input: { cursor: string | null; limit: number; query?: string }): Promise<FontPage>
	remove(input: { id: string }): Promise<{ removed: boolean }>
	beginInstall(input: { fileName: string; bytes: number }): Promise<UploadTicket>
	install(input: { upload: CompletedUpload }): Promise<InstallTaskApi>
	watch(notify: (event: { reason: 'catalog-changed' }) => void): SubscriptionApi
}
```

对应语义很直接：

- Fonts Plugin 自己把 `limit` clamp/reject 到 1–100，并保证 page byte ceiling；Workbench 不理解 list params；
- `beginInstall()` 签发 single-use HTTP upload ticket，文件 bytes 不进 Cap’n Web message；
- `install()` 返回独立可撤销的 task target，因为它确实有 progress/cancel/lifecycle；
- 只有 task 获得 child capability；普通 font row 没有 stub、dispose 或 publication identity。

Renderer 不自己拼 HTTP credential/progress/error：

```ts
const ticket = await api.beginInstall({ fileName: file.name, bytes: file.size })
const upload = await host.transfer.upload(ticket, file, {
	signal,
	onProgress: ({ transferred, total }) => setProgress(transferred / total),
})
const task = await api.install({ upload })
```

## 例四：provider picker 嵌入 consumer

这是 `Attachment` 唯一需要解决的结构：Fonts Plugin 拥有 picker renderer 和 font catalog，Canvas Plugin 拥有“当前选择哪个
font”的领域状态和 tab placement。

### Provider declaration 与 publication

```ts
export interface FontsPickerApi {
	list(input: FontListInput): Promise<FontPage>
}

export interface FontSelectionApi {
	snapshot(): Promise<FontSelectionSnapshot>
	select(input: { fontId: string; expectedRevision: number }): Promise<FontSelectionResult>
}

export const FontsWorkbench = workbench.define({
	manager: FontsManagerView,
	picker: workbench.attachment<FontsPickerApi, FontSelectionApi>({
		renderer: workbench.entry(import.meta.url, '../ui/picker.tsx'),
	}),
})
```

```ts
this.ctx.workbench?.publish(FontsWorkbench, {
	manager: ({ signal }) => new FontsManagerTarget(this.catalog, signal),
	picker: ({ consumer, principal, signal }) =>
		new FontsPickerTarget(this.catalog, { consumer, principal, signal }),
})
```

Provider factory 只获得 platform-issued `consumer.node`，用于关联 provider 已有的 consumer-bound policy/state；不获得 consumer Context、consumer
factory 或 Shell root。

### Consumer placement 与 publication

```ts
export const CanvasWorkbench = workbench.define({
	fonts: FontsWorkbench.picker.place(
		workbench.tab({
			label: 'Fonts',
			order: 30,
		}),
	),
})
```

```ts
this.ctx.workbench?.publish(CanvasWorkbench, {
	fonts: {
		provider: this.fonts,
		consumer: ({ signal }) => new FontSelectionTarget(this.canvasSettings, signal),
	},
})
```

`this.fonts` 必须是 Canvas Plugin 已 committed 的 direct required dependency handle。Runtime 用 definition 中的 `FontsWorkbench.picker`
identity 对应 provider publication；不接收 provider string、optional dependency、candidate scan 或 fallback。

Picker renderer 只获得两个根：

```tsx
export default function FontsPickerPanel() {
	const { provider, consumer, host } = useWorkbench(FontsWorkbench.picker)

	// provider.list(...) reads provider-owned candidates.
	// consumer.select(...) writes consumer-owned selection.
	// host supplies notify/confirm/navigation, never a raw socket or Shell store.
}
```

如果 UI 只修改 provider-wide default，Attachment 只声明 provider generic，consumer publication 也省略 `consumer` factory，hook 返回类型不会出现
`consumer` property。如果 consumer 只在 server 消费 font 而不嵌
provider UI，它根本不使用 Attachment，只通过正常 Plugin dependency 调用 provider domain service。

## 例五：Wretch 的 consumer-owned provider-only Attachment

Wretch 证明 `consumer.node` 不是理论 metadata。Provider 拥有统一 renderer/API，但设置按 required consumer node 隔离；consumer 只决定 placement，
不再把 consumer-owned RPC 作为第二个 root 重绑一次：

```ts
export interface WretchSettingsApi {
	snapshot(): WretchSettingsSnapshot
	update(input: WretchSettingsInput): Promise<WretchSettingsResult>
	reset(): Promise<WretchSettingsSnapshot>
}

export const WretchWorkbench = workbench.define({
	settings: workbench.attachment<WretchSettingsApi>({
		renderer: workbench.entry(import.meta.url, '../ui/settings.tsx'),
	}),
})

this.ctx.workbench?.publish(WretchWorkbench, {
	settings: ({ consumer, signal }) =>
		new WretchSettingsTarget(this.managedSettings.require(consumer.node), signal),
})
```

Consumer 仍通过正常 Plugin API 显式启用自己的 managed settings，并把 constructor-injected required handle 绑定到 placement：

```ts
export const HttpConsumerWorkbench = workbench.define({
	http: WretchWorkbench.settings.place(workbench.tab({ label: 'HTTP' })),
})

protected override async init() {
	await this.http.enableManagedSettings()

	this.ctx.workbench?.publish(HttpConsumerWorkbench, {
		http: { provider: this.http },
	})
}
```

`consumer.node` 是 platform-issued 的 canonical node address，只用于查找 provider 已拥有的 consumer state；consumer reference 本身的 admission/有效期绑定
consumer generation。它不把 consumer Context/instance/facade 暴露给 target，也不是任意调用授权。Provider/consumer/View 任一撤销都会关闭
target。这个结构不需要 optional consumer API，因为写入的设置本来就由 Wretch provider 按 consumer 拥有。

## 例六：日志、实时状态与长任务

它们仍然是一个普通 API，不建立 Query/Channel/Task registry：

```ts
export interface DiagnosticsApi {
	status(): Promise<RuntimeStatusSnapshot>
	watchStatus(notify: (status: RuntimeStatusSnapshot) => void): SubscriptionApi
	listLogs(input: LogPageInput): Promise<LogPage>
	tailLogs(notify: (entry: LogEntry) => void): SubscriptionApi
	rebuildIndex(input: RebuildInput): RebuildTaskApi
	prepareLogDownload(input: LogDownloadInput): Promise<DownloadTicket>
}
```

- 初始状态是 `status()`，之后用 callback invalidation/snapshot；
- 历史日志是 bounded `listLogs()`，live tail 才使用 callback；
- 只有真正需要 byte backpressure 的连续流才改用 Cap’n Web stream；
- 任务 target 负责 `state/cancel/watch`，opened View close 后不能继续产生新 work；
- archive 通过 ticket 下载，不为大 bytes 发明第二 dynamic API protocol。

## 例七：BotManager 仅复用源码

Telegram、KOOK、Milky 和 Discord 可以共用普通 TypeScript builder，但每个 Plugin 仍有独立 API、publication 和 lifecycle：

```ts
export const TelegramEntries = defineBotManagerEntries<{
	overview: TelegramOverviewApi
	accounts: TelegramAccountsApi
	diagnostics: TelegramDiagnosticsApi
}>({
	entries: {
		overview: workbench.entry(import.meta.url, './ui/overview.tsx'),
		accounts: workbench.entry(import.meta.url, './ui/accounts.tsx'),
		diagnostics: workbench.entry(import.meta.url, './ui/diagnostics.tsx'),
	},
	labels: { service: 'Telegram', account: 'Bot' },
	navigation: {
		group: { id: 'bots', label: 'Bots' },
	},
})

export const TelegramWorkbench = workbench.define(TelegramEntries)
```

```ts
this.ctx.workbench?.publish(TelegramWorkbench, bindBotManagerEntries(TelegramEntries, this.manager))
```

`defineBotManagerEntries()` 和 `bindBotManagerEntries()` 是 `platform-kit` 中的普通函数。它们在 define/init 时返回 final records，runtime
不会看到 Feature address、Bot hub、额外 registry 或网络跳转。`navigation.group` 只被展开成各 route 的一致 by-value metadata，不获得 owner 或
lifecycle；Account 仍是 `list/open` 返回的 domain data/child target。

## 预期失败与 exception

Method 不因为走 Cap’n Web 就把全部错误改成 exception：

```ts
type UpdateResult =
	{ ok: true; value: Snapshot } | { ok: false; code: 'conflict' | 'rejected'; current: Snapshot }
```

- 可预期的业务结果用 closed discriminated result；
- domain validation/authorization failure 由 Plugin 自己投影为 stable result/code；
- withdrawn owner/session 使 retained stub 得到 `capability_expired`；
- programming exception reject，并进入 server diagnostics；
- UI 不解析 exception text 或 WebSocket close reason 判断 domain state。

## 这些 API 特意不存在

```ts
workbench.collection(...)
workbench.model(...)
workbench.query(...)
workbench.channel(...)
workbench.feature(...)
workbench.resource('provider:key')
workbench.connect({ transport: 'auto' })
```

可以存在 Plugin 自己选择的 schema/parser、普通 `Page<T>` type helper、`useRemoteValue()` client helper 和 TypeScript definition builder；但它们都没有 server
registry、wire kind、owner、lease 或 independent lifecycle。

## 样例验收

- 最小 settings View 只有一个 TypeScript API、一个 View、一个 target 和一次 publication；
- 同一 root capability 直接覆盖 snapshot、mutation、watch、paged list、task 和 transfer ticket；
- 10,000 rows 不增加 View、route、MF expose、API root 或 socket；
- provider + consumer Attachment 严格止于两个 root，不接受任意 resource map 或第三 authority；
- Wretch provider-only Attachment 可以用 exact consumer node 关联既有 consumer-owned state，不需要第二个 consumer API 或 Context escape hatch；
- Plugin 作者不看到 raw session root、WebSocket、MF Runtime、grant、manifest URL 或 Shell private store；
- 如果真实 Wretch、Fonts 或 BotManager fixture 无法用上述表面自然表达，先修正该 API，不新增 resource type system。
