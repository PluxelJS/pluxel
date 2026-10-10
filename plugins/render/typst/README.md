# `@pluxel/typst`

Workspace 内的 Typst 文档插件，当前保持 private。支持多文件 JSON/文本/字节/真实文件输入、隔离编译、同修订 Vector/PDF 和 `await using` 会话。

服务端接入须注册 FontsPlugin，并由 Host 安装 NodeModules 与 Workers；`standardServices()` / `servicesPreset()` 已包含这些服务。无需启用 Workbench 或 Persistence；部署字体使用 FontsConfig.files/defaultFamily，只有管理字体持久化需要 Persistence。安装本包不会自动挂载服务，详见[接入前提](../../../docs/plugins/rendering/typst.md#接入前提)。

- [用法与生命周期](../../../docs/plugins/rendering/typst.md)
- [实现设计](DESIGN.md)
- [渲染执行规则](../ARCHITECTURE.md)

服务端入口为 `@pluxel/typst`，浏览器预览入口为 `@pluxel/typst/browser`。
