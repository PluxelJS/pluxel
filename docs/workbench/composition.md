---
title: 跨插件复用界面与注册来源
description: 在插件的标签页、路由或面板放置 Attachment，让消费方保存自己的选择，或让中心插件打开来源提供的编辑器。
---

| 你要实现的交互                                            | 谁发布页面、谁保存数据                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| [在 Canvas 的标签页修改默认字体](#放置提供方的设置页)     | Fonts 提供选择器并保存当前 Fonts 节点的默认偏好。    |
| [使用同一份字体目录，各插件单独选字体](#由消费方保存选择) | 字体提供方实现选择器，消费方提供读写自身选择的接口。 |
| [在同一个列表管理多个插件的对象](#向中心插件注册来源)     | 中心发布列表和详情，来源可随数据提供自己的编辑入口。 |

已有插件可通过源码查询定位它公开的 Attachment，再从对应的模块导入条目。 [查询 Workbench 入口](../development/inspection.md#workbench-entries)

## 放置提供方的设置页

Fonts 在 `FontsWorkbench` 中用 `workbench.attachment<FontSelectionApi>({ renderer: './ui/selection.tsx' })` 声明选择器，在自己的 `init()` 发布 `selection: () => this.createSelectionTarget()`。Canvas 从公开模块导入这个条目，在自己的 Workbench 定义里决定它出现的位置。

```ts
import { FontsWorkbench } from '@pluxel/plugin-fonts/workbench'
import { workbench } from '@pluxel/workbench'

export const CanvasWorkbench = workbench.define(import.meta.url, {
	fonts: FontsWorkbench.selection.place({ kind: 'tab', label: 'Fonts' }),
})
```

`.place()` 支持插件详情中的标签页（`tab`）、带路径的页面（`route`）和左、右或底部面板（`panel`）。这些位置都由 Workbench 挂载整个 renderer。自定义 View 中的 JSX 和组件排列由该 View 的作者控制。 [上下文面板](./panels.md)

Canvas 的构造函数声明 `FontsPlugin` 为直接必需依赖。在 `init()` 中，`provider` 绑定实际注入的 Fonts 节点，Workbench 每次打开这个标签页都会向该节点取得新的 RPC target。

```ts
this.ctx.service(WorkbenchRef)?.publish(CanvasWorkbench, {
	fonts: { provider: this.fonts },
})
```

选择器调用 `provider.setPreferredFamily(family)`。Canvas 和 ECharts 绑定同一个 Fonts 节点时，任一入口保存的偏好都属于该节点，两边共享。完整的导入、构造函数和发布示例见[服务端字体](../plugins/rendering/fonts.md#在工作台修改字体节点的默认偏好)。 [Canvas 位置声明](https://github.com/PluxelJS/plugins/blob/717fead1969e5e2206ac09da1e5e8a8de2d372c2/render/canvas/src/workbench.ts) · [Canvas 绑定实例](https://github.com/PluxelJS/plugins/blob/717fead1969e5e2206ac09da1e5e8a8de2d372c2/render/canvas/src/index.ts)

## 由消费方保存选择

如果报表 A 和 B 需要共享候选目录、各自保留选中的字体，选择器需要两套接口。仓库中的 `PluginContributionFontManager` 示例使用双向 Attachment 声明 `workbench.attachment<FontCatalogApi, FontSelectionApi>`。示例的目录接口读取固定的 `FONT_SETS`。要列出实际安装的字体，提供方可从注入的 `FontsPlugin.families` 读取候选；消费方仍然实现自己的选择接口。 [双向声明和放置位置](https://github.com/PluxelJS/pluxel/blob/7ee930604cc3f0a4ba2d64040b335d4cb9894ee3/projects/plugin-host/src/demo/PluginContributionFontDemo.workbench.ts) · [字体目录](../plugins/rendering/fonts.md#读取字体信息与默认字体)

消费方在自己的 `init()` 中绑定两端。

```ts
this.ctx.service(WorkbenchRef)?.publish(FontConsumerWorkbench, {
	appearanceFont: {
		provider: this.fontManager,
		consumer: () => new FontSelectionTarget(this),
	},
})
```

同一个 renderer 用 `provider.listDto()` 读候选目录，用 `consumer.currentDto()` 读本消费方的选择，用 `consumer.set(ref)` 写回该消费方。例如 `sales` 和 `finance` 两个消费节点绑定同一个目录时，在 `sales` 选中字体只更新 `sales`。两份报表若属于同一消费节点，消费方还需按报表 ID 区分选择。 [选择器的查询与写入](https://github.com/PluxelJS/pluxel/blob/7ee930604cc3f0a4ba2d64040b335d4cb9894ee3/projects/plugin-host/src/demo/PluginContributionFontDemo/ui/selection.scope.ts)

示例从部署配置初始化消费插件实例的 `fontSetRef`，之后的选择写在该实例中。关闭页面会释放本次打开的 RPC target，重新打开仍可读取同一实例的选择。插件重启时重新从配置初始化。业务需要跨重启保存时，由消费方在自己的写入方法中保存到节点存储或业务文档。 [插件状态存储](../plugin-development/tinybase.md)

在 Pluxel 源码仓库的 `projects/plugin-host` 目录，`src/demo/PluginContributionFontDemo.ts` 用 `@Plugin({ forkable: true })` 声明消费插件。执行 `vp test run src/demo/PluginContributionFontDemo.test.ts` 可启动两个隔离的消费节点，验证修改 `sales` 后重新打开仍能读到新值，`finance` 保留原值。此示例由测试装配。

## 向中心插件注册来源

机器人工作区由 `BotWorkspacePlugin` 发布列表与详情。来源插件通过构造函数依赖中心，在 `init()` 调用中心的业务方法 `registerSource`，返回注销函数。来源只提供数据时，传入 `id`、`label`、`capability` 和实现 `list/update` 的 `store` 即可。同一时间每个来源 ID 只能注册一次，机器人 ID 在来源内唯一。

Discord 还提供一个独立编辑器。它在自己的 definition 中声明路由 `/discord/bots/:bot`，在 `init()` 发布一次。下面的 `bindings` 为 `editor` 创建每次打开的 RPC target，`botStore` 提供中心所需的数据。

```ts
const publication = this.ctx.service(WorkbenchRef)?.publish(DiscordBotWorkbench, bindings)
return this.workspace.registerSource({
	id: 'discord',
	label: 'Discord',
	capability: '模拟 Discord 社区频道',
	store: botStore,
	...(publication && {
		editor: (bot) => publication.link('editor', { bot: bot.id }),
	}),
})
```

`link` 的第一个参数从这份定义的入口键中选择。路由参数使用声明中的名称，值传原始字符串。Workbench 校验参数并生成具体位置，自动带上发布节点和 fork。标签页和静态路由直接用 `publication.link('settings')`。面板跟随活动文档的插件上下文，由面板目录打开。关闭 Workbench 时，上例仍向中心注册机器人。

中心在详情的 `editor?: WorkbenchEntryLink` 中返回这个地址。详情带有入口时显示编辑按钮，宿主未提供导航时禁用。按钮的处理函数只需知道如何打开入口。

```ts
function openEditor() {
	if (!host.navigation || !detail.editor) return
	try {
		host.navigation.openDocument({ entry: detail.editor, title: detail.name })
	} catch (error) {
		host.notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
	}
}
```

点开 Discord 的 `support` 后，编辑器从自己本次打开的 RPC target 读取并保存该机器人的通知频道。中心无需导入 Discord 的 definition、renderer 或 RPC 类型。通用机器人指令和通知频道分别在各自的文档保存。新增来源可以只注册数据，也可以自行决定表单字段、校验、错误显示和草稿策略。

来源停止后，中心保留最后已知的机器人记录并撤回其编辑入口。Workbench 撤回已打开的来源页面与 RPC 租约。示例只把已保存的频道写入来源节点的 TinyBase，页面内尚未提交的输入在页面失效时会丢失。 [插件状态存储](../plugin-development/tinybase.md)

在 Pluxel 源码仓库的 `projects/plugin-host/src/bot-lab/` 中，`BotSources.ts` 实现注册，`DiscordBot.workbench.ts` 声明来源页面，`BotWorkspacePlugin.ts` 提供中心契约。进入 `projects/plugin-host` 执行 `vp test run src/bot-lab/BotWorkspace.test.ts` 可验证注册、编辑和撤回。
