# Workbench UI Library

第一方 Shell 与仓库维护的 renderer 统一直接使用 Mantine。第三方 renderer 可以按隔离契约选择自己的附加依赖；仓库不维护平行组件系统或 UI library adapter。

## 修改约束

- 优先普通组件、props、hooks；局部例外使用调用点的 `style`、`styles`、`className` 或 CSS variables。
- 主题由 `packages/workbench/shell/src/theme/mantine/theme.ts` 拥有；产品 semantic color tokens 不形成第二套 skin system。
- 普通页面不引入 `factory`、`useStyles`、`useProps`、`createVarsResolver`、`polymorphicFactory` 或自定义 `StylesApiProps`。
- 只有至少两个无关调用方需要同一 Mantine-native component，且普通组合无法清楚表达时，才采用高级扩展 API；同时明确 slots、props、样式与可访问性归属。
- 每个 federated renderer 创建自己的 `MantineProvider`；Shell 提供 singleton module 与唯一的 Core CSS。共享实现不跨 React root 传播 Context。

更换库需要具体产品、可访问性或维护问题作为证据，并覆盖 Federation shared/CSS、全部 renderer roots 与 `valibot-form` Mantine peer 的影响。不能仅为缩短 JSX 或假设未来复用引入抽象；更换时必须同时移除旧系统。

实现边界见 [FRONTEND](FRONTEND.md)；作者 Provider/CSS 规则见 [renderer resources](../docs/workbench/renderer-resources.md)；本地主题操作见 [theme README](../packages/workbench/shell/src/theme/README.md)。

## 验证

主题或组件变更先检查实际 Shell 与受影响 renderer；涉及 Provider、shared 或 Core CSS 时覆盖独立 React roots 和真实 Federation 加载。交互组件检查键盘、focus、窄屏和可访问名称。不要为单一样式改动引入新的组件抽象或实现镜像测试。
