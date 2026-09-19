# @pluxel/preset

官方应用的具体组合，资源准备与关闭始终由 Host 拥有。

- 根入口 `servicesPreset()`：基础服务、日志、Management 与可选 Workbench。
- `/vite` 的 `vitePreset()`：Host 开发驱动与已安装服务的开发附件。
- `/build` 的 `buildPreset()`：发行默认值。
- `/test`：完整服务与 Workbench 测试宿主。

自定义组合可直接使用各领域包，无需本包。应用提供共享框架 peer；工具与 Workbench optional peer 仅在启用相应入口时需要。详见[组合 Host 服务](../../docs/reference/runtime-services.md)。
