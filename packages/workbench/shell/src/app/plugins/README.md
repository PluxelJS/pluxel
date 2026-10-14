# 插件管理实现入口

本目录拥有插件管理：目录、分组、生命周期控制、详情与配置。插件发布的业务应用通过 Workbench publication 进入工作区，不在这里建立第二个业务应用框架。交互取舍见 [Workbench 设计规则](../../../../../../engineering/WORKBENCH_DESIGN.md)。

| 改动                 | 所有者                                                           | 输入与责任                                                                         |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 插件目录与搜索       | `catalog/PluginCatalog.tsx`、`filterModel.ts`、`searchTokens.ts` | 从管理 overview 派生；唯一搜索语法和过滤规则；当前项按 canonical route 匹配        |
| 分组、行、多选与拖放 | `catalog/organizer/`、`catalog/components/`                      | 同一目录呈现；选择、导航、拖动分别表达；持久化和 RPC 协调留在目录层，不散入 DnD 行 |
| 管理 overview        | `pluginOverview.tsx`                                             | 共享 immutable Management snapshot，不建立第二个 writable store                    |
| 自启动与运行操作     | `pluginStatusActions.ts`                                         | RPC 操作与管理 read model 刷新，区分 desired 策略与实际进程状态                    |
| 插件详情             | `detail/`                                                        | canonical owner 的 screen、context 和专属控件；配置页文档名称使用实际插件名        |
| 配置编辑与保存       | `config/`                                                        | 独立 baseline、提交快照、服务端验证与本地目录；见[配置所有权](config/README.md)    |

`workbench/PluginNavigation.tsx` 将 `PluginCatalog` 放入插件管理左工具区；中央 `/plugins` 索引只显示选择提示。不要重建简化列表并丢失现有分组、DnD 和多选，也不要在中央同时渲染第二套管理目录。业务应用的左侧只显示当前 owner 已打开的独立插件面板。

`workbench/PluginTools.tsx` 只组合右侧官方信息与最近日志；扩展列表和顶部查找共享当前 owner 的声明及 `session.openPanel(entry)` 打开路径，扩展内容使用独立原生标签。关闭/恢复与 owner 切换由 workspace session 拥有，管理页面不维护第二份面板状态。日志读取、摘要和策略由 `../log_viewer/` 的 `useLogStream`、`LogPreview`、`LogsPage` 与 `LogPolicyPopover` 分别拥有；“查看完整日志”显式打开带 canonical reference 筛选的独立日志文档，不替换当前配置页。

目录提示不能成为滚动遮挡层。`CatalogHints` 统一抑制滚动中的 tooltip，`CatalogTooltip` 只提供必要短提示；完整详情通过明确操作进入。筛选、折叠和虚拟化变更需同时检查多选与批量操作的目标范围。

只在本领域使用的 helper 留在本目录。配置 schema 分组、anchors、状态徽标和提交逻辑复用 `config/`，不在详情或侧栏另写缓存和规则。按[验收指南](../../../../../../engineering/WORKBENCH_FLEXLAYOUT_VALIDATION.md)选择目录、配置和上下文面板回归。
