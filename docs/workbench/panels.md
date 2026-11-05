---
title: 扩展插件的侧栏与底部面板
description: 在当前插件的左侧、右侧或底部添加轻量辅助面板，复用 Content、View 与 Attachment。
---

除了在中央主区域展示配置或视图文档外，插件还可以通过 `workbench.panel()` 向界面的左侧、右侧或底部抽屉扩展辅助面板。面板适合承载操作指引、快速状态监控或最近产物列表。

## 场景选型与布局规划

- **左侧面板（`left`）**：适合放置插件内的快捷导航或操作指引；
- **右侧面板（`right`）**：适合放置插件状态指标或轻量辅助操作；
- **底部面板（`bottom`）**：适合展示最近任务列表或调试日志；
- **中央主文档**：适合承载复杂编辑、表单输入与核心业务界面。

## 声明面板

以添加一个静态说明面板为例：

```ts
// src/workbench.ts
import { workbench } from '@pluxel/workbench'

export const ReportsWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		// 声明放置在左侧面板，并指定标题与排序权重
		placement: workbench.panel('left', { label: '操作指南', order: 10 }),
	}),
})
```

在插件的 `init()` 中正常发布即可：

```ts
this.ctx.workbench?.publish(ReportsWorkbench)
```

用户在 Workbench 界面中查看当前插件时，即可从侧边展开该指南面板。

## 面板内容类型

`workbench.panel()` 支持挂载各种标准的视图类型：

- **Content 内容**：使用 Markdown 与简明状态快速搭建；
- **View 组件**：需要交互式动态组件时，传入基于 React 编写的视图；
- **Attachment 组合**：将其他插件提供的选择器或设置页直接嵌入面板中。

<span id="数据与清理"></span>

## 数据与清理

面板与当前处于活动状态的插件紧密绑定：

- 当用户切换到其他插件时，原插件的面板会自动卸载并释放订阅；
- 关闭面板标签或收起抽屉面板时，底层的 RPC 会话与定时监听会自动清理，防止后台无谓消耗资源。
