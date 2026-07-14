# @pluxel/runtime

Runtime 保持业务 HTTP 与可选 Workbench 正交。插件以静态 extension 声明 view 与 model，
只在宿主启用 Workbench 时挂载：

```ts
const extension = workbench.define({
	plugin: 'ExamplePlugin',
	model: { commands: workbench.model.rpc<ExampleRpc>() },
})

this.ctx.workbench.mount(extension, {
	commands: workbench.provide.rpc(() => new ExampleRpc(this)),
})
```

公开入口：

- `@pluxel/runtime`：插件、配置和常驻 runtime API；
- `@pluxel/runtime/workbench`：extension、view、model、port 和 provider contract；
- `@pluxel/runtime/workbench/ui`：浏览器端 view-scoped model 与 UI bundle；
- `@pluxel/runtime/web`：宿主浏览器 transport 与 Workbench context；

宿主只通过顶层 `workbench` 配置启用整套能力。关闭后不创建 registry、compiler、watcher、artifact
route 或资源 transport，插件的业务 HTTP 和生命周期不受影响。
