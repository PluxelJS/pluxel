---
title: Content：说明、状态与一次性操作
description: 用 host-rendered Content 为 Plugin 增加说明、bounded state、按钮和一次性 Valibot 表单。
---

当页面只需要说明、最新状态、少量按钮或一次性表单时，使用 Content。它由 Shell 渲染，不加载 Plugin React 代码、MF producer
或 Bridge；业务能力仍留在 Plugin 中。

不要用 Content 做分页、progress/cancel、多份独立 loading state、lossless stream 或自定义组件。这些需求直接使用
[View 标准配方](./view.md)。普通非敏感配置仍使用 `configs.use()` 的标准 Config UI。

## 最小路径

定义 Markdown、slot 和 placement。definition 保持静态；运行时 item、权限和业务状态不进入 definition：

```ts
// src/workbench.ts
import { v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'

const Status = v.object({
	connected: v.boolean(),
	queued: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

export const ServiceWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './overview.md', {
			status: workbench.data(Status),
			refresh: workbench.action({ label: 'Refresh' }),
		}),
		placement: workbench.tab({ label: 'Overview' }),
	}),
})
```

Markdown 只决定 slot 的位置：

```md
# Service

::slot[status]

::slot[refresh]
```

在 Plugin `init()` 中只发布一次，并为每个 data/action key 提供 exact binding：

```ts
override init() {
	this.ctx.workbench?.publish(ServiceWorkbench, {
		overview: () => ({
			load: () => ({ status: this.inspectService() }),
			actions: {
				refresh: async () => {
					await this.refreshService()
					return { ok: true, message: 'Refreshed' }
				},
			},
		}),
	})
}
```

这就是默认完整路径：不创建 `RpcTarget`、不管理 query cache，也不手动 reload。含 data 的 Content action settle 后，Framework 会
重新执行 `load()`。

## 只在状态会自行变化时加入 live refresh

`dataChanged()` 是 latest-state 提示，不携带事件 payload，也不保证逐事件交付。仅当领域状态在 action 之外变化时，才用 open
signal 注册领域 listener：

```ts
overview: ({ signal, dataChanged }) => {
	this.serviceEvents.addEventListener('change', dataChanged, { signal })
	return {
		load: () => ({ status: this.inspectService() }),
		actions: { refresh: () => this.refreshService() },
	}
},
```

`signal` 会在 entry close、socket close、Plugin replacement 或 owner withdrawal 时 abort。listener 的清理属于领域对象；
`dataChanged()`、load lane 与 Shell observer 由 Framework 拥有。

## 边界

- `:slot[key]` 只放 inline scalar data；`::slot[key]` 放 block data 或 action。每个声明必须恰好出现一次。
- data schema 只用于只读展示；不接受 default、transform、lazy、`undefined`-producing wrapper 或 password。
- action input 必须是 host form 支持的 Valibot object。Shell 只提交 raw portable data，Runtime 在 handler 前再次校验。
- `confirm` 只防误触；handler 仍须按 `principal` 重新授权并检查当前领域状态。
- pure Markdown Content 没有 binding、opened root 或 quota；action-only Content 不建立 data observer。

完整 Markdown allowlist、slot 编译、data/action exactness 与错误语义见[完整 Workbench 参考](./index.md#host-rendered-content)。
