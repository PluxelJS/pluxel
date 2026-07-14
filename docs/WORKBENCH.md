# Workbench Architecture

Workbench 是 optional、host-owned 的前端扩展能力，不是插件业务 API，也不是插件可直接写入的 React registry。

## Authoring model

作者模型分成三个边界：

| 层 | 公开入口 | 内容 |
| --- | --- | --- |
| Contract | `@pluxel/runtime/workbench/contract` | browser-safe resources、Views、placements、Ports |
| Extension | `@pluxel/runtime/workbench` | Contract + server-only UI entry |
| Binding | `@pluxel/runtime/workbench` | RPC factory、collection projection/managed state、events producer |

Contract 不包含 plugin ID、Context、provider、Node API 或 `import.meta.url`。Extension 不重复 owner；
`ctx.workbench.mount()` 从 immutable plugin Context 推导 owner，并把 registration 与 cleanup 绑定到 owner effects。

```ts
// workbench-contract.ts
import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export const BillingUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<BillingCommands>(),
		status: workbenchContract.collection<BillingStatus>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					label: 'Billing',
					order: 20,
				}),
			],
		},
	},
})
```

```ts
// server only
const BillingWorkbench = workbench.extension({
	contract: BillingUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

ctx.workbench.mount(BillingWorkbench, {
	commands: workbench.bind.rpc(() => new BillingRpc()),
	status: workbench.bind.collection({
		read: () => billingStatus.snapshot(),
		subscribe: (invalidate) => billingStatus.subscribe(invalidate),
	}),
})
```

`bind.collection()` 是 business/admin state 的只读实时投影。只有真正属于 Workbench 的管理状态才使用
`bind.managedCollection()`；其可选 handle 不得成为插件核心生命周期或业务 API 的前提。

## Browser UI

UI entry 直接导入 Contract value：

```tsx
const ui = createWorkbenchUi(BillingUi)

export function Overview() {
	const { commands, status } = ui.useResources()
	const snapshot = status.useSnapshot()
	// loading | ready | stale | error
}

export default ui.define({ Overview })
```

同一 Federation bundle 是 owner resources 的前端信任边界，所以普通 View 不声明 `uses`。`useResources()` 返回
全部 owner resource 的 lazy facade：RPC 首次调用才请求，collection 首次 `useSnapshot()` 才订阅，events 首次
`subscribe()`/`useConnectionState()` 才连接。

Contract runtime value 只能校验 resource key/kind、View、placement、Port 和 UI exports。TypeScript generic 中的
RPC payload、collection item 和 event payload 在运行时已擦除，不冒充 runtime schema。

## Cross-plugin UI

Port 是跨插件 UI resource 注入的唯一路径：consumer 声明 outlet、placement 和 resource mapping；provider 声明
无 placement renderer，并在 UI 中调用 `ui.usePort(Port)`。provider 不能占据 consumer 的 Tab/route/action。

renderer 从 committed direct required dependencies 中按 Port ID + exact version 唯一解析。零个 renderer 时 outlet
unavailable，多个时显示 ambiguity error，不按注册顺序猜测。Port grant 按 target/render scope 隔离。

## Security and lifecycle

- transport 只接受 opaque grant，不接受 plugin/resource namespace；
- owner stop 立即撤销 resource 和 Port grant；
- replacement 可以保留 bundle/page shell，但不能调用已停止 provider；
- rollback 重新 mount 并签发新 lease，不复活旧 lease；
- artifact、layout 和 resource revision 分离，bundle-only 更新不撤销 resource lease；
- disabled Workbench 不创建 backend、compiler、watcher、route、transport 或 persistent state；
- bundle、RPC、collection、events 和 Port 错误必须进入可见状态或 View error boundary。

## Implementation entries

- `packages/runtime/src/workbench/`
- `packages/runtime/src/services/workbench/`
- `packages/components/src/workbench/`
- `packages/rolldown/src/rolldown/plugins/workbenchUiBuildPlugin.ts`
- `packages/runtime-dev/src/workbench/`
