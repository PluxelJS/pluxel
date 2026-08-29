# FontManager collection 端到端示例

> 状态：Workbench vNext 候选 vertical fixture，不是当前 API。本文只负责说明“provider 创建并管理 collection，required consumer 选择并消费
> collection”的完整调用面。基础 authoring 规则见 [`AUTHORING.md`](AUTHORING.md)，通用样例见 [`EXAMPLES.md`](EXAMPLES.md)。

## 场景与结论

假设 `FontManagerPlugin` 负责：

- 注册、删除和检查字体资产；
- 创建、重命名、编排和删除字体 collection；
- 用 stable `collectionId` 解析 collection 当前内容；
- 提供 collection manager/editor UI 和可嵌入的 picker UI。

`CanvasPlugin`、`TakumiPlugin` 或 `EChartsPlugin` 作为 required consumer 负责：

- 持久化“我选择了哪个 `collectionId`”；
- 决定 collection 缺失时 fallback 还是拒绝工作；
- 在自己的 Workbench tab 中放置 FontManager 提供的 picker；
- 在真正渲染时通过 constructor-injected `FontManagerPlugin` 使用 collection。

满足上述需求的默认模型只有两个 Workbench declaration：

| Declaration                   | Owner                                                                     | 用途                                       |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `manager` local View          | FontManager                                                               | 字体与 collection 的总览、CRUD、预览和安装 |
| `collectionPicker` Attachment | renderer/provider API 属于 FontManager，placement/selection 属于 consumer | 在 consumer 工作区选择 collection          |

Collection 本身是 FontManager 的持久领域对象，不是 Workbench `Collection` resource。Manager 通过普通 by-ID Cap’n Web 方法编辑它；只有产品明确要求
“同时打开多个 collection 独立 document”时，才增加第三个 parameterized View。创建 10,000 个 collection 仍然只有两个默认 declaration、一个
FontManager MF producer 和一条 page control socket。

## 先冻结 owner，而不是先设计 UI

| Fact                   | 唯一 owner                 | 持久化内容                                                 | 生命周期                           |
| ---------------------- | -------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| font bytes/metadata    | FontManager                | asset ID、family、style、hash、storage ref                 | FontManager domain policy          |
| font collection        | FontManager                | collection ID、name、ordered font IDs、revision            | FontManager domain policy          |
| consumer selection     | Canvas/Takumi/ECharts 各自 | selected collection ID、consumer revision、fallback policy | consumer config/domain state       |
| manager target         | opened FontManager View    | 当前 principal、AbortSignal                                | View close/FontManager withdrawal  |
| picker provider target | opened Attachment          | 可见 collection catalog                                    | View/FontManager/consumer 三者交集 |
| picker consumer target | opened Attachment          | 修改当前 consumer selection                                | View/consumer withdrawal           |

这张表避免两个常见错误：

1. FontManager 不保存所有 consumer 的选择；否则 consumer config ownership 会被反转。
2. Consumer 不保存 Cap’n Web stub、MF expose 或 provider string；它只保存 FontManager 能验证的 stable domain ID。

## Server domain API 独立于 Workbench

Workbench 关闭后，consumer 仍然必须能正常使用字体。因此最先存在的是普通 Plugin dependency API：

```ts
export type FontCollectionResolution =
	| Readonly<{
			kind: 'ready'
			id: string
			revision: number
			families: readonly ResolvedFontFamily[]
	  }>
	| Readonly<{ kind: 'missing'; id: string }>

@Plugin({ displayName: 'Font Manager' })
export class FontManagerPlugin extends BasePlugin {
	resolveCollection(collectionId: string): FontCollectionResolution {
		return this.collections.resolve(collectionId)
	}

	watchCollections(notify: (revision: number) => void): SubscriptionApi {
		return this.collections.watch(notify)
	}
}
```

`resolveCollection()` 是 server-to-server Plugin capability，不是 browser RPC。它可以返回 FontManager 已解析的 immutable snapshot，也可以在真实实现需要昂贵
font/native resource 时返回具有明确 withdrawal/dispose 语义的 domain handle；两种情况都不需要 Workbench registry。

Consumer 在业务路径中使用 constructor dependency：

```ts
@Plugin({ displayName: 'Canvas' })
export class CanvasPlugin extends BasePlugin {
	constructor(private readonly fonts: FontManagerPlugin) {
		super()
	}

	render(input: CanvasInput) {
		const selected = this.settings.snapshot().fontCollectionId
		if (selected === null) {
			return this.renderWithSystemFonts(input)
		}

		const collection = this.fonts.resolveCollection(selected)
		if (collection.kind === 'missing') {
			return this.renderWithSystemFonts(input) // 这是 Canvas 自己选择的 fallback policy。
		}
		return this.renderWithFamilies(input, collection.families)
	}
}
```

Required dependency 保证 FontManager generation 失败/停止时 Canvas 不会继续拿旧 provider facade 工作。单个 collection 被删除则只是 domain `missing`，不是
Plugin stop、Workbench withdrawal 或 MF event。

## Browser-safe domain values

Workbench API 只传 bounded value、callback 和确有独立生命周期的 task：

```ts
export type FontRow = Readonly<{
	id: string
	family: string
	style: string
	bytes: number
}>

export type FontCollectionRow = Readonly<{
	id: string
	name: string
	revision: number
	fontCount: number
	updatedAt: string
}>

export type FontCollectionSnapshot = Readonly<{
	id: string
	name: string
	revision: number
	fontIds: readonly string[]
}>

export type Page<T> = Readonly<{
	items: readonly T[]
	nextCursor: string | null
}>

export interface SubscriptionApi {
	close(): void
}
```

`FontCollectionRow` 是列表 value，`FontCollectionSnapshot` 是完整编辑 value。二者都没有 stub、dispose、route registration 或 runtime identity。

## Manager API 直接完成 collection CRUD

Collection 管理不需要独立 platform primitive。一个 manager root 用普通 by-ID 方法完成列表、读取、创建、修改和删除：

```ts
export type FontCollectionSnapshotResult =
	Readonly<{ ok: true; value: FontCollectionSnapshot }> | Readonly<{ ok: false; code: 'not_found' }>

export type CreateFontCollectionResult =
	| Readonly<{ ok: true; value: FontCollectionRow }>
	| Readonly<{ ok: false; code: 'name_conflict' | 'limit_exceeded' }>

export interface FontCollectionCatalogApi {
	listCollections(input: {
		cursor: string | null
		limit: number
		query?: string
	}): Promise<Page<FontCollectionRow>>
	getCollection(input: { collectionId: string }): Promise<FontCollectionSnapshotResult>
	watchCollections(notify: (catalogRevision: number) => void): SubscriptionApi
}

export type UpdateFontCollectionInput = Readonly<{
	collectionId: string
	expectedRevision: number
	name: string
	fontIds: readonly string[]
}>

export type UpdateFontCollectionResult =
	| Readonly<{ ok: true; value: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'conflict'; current: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'invalid_font' | 'not_found' }>

export type RemoveFontCollectionResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: 'conflict'; current: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'not_found' }>

export type RemoveFontResult =
	Readonly<{ ok: true }> | Readonly<{ ok: false; code: 'not_found' | 'in_use' }>

export interface FontManagerApi extends FontCollectionCatalogApi {
	listFonts(input: { cursor: string | null; limit: number; query?: string }): Promise<Page<FontRow>>
	removeFont(input: { fontId: string }): Promise<RemoveFontResult>
	createCollection(input: { name: string }): Promise<CreateFontCollectionResult>
	updateCollection(input: UpdateFontCollectionInput): Promise<UpdateFontCollectionResult>
	removeCollection(input: {
		collectionId: string
		expectedRevision: number
	}): Promise<RemoveFontCollectionResult>
	beginInstall(input: { fileName: string; bytes: number }): Promise<UploadTicket>
	install(input: { upload: CompletedUpload }): Promise<InstallTaskApi>
	watchFonts(notify: (catalogRevision: number) => void): SubscriptionApi
}
```

`FontCollectionCatalogApi` 是 manager 与 picker 共用的最小只读 shape，不是 platform interface；两个 opened root 仍可对同一方法实施不同的 principal/consumer
visibility policy。`expectedRevision` 让竞争更新以可恢复结果显式返回，不依赖 error message。

`UploadTicket`、`CompletedUpload` 和 `InstallTaskApi` 沿用 [`EXAMPLES.md`](EXAMPLES.md) 中的 single-use HTTP transfer/child task 语义；它们只服务字体文件安装。普通
font/collection row 没有 child capability。

## Definition 只有静态 UI topology

```ts
// workbench/definition.ts
import { workbench } from '@pluxel/runtime/workbench'
import type { FontCollectionCatalogApi, FontCollectionSelectionApi, FontManagerApi } from './api.ts'

export const FontManagerWorkbench = workbench.define({
	manager: workbench.view<FontManagerApi>({
		renderer: workbench.entry(import.meta.url, '../ui/manager.tsx'),
		placement: workbench.route('/fonts', {
			title: 'Fonts',
			navigation: { label: 'Fonts' },
		}),
	}),

	collectionPicker: workbench.attachment<FontCollectionCatalogApi, FontCollectionSelectionApi>({
		renderer: workbench.entry(import.meta.url, '../ui/collection-picker.tsx'),
	}),
})
```

创建、更新或删除 collection 都不改变 definition/layout；manager renderer 只用本地 React state 选择当前编辑的 `collectionId`。

## FontManager publication

```ts
protected override init() {
	this.ctx.workbench?.publish(FontManagerWorkbench, {
		manager: ({ principal, signal }) =>
			new FontManagerTarget(this.collections, { principal, signal }),
		collectionPicker: ({ consumer, principal, signal }) =>
			new FontCollectionCatalogTarget(
				this.collections.visibleTo(consumer.node, principal),
				signal,
			),
	})
}
```

`collectionPicker` factory 可以用 platform-issued `consumer.node` 应用 provider 已有的 visibility policy，但它不能取得 consumer Context、instance、config 或
dependency facade。

Publication 不枚举 collection IDs，也不在 create/delete 时重发 layout。它只发布一个 manager View factory 和一个 Attachment provider factory。

## Manager UI 如何创建和编辑 collection

```tsx
export default function FontManagerPanel() {
	const { api, host } = useWorkbench(FontManagerWorkbench.manager)
	const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null)
	const collections = useRemoteValue({
		read: () => api.listCollections({ cursor: null, limit: 50 }),
		subscribe: (invalidate) => api.watchCollections(invalidate),
	})

	async function create(name: string) {
		const result = await api.createCollection({ name })
		if (!result.ok) {
			host.notify({ message: `Create failed: ${result.code}` })
			return
		}
		setEditingCollectionId(result.value.id)
	}

	// 点击 row 只更新 editingCollectionId；editor 通过 get/update/removeCollection 工作。
}
```

Create flow 是：

```text
createCollection mutation
  -> FontManager 写入一个 domain row
  -> catalog invalidation 合并通知
  -> 当前 bounded page reread
  -> renderer 选中新 ID
  -> getCollection({ collectionId }) 取得编辑 snapshot
```

没有 collection registration、新 target、layout revision、MF rebuild 或新 socket。

### 只在独立 document UX 真实需要时加 parameterized View

如果 FontManager 产品明确要求“在多个 Workbench tab 中同时编辑 collection”，可以在不改变 domain API 的前提下增加一个参数化 View：

```ts
export interface FontCollectionDocumentApi {
	snapshot(): Promise<FontCollectionSnapshotResult>
	update(input: {
		expectedRevision: number
		name: string
		fontIds: readonly string[]
	}): Promise<UpdateFontCollectionResult>
	remove(input: { expectedRevision: number }): Promise<RemoveFontCollectionResult>
	watch(notify: (revision: number) => void): SubscriptionApi
}

collectionDocument: workbench.view<FontCollectionDocumentApi>({
	renderer: workbench.entry(import.meta.url, '../ui/collection-document.tsx'),
	placement: workbench.route('/collections/:collectionId', {
		title: 'Font collection',
	}),
})
```

同一 definition 的 publication 才相应多一个 factory：

```ts
collectionDocument: async ({ params, principal, signal }) => {
	const collection = await this.collections.admit(params.collectionId, {
		principal,
		signal,
	})
	return new FontCollectionDocumentTarget(collection, signal)
}
```

这是一个可选的 UI topology 决策，不是 collection 模型的前提。Collection row 仍没有 target；只有实际打开某个 canonical path 时，server 才重新匹配
`collectionId` 并为该 opened document 创建一个临时 scoped root。成功删除后该 root 进入 inert/removed 状态，后续操作返回 `not_found`，renderer 清除 dirty
marker 并 `navigate('/fonts')`。

## Picker 的 provider/consumer API

Provider root 使用上文的最小 `FontCollectionCatalogApi`，只能列表、读取和观察当前 consumer 可见的 collection；它没有 manager mutation。

Consumer root 只修改 consumer-owned selection，并投影 picker 真正需要的 selection 状态：

```ts
export type FontCollectionSelectionSnapshot =
	| Readonly<{
			revision: number
			status: 'none'
			collectionId: null
	  }>
	| Readonly<{
			revision: number
			status: 'ready' | 'missing'
			collectionId: string
	  }>

export type SelectFontCollectionResult =
	| Readonly<{ ok: true; value: FontCollectionSelectionSnapshot }>
	| Readonly<{
			ok: false
			code: 'conflict' | 'collection_missing' | 'rejected'
			current: FontCollectionSelectionSnapshot
	  }>

export interface FontCollectionSelectionApi {
	snapshot(): Promise<FontCollectionSelectionSnapshot>
	select(input: {
		collectionId: string
		expectedRevision: number
	}): Promise<SelectFontCollectionResult>
	clear(input: { expectedRevision: number }): Promise<SelectFontCollectionResult>
	watch(notify: () => void): SubscriptionApi
}
```

Provider API 不修改 Canvas config；consumer API 不创建、重命名或删除 provider collection。两个 authority 在类型和 target owner 上分开。

### 为什么不合成一个 `FontCollectionPickerApi`

把 catalog 和 selection 合成一个 root 表面上少一个 property，却必须虚构一个 owner：

- 由 FontManager 拥有时，provider 必须代理 CanvasSettings 的写入和 revision；
- 由 Canvas 拥有时，每个 consumer 都要重写一层 FontManager catalog forwarding，provider API 演进还要同步更新所有 consumer；
- 由 Workbench 拥有时，就变成了本提案明确不要的 collection/integration service。

Attachment renderer 本来就是两个 owner 相遇的唯一地方。固定 `{ provider, consumer }` 两个 typed roots，反而让每边都直接调用真正 owner，没有 forwarding
facade、方法 registry 或第三方 authority。Provider-only 场景在类型上直接没有 `consumer`，所以这不是一个每个 Attachment 都必须支付的空抽象。

## Consumer placement 与 publication

```ts
// Canvas workbench/definition.ts
export const CanvasWorkbench = workbench.define({
	fonts: FontManagerWorkbench.collectionPicker.place(
		workbench.tab({
			label: 'Fonts',
			order: 30,
		}),
	),
})
```

```ts
// CanvasPlugin
protected override init() {
	this.ctx.workbench?.publish(CanvasWorkbench, {
		fonts: {
			provider: this.fonts,
			consumer: ({ principal, signal }) =>
				new CanvasFontSelectionTarget(this.settings, this.fonts, {
					principal,
					signal,
				}),
		},
	})
}
```

`this.fonts` 是 Canvas constructor 已注入的 exact required dependency handle。它不是 provider string，也不会让 runtime scan 所有 Plugin 寻找 picker。

Consumer target 在写入选择前使用同一个 domain dependency 验证 ID：

```ts
class CanvasFontSelectionTarget extends RpcTarget implements FontCollectionSelectionApi {
	constructor(
		private readonly settings: CanvasSettings,
		private readonly fonts: FontManagerPlugin,
		private readonly open: Pick<ViewOpenContext, 'principal' | 'signal'>,
	) {
		super()
	}

	snapshot(): Promise<FontCollectionSelectionSnapshot> {
		const current = this.settings.snapshotFontCollectionSelection(this.open.principal)
		if (current.collectionId === null) {
			return Promise.resolve({ ...current, status: 'none' })
		}

		const resolved = this.fonts.resolveCollection(current.collectionId)
		return Promise.resolve({ ...current, status: resolved.kind })
	}

	select(input: { collectionId: string; expectedRevision: number }) {
		const resolved = this.fonts.resolveCollection(input.collectionId)
		if (resolved.kind === 'missing') {
			return this.settings.rejectFontSelection('collection_missing')
		}
		return this.settings.selectFontCollection(input, this.open)
	}

	clear(input: { expectedRevision: number }) {
		return this.settings.clearFontCollection(input, this.open)
	}

	watch(notify: () => void): SubscriptionApi {
		return mergeSubscriptions(
			this.settings.watchFontCollectionSelection(this.open.principal, () => notify()),
			this.fonts.watchCollections(() => notify()),
			this.open.signal,
		)
	}
}
```

`snapshot()` 用 FontManager 当前内容投影 `ready | missing`，但 selection ID/revision 仍由 CanvasSettings 拥有。`watch()` 只是这个 Attachment target 内的普通
TypeScript 组合：任一 consumer selection 或 provider catalog 变化都会使 snapshot 失效；`mergeSubscriptions` 不是 Workbench 概念。`principal` 只是已认证的 server-derived
factory input，CanvasSettings 用它授权 consumer mutation，`FontCollectionCatalogTarget` 用它授权 provider catalog read。如果“可见”和“可选”不是同一条 domain
policy，`select()` 再调用 FontManager 明确的 selection admission 方法；Workbench 不校验这些 collection 规则。

## Picker renderer

```tsx
export default function FontCollectionPickerPanel() {
	const { provider, consumer, host } = useWorkbench(FontManagerWorkbench.collectionPicker)
	const [query, setQuery] = useState('')
	const catalog = useRemoteValue(
		{
			read: () =>
				provider.listCollections({
					cursor: null,
					limit: 50,
					query,
				}),
			subscribe: (invalidate) => provider.watchCollections(invalidate),
		},
		[query],
	)
	const selection = useRemoteValue({
		read: () => consumer.snapshot(),
		subscribe: (invalidate) => consumer.watch(invalidate),
	})

	async function select(collectionId: string) {
		if (selection.state !== 'ready') return
		const result = await consumer.select({
			collectionId,
			expectedRevision: selection.value.revision,
		})
		if (!result.ok) host.notify({ message: `Selection failed: ${result.code}` })
	}

	// provider rows + consumer selected ID 足以渲染 picker。
}
```

Renderer 使用同一个 Bridge/Context，但只拿到这次 Attachment 的两个 roots。它不能取得 FontManager manager API、Canvas Plugin instance、其他 View API 或 raw
session root。

## 一条完整操作链

```text
FontManager init
  -> 原子 publish manager factory + collectionPicker provider factory

Canvas init
  -> required constructor dependency 已取得 this.fonts
  -> publish Canvas 的 picker placement + selection factory

用户在 FontManager manager 创建 collection
  -> 同一 Cap'n Web/WS session 调用 createCollection()
  -> FontManager 持久化 row，manager 本地选中新 collectionId

用户打开 Canvas 的 Fonts tab
  -> openView() 同时取得 provider catalog root + Canvas selection root
  -> MF 加载 FontManager 拥有的 picker renderer

用户选择 collection
  -> picker 调用 consumer.select({ collectionId, expectedRevision })
  -> Canvas target 用 this.fonts 验证 ID，只把 collectionId 写入 CanvasSettings

Canvas 真正渲染
  -> 不经 Workbench/WS/MF
  -> CanvasPlugin 直接调用 this.fonts.resolveCollection(collectionId)
  -> 使用当前 immutable font family snapshot
```

因此 Workbench 只出现在“人如何管理和选择”的路径上；业务执行仍在 Plugin graph 内走直接 dependency capability。Browser 与 Canvas 持久化状态都不保存
Cap’n Web stub、Attachment descriptor 或 MF expose。

## Rename、delete 与 replacement

本 fixture 选择一个明确且实用的 deletion policy：允许 FontManager 删除 collection，不暗中改写 consumer config。

- rename/reorder/add/remove font：collection ID 不变、revision 增加；consumer 下次 resolve 自动看到新内容；
- delete：consumer 仍保存原 ID，但 `resolveCollection()` 返回 `missing`，picker snapshot 显示 `status: 'missing'`；
- Canvas 根据自己的 policy fallback 到 system/default fonts，或稳定拒绝 render；
- 用户重新选择时 consumer mutation 覆盖旧 ID；
- FontManager 不扫描所有 consumer config，也不自动替用户选择另一个 collection。

Manager 中删除成功只需清除本地编辑选择；它不关闭 platform resource：

```tsx
const result = await api.removeCollection({
	collectionId: collection.id,
	expectedRevision: collection.revision,
})
if (result.ok) {
	setEditingCollectionId(null)
}
```

如果产品要求“有 consumer 使用时禁止删除”，FontManager 可以在自己的 domain service 增加 usage admission/lease 并返回 `in_use`；这仍然是 FontManager
业务规则，不需要 Workbench Collection registry。

Lifecycle 继续沿现有 owner：

- Canvas stop 只撤销 Canvas placement、consumer target 和相关 opened Attachment，不撤销 FontManager manager；
- FontManager stop 会让 required Canvas dependent 一起退出 effective graph，并撤销全部 provider roots；
- provider/consumer replacement 后旧 stubs 稳定失败，新 generation 必须重新 publication/open；
- WS disconnect 只销毁当前 connection epoch 的 targets/subscriptions，持久 font、collection 和 selection 不丢失。

## 规模与成本

假设 FontManager 有 `N` 个 collection、`M` 个 consumer Plugin、当前打开 `O` 个相关 document/tab：

| Inventory                      | 数量关系                                                    |
| ------------------------------ | ----------------------------------------------------------- |
| FontManager definition entries | 默认固定 2；选用 document UX 时固定 3，与 `N` 无关          |
| FontManager MF producer        | 固定 1                                                      |
| control WebSocket / page       | 固定 1                                                      |
| collection rows                | `N`，只存在于 domain storage 与 bounded API page            |
| consumer placement             | 每个明确选择嵌入 picker 的 consumer 1 个，即 `O(M)`         |
| opened API roots               | 只随当前打开 View/Attachment 增长，即 `O(O)`，不随 `N` 增长 |

`listCollections()` 必须 clamp/reject page limit、限制 serialized bytes，并让 query/index 受数据库预算约束。高频大 catalog 若 measured reread 成本不可接受，
可以把 revision/coalescing/patch 封装为 FontManager 内部 helper；不能为此让每个 row 获得 Workbench identity。

## 三种常见变体

### Consumer-specific selection

本例使用的 `Attachment<FontCollectionCatalogApi, FontCollectionSelectionApi>`。Provider 列候选，consumer 写自己的 selection，是 Canvas/Takumi/ECharts
最常见形态。

### Provider-wide default

如果 UI 修改的是 FontManager 全局默认，而不是 consumer config，使用 provider-only
`Attachment<FontCollectionDefaultApi>`；consumer publication 省略 `consumer` factory，hook 类型也没有 `consumer` property。

### Server-only consumption

如果 consumer 只在代码/config 中引用 collection，不需要嵌入 FontManager UI，则完全不声明 Attachment。它只使用 constructor dependency 的
`resolveCollection()`，Workbench disabled 时行为不变。

## API 是否足够优雅实用

对当前已知场景，答案是肯定的，原因不是 API 最通用，而是每个事实只声明一次：

- collection identity、内容和 mutation 只在 FontManager domain 出现；
- consumer 只持久化 ID 与自己的 fallback policy；
- 默认只有 manager local View 和 picker Attachment；parameterized document 是经产品 UX 证明后才增加的可选 topology；
- provider catalog 与 consumer selection 是两个清楚的 API root，不用 arbitrary resource map；
- required constructor edge 同时服务真实业务调用和 Attachment resolution，不再建立 Port candidate graph；
- 创建和编辑 collection 默认不触发 runtime registration 或新 target；
- Domain validation、revision conflict、delete/fallback 都在真正 owner 中实现，Workbench 不猜业务规则。

这套 API 有意不覆盖以下结构：

- optional/unknown provider marketplace、priority 或 fallback discovery；
- 跨多个 FontManager provider 的原子 collection join；
- 恶意同源 renderer sandbox；
- 离线编辑与跨 connection mutation replay。

如果未来真的出现这些产品需求，应先建立新的 domain owner/Plugin 或独立安全设计，而不是给 Attachment 增加 scan、registry、priority、third authority 或 resume
protocol。
