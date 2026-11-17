# Workbench 视觉规则

本页拥有视觉状态与样式实现规则；用户任务和交互取舍见 [Workbench 设计](../../../engineering/WORKBENCH_DESIGN.md)。Mantine 使用及扩展边界见 [UI Library](../../../engineering/UI_LIBRARY.md)，主题源码入口见 [theme README](./src/theme/README.md)。

## 阅读层次

采用 Linear 式分层：工具栏、入口栏、标签栏和侧边 Border 面板放在 canvas 上；中央文档是 surface（`--mantine-color-body`）上的圆角浮起面板；文档内需要独立区分的摘要、代码和表头使用 raised。区域之间靠明暗与细线（`--plx-border`）分隔，控件和卡片外框用 `--mantine-color-default-border`。阴影只留给菜单、弹层和对话框。先删除重复标题、包装和空区域，再调整密度，不靠缩小所有按钮或输入框掩盖布局问题。

正文 13px（`sm`），控件高度与字号由公开主题 `@pluxel/workbench/mantine` 的组件 `vars` 统一；页面直接使用 Mantine size props，不在全局 SCSS 重写控件尺寸。共享 SCSS 只承担 Shell 布局与跨领域中性表面，业务页面不定义另一套控件皮肤。

## 交互状态

标签、目录行和导航入口共用状态背景语义，不能各自拼接不同透明度的强调色。

| 状态               | 表现                                                          |
| ------------------ | ------------------------------------------------------------- |
| 普通               | 使用所属区域背景，文字保持可读                                |
| 悬停               | 轻量 hover 背景，提示可操作，不冒充选中                       |
| 活跃选中           | 明确 selected 背景；可附选中边线，不能只靠文字或细线辨认      |
| 非活跃容器中的选中 | 低强调的 inactive-selected 背景，保留选择事实但不争夺当前焦点 |
| 键盘焦点           | 独立 `focus-visible` 轮廓，与 hover 和 selected 可同时存在    |

hover 不覆盖选中背景；失焦也不清除选中事实。强调色表达操作与选择，错误、警告、成功使用对应语义色。运行状态圆点不代替选择反馈，文本与图标不能只靠颜色传递必要信息。

## 所有者与验收

主题结构（尺寸、字体、颜色名称、组件默认值）由 `packages/workbench/src/mantine/theme.ts` 拥有，Shell 与插件 renderer 共用。颜色流为 accent presets → `theme/core/themeModel.ts` 的中性层、状态色与 CSS 变量 → Mantine 和布局调用方。Mantine 已有的文字、表面、边框和强调色直接用 `--mantine-*` 变量；`--plx-*` 只保留 `canvas`、`raised`、`border` 和 hover/selected 状态。新增状态先扩展这一权威来源，再让相关消费者复用；不在组件中放原始色值、装饰专用 token 或全局重绘控件家族。

状态变更检查浅/深主题中的普通、悬停、活跃选中、非活跃选中与键盘焦点组合。特别检查鼠标移入选中项后背景不退化、切换容器后原选择仍可辨认；同时检查长名称、窄窗口及插件真实 renderer，不能只验证静态 token 值。
