---
title: Workbench 工作台指南
description: 掌握 Pluxel 可视化管理工作台，为插件添加配置表单、操作面板与自定义业务界面。
---

Workbench 是 Pluxel 内置的可视化管理工作台。它为开发者和运维人员提供了直观的交互界面，既可以集中管理插件的运行状态与配置，也支持插件向工作台发布自定义的前端业务视图。

业务逻辑始终由插件独立持有，关闭工作台不会影响后台业务服务的正常运行。

## 核心概念与界面布局

访问应用地址的 `/__pluxel/workbench` 路径即可打开工作台：

- **插件管理目录（Plugins）**：集中查看所有已装载的插件列表、依赖拓扑与运行状态。点击特定插件，中央主区域会呈现其标准的配置表单。
- **业务应用（Apps）**：插件发布的独立业务交互页面（例如报表看板、可视化编辑器或机器人管理界面）。
- **上下文工具栏与面板**：右侧与底部抽屉面板，提供实时的日志流查看、节点状态自省与快捷操作。

## 声明扩展

通用配置由插件的 Valibot Schema 自动生成表单。需要自定义界面时，在模块顶层导出一份 `workbench.define(import.meta.url, entries)`。对象的键标识入口，文件路径相对于这份定义所在的模块。 [插件配置](../plugin-development/configuration.md)

| 入口                   | 插件提供的内容                               | 发布时的绑定                                                                                                     |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `workbench.content`    | Markdown 文件，可在 `slots` 中声明数据和操作 | 纯文档直接发布，有槽位时提供数据或操作工厂。[Content 页面](./content.md)                                         |
| `workbench.view`       | 一个 React renderer 和打开位置               | 工厂为每次打开创建新的 RPC target。[View 视图](./view.md)                                                        |
| `workbench.attachment` | 其他插件可以复用的 React renderer            | 提供方创建 target，消费方通过 `.place(placement)` 放置并绑定自己的 provider 实例。[跨插件组合](./composition.md) |

位置独立于内容。使用 `{ kind: 'tab', label }` 添加插件选项卡，使用 `{ kind: 'route', path, title }` 声明可导航的页面，使用 `{ kind: 'panel', region, label }` 添加左侧、右侧或底部面板。路由需要在应用导航中展示时提供 `navigation: { label }`。 [上下文面板](./panels.md)

如果一个中心页面要列出其他插件管理的对象，来源插件可以随业务数据提供 `WorkbenchEntryLink`，让用户从列表或详情进入该插件自己的编辑器。 [向中心插件注册来源](./composition.md#向中心插件注册来源)

## 发布一个 Markdown 入口

插件在 `init()` 中通过可选的 Workbench 服务发布整份定义。以下例子只需在定义旁放置一份 `overview.md`。

```ts no-twoslash
import { workbench, type Workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'

const WorkbenchRef = defineServiceRef<Workbench>()
export const AnalyticsWorkbench = workbench.define(import.meta.url, {
	overview: workbench.content({
		document: './overview.md',
		placement: { kind: 'tab', label: '概览' },
	}),
})

@Plugin({ displayName: 'Analytics' })
export class AnalyticsPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(AnalyticsWorkbench)
	}
}
```
