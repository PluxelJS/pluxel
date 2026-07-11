# Toolchain

插件构建工具链只负责静态元数据与制品生成：

- `configSourcePlugin()` 提取 config source、binding、layout 和 schema registration。
- 生成的元数据 helper 从 `@pluxel/runtime/toolchain` 导入；该入口不是插件作者 API。
- UI compiler 将纯 `ui()` declaration 指向的源码构建为 federation artifact。
- lint guard 检查 required dependency、required feature 和 lazy feature 的静态约束。

工具链不改写公开调用，不在生产代码中插入另一套 UI 注册 API。`web.ui.register()` 在开发与生产保持同一语义。

Web Management 关闭时，static/dynamic Vite route 不创建 UI compiler 或 watcher。完整约束见 `docs/PLUGIN_AUTHORING_FINAL.md`。
