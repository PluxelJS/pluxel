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
	checks: v.pipe(v.number(), v.integer(), v.minValue(0)),
	updatedAt: v.string(),
})

// 2. 定义页面结构：关联 Markdown 文件与槽位（Slots）
export const ServiceWorkbench = workbench.define(import.meta.url, {
	overview: workbench.content({
		document: './overview.md',
		slots: {
			status: workbench.data(StatusSchema),
			refresh: workbench.action({ label: '记录检查' }),
		},
		placement: { kind: 'tab', label: '概览' },
	}),
})
```

### 2. 编写 Markdown 模板

在同目录创建 `overview.md`，使用 `::slot[slotKey]` 标记交互组件出现的位置：

```md
# 服务运行概览

已记录的检查次数与最近更新时间：

::slot[status]

完成检查后，点击下方按钮记录一次。

::slot[refresh]
```

### 3. 在插件中发布数据与操作

在插件的 `init()` 钩子中，为定义的槽位绑定实际的获取与执行逻辑：

```ts
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'
import { ServiceWorkbench } from './workbench.ts'

const WorkbenchRef = defineServiceRef<Workbench>()

@Plugin({ displayName: 'Service checks' })
export class ServicePlugin extends BasePlugin {
	private checks = 0
	private updatedAt = new Date().toISOString()

	recordChecks(count = 1) {
		this.checks += count
		this.updatedAt = new Date().toISOString()
	}

	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(ServiceWorkbench, {
			overview: () => ({
				load: () => ({ status: { checks: this.checks, updatedAt: this.updatedAt } }),
				actions: { refresh: () => this.recordChecks() },
			}),
		})
	}
}
```

点击“记录检查”会调用 `actions.refresh`，Workbench 在操作后重新执行 `load()`，页面显示最新的计数与时间。

## 添加操作表单

要让用户一次记录多次检查，在 `src/workbench.ts` 的模块顶层声明表单输入。

```ts
const CheckInput = v.object({
	count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
})
```

在同一组 `slots` 中，把原来的 `refresh` 替换为以下声明。键仍是 `refresh`，Markdown 中的 `::slot[refresh]` 直接展示该表单。

```ts
refresh: workbench.action({
	label: '记录检查',
	input: CheckInput,
	form: 'embedded',
}),
```

在插件绑定的 `actions` 中改为 `refresh: ({ count }) => this.recordChecks(count)`。服务端按 `CheckInput` 校验输入后才执行该方法。省略 `form` 时，点击按钮会打开表单对话框。

<span id="只在状态会自行变化时加入-live-refresh"></span>

## 只在状态会自行变化时加入 live refresh

如果后台任务或其他插件也会调用 `recordChecks()`，可以通知已经打开的页面。为 `ServicePlugin` 添加字段 `private readonly changes = new EventTarget()`，在 `recordChecks()` 完成修改后调用 `this.changes.dispatchEvent(new Event('change'))`。在 `overview` 工厂返回的对象里，与 `load`、`actions` 并列添加以下属性。

```ts
subscribe: (changed) => {
	this.changes.addEventListener('change', changed)
	return { [Symbol.dispose]: () => this.changes.removeEventListener('change', changed) }
},
```

Workbench 先订阅，再读取首次状态；后续 `changed()` 通知合并到串行的 `load()` 中。关闭该页面时释放它的监听器。
