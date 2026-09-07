---
title: 添加说明、状态与操作按钮
description: 用 Markdown 和配置 schema 添加管理界面，无需编写 React。
---

当页面只需要说明、最新状态、少量按钮或一次性表单时，使用 Content。你写 Markdown 和数据处理函数，Workbench 负责显示。
开始前，宿主应已[启用 Workbench](../getting-started/host-setup.md#workbench-与-management-access)，Plugin 应能正常启动。

不要用 Content 做分页、progress/cancel、多份独立 loading state、lossless stream 或自定义组件。这些需求直接使用
[View 标准配方](./view.md)。普通非敏感配置仍使用 `configs.use()` 的标准 Config UI。

## 最小路径

先在 `src/workbench.ts` 声明页面。slot 是 Markdown 中插入数据或按钮的位置；下面的 `status` 与 `refresh` 各对应一个 slot：

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
		actions: { refresh: async () => {
			await this.refreshService()
			return { ok: true, message: 'Refreshed' }
		} },
	}
},
```

`signal` 会在 entry close、socket close、Plugin replacement 或 owner withdrawal 时 abort。listener 的清理属于领域对象；
`dataChanged()`、load lane 与 Shell observer 由 Framework 拥有。

## Markdown 与字段规则

Markdown 在 build time 编译，浏览器不会运行 Markdown parser 或插入 raw HTML。支持普通段落、标题、强调/删除线、
列表、引用、分隔线、代码、bounded GFM table，以及安全的 `https:`、`mailto:` 和本文 fragment link。HTML、图片、
相对链接、JSX 风格标签、task list 与 frontmatter 会使构建失败；`{name}` 一类 MDX expression 只按普通文本处理，
不会执行。

`:slot[key]` 只能在普通 paragraph 中放 inline scalar data；`::slot[key]` 放 block data 或 action。每个声明必须恰好出现一次，
unknown、missing、duplicate、nested 或 inline action 都会使构建失败。Data schema 用于只读展示，不允许 default、transform、lazy、
undefined-producing wrapper 或 password；action input 必须是 host form 支持的 Valibot object，默认用 dialog，`form: 'embedded'`
固定展开。Shell 只提交 raw portable data，Runtime 会在 handler 前再次执行 authoritative Valibot validation。

需要防止误触时给 action 添加确认文案，例如
`workbench.action({ label: '删除', confirm: '确定删除这条记录吗？' })`。Shell 会显示危险样式并在提交前调用 host confirm。
这只是 UX guard，不是授权边界：Framework 会在执行时重新确认 owner generation；handler 仍须根据 open 时认证的
`principal` 重新授权，并在写入前重新检查当前领域状态，不能信任确认框、旧 data 或客户端提交的前置条件。

`load()` 一次返回所有 data keys，并可直接返回领域已有的递归只读 detached snapshot；Framework 不会修改它。`actions` 与声明的
action keys 都必须 exact。含 data 的 Content 执行 Action 后，Framework 会在同一个 `run()` 调用中再 load 一次，所以按钮和表单
不需要自建 snapshot、watch、invalidate 或 RPC target；action-only Content 直接返回 action outcome。`dataChanged()` 没有 payload，表示
“当前 read model 可能已变化”；它提供 latest-state push，不保证逐事件交付。`signal` 是整个 opened Content 的 lifetime signal，
关闭、session 失效或 Plugin replacement 时用于清理领域订阅。

只有 action 的 Content 不调用 `subscribe()`，打开后可直接执行按钮或表单；只有声明了 data，Shell 才建立一个 observer 并执行
initial `load()`。

纯 Markdown Content 省略 slots，并继续 `publish(ServiceWorkbench)`，不创建 root、不占 opened-entry quota，也不生成 MF
producer/Bridge。需要 lossless events、独立并发状态、progress/cancel、server pagination 或任意 React UI 时使用完整 View。

## 加入一次性表单

在 action 上声明 `input`，Workbench 就会显示并校验表单。默认点击按钮打开对话框；需要直接展开时加 `form: 'embedded'`。

```ts
const ProbeInput = v.object({
	timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(30_000)),
})

// 放进 workbench.markdown() 的 slots 对象
probe: workbench.action({ label: '测试连接', input: ProbeInput, form: 'embedded' })
```

在 Markdown 中加入 `::slot[probe]`，并在 `actions.probe` 中处理校验后的 `{ timeoutMs }`，返回 `{ ok: true, message: '连接正常' }`。
字段标题和控件偏好使用 [Valibot 表单 metadata](./valibot-form.mdx)。

## 检查结果

运行应用，打开插件详情的 Overview 标签。应看到状态和 Refresh 按钮；点击后状态会重新读取。
如果标签缺失，检查宿主已开启 Workbench、Plugin 已运行，并且 `publish()` 的 key 与声明一致。
Markdown 的错误 slot、重复 slot 或不支持的内容应在构建时修正。
