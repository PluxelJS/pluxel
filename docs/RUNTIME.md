# Runtime

Runtime 建立在 core 生命周期之上，并提供常驻 HTTP、config、logger、effects/events、persistence/pluginData 等服务。

Web Management 是由 static/dynamic launcher 按顶层 `webManagement` 配置安装的可选 bundle，包含 UI registry、插件管理 RPC/SSE、管理态同步、管理路由与 UI assets。插件只使用 `ctx.webManagement.use()`，不负责安装服务。

HTTP 不属于 Web Management。headless runtime 仍可完整运行插件 HTTP 和核心业务。

route/HMR/Vite 只消费 core commit 和 runtime capability，不改变插件公开 API。最终边界见 `docs/PLUGIN_AUTHORING_FINAL.md`。
