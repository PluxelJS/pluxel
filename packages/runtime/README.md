# @pluxel/runtime

插件实现包本身允许不存在时，用 opaque optional ref 声明增强能力：

```ts
const Audit = optionalPlugin(() =>
	import('pluxel-plugin-audit').then(({ AuditPlugin }) => AuditPlugin),
)

this.plugins.use(Audit, (audit) => audit.registerSource(this))
```

runtime 在 consumer commit 后解析 ref，使用正常 graph lifecycle、RuntimeState 和 replacement watcher；absent
不阻塞 consumer，broken provider 产生独立诊断。已由 host catalog 管理的 provider 继续使用
`plugins.use(Provider, callback)`。

Runtime 保持业务 HTTP 与 optional Workbench 正交。Workbench 分为 browser-safe Contract、server Extension 和
owner-bound Binding：

```ts
// browser-safe module
const ExampleUi = workbenchContract.define({
	resources: { commands: workbenchContract.rpc<ExampleCommands>() },
	views: {
		Overview: {
			placements: [workbenchContract.slot(workbenchContract.slots.PluginTabs)],
		},
	},
})

// server module
const extension = workbench.extension({
	contract: ExampleUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

this.ctx.workbench.mount(extension, {
	commands: workbench.bind.rpc(() => new ExampleRpc(this)),
})
```

公开入口：

- `@pluxel/runtime`：原样转发 core 作者 API，并增加配置和常驻 runtime API；
- `@pluxel/runtime/workbench/contract`：browser-safe resource、View、placement 和 Port Contract；
- `@pluxel/runtime/workbench`：server-only Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource facade、hooks 和 UI exports；
- `@pluxel/runtime/web`：host browser transport 与 Workbench Context。

宿主只通过顶层 `workbench` 配置启用整套能力。关闭后不创建 registry、compiler、watcher、artifact route 或
resource transport，插件业务 HTTP 和生命周期不受影响。
