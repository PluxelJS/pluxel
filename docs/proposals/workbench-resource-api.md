# Workbench Resource API

状态：提案。

本文收敛下一版 Workbench 作者 API 与运行时边界。它允许破坏兼容，不是当前 API，也不作为实现或用户文档的依据。

## 问题

当前设计把资源选择同时编码在 extension、view token、grant 和 UI hook 类型中。这样可以推导出很精细的类型，
但也产生了重复声明、复杂诊断和不真实的安全感：同一插件的 View 位于同一个 Federation bundle 和 JS realm，
View 不是可信代码隔离边界。

设计目标是让类型保护真实边界，而不是模拟运行时拓扑：

- 普通作者只理解 Extension、Resource、View 和 Placement；Port 只用于高级跨插件集成。
- 作者不手写 resource、view、outlet、slot 或 icon 的协议字符串。
- View 负责渲染身份、placement 和错误隔离，不负责选择本插件资源。
- Extension bundle 是本插件资源的前端信任边界；Port 是跨插件资源注入边界。
- Workbench descriptor 是 browser-safe 的纯 contract value，服务端 mount 与浏览器 UI 共同消费它。
- 类型错误应指向作者字段；grant、layout、transport 和 registry 类型不进入公开补全。

## Contract module boundary

`TelegramWorkbench` 所在模块必须是 browser-safe 的纯 contract。这是直接传值推导、独立 Federation build
和服务端/浏览器共享同一事实来源的前提，不是推荐性的文件组织习惯。

```text
plugin/
├─ workbench-contract.ts   browser-safe descriptor，无副作用
├─ browser-contracts.ts   RPC/data/event 的 browser-safe 类型
├─ TelegramPlugin.ts      服务端实现只导入 descriptor 并 mount
└─ ui/index.tsx           浏览器导入同一个 descriptor value
```

contract module 只允许包含：

- plugin ID、resource kind、View、placement、Port 和 UI entry metadata；
- browser-safe 数据结构与 method interface 的 type-only import；
- 纯的、可冻结、可重复求值的 descriptor builder。

contract module 不得引用 Plugin 实现类、Context、provider factory、Node builtin、仅服务端可解析的 package，
也不得在模块求值时注册资源、打开连接或读取运行环境。`workbench.define()`、placement helper 和 entry helper
本身必须 browser-safe 且无副作用；服务端路径解析属于 toolchain/artifact 层，不能泄漏进 descriptor 求值。

浏览器直接导入 contract value，而不是只导入它的类型。这样 `createWorkbenchUi()` 同时获得静态推导和运行时
schema，可以验证 UI bundle 与 contract 是否匹配。若 contract module 不能被浏览器安全导入，应修复模块边界，
不能退回 `typeof` 泛型来掩盖服务端依赖泄漏。

## Proposed API

共享 contract 声明保持普通数据结构，不使用 View resource token 或 `uses` 清单：

```ts
// workbench-contract.ts
import { workbench } from '@pluxel/runtime/workbench'
import type { TelegramCommands, TelegramSettings, TelegramStatus } from './browser-contracts'

export const TelegramWorkbench = workbench.define({
	plugin: 'TelegramPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),

	resources: {
		commands: workbench.rpc<TelegramCommands>(),
		settings: workbench.collection<TelegramSettings>(),
		status: workbench.collection<TelegramStatus>(),
	},

	views: {
		Settings: {
			placements: [
				workbench.slot(workbench.slots.PluginTabs, {
					label: 'Telegram 管理',
					icon: workbench.icons.Settings,
					order: 50,
				}),
				workbench.route('/settings', {
					title: 'Telegram Bot',
					icon: workbench.icons.BrandTelegram,
					order: 69,
				}),
			],
		},
	},
})
```

约定：

- `order` 小值优先；route 默认进入导航，`navigation: false` 才隐藏。
- View 名由对象属性产生，slot 和 icon 使用公开 typed value。
- route path、展示文本、plugin ID 和 UI entry path 是外部数据，保留字符串。
- 只读 document 是特殊 View；互动界面使用 React View 和 typed RPC。

resource kind 已由 Extension 确定，mount 不再重复 provider wrapper：

```ts
const mounted = this.ctx.workbench.mount(TelegramWorkbench, {
	commands: () => new TelegramRpc(this),
	settings: {},
	status: {},
})

this.settings = mounted?.collections.settings
```

浏览器传入同一个 contract value，由函数参数直接推导类型；不使用 `typeof` 泛型，也不重复 View 名：

```tsx
import { TelegramWorkbench } from '../workbench-contract'

const ui = createWorkbenchUi(TelegramWorkbench)

export function Settings() {
	const { commands, settings } = ui.useResources()
	const snapshot = settings.useSnapshot()

	if (snapshot.status === 'loading') return <Skeleton />
	if (snapshot.status === 'error') return <Alert>{snapshot.error.message}</Alert>
	return <SettingsForm commands={commands} settings={snapshot.items} />
}

export default ui.define({ Settings })
```

`ui.define()` 必须根据传入的 descriptor，在编译期和运行时精确检查全部声明 View 都存在、没有额外 View，
且值是 React component。直接传值也能在开发时检测错误 contract、错误 bundle 或 View export 不一致。

## Resource semantics

`ui.useResources()` 返回全部 owner resource 的 typed lazy facade，但不会建立全部连接：

- RPC 第一次调用才发请求。
- collection 第一次 `useSnapshot()` 才订阅。
- events 第一次订阅才连接。
- client registry 按 transport 和 stable resource lease 缓存、引用计数并复用连接。
- collection 与 events 在同一 transport 上复用 multiplex stream；切换 View 不重建 client。

collection 是只读实时投影。浏览器只保留一个查询 hook：

```ts
const snapshot = records.useSnapshot({
	where: { userId },
	sort: { createdAt: -1 },
	limit: 50,
})
```

snapshot 显式提供 `loading | ready | stale | error`、items、error、connected 和 refresh。所有 mutation 通过
typed RPC 完成，以获得服务端确认、结构化错误和确定的失败语义。

`useResources()` 和 `useSnapshot()` 保留 `use` 前缀，因为它们确实使用 React Context 或订阅；RPC 调用和
imperative event subscription 不使用 `use` 命名。服务端不提供 `uses` 声明。

## Cross-plugin ports

Port 是唯一跨插件 UI capability 路径。Port View 不拥有直接 placement，由 consumer 决定位置并注入资源。

```ts
const FontSettingsPort = workbench.port({
	id: 'font.settings',
	version: 1,
	resources: {
		settings: workbench.rpc<FontSettingsCommands>(),
	},
})

const resources = {
	fontSettings: workbench.rpc<FontSettingsCommands>(),
}

export const ConsumerWorkbench = workbench.define({
	plugin: 'ConsumerPlugin',
	resources,
	views: {},
	outlets: {
		FontSettings: {
			port: FontSettingsPort,
			placement: workbench.slot(workbench.slots.PluginTabs, { label: '字体' }),
			provide: { settings: resources.fontSettings },
		},
	},
})
```

resource descriptor 的对象身份在 `define()` 时解析为内部 key，作者不写 mapping string。Provider View 声明
`accepts: FontSettingsPort`，浏览器用 `ui.usePort(FontSettingsPort)` 读取当前 outlet 注入的资源。运行时必须
验证 Port、version 和当前 render scope；类型不代替 capability 校验。

## Runtime boundaries

- grant 身份基于 target、owner 和 resource lease，不基于 View 或 placement index。
- layout 只引用稳定的 extension resource scope；Port grant 只属于对应 target outlet。
- 浏览器 transport 只提交 opaque grant，不提交 collection name、resource key 或 Port alias。
- mount 先 staged；只有 core commit 成功才原子激活并替换旧 lease，失败时保留旧 Workbench。
- artifact、layout 和 resource lease 使用独立 revision；无关插件或 bundle-only 更新不得撤销 resource lease。
- placement identity 由 owner、View 和 slot/path 产生；`define()` 拒绝同一 View 的重复 slot/path。
- RPC、collection、events 和 bundle 错误必须进入可见状态或 error boundary，不得只写 console 或永久 loading。

公开入口只导出作者概念。layout、bundle、grant、provider、registry、transport 和 host renderer 进入 internal
entry。RPC 参数/返回值、collection item、event payload、mount 完整性、精确 UI exports 和 Port contract 继续由
类型保护；网络数据、lease 和生命周期始终运行时验证。

## Non-goals

- 不用 TypeScript 类型模拟安全沙箱。
- 不通过静态分析 React 源码推导资源授权。
- 不用同名 type alias、生成类型或 `typeof` 泛型掩盖非 browser-safe contract。
- 不为旧 API 保留 alias 或双轨实现。
- 不把 Workbench 变成插件业务能力的启动前提。
- 不用 tsdown patch 修补 package build order 或错误 export boundary。

## Open questions

- Port version 是只允许完全相等，还是支持明确的兼容范围。
- resource lease 在同一浏览器 session 内按 target 隔离，还是允许 owner 自有 View 跨 target 共享。
- staged HMR replacement 的超时、取消和旧 lease 保留期限。
- events 的最终 React API；它必须暴露 connection/error 状态，同时避免与 collection stream 重复连接。

## Acceptance

- workspace 中普通 UI 不出现 resource token、`uses`、View-qualified resource hook 或协议 key string。
- `createWorkbenchUi(Extension)` 直接从 contract value 推导，且能运行时验证 View exports。
- 每个 contract module 的独立浏览器构建不包含 Plugin 实现、Context、Node builtin 或 server-only package。
- disabled Workbench 不创建 backend、compiler、watcher、route、transport 或持久状态。
- 连续切换 View/route 不重连仍被引用的资源；无关插件更新不撤销 lease。
- HMR replacement 成功时原子切换，失败时旧 UI 与资源保持可用。
- collection loading、stale、error 和 reconnect 可见；RPC timeout 返回结构化上下文。
- production Federation artifact smoke、全仓 build、lint 和高价值 lifecycle/resource tests 通过。
- 测试只覆盖作者 API exactness、lease reuse/revoke、staged activation、错误状态和生产 artifact 等不变量。
