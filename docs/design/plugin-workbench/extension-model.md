# Plugin Workbench Extension Model

## Goal

下一阶段的插件工作台不再以“某个点位塞一段 React 节点”为核心，而是改成：

- 宿主先定义稳定的 workbench 容器
- 扩展声明自己是一个什么 `view`
- 宿主把这些 view 放到合适的容器中
- 每个容器自己决定 tab、缓存、显隐和布局行为

这样做的目标不是更像 VS Code，而是让：

- 中间、右侧、底部都能自然拥有 tab
- 扩展和宿主的职责边界清晰
- 后续替换 Mantine / HeroUI 时不必重想扩展模型

## Scope Hierarchy

新的扩展模型必须先明确四种作用域：

- `global`
  最左 activity rail、全局状态栏、全局命令入口
- `section`
  当前一级路由拥有的左侧次级导航
- `editor`
  中间主内容 tab 本身
- `editor-context`
  右侧 sidebar 和底部 panel

这四者里，真正适合插件工作台动态扩展的，不是全部。

更实用的边界是：

- 最左 activity 继续使用全局导航模型
- 左侧 section pane 由 route host 自己拥有
- 中间 / 右侧 / 底部由 workbench view 模型接管

也就是说：

- `navbar:items` 属于全局
- `/plugins` 左侧插件列表属于 section host
- `plugin:tabs / plugin:context / plugin:dock` 属于当前 editor tab 的情境扩展

这比“全部都做成一个层级的 slot”更稳，因为左侧对象选择和右侧情境阅读根本不是同一类东西。

## Core Position

结论是：可以学 VS Code，把三个区域都做成 tab-aware。

但不能继续沿用现在的“`plugin:tabs` / `plugin:context` / `plugin:dock` 只是不同 slot”思路。

如果继续沿用 slot：

- 中间 tab 是“页面”
- 右侧 tab 是“上下文”
- 底部 tab 是“日志”
- 这三者没有统一抽象
- 缓存、标题、图标、关闭、显隐、恢复都要各写一套

这会越改越乱。

正确方向是统一成一套 `WorkbenchView` 模型。

## Target Layout

未来插件工作台建议稳定为四层：

- 左侧 `activity rail`
- 左侧 `section pane`
- 中间 `editor area`
- 右侧 `sidebar`
- 底部 `panel`

其中：

- `activity rail` 是 global
- `section pane` 是 section-owned
- `editor area` 是文档型区域，允许同时打开多个页面 tab
- `sidebar` 是上下文型区域，允许在同一侧栏里切换多个 view tab
- `panel` 是工具型区域，允许在底部切换多个 view tab

后三个区域都可以有 tab，但语义不同。

建议的视觉结构：

```text
+--------------------------------------------------------------------------------------+
| activity rail | section pane | top editor tabs                                       |
|               |              +----------------------------------------------------------------------+
|               |              | editor area                           | sidebar tabs       |
|               |                                                |--------------------|
|               |              |                                      | active sidebar view|
|               |              |                                      |                    |
|               |              |-----------------------------------------------------------|
|               |              | panel tabs                                                |
|               |              |-----------------------------------------------------------|
|               |              | active panel view                                         |
+--------------------------------------------------------------------------------------+
```

重点不是把每个区域都做成同样的 tab 样子，而是把三个区域都明确成“容器 + tab strip + active view”。

## Concrete Tab Placement

### Section Pane

左侧次级导航不应该和 plugin-context tab 混在一起。

它的职责是：

- 决定当前工作区里“对象列表 / 过滤器 / 选择器”放哪
- 由当前一级路由自己决定内容
- 允许独立记忆显隐和宽度

例如：

- `/plugins` 用它承载插件列表
- `/packages` 将来可用它承载包源或分类过滤器

它不是插件右侧栏，也不应该共享同一套 view state。

### Editor Tab Strip

位置：

- 位于中间主工作区最上方
- 在运行控制带之下
- 横向铺满 editor area

职责：

- 负责切换主工作对象
- 负责关闭、dirty 提示、新开与复用

### Sidebar Tab Strip

位置：

- 位于右侧栏最上方
- 不放在全局顶栏
- 宽度跟随右栏，不占中间工作区高度

视觉规则：

- 只显示 icon + 短标题
- 默认单行，不换行
- 超出后横向滚动，不做多行堆叠

职责：

- 只负责切换右侧辅助 view
- 不承担主导航
- 不承担插件启停主操作

### Panel Tab Strip

位置：

- 位于底部面板上边缘
- 紧贴 editor area 下方
- 始终在日志/工具内容之上

视觉规则：

- 更接近 IDE 的 panel tabs
- 左侧是 tabs，右侧是面板控制
- tab 可带状态点，但不显示过多副标题

职责：

- 负责在 Logs / Events / Tasks / Sessions 等工具视图间切换
- 不承担 editor 级语义

## Three Tab Systems

### 1. Editor Tabs

中间 tab 负责“我正在处理哪个页面 / 文档 / 插件任务”。

适合承载：

- 插件概览
- 插件配置
- 插件自定义页面
- 主页 / 包管理 / 全局页面

特征：

- 可同时打开多个
- 可关闭
- 有 dirty 保护
- 需要 tab 级缓存
- 更接近 VS Code 的 editor tabs

### 2. Sidebar Tabs

右侧 tab 负责“当前主任务的辅助信息和上下文”。

适合承载：

- Outline / TOC
- Inspect / Metadata
- Dependencies
- Diagnostics
- Extension-specific inspector

特征：

- 默认同一时刻只显示一个 active view
- 通常不需要像 editor 一样大量并行打开
- 重点是快速切换和信息密度
- 应记住每个 editor tab 对应的 sidebar active view

右侧不应该继续放主操作按钮。

建议默认宿主 views：

- `Outline`
- `Inspect`
- `Dependencies`
- `Diagnostics`

建议交互：

- 默认只激活一个
- 不提供普通关闭
- 允许隐藏整个 sidebar
- editor tab 切换时，恢复该 editor 上次使用的 sidebar active view

### 3. Panel Tabs

底部 tab 负责“运行验证与工具输出”。

适合承载：

- Logs
- Events
- Tasks
- Interaction Sessions
- Runtime output

特征：

- 默认高度较低
- 需要强可达性
- 常在配置后立刻切换查看
- 应记住每个 editor tab 对应的 panel active view

底部天然适合日志，因此 `Logs` 应成为宿主保留的固定 panel view，而不是一个普通 slot。

建议默认宿主 views：

- `Logs`
- `Events`
- `Tasks`
- `Sessions`

建议交互：

- `Logs` 永远存在，但不一定永远激活
- panel 可整体隐藏
- panel 高度可自由拖拽，只保留最小高度限制
- editor tab 切换时，恢复该 editor 上次使用的 panel active view

## Default View Policy

不是所有容器都应该像浏览器一样“随便开随便关”。

建议默认规则：

- `editor`:
  可多开、可关闭、可 dirty 保护
- `sidebar`:
  默认固定一组可切换 view，不鼓励关闭单个 view
- `panel`:
  默认固定一组工具 view，可切换，不鼓励关闭 `Logs`

更具体地说：

- editor tab 是“文档实例”
- sidebar tab 是“辅助视图选择器”
- panel tab 是“工具视图选择器”

## Right Sidebar Detailed Design

右侧栏建议拆成两层：

### 1. Sidebar Header

包含：

- tab strip
- collapse button
- 可选的当前 view 局部操作

不包含：

- 插件启停
- 全局搜索
- editor 级命令

### 2. Sidebar Body

只渲染当前 active sidebar view。

建议：

- 统一滚动
- 每个 sidebar view 自己只管内容
- TOC / Outline 不再做悬浮层，而是作为 `Outline` view 驻留在这里

因此你之前关心的 TOC 设计，在新模型里不是“全局浮层是否显示”，而是：

- 右侧是否显示 sidebar
- sidebar 当前 active view 是否为 `Outline`

## Bottom Panel Detailed Design

底部 panel 建议拆成三段：

### 1. Panel Header Left

包含：

- panel tabs

例如：

- `Logs`
- `Events`
- `Tasks`
- `Sessions`

### 2. Panel Header Right

包含：

- 清空
- 筛选
- 自动滚动
- 折叠 panel

这些都是 panel 范围内的工具操作，不应跑到 editor 顶栏。

### 3. Panel Body

只渲染当前 active panel view。

例如：

- `Logs` 渲染实时日志
- `Tasks` 渲染任务状态
- `Sessions` 渲染 interaction surface / session

## Editor / Sidebar / Panel Linkage

三者不是独立系统，而是跟 editor tab 关联：

- 每个 editor tab 记住自己的 sidebar active view
- 每个 editor tab 记住自己的 panel active view
- 每个 editor tab 记住自己是否展开 sidebar / panel

但左侧 `section pane` 不属于这里。

左侧次级导航应该按 section 记忆，而不是按 editor tab 记忆。

这很重要。

如果不这样：

- 切插件 tab 时右侧总会跳回默认 view
- 看日志时切回另一个插件，又要重新切一次 panel
- 整体会有很强的“工作上下文丢失”感

所以正确模型是：

- workspace 提供区域骨架
- editor tab 提供上下文边界
- sidebar / panel 提供当前上下文下的辅助视图

## Why This Is Better Than Current Nested Tabs

现在中间配置区的 tab 实际混了三件事：

- 页面级切换
- 配置 schema 分组
- 插件扩展内容

这会导致：

- 层级混乱
- tab 标题含义不稳定
- 路由、配置、扩展都抢同一条 tab 带

新模型里应明确分层：

- editor tab 只解决“工作对象”
- sidebar / panel tab 只解决“辅助视图”
- 配置 schema 分组是 view 内部导航，不再冒充 workbench tab

也就是说：

- `Config` 是一个 editor view
- `Logs` 是一个 panel view
- `Outline` 是一个 sidebar view
- `cfg:*` 不再是 workbench 一级 tab，而改成 config view 内的局部切换

## New Extension Model

## View Definition

扩展不再直接声明自己要插到哪个 slot，而是声明一个 `view`：

- `id`
- `title`
- `icon`
- `location`
- `kind`
- `order`
- `when`
- `initialVisibility`
- `persistence`
- `render`

建议的核心类型：

```ts
type WorkbenchViewLocation = 'editor' | 'sidebar' | 'panel'

type WorkbenchViewKind = 'document' | 'inspect' | 'tool'

type WorkbenchViewPersistence = 'tab' | 'plugin' | 'workspace'

interface WorkbenchViewDef {
	id: string
	title: string
	icon?: ReactNode | string
	location: WorkbenchViewLocation
	kind: WorkbenchViewKind
	order?: number
	when?: (ctx: PluginExtensionContext) => boolean
	initialVisibility?: 'visible' | 'hidden'
	persistence?: WorkbenchViewPersistence
	render: (ctx: PluginExtensionContext) => ReactNode
}
```

## Location Rules

### `editor`

只接受真正的主工作内容：

- 概览
- 配置
- 路由页面
- 扩展文档页

要求：

- 有明确标题
- 可被单独打开
- 对关闭和缓存负责

### `sidebar`

只接受上下文辅助视图：

- 大纲
- 诊断
- 元数据
- 依赖关系

要求：

- 紧凑
- 可折叠
- 不抢主操作

### `panel`

只接受运行输出或工具视图：

- 日志
- 任务
- 交互流
- 历史记录

要求：

- 高度可压缩
- 可快速切换
- 默认更工具化

## Host-Owned Views

以下应该是宿主保留 view，不允许插件覆盖：

- `editor.overview`
- `editor.config`
- `editor.route`
- `sidebar.outline`
- `sidebar.inspect`
- `sidebar.dependencies`
- `sidebar.diagnostics`
- `panel.logs`
- `panel.events`
- `panel.tasks`
- `panel.sessions`

原因：

- 这些是产品结构，不是扩展补丁
- 扩展只能补充，不应重定义宿主骨架

## Extension Contributions

插件扩展只做补充型贡献：

- 新增一个 editor document view
- 新增一个 sidebar inspector view
- 新增一个 panel tool view
- 新增 toolbar command
- 新增 status item

不再支持“随便渲染一块不知归属的节点”。

插件如果想扩展右侧或底部，应该明确声明：

- 这是一个 `sidebar` view
  或
- 这是一个 `panel` view

而不是再让宿主猜“这段节点适合塞哪里”。

## Commands And Status

除了 view，扩展模型还应拆出两类一等公民：

### Commands

用于进入工具栏、命令面板、上下文操作区。

建议替代当前零散的：

- `plugin:header`
- `plugin:actions`

统一成：

- `workbench.command.primary`
- `workbench.command.secondary`
- `workbench.command.context`

其中插件启停仍是宿主保留 primary command。

### Status Items

用于轻量状态提示，不进入 view。

例如：

- 同步状态
- provider 状态
- 轻量告警

建议统一到：

- `workbench.status.editor`
- `workbench.status.panel`
- `workbench.status.global`

## State And Persistence

未来状态应按三层存：

### 1. Workspace State

跨页面共享：

- 左右下区域显隐
- 区域尺寸
- sidebar / panel 的 pinned views

### 2. Editor Tab State

跟随中间 editor tab：

- 当前 sidebar active view
- 当前 panel active view
- 各 view 的局部 UI state
- dirty / draft / scroll

### 3. View Internal State

由 view 自己维护：

- 表单局部状态
- 表格筛选
- 临时展开状态

宿主只负责边界，不负责 view 业务细节。

## Proposed Replacement For Current Points

当前点位建议整体废弃为新模型：

- `plugin:tabs` -> `workbench.view.editor`
- `plugin:context` -> `workbench.view.sidebar`
- `plugin:dock` -> `workbench.view.panel`
- `plugin:header` -> `workbench.command.secondary`
- `plugin:actions` -> `workbench.command.context`
- `plugin:info` -> 删除，不再保留 legacy fallback

这轮设计里不再优先兼容旧点位。

如果要迁移，也应由宿主做一次薄兼容映射，然后尽快删除。

## Practical UX Rules

从实用性看，建议规则如下：

- 中间 editor tab 可多开、可关闭、可 dirty 保护
- 右侧 sidebar tab 允许切换，不鼓励无限堆积
- 底部 panel tab 允许切换，Logs 固定存在
- 每个 editor tab 单独记住自己的 sidebar / panel active view
- 配置页里的 schema group 退化为局部 segmented control，不再占用 workbench 一级 tab

建议再明确三条：

- 右侧和底部的 tab 默认是“切换器”，不是“实例管理器”
- 只有 editor tabs 才默认承担“多实例、多关闭、多 dirty”
- 插件扩展如果需要多实例，应优先走 editor view，而不是 sidebar / panel view

## Migration Order

建议按下面顺序重构，而不是一次性打散：

1. 先在宿主引入统一 `WorkbenchViewDef`
2. 把宿主现有 overview/config/route/context/logs 改成保留 view
3. 把右侧和底部改成真正的 tab container
4. 让扩展从旧 slot 迁到 `editor/sidebar/panel` view
5. 最后删除 `plugin:info` 等 legacy 点位

## Final Position

可以把三个地方都做成 tab。

但前提是：

- tab 不是 UI 装饰
- 扩展点不再是 slot 注入
- 整体模型改成宿主主导的 view container

只要这层改对，后面无论 Mantine、HeroUI 还是自定义样式系统，工作台结构都不需要再重想。
