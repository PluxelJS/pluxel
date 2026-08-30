# Pluxel 官方插件开发约束

修改官方插件前，先阅读本目录的 [`README.md`](README.md) 和对应包内的设计文档。

- 只使用 Pluxel 公开的插件作者 API。官方插件不得依赖 `@pluxel/runtime/internal`，也不得在 runtime
  中获得只服务于自身的特殊入口。
- 将官方插件视为跨插件组成、调用方归属、生命周期、配置、日志和可选 Workbench 集成的实践验证层与
  一致性验证层。
- Workbench 关闭时，业务能力仍必须完整运行。Plugin 自有管理界面只通过固定 Direct View 或 Attachment 投影
  browser-safe API。
- 包内问题优先在包内解决。只有当需求能够表达为可复用的跨插件不变量，而不是单个插件的实现捷径时，
  才提议修改 Pluxel core/runtime。
- Pluxel 作者 API 变化时，在同一变更中更新受影响的官方插件，使它们始终代表当前推荐写法。
- 不发布占位 API。包仍标记为 private 且尚未实现时，保持源码入口为空，把尚未落地的决定记录在包内
  设计文档中。
