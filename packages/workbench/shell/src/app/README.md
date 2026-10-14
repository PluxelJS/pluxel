# Shell 实现入口

此目录拥有认证后的应用组合、工作区和官方管理页面。新增交互先读 [Workbench 设计规则](../../../../../engineering/WORKBENCH_DESIGN.md)，涉及状态或生命周期再读 [Frontend](../../../../../engineering/FRONTEND.md)。公开插件能力由包级 Workbench 实现拥有，不能从 Shell 私有实现向插件暴露 API。

| 修改对象                 | 实现所有者                                                                               | 边界                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 应用装配与普通入口导航   | `index.tsx`、`frames/`                                                                   | Providers 保留；普通导航使用活动文档，独立页面跨 frame 完整导航                  |
| 路由、链接、错误恢复     | `router/`                                                                                | 薄 route 文件组合领域 screen；每文档独立 Router/error boundary，不递归创建 Shell |
| 布局、工具、动作和持久化 | `workbench/session.tsx`、`WorkbenchShell.tsx`、`snapshot.ts`                             | 一个 FlexLayout Model；Worksplit 协调文档身份、history 和关闭；无第二布局 store  |
| 当前文档与上下文扩展     | `workbench/document.tsx`、`panelTabs.tsx`、`PluginPanelDirectory.tsx`、`PluginTools.tsx` | canonical owner 来自活动文档；隐藏/切换释放工具 activation；不传实体上下文       |
| 官方导航、全局入口查找   | `workbench/navigationItems.ts`、`WorkspaceNavigation.tsx`                                | 共享入口来源；插件业务应用与管理分开；查找不是第二个管理目录                     |
| 插件管理                 | `plugins/`                                                                               | 唯一分组目录、详情和配置；见[领域入口](plugins/README.md)                        |
| 官方领域页面             | `plugin-graph/`、`home/`、`security/`、`log_viewer/`                                     | 模型与 hooks 留在所属领域；包管理业务由其 Plugin 拥有                            |
| 服务端 read model        | `managementQuery.tsx` 与领域 hooks                                                       | 使用公开 Management client；缓存只持有 immutable DTO，不能持有 RPC resource      |
| 通知与更新               | `notifications/`、`workbench/shell/`                                                     | 用户能区分 pending、失败和已应用；不能用成功 UI 掩盖失败回执                     |

日志的流资源、行/列表/详情展示与预览/完整页组合入口见 [Frontend 日志分层](../../../../../engineering/FRONTEND.md#日志读取与展示)，不要把订阅协议或页面布局合并为带多种 variant 的通用组件。

表中的 workbench 文件路径相对 `workbench/`。Content/MF activation 与 opened ownership 位于 Shell 的 `../workbench/runtime.tsx`，公开 renderer 资源实现位于包级 `src/workbench/`，不得在页面重建 owner/cache。

状态、关闭、恢复和资源约束由 [Frontend](../../../../../engineering/FRONTEND.md) 维护；控件尺度与状态背景由[视觉规则](../../color-design.md)维护。领域 helper 优先留在唯一使用目录，不为内部单调用方增加转发 barrel 或 wrapper。

按变更选择[验收入口](../../../../../engineering/WORKBENCH_FLEXLAYOUT_VALIDATION.md)，不把整套测试和历史迁移记录作为每次局部修改的通读前提。
