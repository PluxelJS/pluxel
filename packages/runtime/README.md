# @pluxel/runtime

Runtime 保持业务 HTTP 与可选 Management Plane 正交。插件以静态 contract 声明管理资源和贡献，
只在宿主启用管理面时挂载：

```ts
const module = defineManagementModule({
	id: 'ExamplePlugin',
	resources: { api: managementResource.api<ExampleApi>() },
})

this.ctx.management.mount(module, {
	api: managementBinding.api(() => new ExampleApi(this)),
})
```

公开入口：

- `@pluxel/runtime`：插件、配置和常驻 runtime API；
- `@pluxel/runtime/management`：module、resource、view、port 和 binding contract；
- `@pluxel/runtime/management/ui`：浏览器端 typed resource client 与 UI module；
- `@pluxel/runtime/management/federation`：Management UI artifact 的构建共享约定；
- `@pluxel/runtime/web`：宿主浏览器 transport 与 Workbench context；
- `@pluxel/runtime/services/management`：仅供宿主 launcher 安装可选 backend。

宿主只通过顶层 `management` 配置启用整套能力。关闭后不创建 registry、compiler、watcher、artifact
route 或资源 transport，插件的业务 HTTP 和生命周期不受影响。
