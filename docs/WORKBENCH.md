# Workbench Architecture

Workbench 是 Management layout 的 host renderer，不是插件 UI registry 的所有者替身。

- 启动时加载 global layout 的全局 placement 与 route 导航描述；进入插件页或独立 route 时加载该 target
  的 plugin layout；
- 只加载 layout 引用的 remote artifact；
- 所有 loader 共享一条 Management revision SSE；
- HMR 时先加载新 artifact，再原子替换该 layout registrations；
- route、Tab、header、dock、capability placement 最终由 host 映射；
- builtin document 由 host 渲染，remote view 运行在 `ManagementViewProvider` 中；
- UI 只能通过 `managementApp<typeof contract>()` 读取当前 item bindings；contract 使用 type-only import，
  remote 不执行服务端 module declaration。

Workbench 的内部 placement registry 仍是 host 实现细节，不是插件作者 API。插件不能直接注册 React
节点、全局 route 或任意 target contribution。
