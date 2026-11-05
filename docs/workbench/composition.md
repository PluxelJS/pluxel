---
title: 在插件之间复用界面（Attachment）
description: 使用 Attachment 机制跨插件复用通用设置页与选择器面板，实现界面与数据的优雅解耦。
---

在复杂的插件化系统中，一个插件的前端界面往往需要复用另一个插件提供的能力。例如：

- 报表插件在自身的设置页中，直接嵌入 HTTP 客户端插件的统一网络配置面板；
- 画布插件在属性编辑抽屉中，嵌入字体管理插件的字体选择器。

通过 **Attachment（附加件）** 机制，提供界面的插件（Provider）负责实现界面与服务端接口，而使用界面的插件（Consumer）只需声明其挂载位置即可。

## 单方持有配置（Provider-only）

最常见的场景是：配置数据完全由提供方插件负责存储与管理，消费方仅在自身界面中挂载该配置入口。

### 1. 提供方声明 Attachment

提供方在 `src/workbench.ts` 中声明一个 Attachment 视图：

```ts
import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export interface HttpSettingsApi extends RpcTarget {
	snapshotDto(): Promise<{ timeoutMs: number }>
	updateDto(input: { timeoutMs: number }): Promise<void>
}

export const HttpWorkbench = workbench.define({
	// 声明一个没有预设位置的 Attachment 视图
	settings: workbench.attachment<HttpSettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
	}),
})
```

在提供方的 `init()` 中发布该能力：

```ts
this.ctx.workbench?.publish(HttpWorkbench, {
	settings: ({ consumer, signal }) => new HttpSettingsTarget(consumer.node, signal),
})
```

### 2. 消费方指定挂载位置

消费方插件在自身的 `workbench.ts` 中通过 `.place()` 方法将其挂载到指定选项卡：

```ts
import { HttpWorkbench } from '@acme/http/workbench'
import { workbench } from '@pluxel/workbench'

export const ReportsWorkbench = workbench.define({
	// 将提供方的 settings 挂载为当前插件的一个选项卡
	http: HttpWorkbench.settings.place(workbench.tab({ label: '网络设置' })),
})
```

这样，用户打开“报表插件”时，便能直接看到一个无缝嵌入的“网络设置”选项卡，修改的数据由底层 HTTP 插件安全维护。

## 消费方自存选择（双向 API）

在选择器场景中（例如字体选择器），字体列表由提供方提供，但“当前报表选用了哪种字体”需要保存在消费方自身的配置中。

此时，Attachment 支持同时传入 `providerApi` 与 `consumerApi`，组件内既能拉取提供方的全量数据列表，又能调用消费方接口保存当前的选择结果，实现完美的跨插件交互协作。
