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

## 界面开发形态

根据业务复杂程度，插件可选择以下不同层次的展示能力：

| 视图类型                 | 适用场景                                 | 说明                                                                                     |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| **标准配置表单**         | 修改通用配置参数（如并发数、超时、开关） | 直接使用 Valibot Schema 自动生成，详见[声明配置](../plugin-development/configuration.md) |
| **Content 内容页**       | 展示结构化说明、指标摘要或简单操作按钮   | 使用声明式数据驱动的轻量页面，详见 [Content 页面](./content.md)                          |
| **View 完整视图**        | 复杂前端交互、动态数据流或图表应用       | 使用 React 开发完整的单页组件与 RPC 交互，详见 [View 视图](./view.md)                    |
| **Attachment 组合视图**  | 将一个插件的视图嵌入到另一个插件中       | 跨插件的视图组合复用，详见 [Attachment 组合](./composition.md)                           |
| **上下文面板（Panels）** | 挂载在主界面侧边或底部的辅助操作栏       | 快捷查看状态或常用指令，详见 [上下文面板](./panels.md)                                   |

## 快速上手：声明与发布入口

为插件接入工作台只需两步：

1. **静态声明入口**：在插件元数据中通过 `workbench.define()` 声明界面类型、标题与路由位置；
2. **动态发布能力**：在插件的 `init()` 钩子中调用 `this.ctx.workbench?.publish()`，绑定实际的业务数据与操作方法。

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Analytics' })
export class AnalyticsPlugin extends BasePlugin {
	protected override init() {
		// 仅在宿主启用了 Workbench 时发布交互能力
		this.ctx.workbench?.publish('analytics:overview', {
			async getStats() {
				return { activeUsers: 42 }
			},
		})
	}
}
```

使用可选链 `?.` 可以确保插件在没有安装 Workbench 服务的纯后台宿主中依然能平稳运行。
