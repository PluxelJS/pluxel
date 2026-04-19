# Plugin Workbench Implementation

## Scope

本文档只记录当前已经落地的实现，不记录已废弃方案。

当前工作台代码已经按三层收口：

- router
- workbench shell
- plugin detail workbench

核心文件：

- `packages/components/src/app/router/index.tsx`
- `packages/components/src/app/router/routes/*`
- `packages/components/src/app/workbench/store.ts`
- `packages/components/src/app/workbench/context.tsx`
- `packages/components/src/app/workbench/WorkbenchShell.tsx`
- `packages/components/src/app/workbench/split/index.ts`
- `packages/components/src/app/workbench/split/*`
- `packages/components/src/app/plugins/detail/PluginScreen.tsx`
- `packages/components/src/app/plugins/detail/workbench/PluginWorkbench.tsx`
- `packages/components/src/app/plugins/detail/workbench/PluginWorkbenchHostViews.tsx`
- `packages/components/src/app/plugins/detail/workbench/PluginWorkbenchViewContainer.tsx`
- `packages/components/src/app/plugins/detail/RightPane.tsx`
- `packages/components/src/app/plugins/config/ConfigForm.tsx`
- `packages/components/src/app/plugins/config/ConfigLayout.tsx`
- `packages/components/src/app/plugins/config/ConfigTab.tsx`

## Route Structure

工作台壳层现在直接由 TanStack Router 文件路由承载：

- `/_workbench` 使用 `WorkbenchShell`
- `/_workbench/plugins/$name` 直接渲染插件详情工作面
- `/_workbench/plugins/$name/$` 保留插件子路由，但不卸载主插件页
- `/_standalone/*` 承接 standalone extension frame

相关文件：

- `packages/components/src/app/router/index.tsx`
- `packages/components/src/app/router/routes/_workbench.tsx`
- `packages/components/src/app/router/routes/_workbench.plugins.$name.tsx`
- `packages/components/src/app/router/routes/_workbench.ext.$pluginName.$.tsx`
- `packages/components/src/app/router/routes/_standalone.ext-standalone.$pluginName.$.tsx`

关键点：

- 路由树由 `@tanstack/router-plugin/vite` 生成
- 不再维护手写 route tree
- 插件详情 route 自己持有隐藏 `<Outlet />`，保证子路由存在但主页面实例不重置

## Shell State

Workbench 只有一个权威 UI 状态源：

- `packages/components/src/app/workbench/store.ts`

它持有三类核心状态：

- 顶栏 tab 状态
- section pane 状态
- tab-scoped view state

### 1. 顶栏 Tab 状态

结构：

- `uiState.tabs`
- `uiState.activeTabId`
- `uiState.tabState`
- `dirtyTabs`

持久化位置：

- `localStorage['pluxel:workbench:ui']`

其中 `tabState` 是按 tab id 存的轻量状态树，用于保存：

- 当前 tab 的 plugin workbench layout 开关
- 右侧内容选择
- schema 选择
- 配置草稿相关瞬时状态

### 2. Section Pane 状态

左侧次级导航已经从旧的局部 layout 状态抽离出来，统一作为 route-owned pane 保存：

- `uiState.sectionPanes`

当前 `/plugins` section 使用：

- `sectionPanes.plugins.visible`
- `sectionPanes.plugins.layout`

这意味着左侧列表不再属于 plugin detail 的右侧/底部情境系统，而是明确属于 section shell。

### 3. Tab-Scoped Workbench State

插件详情页的右栏 / 底栏显隐不再是壳层全局状态，而是挂到当前 active tab 的：

- `plugin:workbench:layout`

这样切换不同 plugin tab 时：

- 右栏开关跟随 tab
- 底栏开关跟随 tab
- 不会在不同插件间相互污染

## Navigation Model

工作台导航由两层协作完成：

- `RouterLinkAdapter`
- `workbench/context.tsx`

核心策略：

- 默认 `replace-active`
- 显式入口才 `open-tab`
- 当前 active tab dirty 时，`auto` 自动升级成 `open-tab`

链路如下：

1. 入口组件调用 `RouterLinkAdapter`
2. `RouterLinkAdapter` 通过 `requestNavigation(to, mode)` 写入 intent
3. 正常执行 router `navigate({ to })`
4. `WorkbenchShell` 在 pathname 变化后消费 intent
5. `syncWorkbenchLocation(...)` 决定复用当前 tab、新开 tab，或激活已有 tab

## Plugin Detail Composition

插件详情页当前分成两层：

### 1. Screen Layer

文件：

- `packages/components/src/app/plugins/detail/PluginScreen.tsx`

职责：

- 获取 plugin meta / config / runtime 状态
- 组织 detail 页的 host 结构
- 把上下文传给具体 workbench 容器

### 2. Workbench Layer

文件：

- `packages/components/src/app/plugins/detail/workbench/PluginWorkbench.tsx`

职责：

- 使用两层 `WorkbenchSplitView`（底层当前适配 `allotment`）
- 组织中心区、右栏、底部 dock
- 只处理容器布局，不承担业务数据逻辑

当前布局：

- 外层横向：
  - workspace
  - sidebar
- 内层纵向：
  - content
  - dock

当前尺寸持久化键：

- `pluxel:plugin:workbench:h`
- `pluxel:plugin:workbench:v`

尺寸是 workbench 级偏好。

显隐是 tab-scoped 状态。

## Right Pane Responsibilities

主工作内容统一收口到：

- `packages/components/src/app/plugins/detail/RightPane.tsx`

它当前负责：

- 读取 plugin detail route search
- 解析 plugin sub-route
- 决定当前 active view
- 承接 config 表单 / builtin layout / extension route 渲染
- 聚合 dirty 状态并上报到当前 workbench tab

关键设计点：

- route search 只负责可分享的最小状态，例如 `tab`、`schema`
- tab-scoped state 负责恢复不适合暴露在 URL 上的工作态
- plugin sub-route 作为主插件页的子路由存在，但不会触发整页重建

## Config Editing Flow

配置编辑链路现在是：

- `ConfigTab`
  单 schema 表单实例
- `ConfigForm`
  多 schema tab 聚合
- `ConfigLayout`
  builtin markdown/layout 模式聚合
- `RightPane`
  汇总 dirty / draft / active state
- `workbenchStore`
  只保存当前 workbench tab 的抽象脏状态

这样壳层不理解具体字段，也不持有表单实例，只接收：

- 当前 tab 是否 dirty
- 当前 tab 的轻量 view state

## Extension Placement

当前扩展点落位如下：

- `navbar:items`
  最左 activity rail
- `plugin:header`
  插件运行控制带补充区
- `plugin:tabs`
  editor area 内容扩展
- `plugin:context`
  右侧 sidebar
- `plugin:dock`
  底部 panel
- `plugin:info`
  右栏概览扩展位

左侧 section pane 不开放为“任意插件动态改形”的扩展位，它仍然由 route host 控制。

## File Structure Rules

这次重构后约束如下：

- router 只负责 route 装配和 URL contract
- workbench 目录只负责壳层状态、导航意图、布局持久化
- split 子目录只负责 pane adapter、layout spec、split state 工具
- plugin detail 目录只负责插件工作面
- 不再保留只做一层转发的旧 route/page 壳文件

因此旧的：

- `frames/WorkbenchShell.tsx`
- `frames/WorkbenchTabsContext.tsx`
- `frames/WorkbenchLayoutContext.tsx`
- `app/routes/PluginDetailRoute.tsx`

都已经退出主路径。

## Persistence Boundaries

当前边界刻意分成三层：

- URL：
  只存最小可分享状态
- localStorage：
  只存 workbench UI 偏好和 tab 壳层状态
- runtime memory：
  草稿、瞬时表单态、未提交工作上下文

这样做的目的：

- 避免把敏感草稿写入持久存储
- 避免 URL 被临时 UI 状态污染
- 让 workbench 壳层恢复足够稳定，但不承担业务级缓存
