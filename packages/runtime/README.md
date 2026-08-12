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

单独构建的 Node ESM entry 使用 `defineNodeModule(import.meta.url, literal)` 声明，并通过
`ctx.nodeModules.use(declaration, setup)` 消费。首次 load/setup 会阻塞插件启动；开发期 staged replacement 与 owner
cleanup 由 runtime 管理。artifact 不定义 worker 或任务协议。

CPU-bound / thread-safe native 工作使用 `defineWorkerTask<Input, Output>()` 和 `ctx.workers.run()`。所有插件共享一个
root-owned、lazy、bounded、owner-fair 的 worker-thread pool；Tinypool 不进入插件 API。输入输出必须可 structured clone，
插件 stop 会取消并等待已接纳工作。`run(..., { transfer: [buffer] })` 可把大型 `ArrayBuffer` ownership 立即转入已接纳任务，
避免第二次字节复制；buffer 会同步 detach，后续失败不回滚。普通异步 I/O 与短小 native 调用不应为了“统一”而额外跨线程。

Runtime 保持业务 HTTP 与 optional Workbench 正交。Workbench 分为 browser-safe Contract、server Extension 和
owner-bound Binding：

```ts
// browser-safe module
const ExampleUi = workbenchContract.define({
	resources: { commands: workbenchContract.rpc<ExampleCommands>() },
	views: {
		Overview: {
			placements: [workbenchContract.tab()],
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

consumer 只需把一个 Port 的同名 resources 一对一注入 placement 时，用 `portOutlet()` 省略重复 Contract：

```ts
const settings = workbench.portOutlet({
	port: SettingsPort,
	placement: workbenchContract.tab(),
})

this.ctx.workbench.mount(settings, {
	settings: workbench.bind.rpc(() => new SettingsRpc(this)),
})
```

需要重命名、组合或只提供部分 consumer resources 时继续使用显式 `workbenchContract.define({ outlets })`。

公开入口：

- `@pluxel/runtime`：唯一作者入口，原样转发 core API，并注册配置、HTTP、persistence 等常驻能力；
- `@pluxel/runtime/services/vault`：宿主显式启用 Vault；未导入时不注册 Vault backend 或 eager preflight；
- `@pluxel/runtime/workbench/contract`：browser-safe resource、View、placement 和 Port Contract；
- `@pluxel/runtime/workbench`：server-only Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：浏览器 resource facade、hooks、受限 host capability 与 declarative Pane Kit；
- `@pluxel/runtime/web`：host browser transport 与 Workbench Context。

宿主只通过顶层 `workbench` 配置启用整套能力。关闭后不创建 registry、compiler、watcher、artifact route 或
resource transport，插件业务 HTTP 和生命周期不受影响。
