# Pluxel User Docs

这里是插件作者和宿主应用开发者的用户文档，只描述当前支持的用法。

## 从这里开始

- [`plugin-authoring.md`](plugin-authoring.md)：完整插件形状、依赖、feature、配置、生命周期、HTTP、Web Management 和最佳实践。
- [`host-setup.md`](host-setup.md)：static/dynamic Vite host、Web Management 开关和启动策略。
- [`starter-monorepo.md`](starter-monorepo.md)：生成可独立运行的纯净应用 monorepo。
- [`tooling.md`](tooling.md)：CLI 可选能力、构建工具链和 HMR diagnostics 入口。

阅读完主路径后，再按使用到的 package subpath 查类型和示例。内部架构、实现入口和维护约束位于 [`docs/`](../docs/README.md)，不是写插件的前置知识。

## 文档承诺

- 示例使用当前公开 API。
- 先给标准写法，再解释必要的设计原因。
- 不展示兼容 API、内部 helper 或迁移历史。
- 对 required/optional、业务/管理面、声明/执行等容易误用的边界给出明确选择规则。
