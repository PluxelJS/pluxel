# Workbench Architecture

Workbench 是可选、宿主拥有的前端扩展能力。它不是通用Workbench，也不是插件可以直接写入的 React registry。

## Authoring vocabulary

- `WorkbenchExtension`：一个插件的前端扩展声明；`plugin` 是构建期 owner，mount 时必须与 Context owner 一致。
- `WorkbenchView`：最小渲染、授权和错误隔离单元；一个 view 可以拥有多个 placement。
- `WorkbenchPlacement`：宿主中的 slot 或 route，只决定 view 出现在哪里，不定义 renderer 或 model。
- `WorkbenchViewModel`：一个 view 显式选择的 `rpc`、`collection`、`events` model。
- `WorkbenchLayout`：宿主为 global 或某个 target plugin 解析出的 view 列表。
- `WorkbenchBundle`：由 Federation 构建、按源码 hash 发布的浏览器产物。
- `grantId`：layout 为一个 view/model pair 下发的短期 opaque capability；插件图变化时撤销。

普通插件作者只使用两个入口：

```text
@pluxel/runtime/workbench
@pluxel/runtime/workbench/ui
```

服务端声明与 provider：

```ts
const BillingWorkbench = workbench.define({
	plugin: 'BillingPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<BillingRpc>(),
		status: workbench.model.collection<BillingStatus>(),
		activity: workbench.model.events<{ updated: { at: number } }>(),
	},
	views: (model) => ({
		Overview: workbench.view.remote({
			model: [model.commands, model.status, model.activity],
			placements: [
				workbench.place.slot({ slot: workbench.slot.PluginTabs, label: 'Billing' }),
				workbench.place.route({
					path: '/overview',
					title: 'Billing',
					navigation: { priority: 50 },
				}),
			],
		}),
		StatusBadge: workbench.view.remote({
			model: [model.status],
			placements: [workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions })],
		}),
	}),
})

ctx.workbench.mount(BillingWorkbench, {
	commands: workbench.provide.rpc(() => new BillingRpc()),
	status: workbench.provide.collection({ storage: 'memory', uiAccess: 'read' }),
	activity: workbench.provide.events(({ emit, signal }) => {
		// provider 不接触 HTTP、SSE namespace 或内部 channel。
	}),
})
```

浏览器 entry：

```tsx
const ui = createWorkbenchUi<typeof BillingWorkbench>()

function Overview() {
	const { commands, status, activity } = ui.views.Overview.useModel()
	const host = useWorkbenchHost()
	// status.useOneById(), status.useMany(), activity.on(), await commands.refresh()
}

export default ui.expose({ Overview, StatusBadge })
```

## Security and lifecycle

- extension 统一声明 model；`views(model)` 通过自动补全的 typed token 选择 model，作者不写协议字符串。
  registry 绝不把整个 extension model
  发给每个 view。
- RPC、collection 和 events transport 只接受 `grantId`，不接受 plugin/model namespace。
- UI bundle 更新不改变 model graph，因此复用 grant；插件卸载、replacement 或依赖图变化立即撤销 grant。
- collection grant 只对应一个逻辑 collection。浏览器 replica 和 event connection 按 transport/grant 复用，
  不跨 owner 或 model 合并。
- `workbench: false` 时不安装 backend，不注册 provider、不构建 UI，也不创建浏览器 transport。
- view 错误由 view boundary 显示并记录；bundle、layout、RPC、collection、events 错误不得静默吞掉。

## Host rendering

宿主加载 global layout 的 slot 与 route 导航描述；进入插件页或独立 route 时加载 target layout。只加载 layout
引用的 bundle，先完成新 bundle 加载再原子替换 registrations。route、Tab、header、dock 与 capability slot 最终
都由 host 映射；builtin document 由 host 渲染，remote view 运行在 `WorkbenchViewProvider` 中。

Federation 常量属于 `@pluxel/core/federation` 的唯一 build contract。runtime 不再转手 re-export，toolchain、
runtime-dev 和 host 直接依赖该 contract，避免不同 package 的 `dist` 构建顺序制造 missing export。
