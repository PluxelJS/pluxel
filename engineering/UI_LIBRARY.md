# Workbench UI Library

第一方 Shell 和仓库 renderer 直接使用 Mantine。第三方 renderer 可在隔离边界内选择附加依赖。Takumi 离线 JSX 图片模板由消费插件自行选择组件和 CSS，与 Shell Provider、主题和 Federation 分开。

## 修改约束

普通页面使用组件、props、hooks，以及调用点的 `style`、`styles`、`className` 或 CSS variables。

`@pluxel/workbench/mantine` 的 `packages/workbench/src/mantine/theme.ts` 定义共享尺寸、字体、颜色和组件默认值。Shell 叠加用户强调色，通过 `theme/core/themeModel.ts` 输出文档级 CSS 变量。`--plx-*` 补充画布、内嵌表面、细线和选择状态的 token。

`factory`、`useStyles`、`useProps`、`createVarsResolver`、`polymorphicFactory` 和自定义 `StylesApiProps` 只用于至少两个无关调用方确需的 Mantine-native 扩展，且普通组合无法清晰表达时；采用时明确 slots、props、样式和可访问性归属。

Federated renderer 使用 `WorkbenchMantineProvider` 为各 React root 创建 Provider。Shell 提供 singleton module、唯一 Core CSS 和文档级变量。接入规则见 [Workbench](WORKBENCH.md#mf2-与-react-bridge)、[renderer resources](../docs/workbench/renderer-resources.md) 和 [theme README](../packages/workbench/shell/src/theme/README.md)。

更换库需有具体产品、可访问性或维护依据，统一处理 shared/CSS、所有 renderer roots 和 `valibot-form` peer，并移除被替换的组件系统。

## 验证

主题或组件变更检查实际 Shell 与受影响 renderer。Provider、shared 或 CSS 变化验证独立 React roots 和真实 Federation 加载；交互组件检查键盘、focus、窄屏和可访问名称。
