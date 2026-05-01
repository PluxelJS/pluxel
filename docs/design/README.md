# Design Docs

这组文档回答“某个子系统为什么采用当前方案、API 如何收敛、设计边界是什么”。

当前条目：

- `docs/design/vite-architecture.md`
  Vite 配置分层：components workbench、runtime web、hmr dev host 与环境插件作用域规则
- `docs/design/plugin-feature/overview.md`
  Feature 设计收敛：`use(required)` / `tryUse(optional)`、可选依赖边界与 lazy load 规则
- `docs/design/plugin-workbench/design.md`
  插件工作台设计：当前布局、tab 策略、交互原则与设计缘由
- `docs/design/plugin-workbench/implementation.md`
  插件工作台实现：当前代码结构、状态流、dirty 上报与导航链路
- `docs/design/plugin-workbench/extension-model.md`
  插件工作台下一阶段扩展模型：editor/sidebar/panel 三容器 tab 化与新 view 契约
- `docs/design/plugin-config/overview.md`
  插件 config 声明与 builtin doc/config layout 的设计收敛
- `docs/design/plugin-contribution/overview.md`
  插件 UI 系统设计：builtin、自定义前端、共享状态模型与 interaction ownership
- `docs/design/ops-catalog/overview.md`
  ops live registry 的 host-side catalog 设计：动态控制面、runtime read model 与 workbench Ops 视图
- `packages/ops/docs/core-v2.md`、`packages/ops/docs/adapters-v2.md`
  ops V2 设计：轻量 core contract 与 CLI/runtime/host 外沿设施分层
实现 contract 不放在这里，统一跟随对应包：

- `packages/runtime/docs/config/contract.md`
