# Plugin-facing API examples

> 本文只展示 Workbench vNext 的候选 Plugin authoring surface，不是当前 API。语义必须保持，helper 的 exact naming 由
> [`DELIVERY_PLAN.md`](DELIVERY_PLAN.md) Slice A–D 冻结。规范边界仍以 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) 和
> [`AUTHORING.md`](AUTHORING.md) 为准。

## 先看最终调用面

Plugin 作者只处理四件事：

1. 用 Standard Schema 声明一个 exact Cap’n Web capability contract；
2. 用 `workbench.view()` 绑定 renderer、placement 和该 contract；
3. 在 Plugin `init()` 中用一个 target factory 原子 `publish()`；
4. React renderer 只接收 typed API stub 和固定 host facade。

只有 provider 的 renderer/API 需要被 required consumer 放置时，才增加 `workbench.attachment()`。下列名称是候选 API，但有意
保持与未来 package boundary 一致：

```ts
import { capability, SubscriptionApi } from '@pluxel/runtime/web/capability'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchReact } from '@pluxel/runtime/workbench/react'
```

Browser-safe contract/definition 不 import Plugin class、database、Node builtin 或 server service。一个中等规模 Plugin 可以使用：

```text
src/
  workbench/
    contracts.ts       # schemas + capability contracts
    definition.ts      # Views/Attachments + renderer references
    targets.ts         # server RpcTarget implementations
  ui/
    settings.tsx       # MF React Bridge renderer source
  index.ts             # Plugin class + one publish()
```

## 例一：最小 settings View

### Browser-safe contract

```ts
// workbench/contracts.ts
import * as v from 'valibot'
import { capability, SubscriptionApi } from '@pluxel/runtime/web/capability'

const Revision = v.pipe(v.number(), v.integer(), v.minValue(0))

export const SettingsSnapshot = v.object({
	revision: Revision,
	enabled: v.boolean(),
	endpoint: v.string(),
})

export const SettingsUpdate = v.object({
	expectedRevision: Revision,
	enabled: v.boolean(),
	endpoint: v.string(),
})

export const SettingsUpdateResult = v.union([
	v.object({
		ok: v.literal(true),
		value: SettingsSnapshot,
	}),
	v.object({
		ok: v.literal(false),
		code: v.picklist(['conflict', 'rejected']),
		current: SettingsSnapshot,
	}),
])

export const SettingsApi = capability.define({
	snapshot: capability.method({
		result: SettingsSnapshot,
	}),
	update: capability.method({
		input: SettingsUpdate,
		result: SettingsUpdateResult,
	}),
	watch: capability.method({
		input: capability.callback(v.object({ revision: Revision })),
		result: capability.target(SubscriptionApi),
	}),
})
```

`capability.define()` 不建立 resource namespace。它只生成 server validation metadata、typed implementation surface 和 browser stub
type。`watch()` 中的 callback 是 Cap’n Web 反向 capability；platform 提供的 `SubscriptionApi` 只管本次订阅的
close/dispose，不是全局 subscription registry。

### View definition

```ts
// workbench/definition.ts
import { workbench } from '@pluxel/runtime/workbench'
import { SettingsApi } from './contracts.ts'

export const SettingsView = workbench.view({
	api: SettingsApi,
	renderer: workbench.federation.react(import.meta.url, '../ui/settings.tsx'),
	placements: [
		workbench.tab({
			label: 'Settings',
			order: 20,
		}),
	],
})

export const ExampleWorkbench = workbench.define({
	views: {
		settings: SettingsView,
	},
})
```

Definition 没有 Plugin address、socket URL、RPC namespace、remote name 或 manifest URL。Owner 由最终调用 `publish()` 的 Plugin
Context 推导；producer/expose 由 toolchain 生成。

### Server target 与 publication

```ts
// workbench/targets.ts
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { capability } from '@pluxel/runtime/web/capability'
import { SettingsApi } from './contracts.ts'

export class SettingsTarget extends RpcTarget implements capability.Server<typeof SettingsApi> {
	constructor(
		private readonly settings: SettingsService,
		private readonly signal: AbortSignal,
	) {
		super()
	}

	snapshot() {
		return this.settings.snapshot()
	}

	update(input: capability.Input<typeof SettingsApi, 'update'>) {
		return this.settings.update(input, { signal: this.signal })
	}

	watch(notify: capability.Input<typeof SettingsApi, 'watch'>) {
		return capability.subscription(this.settings.subscribe((revision) => void notify({ revision })))
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
			views: {
				settings: ({ signal }) => new SettingsTarget(this.settings, signal),
			},
		})
	}
}
```

`publish()` 已知道 `ExampleWorkbench.views.settings.api`，因此 binding 只写 factory。Type/runtime 仍会检查 exactness，并在 target
进入 Cap’n Web 前包装 input/result validator。Factory 只获得 validated principal、server-derived route params 和 opened-view
`AbortSignal`；未打开 View 时不调用 factory。

### React renderer

```tsx
// ui/settings.tsx
import { workbenchReact } from '@pluxel/runtime/workbench/react'
import type { SettingsApi } from '../workbench/contracts.ts'

export default function SettingsPanel({
	api,
	host,
}: workbenchReact.LocalViewProps<typeof SettingsApi>) {
	const settings = workbenchReact.useRemoteValue({
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
					if (!result.ok) host.notify(`Update failed: ${result.code}`)
				}}
			>
				Toggle
			</button>
		</section>
	)
}
```

`useRemoteValue()` 只是 React/client convenience；server 仍然只看到 `snapshot/update/watch`。不用该 hook 时，renderer 可直接调
typed stub。

## 例二：参数化 Account document

Dynamic account 不发布成新 View。一个 parameterized route 复用同一 View/expose，server 在打开时生成窄 target：

```ts
export const AccountView = workbench.view({
	api: AccountApi,
	renderer: workbench.federation.react(import.meta.url, '../ui/account.tsx'),
	placements: [
		workbench.route('/accounts/:accountId', {
			title: 'Account',
			navigation: false,
		}),
	],
})

export const AccountWorkbench = workbench.define({
	views: { account: AccountView },
})

ctx.workbench?.publish(AccountWorkbench, {
	views: {
		account: ({ params, principal, signal }) =>
			new AccountTarget(manager, {
				accountId: params.accountId,
				principal,
				signal,
			}),
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
export default function AccountEditor({ api, host }: AccountViewProps) {
	const account = workbenchReact.useRemoteValue({ read: () => api.snapshot() })
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
也是有过期时间、用途和大小限制的普通 Standard Schema values。

```ts
const FontRow = v.object({
	id: v.string(),
	family: v.string(),
	style: v.string(),
	bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

const FontPage = v.object({
	items: v.pipe(v.array(FontRow), v.maxLength(100)),
	nextCursor: v.nullable(v.string()),
})

const InstallTaskSnapshot = v.object({
	state: v.picklist(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
	progress: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
})

export const InstallTaskApi = capability.define({
	state: capability.method({ result: InstallTaskSnapshot }),
	cancel: capability.method({ result: v.undefined() }),
	watch: capability.method({
		input: capability.callback(InstallTaskSnapshot),
		result: capability.target(SubscriptionApi),
	}),
})

export const FontsManagerApi = capability.define({
	list: capability.method({
		input: v.object({
			cursor: v.nullable(v.string()),
			limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
			query: v.optional(v.string()),
		}),
		result: FontPage,
	}),
	remove: capability.method({
		input: v.object({ id: v.string() }),
		result: v.object({ removed: v.boolean() }),
	}),
	beginInstall: capability.method({
		input: v.object({ fileName: v.string(), bytes: v.number() }),
		result: UploadTicket,
	}),
	install: capability.method({
		input: v.object({ upload: CompletedUpload }),
		result: capability.target(InstallTaskApi),
	}),
	watch: capability.method({
		input: capability.callback(v.object({ reason: v.literal('catalog-changed') })),
		result: capability.target(SubscriptionApi),
	}),
})
```

对应语义很直接：

- `list()` 始终有 cursor、row 上限和 byte 上限；变更后只重读当前 page；
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
export const FontsPickerApi = capability.define({
	list: capability.method({ input: FontListInput, result: FontPage }),
})

export const FontSelectionApi = capability.define({
	snapshot: capability.method({ result: FontSelectionSnapshot }),
	select: capability.method({
		input: v.object({ fontId: v.string(), expectedRevision: Revision }),
		result: FontSelectionResult,
	}),
})

export const FontsPicker = workbench.attachment({
	providerApi: FontsPickerApi,
	targetApi: FontSelectionApi,
	renderer: workbench.federation.react(import.meta.url, '../ui/picker.tsx'),
})

export const FontsWorkbench = workbench.define({
	views: { manager: FontsManagerView },
	attachments: { picker: FontsPicker },
})
```

```ts
this.ctx.workbench?.publish(FontsWorkbench, {
	views: {
		manager: ({ signal }) => new FontsManagerTarget(this.catalog, signal),
	},
	attachments: {
		picker: ({ caller, principal, signal }) =>
			new FontsPickerTarget(this.catalog, { caller, principal, signal }),
	},
})
```

Provider factory 可以获得 validated caller identity，以实现 caller-bound policy；不获得 consumer 的 target factory 或 Shell root。

### Consumer placement 与 publication

```ts
export const CanvasWorkbench = workbench.define({
	attachments: {
		fonts: FontsPicker.place(
			workbench.tab({
				label: 'Fonts',
				order: 30,
			}),
		),
	},
})
```

```ts
this.ctx.workbench?.publish(CanvasWorkbench, {
	attachments: {
		fonts: {
			provider: this.fonts,
			target: ({ signal }) => new FontSelectionTarget(this.canvasSettings, signal),
		},
	},
})
```

`this.fonts` 必须是 Canvas Plugin 已 committed 的 direct required dependency handle。Runtime 用 definition 中的 `FontsPicker`
identity 对应 provider publication；不接收 provider string、optional dependency、candidate scan 或 fallback。

Picker renderer 只获得两个根：

```tsx
export default function FontsPickerPanel({
	provider,
	target,
	host,
}: workbenchReact.AttachmentProps<typeof FontsPicker>) {
	// provider.list(...) reads provider-owned candidates.
	// target.select(...) writes consumer-owned selection.
	// host supplies notify/confirm/navigation, never a raw socket or Shell store.
}
```

如果 UI 只修改 provider-wide default，`FontsPicker` 省略 `targetApi`，consumer 也省略 `target`。如果 consumer 只在 server 消费 font 而不嵌
provider UI，它根本不使用 Attachment，只通过正常 Plugin dependency 调用 provider domain service。

## 例五：日志、实时状态与长任务

它们仍然是一个普通 API，不建立 Query/Channel/Task registry：

```ts
export const DiagnosticsApi = capability.define({
	status: capability.method({ result: RuntimeStatusSnapshot }),
	watchStatus: capability.method({
		input: capability.callback(RuntimeStatusSnapshot),
		result: capability.target(SubscriptionApi),
	}),
	listLogs: capability.method({ input: LogPageInput, result: LogPage }),
	tailLogs: capability.method({
		input: capability.callback(LogEntry),
		result: capability.target(SubscriptionApi),
	}),
	rebuildIndex: capability.method({
		input: RebuildInput,
		result: capability.target(RebuildTaskApi),
	}),
	prepareLogDownload: capability.method({
		input: LogDownloadInput,
		result: DownloadTicket,
	}),
})
```

- 初始状态是 `status()`，之后用 callback invalidation/snapshot；
- 历史日志是 bounded `listLogs()`，live tail 才使用 callback；
- 只有真正需要 byte backpressure 的连续流才改用 Cap’n Web stream；
- 任务 target 负责 `state/cancel/watch`，opened View close 后不能继续产生新 work；
- archive 通过 ticket 下载，不为大 bytes 发明第二 dynamic API protocol。

## 例六：BotManager 仅复用源码

Telegram、KOOK、Milky 和 Discord 可以共用普通 TypeScript builder，但每个 Plugin 仍有独立 API、publication 和 lifecycle：

```ts
export const TelegramViews = defineBotManagerViews({
	apis: {
		overview: TelegramOverviewApi,
		accounts: TelegramAccountsApi,
		diagnostics: TelegramDiagnosticsApi,
	},
	renderers: {
		overview: workbench.federation.react(import.meta.url, './ui/overview.tsx'),
		accounts: workbench.federation.react(import.meta.url, './ui/accounts.tsx'),
		diagnostics: workbench.federation.react(import.meta.url, './ui/diagnostics.tsx'),
	},
	labels: { service: 'Telegram', account: 'Bot' },
})

export const TelegramWorkbench = workbench.define({ views: TelegramViews })
```

```ts
this.ctx.workbench?.publish(TelegramWorkbench, {
	views: bindBotManagerViews(TelegramViews, this.manager),
})
```

`defineBotManagerViews()` 和 `bindBotManagerViews()` 是 `platform-kit` 中的普通函数。它们在 define/init 时返回 final records，runtime
不会看到 Feature address、Bot hub、额外 registry 或网络跳转。Account 仍是 `list/open` 返回的 domain data/child target。

## 预期失败与 exception

Method 不因为走 Cap’n Web 就把全部错误改成 exception：

```ts
type UpdateResult =
	{ ok: true; value: Snapshot } | { ok: false; code: 'conflict' | 'rejected'; current: Snapshot }
```

- 可预期的业务结果用 closed discriminated result；
- invalid network input/result 由 capability wrapper 投影为 stable platform error；
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

可以存在普通 `Page<T>` schema helper、`useRemoteValue()` client helper 和 TypeScript definition builder；但它们都没有 server
registry、wire kind、owner、lease 或 independent lifecycle。

## 样例验收

- 最小 settings View 只有一个 contract、一个 View、一个 target 和一次 publication；
- 同一 root capability 直接覆盖 snapshot、mutation、watch、paged list、task 和 transfer ticket；
- 10,000 rows 不增加 View、route、MF expose、API root 或 socket；
- provider + target Attachment 严格止于两个 root，不接受任意 resource map 或第三 authority；
- Plugin 作者不看到 raw session root、WebSocket、MF Runtime、grant、manifest URL 或 Shell private store；
- 如果真实 Wretch、Fonts 或 BotManager fixture 无法用上述表面自然表达，先修正该 API，不新增 resource type system。
