# 官方插件维护

`plugins/*` 和 `plugins/<domain>/*` 是通过公开作者 API 装配的具体 Plugin；`packages/*` 保存框架与通用库。
领域子目录只做分类，不引入聚合插件或隐式 catalog。

- 选择、安装、配置插件：[用户指南](../docs/plugins/index.md)。
- 修改实现：先读 [开发约束](AGENTS.md)，再读对应包的 `DESIGN.md`。
- 渲染插件的共同调度与资源规则：[执行架构](render/ARCHITECTURE.md)。
- 框架集成验证使用 `projects/plugin-host`；独立产品的源码协作使用 [源码开发工具](../docs/development/tooling.md)。

官方插件同时验证公开作者模型：框架 API 变化时同步迁移受影响实现。包内问题先在包内解决；只有第三方 provider
也需要的跨插件不变量才进入框架。secret 不进入普通配置、日志或 Workbench DTO。
