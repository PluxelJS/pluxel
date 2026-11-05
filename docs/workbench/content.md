---
title: Content 页面：声明式说明与操作按钮
description: 使用 Markdown 与 Valibot Schema 快速搭建包含指标展示、操作按钮与表单的管理页面，无需编写前端 React 组件。
---

如果插件的管理界面只需要展示运行状态、说明文档、几个操作按钮或简单的配置表单，使用 **Content** 是最快捷的选择。你只需编写标准的 Markdown 文本并定义数据槽位（Slot），Workbench 会自动负责界面渲染、数据加载与交互反馈。

## 快速上手

### 1. 声明页面与槽位结构

在 `src/workbench.ts` 中声明页面元数据：

```ts
import * as v from 'valibot'
import { workbench } from '@pluxel/workbench'

// 1. 定义展示数据的 Schema
const StatusSchema = v.object({
	connected: v.boolean(),
	queued: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

// 2. 定义页面结构：关联 Markdown 文件与槽位（Slots）
export const ServiceWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './overview.md', {
			status: workbench.data(StatusSchema),
			refresh: workbench.action({ label: '刷新状态' }),
		}),
		placement: workbench.tab({ label: '概览' }),
	}),
})
```

### 2. 编写 Markdown 模板

在同目录创建 `overview.md`，使用 `::slot[slotKey]` 标记交互组件出现的位置：

```md
# 服务运行概览

当前连接与任务堆积状态：

::slot[status]

点击下方按钮可手动触发上游同步：

::slot[refresh]
```

### 3. 在插件中发布数据与操作

在插件的 `init()` 钩子中，为定义的槽位绑定实际的获取与执行逻辑：

```ts
override init() {
	this.ctx.workbench?.publish(ServiceWorkbench, {
		overview: () => ({
			// 对应 workbench.data 的数据加载函数
			load: () => ({
				status: this.inspectService(),
			}),
			// 对应 workbench.action 的操作逻辑
			actions: {
				refresh: async () => {
					await this.refreshService()
					return { ok: true, message: '刷新成功' }
				},
			},
		}),
	})
}
```

当用户在界面中点击“刷新状态”按钮后，后台执行完毕，Workbench 会自动重新调用 `load()` 刷新页面数据，无需前端编写任何状态维护逻辑。

## 添加操作表单

如果按钮点击需要用户输入参数，可以为 `action` 声明输入 Schema：

```ts
const ProbeInput = v.object({
	timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(30_000)),
})

export const ServiceWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './overview.md', {
			probe: workbench.action({
				label: '测试探测',
				input: ProbeInput,
				form: 'embedded', // 'embedded' 展开表单，默认点击后弹窗输入
			}),
		}),
		placement: workbench.tab({ label: '概览' }),
	}),
})
```

在插件的 `actions.probe` 中直接接收校验后的入参 `{ timeoutMs }`。

<span id="只在状态会自行变化时加入-live-refresh"></span>

## 只在状态会自行变化时加入 live refresh

如果数据源在后台会自发产生更新（例如后台定时拉取、收到 WebSocket 广播），可在绑定中提供 `subscribe` 监听：

```ts
overview: () => ({
	load: () => ({ status: this.inspectService() }),
	// 订阅外部数据变化
	subscribe: (changed) => {
		this.serviceEvents.on('change', changed)
		// 返回注销函数，页面关闭时自动清理
		return {
			[Symbol.dispose]: () => this.serviceEvents.off('change', changed),
		}
	},
	actions: {
		refresh: async () => {
			await this.refreshService()
			return { ok: true, message: '已刷新' }
		},
	},
})
```

每当调用 `changed()` 时，Workbench 会自动重新调用 `load()` 更新界面上的数据展示。
