---
title: 插件间 UI 组合
description: 用 Attachment 覆盖 provider 设置、FontManager collection 和 BotManager 等真实场景。
---

Attachment 适合“provider 拥有界面，consumer 决定把它放在哪里”的场景。它只组合每次打开所需的
Cap’n Web roots，不建立新的依赖注入、状态存储或领域模型。

先确认确实需要跨 Plugin 复用 UI。如果 consumer 只在服务端调用 provider，就使用普通 constructor dependency；
如果 consumer 自己完全拥有页面和 API，就使用本地 View。

## Provider-only 设置页

以共享 HTTP provider 为例：provider 已按 caller node 保存设置，consumer 只希望在自己的详情页放置 provider 的设置页。

Provider 的 browser-safe declaration：

```ts
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export type HttpSettings = Readonly<{
	headers: Readonly<Record<string, string>>
	timeoutMs?: number
}>

export interface HttpSettingsApi extends RpcTarget {
	snapshot(): HttpSettings
	update(input: HttpSettings): Promise<HttpSettings>
	reset(): Promise<HttpSettings>
}

export const HttpWorkbench = workbench.define({
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})
```

Provider 发布一个按 exact consumer node admission 的 target：

```ts
this.ctx.workbench?.publish(HttpWorkbench, {
	settings: ({ consumer, signal }) =>
		new HttpSettingsTarget(this.settings.require(consumer.node), signal),
})
```

`consumer.node` 只是 server-issued identity。Provider 可以用它查找自己已经拥有的 per-consumer state，但不能
取得 consumer instance、Context、config 或任意 dependency facade。

Consumer 通过 constructor dependency 持有 provider，然后声明 placement：

```ts
import { HttpWorkbench } from '@acme/http/workbench'
import { workbench } from '@pluxel/runtime/workbench'

export const ReportsWorkbench = workbench.define({
	http: HttpWorkbench.settings.place(
		workbench.tab({ label: 'HTTP', icon: workbench.icons.Settings }),
	),
})

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly http: HttpPlugin) {
		super()
	}

	override init() {
		this.ctx.workbench?.publish(ReportsWorkbench, {
			http: { provider: this.http },
		})
	}
}
```

Renderer 仍位于 provider package：

```tsx
export default function HttpSettingsPanel() {
	const { provider, host } = useWorkbench(HttpWorkbench.settings)
	// provider is RpcStub<HttpSettingsApi>
}
```

这条路径只有一个 renderer 和一个 provider API。Consumer 不实现转发 target，不复制 provider 的 UI，也不把
设置 state 搬到 Workbench。

## Provider catalog + consumer selection

FontManager 类型的场景多一个真实 owner：

- provider 拥有字体资产和 collection catalog；
- consumer 拥有“当前选择哪个 collection”及自己的 fallback policy；
- picker UI 需要同时读取 catalog 和修改 selection。

因此 Attachment 声明两个 roots：

```ts
export type FontCollectionRow = Readonly<{
	id: string
	name: string
	revision: number
	fontCount: number
}>

export type FontCollectionSnapshot = Readonly<{
	id: string
	name: string
	revision: number
	fontIds: readonly string[]
}>

export type FontSelection = Readonly<{
	revision: number
	collectionId: string | null
}>

export interface FontCatalogApi extends RpcTarget {
	list(input: { cursor: string | null; limit: number; query?: string }): Readonly<{
		items: readonly FontCollectionRow[]
		nextCursor: string | null
	}>
	get(input: { collectionId: string }):
		| Readonly<{ ok: true; value: FontCollectionSnapshot }>
		| Readonly<{ ok: false; code: 'not_found' }>
	watch(invalidate: () => void): RpcTarget
}

export interface FontManagerApi extends RpcTarget {
	listCollections(input: {
		cursor: string | null
		limit: number
		query?: string
	}): Promise<Readonly<{ items: readonly FontCollectionRow[]; nextCursor: string | null }>>
	createCollection(input: { name: string }): Promise<FontCollectionSnapshot>
	updateCollection(input: {
		id: string
		expectedRevision: number
		name?: string
		fontIds?: readonly string[]
	}): Promise<
		| Readonly<{ ok: true; value: FontCollectionSnapshot }>
		| Readonly<{ ok: false; code: 'conflict' | 'not_found' }>
	>
	removeCollection(input: { id: string; expectedRevision: number }): Promise<
		| Readonly<{ ok: true }>
		| Readonly<{ ok: false; code: 'conflict' | 'not_found' }>
	>
}

export interface FontSelectionApi extends RpcTarget {
	snapshot(): FontSelection
	select(input: { collectionId: string; expectedRevision: number }): Promise<
		| Readonly<{ ok: true; value: FontSelection }>
		| Readonly<{
				ok: false
				code: 'conflict' | 'collection_missing' | 'rejected'
				current: FontSelection
		  }>
	clear(input: { expectedRevision: number }): Promise<FontSelection>
	watch(invalidate: () => void): RpcTarget
}

export const FontManagerWorkbench = workbench.define({
	manager: workbench.view<FontManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.route('/fonts', {
			title: 'Fonts',
			navigation: { label: 'Fonts' },
		}),
	}),
	collectionPicker: workbench.attachment<FontCatalogApi, FontSelectionApi>({
		renderer: workbench.entry(import.meta.url, './ui/collection-picker.tsx'),
	}),
})
```

FontManager 发布 manager 和 catalog roots：

```ts
this.ctx.workbench?.publish(FontManagerWorkbench, {
	manager: ({ principal, signal }) =>
		new FontManagerTarget(this.collections.authorizedFor(principal), signal),
	collectionPicker: ({ consumer, principal, signal }) =>
		new FontCatalogTarget(this.collections.visibleTo(consumer.node, principal), signal),
})
```

Canvas 等 consumer 放置 picker，并发布自己的 selection root：

```ts
export const CanvasWorkbench = workbench.define({
	fonts: FontManagerWorkbench.collectionPicker.place(workbench.tab({ label: 'Fonts', order: 30 })),
})

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
```

Picker renderer 精确得到两个 owners：

```tsx
export default function FontCollectionPicker() {
	const { provider, consumer, host } = useWorkbench(FontManagerWorkbench.collectionPicker)
	// provider: catalog; consumer: current Canvas selection
}
```

Provider root 不代理 consumer selection，consumer root 也不转发 catalog。两个 target 各自保留 owner admission 与
cleanup；任一 owner withdrawal 都会使当前 opened Attachment 和 socket epoch 失效，但错误来源和清理责任仍保持清楚。

## Collection 是领域对象

`collection` 不是 Workbench 概念。它是 FontManager 自己的普通记录：

```ts
type FontCollection = Readonly<{
	id: string
	name: string
	revision: number
	fontIds: readonly string[]
}>
```

Workbench topology 保持常数：一个 manager View、一个 picker Attachment。1 个或 10,000 个 collections 都不改变
definition、layout、MF producer/expose 或 WebSocket 数量。

Consumer 只持久化 `collectionId`。实际 render 仍走正常 Plugin dependency：

```ts
const selected = this.settings.fontCollectionId
const collection = selected ? this.fonts.resolveCollection(selected) : null
if (!collection || collection.kind === 'missing') return this.renderWithFallback(input)
return this.renderWithFamilies(input, collection.families)
```

Rename 保持 stable ID；delete 后 picker 可投影 `missing`，但 provider 不自动清空所有 consumers。是否 fallback、
报错还是要求重新选择，是 consumer 的业务政策，不是 Workbench lifecycle。

Manager API 应直接满足管理页，而不是为每一行制造 capability：

- `listCollections({ cursor, limit, query })` 返回 bounded rows；
- `createCollection()` 成功时返回完整 snapshot，让 UI 直接进入编辑态；
- `updateCollection({ expectedRevision, ... })` 返回 success/conflict/not-found；
- `removeCollection()` 不隐式修改 consumer state；
- watch 只通知当前 bounded read model 重读。

只有确实需要同时打开多个 collection editor 时，才增加一个 `/collections/:collectionId` View。它仍是一个
descriptor 和 expose，每个实际打开的 document 才创建 fresh root。

## BotManager

Bot 管理与 FontManager 的结构相同，但动态对象通常是 account：

| 需求                     | 合适的形状                                   |
| ------------------------ | -------------------------------------------- |
| 平台总览                 | local View + bounded snapshot                |
| account 列表/CRUD        | manager View 的分页 API                      |
| 独立 account editor/logs | 一个 parameterized account View              |
| 共用 HTTP 设置页         | HTTP provider-owned Attachment               |
| 另一 Plugin 选择 account | catalog + selection Attachment               |
| 实际发送消息             | constructor-injected bot platform dependency |

Telegram、KOOK、Discord 可以用普通 TypeScript function 复用相同的 View declaration shape，但每个平台继续拥有
自己的 Plugin definition、persistence、authentication、factories 和 failure boundary。不要为复用几段 UI wiring 创建
中心 registry 或可以查找任意 bot provider 的 service locator。

## 判断 Attachment 是否合适

使用 Attachment 前逐项确认：

1. Renderer 的产品和领域 ownership 确实属于 provider。
2. Placement ownership 确实属于 consumer。
3. Consumer 已通过 constructor 声明对 provider 的 required dependency。
4. Provider API 和可选 consumer API 可以独立说明授权、失败和 cleanup。
5. 动态 rows 不会被误建模成 entries 或 capabilities。

有一项不成立时，通常应改用 local View、普通 shared React component 或纯服务端 Plugin dependency。
