# Plugin-facing API examples

> 这些样例固定 vNext 的目标调用面，不是当前 API。它们只展示 Workbench 特有 wiring；领域
> service、parser、authorization 和 UI 细节由 Plugin 自己实现。

## 1. Minimal settings View

Browser-safe API：

```ts
export type SettingsSnapshot = Readonly<{
	revision: number
	enabled: boolean
	endpoint: string
}>

export type SettingsResult =
	| Readonly<{ ok: true; value: SettingsSnapshot }>
	| Readonly<{ ok: false; code: 'conflict'; current: SettingsSnapshot }>
	| Readonly<{ ok: false; code: 'invalid_endpoint' }>

export interface SubscriptionApi {
	close(): void
}

export interface SettingsApi {
	snapshot(): Promise<SettingsSnapshot>
	update(input: {
		expectedRevision: number
		enabled: boolean
		endpoint: string
	}): Promise<SettingsResult>
	watch(invalidate: () => void): SubscriptionApi
}
```

Definition 与 publication：

```ts
export const ExampleWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer: workbench.entry(import.meta.url, '../ui/settings.tsx'),
		placement: workbench.tab({ label: 'Settings', order: 20 }),
	}),
})

@Plugin({ displayName: 'Example' })
export class ExamplePlugin extends BasePlugin {
	private readonly settings = new SettingsService()

	protected override init() {
		this.ctx.workbench?.publish(ExampleWorkbench, {
			settings: ({ principal, signal }) =>
				new SettingsTarget(this.settings.authorizedFor(principal), signal),
		})
	}
}
```

Renderer：

```tsx
export default function SettingsPanel() {
	const { api, host } = useWorkbench(ExampleWorkbench.settings)
	const settings = useRemoteValue({
		read: () => api.snapshot(),
		subscribe: (invalidate) => api.watch(invalidate),
	})

	if (settings.state !== 'ready') return <p>{settings.state}</p>

	const value = settings.value
	return (
		<button
			onClick={async () => {
				const result = await api.update({
					expectedRevision: value.revision,
					enabled: !value.enabled,
					endpoint: value.endpoint,
				})
				if (!result.ok) {
					host.notify({ message: `Update failed: ${result.code}` })
				}
			}}
		>
			Toggle
		</button>
	)
}
```

这个页面只有一个 domain interface、一个 View descriptor、一个 factory 和一个 target。API generic
由 descriptor 贯穿 factory 与 hook；作者不再声明 resource key、grant、client facade、remote name
或 Bridge props。

## 2. Parameterized account document

Account row 保持 by-value；独立 document UX 由一个 route pattern 表达：

```ts
export const TelegramWorkbench = workbench.define({
	account: workbench.view<TelegramAccountApi>({
		renderer: workbench.entry(import.meta.url, '../ui/account.tsx'),
		placement: workbench.route('/accounts/:accountId', {
			title: 'Telegram account',
		}),
	}),
})

ctx.workbench?.publish(TelegramWorkbench, {
	account: async ({ params, principal, signal }) => {
		const account = await this.accounts.admit(params.accountId, {
			principal,
			signal,
		})
		return new TelegramAccountTarget(account, signal)
	},
})
```

Browser 只请求 canonical relative path。Server 重新匹配 declared pattern，再把 frozen params 交给
factory；不存在 browser-supplied authority record。每次实际打开创建独立 root/signal，但所有 accounts
复用同一个 View descriptor、Bridge expose 和 route pattern。

Manager renderer 打开 document：

```ts
host.navigation?.openDocument({
	path: `/accounts/${encodeURIComponent(account.id)}`,
	title: account.displayName,
	meta: 'Telegram',
})
```

Document renderer 管理 chrome：

```tsx
export default function AccountEditor() {
	const { api, host } = useWorkbench(TelegramWorkbench.account)
	const account = useRemoteValue({
		read: () => api.snapshot(),
		subscribe: (invalidate) => api.watch(invalidate),
	})
	const [dirty, setDirty] = useState(false)

	useEffect(() => {
		host.document?.setDirty(dirty)
		return () => host.document?.setDirty(false)
	}, [dirty, host.document])

	useEffect(() => {
		if (account.state === 'ready') {
			host.document?.setTitle({
				title: account.value.displayName,
				meta: 'Telegram',
			})
		}
	}, [account, host.document])

	// host owns close confirmation; remote has no beforeClose callback.
}
```

如果 account 只在 manager 内编辑，则不声明 parameterized View，直接用 manager root 的 by-ID CRUD。

## 3. Live data、task 与 file transfer

这些交互继续属于一个 root：

```ts
export interface DiagnosticsApi {
	status(): Promise<RuntimeStatusSnapshot>
	watchStatus(invalidate: () => void): SubscriptionApi
	listLogs(input: LogPageInput): Promise<LogPage>
	tailLogs(push: (entry: LogEntry) => void): SubscriptionApi
	rebuildIndex(input: RebuildInput): RebuildTaskApi
	prepareLogDownload(input: LogDownloadInput): Promise<DownloadTicket>
}

export interface RebuildTaskApi {
	state(): Promise<RebuildTaskSnapshot>
	cancel(): Promise<void>
	watch(invalidate: () => void): SubscriptionApi
}
```

规则：

- historical logs 使用 bounded page；live tail 才使用 callback；
- progress burst 在 producer 侧 coalesce；需要 byte backpressure 的连续流才使用 Cap’n Web stream；
- task 是 child capability，因为它确实有独立 state/cancel/lifecycle；
- task 绑定 opened View、Plugin generation 与 request admission，关闭后停止新 work 并有界 drain；
- archive bytes 不进入 Cap’n Web frame，而由 root 签发 single-use ticket。

Download 调用面：

```ts
const ticket = await api.prepareLogDownload({ from, to })
await host.transfer.download(ticket, {
	signal,
	onProgress: ({ transferred, total }) => setProgress(transferred / total),
})
```

Upload 同理：

```ts
const ticket = await api.beginInstall({ fileName: file.name, bytes: file.size })
const completed = await host.transfer.upload(ticket, file, { signal, onProgress })
const task = await api.install({ upload: completed })
```

`host.transfer` 固定 credential、expiry、progress、cancel 与 stable transfer failure；它不是 generic HTTP
client。

## 4. Attachment

### Provider-only: Wretch managed settings

Wretch provider 拥有 renderer/API，并按 exact consumer node 管理 state；consumer 只放置页面：

```ts
export const WretchWorkbench = workbench.define({
	settings: workbench.attachment<WretchSettingsApi>({
		renderer: workbench.entry(import.meta.url, '../ui/settings.tsx'),
	}),
})

ctx.workbench?.publish(WretchWorkbench, {
	settings: ({ consumer, signal }) =>
		new WretchSettingsTarget(this.managedSettings.require(consumer.node), signal),
})
```

Consumer：

```ts
export const HttpConsumerWorkbench = workbench.define({
	http: WretchWorkbench.settings.place(
		workbench.tab({ label: 'HTTP' }),
	),
})

protected override async init() {
	await this.http.enableManagedSettings()

	this.ctx.workbench?.publish(HttpConsumerWorkbench, {
		http: { provider: this.http },
	})
}
```

Renderer 使用 `useWorkbench(WretchWorkbench.settings)`，只得到 `{ provider, host }`。`consumer.node`
是 server-only exact generation address；它只关联 Wretch 已拥有的 state，不授予 consumer Context
或任意调用能力。

### Provider + consumer: collection picker

当 provider 拥有候选 catalog、consumer 拥有 selection 时，Attachment 有两个 roots：

```ts
export const CanvasWorkbench = workbench.define({
	fonts: FontManagerWorkbench.collectionPicker.place(workbench.tab({ label: 'Fonts' })),
})

ctx.workbench?.publish(CanvasWorkbench, {
	fonts: {
		provider: this.fonts,
		consumer: ({ principal, signal }) =>
			new CanvasFontSelectionTarget(this.settings, this.fonts, {
				principal,
				signal,
			}),
	},
})
```

Provider root 读取 FontManager catalog；consumer root 读取/修改 Canvas selection。两者不相互转发，
Workbench 也不成为 integration service。完整 API、subscription 与 delete/missing behavior 见
[`FONT_COLLECTION_EXAMPLE.md`](FONT_COLLECTION_EXAMPLE.md)。

Consumer 只在 server 使用字体、但不嵌入 provider UI 时，完全不声明 Attachment；它只使用普通
constructor dependency。

## 5. BotManager composition

Telegram、KOOK、Milky 与 Discord 的相同点是页面 topology，不是 runtime owner。每个平台仍拥有
自己的 persistence、connection、auth/admission、targets、publication 与 failure boundary。

可以用普通 TypeScript function 生成重复的 final entries：

```ts
type BotRendererEntry = ReturnType<typeof workbench.entry>

function defineBotManagerEntries<OverviewApi, AccountsApi, DiagnosticsApi>(input: {
	entries: Readonly<{
		overview: BotRendererEntry
		accounts: BotRendererEntry
		diagnostics: BotRendererEntry
	}>
	routeBase: `/${string}`
	labels: Readonly<{ service: string; account: string }>
}) {
	const group = { id: 'bots', label: 'Bots' } as const
	return {
		overview: workbench.view<OverviewApi>({
			renderer: input.entries.overview,
			placement: workbench.route(input.routeBase, {
				title: input.labels.service,
				navigation: { label: input.labels.service, group },
			}),
		}),
		accounts: workbench.view<AccountsApi>({
			renderer: input.entries.accounts,
			placement: workbench.route(`${input.routeBase}/accounts`, {
				title: `${input.labels.service} ${input.labels.account}s`,
				navigation: { label: `${input.labels.account}s`, group },
			}),
		}),
		diagnostics: workbench.view<DiagnosticsApi>({
			renderer: input.entries.diagnostics,
			placement: workbench.route(`${input.routeBase}/diagnostics`, {
				title: `${input.labels.service} diagnostics`,
				navigation: { label: 'Diagnostics', group },
			}),
		}),
	}
}
```

Telegram 使用它：

```ts
export const TelegramWorkbench = workbench.define(
	defineBotManagerEntries<TelegramOverviewApi, TelegramAccountsApi, TelegramDiagnosticsApi>({
		entries: {
			overview: workbench.entry(import.meta.url, './ui/overview.tsx'),
			accounts: workbench.entry(import.meta.url, './ui/accounts.tsx'),
			diagnostics: workbench.entry(import.meta.url, './ui/diagnostics.tsx'),
		},
		routeBase: '/telegram',
		labels: { service: 'Telegram', account: 'Bot' },
	}),
)
```

Publication 保持显式，因为平台间 auth、admission 与 factories 通常不同：

```ts
ctx.workbench?.publish(TelegramWorkbench, {
	overview: ({ principal, signal }) =>
		new TelegramOverviewTarget(this.manager, { principal, signal }),
	accounts: ({ principal, signal }) =>
		new TelegramAccountsTarget(this.manager, { principal, signal }),
	diagnostics: ({ principal, signal }) =>
		new TelegramDiagnosticsTarget(this.diagnostics, { principal, signal }),
})
```

只有多个平台确实共享 factory ownership 和 failure semantics 时，才增加普通 binder；binder 仍只返回
final record，不发布 registry 或 runtime identity。

Bot 场景的最终映射：

| 需求                                | 设计                                             |
| ----------------------------------- | ------------------------------------------------ |
| 管理 account list/CRUD              | manager local View + bounded by-ID API           |
| account 独立 editor/logs/connection | optional parameterized account View              |
| Wretch UI 嵌入平台 Plugin           | provider-owned Attachment                        |
| 另一 Plugin 选择某个 bot account    | provider catalog + consumer selection Attachment |
| 实际发送消息                        | constructor-injected platform Plugin dependency  |

Account 数量不改变 Workbench topology。不存在中心 BotManager Plugin、Feature registry、account
publication 或跨平台 service locator。
