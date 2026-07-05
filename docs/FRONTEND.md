# Frontend

插件前端链路分三段：

```text
authoring bridge
-> build/loader-hmr processing
-> runtime artifact consumption
```

这条边界是为了让作者写法、开发期体验和生产 runtime 解耦。

## 三段模型

作者侧：

- 插件代码写 `ui(...).bind(ctx)`。
- 这是 authoring/hmr/build 识别点，不是 runtime 语义。

build/loader-hmr：

- loader HMR mode 在开发期消费 source entry，编译插件 UI remote。
- build 在发布产物里把 authoring bridge 改写成 runtime artifact 注册。

runtime：

- 只消费 `ctx.ext.ui.remote.packaged()`。
- 只理解 packaged remote、builtin/doc extension、SignalDB、RPC、SSE、browser host protocols。
- 不理解源码 entry path。

## Product paths

插件 UI contribution 不是“一切都塞进通用 slot”：

- builtin/doc：host-rendered，适合配置、状态、文档、表单、小型操作。
- custom frontend：编译成 remote UI，适合复杂交互。
- interaction surface：consumer-owned placement 和最终 apply。
- interaction offer：provider-owned resources 和 session UI。
- shared state：通过 runtime services，如 SignalDB/RPC/SSE。

这样可以让 extension point 的 ownership 明确：谁决定放在哪、谁准备资源、谁负责最终提交。

## SignalDB 位置

SignalDB 的 authoritative collection 在 runtime 服务端；浏览器侧是 replica/read hooks。浏览器 UI 应通过 runtime browser helpers 读取，不要直接 import 低层 transport internals。

常见服务端入口：

- `ctx.ext.signaldb.collection({ name, initial, persistence, clientWrites })`
- `collection.doc(selector)`
- `collection.watch(...)`

常见浏览器入口：

- `pluginUi('PluginName')`
- `plugin.use().db.collection('name').useView()`
- `plugin.use().db.useDoc(...)`

## MF2 的角色

MF2 是 custom frontend remote artifact format 和浏览器宿主按需加载协议，不是插件作者 API。不要把 MF2 配置泄漏成 runtime 的业务语义。

## 实现入口

- `packages/runtime/src/plugin.ts`：route-neutral authoring bridge，`ui(...)` / `worker(...)`。
- `packages/runtime-dynamic/src/hmr/extensions/ExtensionCompilerService.ts`：HMR 期编译插件 UI。
- `packages/rolldown/src/vite/plugin-ui.ts`：共享的插件 UI remote build helper。
- `packages/rolldown/src/rolldown/plugins/runtimeUiBridgePlugin.ts`：build 期 bridge rewrite。
- `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`：extension 注册和 runtime 协调。
- `packages/runtime/src/services/plugin-interaction/ExtService.ts`：`ctx.ext` service wiring。
- `packages/runtime/src/services/plugin-interaction/RpcService.ts`：插件 RPC。
- `packages/runtime/src/services/plugin-interaction/SseService.ts`：插件 SSE。
- `packages/runtime/src/services/plugin-interaction/SignalDbService.ts`：runtime-owned SignalDB collections。
- `packages/runtime/src/web/plugin-ui/**`：browser plugin UI contracts 和 helpers。
- `packages/runtime/src/web/ui.ts`：browser UI runtime entry。
- `packages/components/src/app/plugins/**`：host/workbench 插件 UI。

## 改动判断

- 改作者写法：先看 loader-hmr/build bridge。
- 改 remote 注册/消费：先看 runtime `ExtensionService` 和 `web/plugin-ui`。
- 改 workbench 呈现：先看 `WORKBENCH.md` 和 `packages/components/src/app/plugins/**`。
- 改 SignalDB/RPC/SSE：先看 runtime plugin-interaction services。
