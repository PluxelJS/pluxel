# @pluxel/runtime

`@pluxel/runtime` 提供插件作者的常驻运行时能力：HTTP、config、logger、effects、events、persistence/pluginData 与 lifecycle/registry 读取面。

可选网页管理能力通过 `@pluxel/runtime/web-management` 声明，并在插件中由唯一 gate 注册：

```ts
this.ctx.webManagement.use((web) => {
	web.ui.register(pluginUi)
	web.rpc.expose(() => rpc)
	web.sse.expose(() => stream)
	web.state.collection({ name: 'status' })
})
```

宿主 launcher 根据顶层 `webManagement` 配置安装 backend；插件和项目入口不导入 service-registration side effect。

公开入口：

- `@pluxel/runtime`：稳定插件作者与常驻 runtime API。
- `@pluxel/runtime/web-management`：`ui()`、`doc()` 与管理面作者类型。
- `@pluxel/runtime/web`：浏览器插件 UI API。
- `@pluxel/runtime/plugin`：worker 声明。
- `@pluxel/runtime/toolchain`：仅供生成代码使用的元数据 helper。

最终设计见 `docs/PLUGIN_AUTHORING_FINAL.md`，用户写法见 `user-docs/plugin-authoring-model.md`。
