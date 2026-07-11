# HMR

HMR 由 static/dynamic runtime route 与 Vite 持有，不进入插件作者模型。

- 插件声明 UI：`ui(import.meta.url, './ui/index.tsx')`。
- 插件在 `ctx.webManagement.use()` 内调用 `web.ui.register(declaration)`。
- Web Management 开启时，宿主在首个 plugin commit 前安装 backend，Vite 才创建 UI compiler/watchers。
- Web Management 关闭时，不创建 UI compiler，不执行插件 callback。
- 插件替换仍由 core commit/replacement 语义驱动；optional plugin integration 会在 provider replacement 后重新绑定。

构建和 HMR 不改变公开 API，也不生成兼容调用。详细模型见 `docs/PLUGIN_AUTHORING_FINAL.md`。
