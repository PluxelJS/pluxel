# Workbench 验收指南

本页帮助维护者按改动选择证据，避免把单元测试、真实浏览器与在线业务操作混为一谈。当前交互规则见 [Workbench 设计规则](WORKBENCH_DESIGN.md)，所有权约束见 [Frontend](FRONTEND.md)，用户操作见[工作台使用与排查](../docs/workbench/operations.md)。历史迁移结果保留在 Git 历史，不作为当前版本的通过证明。

## 按改动选验证

先运行受影响模块的回归；改变原生布局、CSS、焦点或真实 Content/MF 组合时，再检查正式应用的浏览器表现。仅修改文档时检查路径、锚点、命令和源码一致性，不为文档整理重跑无关业务操作。

测试入口相对 `packages/workbench/shell/tests/`，公开协议测试位于 `packages/workbench/tests/`。下表描述已有回归的职责，不表示本轮全部执行。

| 修改范围                   | 回归入口                                                                                                                                                                              | 必须保护的边界                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 普通导航、复制、标题、深链 | `workbench-app-surface.test.tsx`、`workbench-navigation.test.tsx`、`workbench-shell-interactions.test.tsx`、`workbench-host-navigation.test.tsx`                                      | 普通入口使用当前文档；显式复制产生独立 owner；实际插件名；basepath、search/hash、standalone 和 canonical identity |
| 固定工具、拖放、上下文面板 | `workbench-plugin-panels.test.tsx`、`plugin-panel-directory.test.tsx`、`workbench-shell-interactions.test.tsx`、`workbench-native-menus.test.tsx`                                     | 官方工具固定；插件面板关闭/恢复及声明区域内排序；owner/selection/visibility 变化释放旧 activation                 |
| Router 与页面连续性        | `workbench-route-continuity.test.tsx`、`workbench-route-transition.test.tsx`、`workbench-declared-route-integration.test.tsx`                                                         | 移动、工具焦点和主题变化保留原内容实例；待接纳导航不改写旧 match 输入；单文档错误不卸载 Shell                     |
| 关闭与未保存内容           | `workbench-close-lifecycle.test.tsx`、`workbench-config-save.test.tsx`、`web/config-form-loop.test.tsx`                                                                               | dirty 取消保留输入；批量关闭一次预检；revision/owner/capability 变化拒绝过期决定；保存失败不丢草稿                |
| 持久化、恢复与重置         | `workbench-state-persistence.test.tsx`、`workbench-app-surface.test.tsx`                                                                                                              | Model 与恢复信息唯一；不保存 draft/handle；坏快照保留；存储失败可发现；重置经过关闭守卫                           |
| 目录分组、多选、筛选       | `plugin-catalog-controls.test.tsx`、`plugin-catalog-row.test.tsx`、`plugin-catalog-overview.test.ts`、`plugin-catalog-search.test.ts`、`web/plugin-organizer-virtualization.test.tsx` | 一个管理目录；选择和导航分开；已有分组保留；筛选/虚拟化不破坏目标身份；滚动不被提示遮挡                           |
| Content/MF 打开和释放      | `workbench-native-activation.test.tsx`、`workbench-content-activation.test.tsx`、`workbench-federated-availability.test.tsx`                                                          | 每 open 独立 root；StrictMode 不重复 open；晚到结果释放；Bridge → facade → handle 关闭顺序；失败不伪装成功        |
| 会话与缓存                 | `session-reload.test.ts`、`runtime-updates.test.tsx`、`management-query.test.ts`                                                                                                      | 撤回完整 reload；缓存不持有 capability；旧请求不覆盖写入后的权威快照                                              |
| 配置目录、DOM identity     | `workbench-outline.test.tsx`、`web/config-form-loop.test.tsx`                                                                                                                         | 同 owner 副本的 label、anchor、scroll host 与草稿互不串用                                                         |
| 主题与交互反馈             | `workbench-shell-interactions.test.tsx`、`workbench-native-menus.test.tsx`                                                                                                            | theme provider 生效；菜单保留 Provider；输入、键盘与焦点正确                                                      |
| 公开 DTO/Bridge/资源       | 公开包的 `workbench-client.test.ts`、`workbench-federation.test.tsx`                                                                                                                  | tuple 验证、单一 ownership、closed failure 清理与客户端公开契约一致                                               |

类型检查、构建与测试脚本以 [Workbench package.json](../packages/workbench/package.json) 为准。构建 Shell 使用 `build:web`，发布包制品使用 `build:lib`。官方应用消费已构建 Shell 时，须确认浏览器加载的是新制品，不能只看源码修改或 HMR 通知。

## 浏览器最小场景

使用真实 `projects/plugin-host`；记录所用制品、浏览器、窗口尺寸和是否进行了后端写入。操作现有应用的配置、RPC、生命周期与日志读取，遵循[开发控制台](../docs/development/dev-console.md)：选择项目 profile 并核对 Vite root 与实例归属，再检查权威回执；多个匹配实例时显式选择 instance。隔离 fixture 不能证明在线状态。

1. **导航与草稿**：插件目录打开两个不同插件时标签数不增加；“+”位于活动标签外并生成独立副本。两份输入不同草稿，切换、移动后保留；取消离开仍停留原文档。
2. **区域与上下文**：官方信息/日志不混入扩展标签。从插件信息扩展列表和顶部查找打开同一面板只产生一个原生标签；区域内排序可用，跨区域或拖入中央被拒绝。关闭释放资源并从两处可恢复，切回或刷新不重开已关闭面板。切换 owner 恢复各自未关闭布局，含 fork；撤回声明的保存标签显示不可用并可关闭。左侧只有官方目录时不重复显示竖条，有扩展标签时可选择；没有已打开扩展的底部不占位。
3. **真实扩展**：打开真实 Content/MF 页面与 panel，检查加载、错误、切换和关闭。聚合 bot 示例可用于观察多个 provider 共用业务列表，但只证明示例交互，不证明第三方平台连接。
4. **目录效率**：已有分组、长名称、选中、多选和拖放都有明确反馈；滚动经过名称或分组不出现大浮层挡路；过滤后的操作范围清晰。
5. **阅读与可达性**：浅/深色检查背景、文档、工具区和卡片边界，以及选中、失焦选中、hover 和 focus-visible 组合；常规桌面与窄窗口检查溢出菜单、按钮、滚动范围和表单。截图只能证明实际查看的状态。
6. **日志与策略**：完整页默认将宽度留给日志；筛选和详情按需出现，窄窗口不产生固定侧栏挤压。右侧“最近日志”独立标签最多显示当前 owner 最近 10 条，确认记录滚动时头部与完整页入口不移动；点击“查看完整日志”新开日志文档并保留配置页，确认 canonical reference 含 fork，不串其他实例。切换插件不改变已开日志文档的筛选，切换到插件信息或隐藏右侧释放日志订阅。策略入口与日志一起呈现，继承/覆盖和全局设置表达清楚；仅展开或查看不等于完成写入验证。
7. **恢复与失败**：正常刷新恢复结构和标题，业务草稿按实际契约处理；坏快照显示可恢复错误。会话撤回采用完整 reload，不能悄悄接旧 roots 或备用传输。

`use-log-stream.test.tsx` 与 `log-stream-store.test.ts` 覆盖 epoch reset 前在途读取、乱序 gap 回填、后台绘制暂停时的容量上限、清空后旧结果不回灌和卸载后晚到 subscription 释放。`log-preview.test.tsx` 保护预览最近 10 条、稀疏历史与晚到订阅释放；`log-presentation.test.tsx` 保护行、详情与安全格式化；`log-document.test.tsx` 保护暂停跟随、清空显示和 reset 后撤销旧详情；`workbench-logs-route.test.tsx` 保护 canonical 筛选；`log-document.test.tsx` 保护 reset 后详情清理、暂停跟随与本地清空；`log-policy-race.test.tsx` 使用真实 Query cache 验证写前/写中旧 GET、串行 revision 与失败 readback。

这些是选择场景的清单，不要求每次小改都跑全套。改动影响的边界必须有相应证据；未执行的场景直接注明。

## 如何记录结果

检查结果放在本次变更说明中，包含所改行为、执行命令或浏览器场景、实际结果与未验证边界。本页维护检查方法，不积累单次运行的测试数量、截图路径、进程 ID 和旧通过记录。

桌面 Chromium 截图不能证明 Safari/Firefox、触屏、屏幕阅读器、长期 heap/RSS、海量插件/日志或真实外部平台。日志级别写入、批量失败与资源竞态需要领域回归或明确授权的在线样本，不能由类型检查或打开浮层替代。
