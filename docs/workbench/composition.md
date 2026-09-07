---
title: 在插件之间复用界面
description: 复用设置页和选择器，明确页面、数据与放置位置分别属于哪个插件。
---

当 FontsPlugin 的选择器要出现在 Canvas 的详情页，或者多个插件要共用 HTTP 设置界面时，使用 Attachment。
提供界面的插件维护 React 代码和服务端 API；使用界面的插件只选择放置位置。

开始前，先完成一个 [View](./view.md)，并让使用方通过构造器声明对提供方的依赖。
下文把提供界面的插件称为 provider，把放置它的插件称为 consumer。

## 先选一个 API，还是两个 API

| 谁保存页面修改的数据                       | 选择                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| 全部由 provider 保存                       | 单方 API，先照下面的 HTTP 设置页做                                                    |
| provider 提供候选，consumer 保存自己的选择 | 双方 API，见[多 collection 且 consumer 自有选择](#多-collection-且-consumer-自有选择) |
| 不需要跨插件显示 UI，只调用服务端方法      | 普通构造器依赖                                                                        |
| 只想共用按钮或布局，没有跨插件 API         | 普通 React 组件和 props                                                               |

Attachment 不自动改变依赖、登录权限或存储位置。一次打开得到的 API 对象不能拿去给其他页面复用。

## Provider-only 设置页

以共享 HTTP provider 为例：provider 已按 caller node 保存设置，consumer 只希望在自己的详情页放置 provider 的设置页。

先在提供方的 `src/workbench.ts` 声明 API 和 Attachment。它与 View 的区别是没有固定 `placement`：

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

然后在提供方 `init()` 中发布。下面假设业务服务 `settings` 已按使用方保存设置，`HttpSettingsTarget` 是实现该 API 的 `RpcTarget`：

```ts
this.ctx.workbench?.publish(HttpWorkbench, {
	settings: ({ consumer, signal }) =>
		new HttpSettingsTarget(this.settings.require(consumer.node), signal),
})
```

`consumer.node` 只是 server-issued identity。Provider 可以用它查找自己已经拥有的 per-consumer state，但不能
取得 consumer instance、Context、config 或任意 dependency facade。

最后在使用方通过 `place()` 选择标签页位置，并传入构造器注入的 provider。下面是使用方的关键代码；`HttpPlugin` 从提供方包根入口导入：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { HttpPlugin } from '@acme/http'
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
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { HttpWorkbench } from '../workbench.ts'

const settingsScope = createWorkbenchRenderer(HttpWorkbench.settings)
const httpSettingsQuery = settingsScope.query(({ provider }) => ({
	queryKey: ['http', 'settings'] as const,
	queryFn: () => provider.snapshot(),
}))

function HttpSettingsPanel() {
	const { host } = settingsScope.useWorkbench()
	const settings = httpSettingsQuery.useQuery()
	// render host + detached settings.data
}

export default settingsScope.render(HttpSettingsPanel)
```

这条路径只有一个 renderer 和一个 provider API。Consumer 不实现转发 target，不复制 provider 的 UI，也不把
设置 state 搬到 Workbench。

打开使用方插件的详情，应出现 HTTP 标签，内容来自提供方的 renderer。停止使用方会移除这个位置，
但不删除提供方的设置；关闭 Workbench 后，服务端构造器依赖仍应可用。
如果标签缺失，检查双方已经运行、提供方已发布 Attachment、使用方的 binding key 与 `.place()` 声明相符。

## 官方 FontsPlugin：先用 provider-only

`@pluxel/fonts` 是这套模型的官方参考实现。它的真实需求是：

- FontsPlugin 拥有唯一的 managed 字体集合、持久化和 provider-wide 默认 family；
- Canvas、ECharts、Takumi 只希望在自己的详情页放置同一个选择器；
- consumer 不拥有另一份选择状态，也不需要修改 FontsPlugin 之外的数据。

因此使用一个管理 View 和一个单方 API 的 Attachment 即可：

```ts
import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export interface FontSelectionApi extends RpcTarget {
	snapshot(): Promise<FontSelectionSnapshot>
	setPreferredFamily(family: string | null): Promise<FontSelectionSnapshot>
}

export const FontsWorkbench = workbench.define({
	manager: workbench.view<FontsManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.tab({
			label: 'Fonts',
			icon: workbench.icons.Typography,
		}),
	}),
	selection: workbench.attachment<FontSelectionApi>({
		renderer: workbench.entry(import.meta.url, './ui/selection.tsx'),
	}),
})
```

FontsPlugin 只发布自己拥有的两个 API。Factory 每次打开都会返回 fresh target；当前 target 不保留
subscription 或其他 per-open 资源，因此不需要制造空 disposer：

```ts
this.ctx.workbench?.publish(FontsWorkbench, {
	manager: () => this.createWorkbenchManager(),
	selection: () => this.createSelectionTarget(),
})
```

Canvas 等 consumer 仍通过 constructor dependency 获得 `FontsPlugin`，Workbench 只增加 placement：

```ts
export const CanvasWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({
			label: 'Fonts',
			icon: workbench.icons.Typography,
			order: 30,
		}),
	),
})

@Plugin()
export class CanvasPlugin extends BasePlugin {
	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override init() {
		this.ctx.workbench?.publish(CanvasWorkbench, {
			fonts: { provider: this.fonts },
		})
	}
}
```

Provider-owned renderer 用 descriptor-bound scope 取得唯一 root：

```tsx
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { FontsWorkbench } from '../workbench.ts'

export const selectionScope = createWorkbenchRenderer(FontsWorkbench.selection)
export const fontSelectionQuery = selectionScope.query(({ provider }) => ({
	queryKey: ['fonts', 'selection'] as const,
	queryFn: () => provider.snapshot(),
}))
export const setPreferredFontMutation = selectionScope.mutation(({ provider }) => ({
	mutationFn: (family: string | null) => provider.setPreferredFamily(family),
	workbench: {
		invalidates: [fontSelectionQuery],
	},
}))

function FontSelectionPanel() {
	const selection = fontSelectionQuery.useQuery()
	const setPreferred = setPreferredFontMutation.useMutation()
	// render detached selection.data and call setPreferred.mutateAsync(family)
}

export default selectionScope.render(FontSelectionPanel)
```

阅读官方实现时，重点检查这些可观察的行为：

- manager API 才能上传和删除；selection API 只暴露读取候选和修改统一默认值，调用面没有被 UI 复用扩大；
- consumer stop 只撤销 placement；字体、preference 和 native registration 继续属于 FontsPlugin；
- Workbench disabled 时，constructor dependency、字体恢复、注册和渲染路径完全不变；
- 字体数量变化不会增加 definition、View、Attachment、MF expose 或 WebSocket；
- RPC 输入的大小、family、容量和持久化失败仍由 FontsPlugin 校验，不额外引入 Workbench schema；
- Selection UI 没有已证实的实时同步需求，因此 query 不声明 `workbench.subscribe`；mutation settle 后失效 snapshot，Runtime 自动完成
  portable detach、deep freeze 与 top-level transport result 释放。

这里的“选择”仍是 provider-wide preference。把选择器放到 Canvas、ECharts 或 Takumi 页面，不会把它变成
consumer-owned state。完整业务能力见[字体插件](../plugins/rendering/fonts.md)，真实源码位于
`plugins/render/fonts/src/workbench.ts`、`src/index.ts`、`src/ui/selection.scope.ts` 和 `src/ui/selection.tsx`。

## 多 collection 且 consumer 自有选择

只有产品确实同时满足下面三个条件，才需要从 provider-only Attachment 升级成双 root：

- provider 拥有多个动态 collection；
- consumer 持久化自己的 `collectionId` 与 fallback policy；
- picker 同时需要读 provider catalog 和修改 consumer selection。

以下是产品扩展示例，不是官方 FontsPlugin 已有的配置项。数据分别保存在两侧：

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
import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { FontManagerWorkbench } from '../workbench.ts'

const collectionPickerScope = createWorkbenchRenderer(FontManagerWorkbench.collectionPicker)
const fontCatalogQuery = collectionPickerScope.query(({ provider }) => ({
	queryKey: ['fonts', 'catalog'] as const,
	queryFn: () => provider.list({ cursor: null, limit: 50 }),
}))
const fontSelectionQuery = collectionPickerScope.query(({ consumer }) => ({
	queryKey: ['fonts', 'consumer-selection'] as const,
	queryFn: () => consumer.snapshot(),
}))

function FontCollectionPicker() {
	const { host } = collectionPickerScope.useWorkbench()
	// provider catalog and consumer selection stay separate query resources
}

export default collectionPickerScope.render(FontCollectionPicker)
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
