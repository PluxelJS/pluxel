# FontManager collection vertical spec

> 本文固定“FontManager 管理 collection，required consumer 选择并消费 collection”的最终设计。
> Collection 是 FontManager domain object；只有 `collectionPicker` 是 Workbench Attachment。

## Topology 与 ownership

默认只有两个 Workbench entries：

```ts
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

| State/capability     | Owner                         | Persisted value                             |
| -------------------- | ----------------------------- | ------------------------------------------- |
| font assets          | FontManager                   | asset ID、metadata、hash、storage reference |
| font collection      | FontManager                   | ID、name、ordered font IDs、revision        |
| consumer selection   | Canvas/Takumi/ECharts         | collection ID、revision、fallback policy    |
| manager root         | opened FontManager View       | 不持久化；绑定 principal/signal             |
| picker provider root | FontManager Attachment        | 不持久化；只读 catalog                      |
| picker consumer root | consumer Attachment placement | 不持久化；只读写 consumer selection         |

FontManager 不保存各 consumer 的选择。Consumer 不保存 RPC stub、MF expose、provider string 或
Workbench identity，只保存 stable `collectionId`。创建或删除 collection 不改变 definition、layout、
publication、producer 或 route inventory。

## Server domain dependency

Workbench disabled 时字体消费必须照常工作，因此业务路径使用正常 Plugin dependency：

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
}
```

Consumer 通过 constructor dependency 使用它：

```ts
@Plugin({ displayName: 'Canvas' })
export class CanvasPlugin extends BasePlugin {
	constructor(private readonly fonts: FontManagerPlugin) {
		super()
	}

	render(input: CanvasInput) {
		const collectionId = this.settings.snapshot().fontCollectionId
		if (collectionId === null) return this.renderWithSystemFonts(input)

		const collection = this.fonts.resolveCollection(collectionId)
		if (collection.kind === 'missing') return this.renderWithSystemFonts(input)
		return this.renderWithFamilies(input, collection.families)
	}
}
```

Fallback 或 hard failure 是 consumer policy。单个 collection 缺失是 domain state，不触发 Plugin
withdrawal、Workbench event 或 MF update。`FontManagerPlugin` 不暴露只为 picker UI 服务的
`watchCollections()` dependency method；browser catalog watch 只存在于 picker/manager target。

## Browser-safe domain API

```ts
export type Page<T> = Readonly<{
	items: readonly T[]
	nextCursor: string | null
}>

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

export interface SubscriptionApi {
	close(): void
}
```

Rows 与 snapshots 都是 bounded values，没有 target、dispose、route 或 runtime identity。

Catalog API 是 FontManager 自己复用的领域 shape，不是 platform interface：

```ts
export type FontCollectionSnapshotResult =
	Readonly<{ ok: true; value: FontCollectionSnapshot }> | Readonly<{ ok: false; code: 'not_found' }>

export interface FontCollectionCatalogApi {
	listCollections(input: {
		cursor: string | null
		limit: number
		query?: string
	}): Promise<Page<FontCollectionRow>>

	getCollection(input: { collectionId: string }): Promise<FontCollectionSnapshotResult>

	watchCollections(invalidate: () => void): SubscriptionApi
}
```

Manager root 扩展 catalog 并直接完成 by-ID CRUD：

```ts
export type CreateFontCollectionResult =
	| Readonly<{ ok: true; value: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'name_conflict' | 'limit_exceeded' }>

export type UpdateFontCollectionResult =
	| Readonly<{ ok: true; value: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'conflict'; current: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'invalid_fonts'; fontIds: readonly string[] }>
	| Readonly<{ ok: false; code: 'not_found' }>

export type RemoveFontCollectionResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: 'conflict'; current: FontCollectionSnapshot }>
	| Readonly<{ ok: false; code: 'not_found' }>

export interface FontManagerApi extends FontCollectionCatalogApi {
	listFonts(input: { cursor: string | null; limit: number; query?: string }): Promise<Page<FontRow>>

	createCollection(input: { name: string }): Promise<CreateFontCollectionResult>

	updateCollection(input: {
		collectionId: string
		expectedRevision: number
		name: string
		fontIds: readonly string[]
	}): Promise<UpdateFontCollectionResult>

	removeCollection(input: {
		collectionId: string
		expectedRevision: number
	}): Promise<RemoveFontCollectionResult>

	removeFont(input: { fontId: string }): Promise<RemoveFontResult>
	beginInstall(input: { fileName: string; bytes: number }): Promise<UploadTicket>
	install(input: { upload: CompletedUpload }): Promise<InstallTaskApi>
	watchFonts(invalidate: () => void): SubscriptionApi
}
```

`createCollection()` 返回完整 snapshot，因此 manager 可以直接进入编辑态，不需要串行调用
`getCollection()`。`expectedRevision` 使冲突可恢复；`invalid_fonts` 返回具体 IDs，使 UI 能定位问题。
Plugin 自己 clamp/reject `limit`、限制 page bytes/font count/name，并执行 authorization。

文件 bytes 通过 single-use HTTP transfer ticket；只有 install task 和 subscription 是 child capability。

## FontManager publication 与 manager behavior

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

Provider factory 可用 platform-issued `consumer.node` 应用已有 visibility policy，但不能取得 consumer
Context、instance、config 或 dependency facade。Publication 只绑定两个 factories，不枚举 IDs。

Manager renderer 保持本地 `editingCollectionId`/draft state：

```ts
const result = await api.createCollection({ name })
if (result.ok) {
	setEditingCollectionId(result.value.id)
	setDraft(result.value)
}
```

List invalidation 使当前 bounded page 重读；创建结果本身已足够进入 editor。点击其他 row 才按需
`getCollection()`。Update 成功以返回 snapshot 替换 draft；conflict 显示 current snapshot；remove
成功清空当前 draft。以上操作都不创建新 root 或 route。

## Consumer selection API

Consumer root 只拥有 selection，不代理 provider catalog：

```ts
export type FontCollectionSelectionSnapshot = Readonly<{
	revision: number
	collectionId: string | null
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
	watch(invalidate: () => void): SubscriptionApi
}
```

`ready | missing | none` 不是持久状态，也不属于 consumer root；它是 Attachment renderer 把 provider
catalog 与 consumer selection 组合出的 read projection。

Consumer target 在 mutation 时直接使用 constructor dependency 验证 ID，而 `watch()` 只观察
consumer-owned settings：

```ts
class CanvasFontSelectionTarget extends RpcTarget implements FontCollectionSelectionApi {
	constructor(
		private readonly settings: CanvasSettings,
		private readonly fonts: FontManagerPlugin,
		private readonly open: Pick<ViewOpenContext, 'principal' | 'signal'>,
	) {
		super()
	}

	snapshot() {
		return Promise.resolve(this.settings.snapshotFontCollectionSelection(this.open.principal))
	}

	select(input: { collectionId: string; expectedRevision: number }) {
		if (this.fonts.resolveCollection(input.collectionId).kind === 'missing') {
			return this.settings.rejectFontSelection('collection_missing')
		}
		return this.settings.selectFontCollection(input, this.open)
	}

	clear(input: { expectedRevision: number }) {
		return this.settings.clearFontCollection(input, this.open)
	}

	watch(invalidate: () => void) {
		return new SubscriptionTarget(
			this.settings.watchFontCollectionSelection(this.open.principal, () => void invalidate()),
		)
	}
}
```

选择成功后 provider 仍可能被并发删除；这不是跨 Plugin transaction。Provider invalidation 会把
picker projection 改成 `missing`，业务消费按 consumer fallback policy 处理。

## Consumer placement 与 publication

```ts
export const CanvasWorkbench = workbench.define({
	fonts: FontManagerWorkbench.collectionPicker.place(
		workbench.tab({ label: 'Fonts', order: 30 }),
	),
})

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

`this.fonts` 是 committed direct required dependency handle。Canvas placement 不生成自己的 MF
producer；它引用 FontManager producer 中的 picker expose。

## Picker read model

Picker entry 取得两个精确 roots：

```tsx
export default function FontCollectionPickerPanel() {
	const { provider, consumer, host } = useWorkbench(FontManagerWorkbench.collectionPicker)
	const picker = useFontCollectionPicker({ provider, consumer })

	// picker.catalog: current bounded provider page
	// picker.selection: revision + collectionId + none/ready/missing projection
	// picker.setQuery(...) only rereads the catalog
	// picker.select(...) calls the consumer root
}
```

`useFontCollectionPicker()` 是 FontManager UI package 中的普通 domain React helper，不是 Workbench
API。它拥有一个 provider subscription 和一个 consumer subscription：

```text
start
  subscribe provider.watchCollections
  subscribe consumer.watch
  read consumer.snapshot
  read current catalog page
  if selected ID != null: provider.getCollection(ID)

provider invalidation
  coalesce -> reread current catalog page
           -> recheck current selected ID -> ready/missing

consumer invalidation
  coalesce -> reread selection
           -> only when selected ID changes, recheck that ID

query/cursor change
  reread catalog page only

dispose
  close both subscriptions and reject late reads
```

这样 catalog 与 derived selection status 共用同一个 provider subscription；consumer target 不再
通过 `FontManagerPlugin.watchCollections()` 建立第二个 provider watch。Helper 使用
`useSyncExternalStore` 暴露 tear-free snapshot，并沿用 sequence/epoch guard，旧 read 不覆盖新状态。

## Rename、delete 与 replacement

- Rename 保持 stable ID，provider catalog invalidation 刷新 row，consumer selection 无需写入；
- Delete 使 provider `getCollection(id)` 返回 `not_found`，picker projection 变为 `missing`；
- Delete 不自动清空 consumer persisted ID，避免 provider 越权修改所有 consumers；
- Consumer 可明确 clear/select 新 ID，业务路径在此之前执行自己的 fallback/rejection；
- FontManager generation replacement 撤销 manager 与所有 picker provider roots；
- Consumer replacement 撤销自己的 picker placement 与 consumer root；
- Opened View close 关闭两个 subscriptions；socket close 最终释放整个 object graph。

## Optional collection document

只有产品确实要求同时打开多个独立 collection editor 时，才增加一个 parameterized View：

```ts
collectionDocument: workbench.view<FontCollectionDocumentApi>({
	renderer: workbench.entry(import.meta.url, '../ui/collection-document.tsx'),
	placement: workbench.route('/collections/:collectionId', {
		title: 'Font collection',
	}),
})
```

Factory 使用 server-derived `params.collectionId` admission，并只为实际打开的 document 创建 scoped
root。Collection row 仍不是 capability/publication entity；默认 manager 不因这个可选 UX 变复杂。

## Complexity bounds

| 变化                     | View entries    | opened roots        | MF producer/expose       | page WS |
| ------------------------ | --------------- | ------------------- | ------------------------ | ------- |
| 1 -> 10,000 collections  | 2               | 0                   | 1 / 2                    | 1       |
| N consumers place picker | provider 仍为 2 | 0                   | provider 仍为 1 / 2      | 1       |
| 打开 manager             | 不变            | 1 local root        | 按需加载 manager         | 1       |
| 打开一个 consumer picker | 不变            | provider + consumer | 按需加载 picker          | 1       |
| 打开 optional document   | 不变            | 1 scoped root       | 复用一个 document expose | 1       |

这套结构覆盖管理、选择、missing、fallback、并发编辑、任务与文件，同时没有 collection registry、
per-row capability、provider scan、转发 facade 或重复 provider subscription。
