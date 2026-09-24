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
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export type HttpSettings = Readonly<{
	headers: Readonly<Record<string, string>>
	timeoutMs?: number
}>

export interface HttpSettingsApi extends RpcTarget {
	snapshotDto(): HttpSettings
	updateDto(input: HttpSettings): Promise<HttpSettings>
	resetDto(): Promise<HttpSettings>
}

export const HttpWorkbench = workbench.define({
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})
```

这些 `*Dto` 方法由 target 完成授权、输入校验和 DTO 投影，并在返回前调用 `assertWorkbenchDto()`；
具体边界见 [API 契约](../api/contracts.md#生产者负责-dto-边界)。

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
import { BasePlugin, Plugin } from '@pluxel/core'
import { HttpPlugin } from '@acme/http'
import { HttpWorkbench } from '@acme/http/workbench'
import { workbench } from '@pluxel/workbench'

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
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { HttpWorkbench } from '../workbench.ts'

const settingsScope = createWorkbenchRenderer(HttpWorkbench.settings)
const httpSettingsQuery = settingsScope.query(({ provider }) => ({
	queryKey: ['http', 'settings'] as const,
	queryFn: () => provider.snapshotDto(),
}))

function HttpSettingsPanel() {
	const { host } = settingsScope.useWorkbench()
	const settings = httpSettingsQuery.useQuery()
	// render host + immutable settings.data
}

export default settingsScope.render(HttpSettingsPanel)
```

这条路径只有一个 renderer 和一个 provider API。Consumer 不实现转发 target，不复制 provider 的 UI，也不把
设置 state 搬到 Workbench。

打开使用方插件的详情，应出现 HTTP 标签，内容来自提供方的 renderer。停止使用方会移除这个位置，
但不删除提供方的设置；关闭 Workbench 后，服务端构造器依赖仍应可用。
如果标签缺失，检查双方已经运行、提供方已发布 Attachment、使用方的 binding key 与 `.place()` 声明相符。

## 官方 FontsPlugin：先用 provider-only

[FontsPlugin](../plugins/rendering/fonts.md) 的 `FontsWorkbench.selection` 是现成示例：Fonts 拥有字体与统一默认 family，Canvas、ECharts、Takumi 只放置同一个选择器。consumer stop 撤销 placement，不删除 Fonts 的数据；关闭 Workbench 也不改变服务端字体能力。

不要因页面位于 consumer 下，就复制一份 consumer selection。只有 consumer 确实拥有独立设置时，才使用下面的双 API。

## 多 collection 且 consumer 自有选择

只有产品确实同时满足下面三个条件，才需要从 provider-only Attachment 升级成双 root：

- provider 拥有多个动态 collection；
- consumer 持久化自己的 `collectionId` 与 fallback policy；
- picker 同时需要读 provider catalog 和修改 consumer selection。

以下是扩展示例，不是官方 FontsPlugin 已有功能。provider 拥有候选，consumer 拥有选择；两个 API 仅暴露各自任务需要的读取与写入：

```ts
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

type CollectionPage = Readonly<{
	items: readonly Readonly<{ id: string; name: string }>[]
	nextCursor: string | null
}>
type Selection = Readonly<{ revision: number; collectionId: string | null }>

interface FontCatalogApi extends RpcTarget {
	listDto(input: { cursor: string | null; limit: number }): Promise<CollectionPage>
}
interface FontSelectionApi extends RpcTarget {
	snapshotDto(): Promise<Selection>
	selectDto(input: {
		collectionId: string | null
		expectedRevision: number
	}): Promise<
		| Readonly<{ ok: true; value: Selection }>
		| Readonly<{ ok: false; code: 'conflict' | 'collection_missing' }>
	>
}

export const FontManagerWorkbench = workbench.define({
	collectionPicker: workbench.attachment<FontCatalogApi, FontSelectionApi>({
		renderer: workbench.entry(import.meta.url, './ui/collection-picker.tsx'),
	}),
})
```

Provider 发布 catalog root：

```ts
this.ctx.workbench?.publish(FontManagerWorkbench, {
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
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { FontManagerWorkbench } from '../workbench.ts'

const collectionPickerScope = createWorkbenchRenderer(FontManagerWorkbench.collectionPicker)
const fontCatalogQuery = collectionPickerScope.query(({ provider }) => ({
	queryKey: ['fonts', 'catalog'] as const,
	queryFn: () => provider.listDto({ cursor: null, limit: 50 }),
}))
const fontSelectionQuery = collectionPickerScope.query(({ consumer }) => ({
	queryKey: ['fonts', 'consumer-selection'] as const,
	queryFn: () => consumer.snapshotDto(),
}))

function FontCollectionPicker() {
	const { host } = collectionPickerScope.useWorkbench()
	// provider catalog and consumer selection stay separate query resources
}

export default collectionPickerScope.render(FontCollectionPicker)
```

Provider root 不代理 consumer selection，consumer root 也不转发 catalog。两个 target 各自保留 owner admission 与
cleanup；任一 owner withdrawal 都会使当前 opened Attachment 和 socket epoch 失效，但错误来源和清理责任仍保持清楚。

## 动态数据与生命周期

Collection、账号等是 API 返回的领域记录，不按每条记录创建 Workbench entry。列表分页，编辑器需要独立地址时声明一个参数化 route。
consumer 只保存稳定 ID；删除、冲突与 fallback 由双方领域 API 定义。实际渲染或发送消息仍走 constructor dependency，不依赖页面是否打开。

Provider API 与 consumer API 分别校验输入、授权、限制返回规模并清理资源。任一 owner withdrawal 都使当前 Attachment 失效；不能缓存打开的 root 供其他页面复用。
只想复用布局和按钮时，使用普通 React 组件与 props。
