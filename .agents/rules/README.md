# Agent Rules

这里放置可跨项目复用的 agent 决策规则，不记录 Pluxel 当前架构事实。

- 项目专属的架构不变量和实现入口位于 [`engineering/`](../../engineering/README.md)。
- 用户面行为和标准用法位于 [`docs/`](../../docs/README.md)。
- 本目录的规则只提供通用决策方法；与项目专属约束冲突时，以项目约束为准。

当前规则：

- [`library-api-design.md`](library-api-design.md)：TypeScript/JavaScript 库的 public API、配置、类型、错误、扩展点和生命周期设计。
