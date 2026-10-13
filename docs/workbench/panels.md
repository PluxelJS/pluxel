---
title: 扩展插件的侧栏与底部面板
description: 在当前插件的左侧、右侧或底部提供说明、状态和操作，复用 Content、View 与 Attachment。
---

需要让操作指南、状态或辅助工具跟随当前插件时，使用 `workbench.panel()`。需要独立地址、长期编辑或多份草稿时，
继续使用 `tab()` 或 `route()` 打开文档。面板是当前插件的临时工具，不承担文档草稿恢复。

## 最短完整声明

下面在左侧添加一个静态说明面板。沿用 [Content](./content.md) 的 Markdown 编译与发布方式：

```ts
// src/workbench.ts
import { workbench } from '@pluxel/workbench'

export const ReportsWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.panel('left', { label: '操作指南', order: 10 }),
	}),
})
```

`src/guide.md`：

```md
# 生成报表

在插件的报表页面输入标题并生成预览。遇到失败时，打开插件信息检查依赖，再查看插件日志。
```

在所属 Plugin 的 `init()` 中发布一次：

```ts
this.ctx.workbench?.publish(ReportsWorkbench)
```

纯 Markdown 不需要 binding、RPC root 或 renderer。打开该插件的配置或业务文档后，在左侧区域的横向标签中选择“操作指南”。
选择面板不改变文档地址。

## 选择区域与内容

```ts
workbench.panel('left', { label: '操作指南' })
workbench.panel('right', { label: '渲染状态', icon: workbench.icons.ChartBar })
workbench.panel('bottom', { label: '最近产物', order: 20 })
```

区域只能是 `left`、`right` 或 `bottom`；`label` 必填，`icon` 与 `order` 可省略。它不接受路径、navigation 或 publication group。
同一区域的插件面板按 `order` 排序，通过区域内的横向标签切换；它们不加入官方入口栏，也不成为独立文档。
插件管理的左侧保留插件目录；业务应用的左侧只提供当前 owner 的扩展面板，没有扩展时不占据侧栏空间。

- 说明、最新状态和少量操作使用 [Content](./content.md)。将原来的 `placement` 换成 `panel()`，data/action 的声明和 binding 不变。
- 自定义交互、流式输出或复杂工具使用 [View](./view.md)。renderer 与每次打开的 API 仍由现有 View 契约管理。
- 复用其他插件的界面使用 [Attachment](./composition.md)，例如 `ProviderWorkbench.settings.place(workbench.panel('right', { label: '设置' }))`。
  面板跟随放置它的 consumer 插件，API 与 renderer 仍由 provider 拥有。

面板没有中心文档的 `host.document` 能力，不能借面板修改文档标题或脏状态；需要导航时使用现有 `host.navigation`。

底部区域位于中央文档下方，不横跨左右侧栏。区域可通过顶部布局按钮打开或收起。

## 数据与清理

面板按当前活动文档所属的 canonical Plugin node 筛选，包括 fork；切换到其他插件时，原插件面板会卸载。
同一区域切换面板、收起区域或布局隐藏内容时，也会释放当前面板的 opened handle、renderer 与订阅。
再次显示重新打开并读取最新数据，未提交表单和临时组件状态不保证保留。

含 data 的 Content 使用现有 `load()` 与 `dataChanged()`；领域 listener 必须随打开时的 `signal` 清理，
具体完整模式见 [Content 的 live refresh](./content.md#只在状态会自行变化时加入-live-refresh)。
View 使用相同的 per-open `signal` 与资源清理规则，不缓存旧面板的 API root 供下一次打开复用。
Plugin 停止、替换或撤回 publication 时，面板仍遵守原有 owner admission 与会话失效契约。

工作区布局保存选中的面板入口，不保存面板业务草稿；需要保留输入的功能应由业务自己保存，或放到独立文档中。

## 集合、实体与多个文档

例如机器人管理应用，可将机器人集合页声明为带 `navigation` 的 `route()`，从官方“应用”目录进入。
单个机器人或会话使用参数化路由，由业务列表选择实体并构造具体地址。需要并行处理时，通过工作区“+”创建独立文档，
每个文档有自己的路由、输入与草稿；普通入口复用已有文档。

当前面板上下文是 canonical Plugin owner，不是机器人、会话或其他实体。切换同一插件内两个实体文档，不会自动把活动路由参数传给面板。
左侧面板适合该插件的集合导航，右侧和底部可显示插件级状态；实体详情、未提交配置与需要随实体变化的操作应放在中心文档中。
不要让面板通过浏览器地址猜测当前实体，也不要依赖面板获得中心文档的 `host.document` 能力。

## 工作区示例与检查

参考应用 `projects/plugin-host` 的 `ReportStudioWorkbench` 声明了三个 Content 面板：

| key               | 区域与标签     | 数据来源                             |
| ----------------- | -------------- | ------------------------------------ |
| `studioGuide`     | 左侧“操作指南” | 静态 Markdown 的真实操作说明         |
| `studioStatus`    | 右侧“渲染状态” | 当前 ReportStudio 的提供者与缓存统计 |
| `studioArtifacts` | 底部“最近产物” | 当前 ReportStudio 最近八份产物       |

打开 Architecture Lab，显示相应区域并选择面板；生成报表后，渲染状态和最近产物应更新。
切换插件或收起区域后，原面板订阅应释放；再次显示应重新读取当前插件数据。类型检查和声明编译不能代替这条在线验证。
