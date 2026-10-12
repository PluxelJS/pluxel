# Pluxel Workbench：FlexLayout 原生工作区迁移提案

状态：待实施。用户已确定保留 Mantine、采用 FlexLayout 原生工作区，并允许重新设计交互；本文不是现行 API 文档，也不表示本体已经兼容新版 Worksplit。面向接手实施的 GPT‑6.1 Sol，其他 coding agent 同样适用。

复核日期：2026-10-13。本文要求交付可用的新 Workbench，而非复刻旧 UI 或仅替换布局组件。

## 1. 先理解目标

用户的决定已经明确，不需要重新询问是否换 HeroUI、是否保留旧标签栏、是否允许重做布局：

1. **保留 Mantine**，继续使用已有表单、弹窗、通知、主题与业务组件。统一新工作台的视觉密度和反馈方式。
2. **工作区完全 FlexLayout 化**。标签栏、TabSet、TabGroup、Border、分隔线、拖拽预览、最大化、溢出处理与布局持久化，都基于原生结构。
3. 尽量带入已受支持的原生能力，尤其是固定标签、标签分组、组名/颜色/折叠、右键管理、跨容器移动、边栏模式和键盘操作。不能只保留一个可拖拽的中央编辑区。
4. 不要求一比一复原旧 Workbench。旧 activity rail、嵌套 section、assist、底部 dock、面包屑与快捷键都可重排或删除；真实业务能力、地址可达性和资源契约必须保留。
5. 设计应减少点击、重复标题、状态来源和隐含联动。每个新增包装都必须有明确的契约或生命周期收益。
6. 本任务分两部分：本提案及 Worksplit 接入示例优化已经准备；**Pluxel 本体迁移由接手者实施**。不要把提案里的目标写成已实现的事实。

成功后，用户看到的是 Mantine 风格、原生停靠管理、内容连续且错误可恢复的工作台。维护者只需要理解 FlexLayout 模型、Worksplit 文档协调和 Pluxel 插件资源三个主要边界。

### 不纳入首轮的扩展

不新增多窗口、float/popout、任意 Model replacement、布局 undo 平台、跨设备工作区同步、通用菜单 DSL、动态 UI 插件框架或新版 RPC 协议。当前 Worksplit 对其中部分能力明确拒绝。不能为了“尽量原生”绕过这些边界。

## 2. 权威入口、源码基线与工作区现状

首先读取根 [AGENTS.md](../../AGENTS.md)，再按需读取：

- [工程原则](../DESIGN_PRINCIPLES.md)、[系统边界](../PLUGIN_SYSTEM.md)。
- [Workbench](../WORKBENCH.md)：publication、单次打开、MF Bridge、资源释放与撤回。
- [Frontend](../FRONTEND.md)：当前 Shell、状态与缓存所有权。其旧 Workspace/Pane Kit 章节是本次需要替换的实现约束，不是要求保留旧 UI 的产品指令。
- [API 设计规则](../../.agents/rules/library-api-design.md)：公共契约变更时必读硬约束和对应章节。
- [开发控制台](../../docs/development/dev-console.md)：真实在线验证入口。

Worksplit 权威仓库是 [PluxelJS/split-like-vscode](https://github.com/PluxelJS/split-like-vscode)，目标分支为 `refactor/flexlayout-tanstack`。查阅该分支的 `README.md`、`refactor/README.md`、`docs/vscode-workbench-behavior.md` 与公开 exports，不从旧 main 或历史设计草稿推导新 API。

本次复核时：

| 项目 | 基线/位置 | 注意事项 |
| --- | --- | --- |
| Pluxel | `87a1f6b2e89e0e541adeb89c3e9263c62fb87724` | 仍消费旧 Worksplit workspace 包，本体尚未迁移 |
| Worksplit refactor | `eff5b57e593ed9c8df3edefcc2886775b9886b45` 后的工作树 | 本次新增声明式菜单示例和回归，核心公开 API 未变；开工先检查最新提交及未提交差异 |
| 本机 refactor checkout | `/home/ahdg/code/shinium/worksplit-flexlayout-tanstack` | 这是复核位置，不可把绝对路径写进最终构建配置 |
| Studio | [项目 README](../../projects/report-template-studio/README.md)、[制品说明](../../projects/report-template-studio/vendor/README.md) | 使用固定提交的打包制品；无需为这次 demo/文档修改重新打包 |
| Pluxel 子模块 | `vendor/split-like-vscode` | 复核时已有用户改动及不同于父仓库记录的指针，尤其 `refactor/README.md` 草稿；不得 reset/覆盖 |

实施前执行 `git status`、核对依赖来源和 scripts；上述提交只是复核基线，不能覆盖后续更新。建议为本体迁移创建独立分支/工作树。保留用户已有变更；如果子模块有未提交内容，在独立 checkout 内推进迁移，不先清理用户目录。

### 接入新版依赖

当前 `pnpm-workspace.yaml` 将 `vendor/split-like-vscode/packages/core` 与 `packages/react` 加入 workspace，`@pluxel/workbench` 使用 `workspace:*`。因此只改应用 import 或升级一个版本号不会切到 refactor。

在迁移工作树固定 refactor 提交，使 workspace 内的 core/react 来自同一个版本；核对 React、React DOM、FlexLayout、TanStack Router/Store/Hotkeys 的兼容与物理解析。不要将同名同版本的新旧包混装后用 alias 掩盖。Studio 的临时制品方案是先导隔离手段，不应成为本体永久发布方案。

Worksplit 已有 core/react 的 Tegami major 记录；正式推广遵循 Tegami，不手改版本或 publish-lock。更新 Pluxel 所需依赖、锁文件与子模块指针时保持审查范围明确。删除 dnd-kit 等依赖前搜索全包真实调用方。

## 3. Worksplit 复核结论

### 已足够使用的能力

- 唯一 FlexLayout Model，直接使用原生 JSON、Actions、DockLocation、节点与主题。
- 每个文档独立 TanStack Router/memory history，共用应用定义；没有第二套路由匹配引擎。
- 文档身份、复用、多实例、预览、MRU、激活、关闭与 URL 协调。
- TabGroup 名称/颜色/折叠、单标签 pin、Border 模式/尺寸、原生批量布局操作。
- `native` 透传原生展示接口，包括 `onContextMenu`、`onShowOverflowMenu`、`onRenderTab`、`onRenderTabSet`、icons、i18n、keyMap；`layoutRef` 保留原生展示操作。
- 普通关闭、删除批次与 TabSet 关闭经过内容决策，返回可判断的结果；不会默认丢弃 dirty 内容。
- 移动内容不重建业务实例；显式激活可揭示隐藏 Border、展开折叠组并处理最大化可见性。

**不需要增加 Mantine 专用 Worksplit API、Pluxel adapter 包或菜单注册平台。** 主题与菜单属于宿主呈现。只有本体真实接入证明公开契约缺失时，才对 Worksplit 做小范围修正，并提供真实调用及回归。

### 本次已做的接入优化

Worksplit demo 原先调用 `showPopupMenu()`，上游会创建独立 React root。将其内容换成 Mantine 组件时不会自动继承 Shell Provider，且菜单的销毁需要另行管理。

现改为 Shell 持有单个临时菜单状态、声明式渲染原生 `PopupMenu`。Portal 继承 React context，菜单随 Shell 卸载，点坐标锚定时显式指定焦点返回目标，目标节点删除时关闭菜单。所有原生 builder 动作仍提交 `workbench.dispatch()` 并检查回执。

公开消费回归覆盖 Provider 继承、dirty 关闭拒绝、焦点返回与卸载；浏览器回归继续验证原生分组及菜单。没有修改核心引擎，也没有给库引入 Mantine 依赖。以本次交付实际检查结果为证据，不把计划运行的测试写成通过。

本次实际验证：`workbench-customization.test.tsx` 9 项通过；原生布局浏览器回归 21 项通过，新增菜单目标删除/焦点回归 1 项通过；Worksplit workspace typecheck、lint 与 demo production build 通过。这些证据覆盖接入方式，不代表已验证 Pluxel 的实际 Mantine 菜单、外层路由或 RPC/MF 撤回。后者由本提案验收矩阵约束。

## 4. 术语必须分清

| 概念 | 含义/所有者 | 禁止混淆 |
| --- | --- | --- |
| TabNode | 一个原生标签；内容可为文档或固定工具 | 位置变化不改变文档身份 |
| TabSet | 中央可停靠、可分割的容器 | 不是导航分类，也不是标签栏彩色分组 |
| TabGroup | 同一标签栏中的原生分组，有名称、颜色和展开状态 | 不创建另一层 Pluxel editor group |
| Border | 工作区边缘的原生容器，可采用 split/overlay 模式 | 不保留另外一套自定义 dock |
| Worksplit document | 有 Router/URL 的内容实例 | 不是浏览器 document，也不是服务器 opened handle |
| Worksplit tool | 实例寿命内注册的无文档 Router 内容 | 固定注册表不适合直接注册不断变化的插件清单 |
| publication group | 插件入口的业务导航分类 | 不自动等于 FlexLayout TabGroup |
| publication layout | 服务端 capability-free 入口快照 | 不等于客户端 FlexLayout 布局 JSON |
| pinned reference | 固定的插件制品/descriptor 引用 | 与用户固定 UI 标签无关 |

现有 `getEditingContext().activeGroupId` 名称保留，它指 TabSet 或 Border；不能按名称误认为 TabGroup，也不要为此添加同义 alias。

## 5. 目标架构与唯一状态来源

```text
浏览器 document / authenticated session
├─ 单一 RuntimeSessionClient、Management client、Shell QueryClient
├─ Mantine / appearance / feedback / Product providers
├─ 页面入口与 standalone 分流
└─ Workspace session（宿主持有，Shell 借用）
   ├─ 一个 Worksplit 实例
   │  ├─ 一个 FlexLayout Model
   │  ├─ 每个文档一个 Router + memory history
   │  └─ 固定 Shell tools
   ├─ Shell（原生 Layout、Mantine 菜单、全局命令与状态反馈）
   ├─ 文档内容
   │  ├─ Pluxel 内置业务页面
   │  ├─ Content activation / controller
   │  └─ 每次 openEntry 对应的 MF Bridge / opened owner
   └─ 布局快照存储 + 独立 Shell 偏好
```

| 事实 | 唯一权威来源 |
| --- | --- |
| 标签所在容器、顺序、pin、组名/颜色/展开、尺寸、最大化 | FlexLayout Model |
| 文档身份、有效 URL、Router、预览/MRU、关闭中的资格 | Worksplit |
| dirty、编辑 revision、保存成功与失败、业务 draft | 具体文档/业务模型 |
| 插件 availability、generation、publication 与认证 | Pluxel 服务与客户端协议 |
| opened handle、Bridge、订阅和远程 Query owner | 现有 activation 生命周期 |
| 当前打开的菜单、搜索词、密度偏好 | Shell 局部状态 |
| 恢复候选 | 持久化快照；它不是第二个运行时 Model |

禁止继续同步旧 `tabs/editorGroups/grid` Store 与 FlexLayout。只读投影可供导航和状态栏使用，但不能再从投影反向驱动布局。不要把整份 `getLayout()` 快照放进 React state 再回灌 Model。

不要把所有文件合并为一个新 controller，也不要机械按行数拆分。实例创建/销毁、路由定义、菜单呈现和业务 activation 有不同所有权，可分别组织；无独立契约的转发方法直接删除。

## 6. 工作区与导航的产品设计

### 默认布局

初始保持一个中央 TabSet。插件目录/入口导航作为 Shell 固定工具，默认放左侧 Border；必要时提供右侧 inspector、底部状态/日志工具。只保留真实可用的工具，不用空白占位面板展示“IDE 感”。不预设永久 left/main/right 区域或最大 2×2 分区限制。

顶层只保留紧凑的全局工具条：应用/连接状态、入口查找、工作区管理、用户与主题。工具条不再充当第二套标签栏。具体页面操作留在内容区域或原生 TabSet 扩展按钮里，避免三层重复页头。

入口搜索与菜单可找到全部页面和关闭的固定工具。用现有导航信息组织插件与功能，不把 plugin kind、实例、路由、分区都堆成独立 rail。菜单呈现可以重新设计，业务身份必须保持 canonical。

### 打开与焦点

- 普通打开复用符合 Worksplit 身份规则的已有文档；“在新标签打开”显式使用新实例。
- 默认新入口是普通文档，不自动全局启用 preview。只有检索结果的单击预览确有收益时再用 preview，双击/编辑/原生 pin 的保留行为必须可见。
- “拆分到右侧”移动现有标签；“在右侧打开副本”创建独立文档，两种菜单文案和资源语义分开。
- 激活现有文档揭示其真实位置，不复制一个新标签来绕过隐藏状态。
- 工具获得焦点时仍保留活动文档 URL；不得因菜单或搜索框 focus 把其路径写进地址栏。
- 编辑快捷键针对内容，布局快捷键针对明确目标。右键菜单作用于被右键的节点，不取当时的活动文档代替。
- 移动、分组、pin、折叠与最大化都保留内容 DOM、草稿和 opened owner。隐藏不是关闭。

### 窄窗口

优先依赖原生溢出、滚动、Border overlay、最大化和用户可控布局。内容自身响应容器宽度。不要在断点上销毁整个工作区、强制改写用户布局、移动所有标签或自动最大化；这些操作会破坏用户心智和恢复结果。

提供显式“恢复默认布局”入口，并说明影响范围。首轮不要求把复杂桌面工作区改造为完整手机产品，但必须验证小窗口仍可找到标签、菜单和恢复入口。

## 7. Mantine 风格化：呈现统一，行为沿用原生

### 主题

由现有 Mantine theme/color scheme 驱动工作区字体、字号、背景层级、分隔线、选中/悬停、焦点圈、间距与组颜色。通过一个 Shell 样式入口映射到**安装版本实际存在**的 FlexLayout CSS variables/classes，保留原生 DOM 结构。不要凭旧版文档猜变量名。

支持浅色、深色和系统主题切换；菜单 portal 的目标也必须处于正确的主题作用域。CSS 顺序明确，避免两个全局 reset。MF renderer 继续遵守既有独立 Provider 与 Shell 加载 Core CSS 的契约。

原生标签只扩展必要信息：图标、标题、dirty 标记、错误或加载状态。通过 `onRenderTab` / `onRenderTabSet` 添加，不另外画可拖拽标签栏。分组名称和颜色仍直接读写原生节点。

内容根默认不套 Card。布局边界已有分隔线，避免每个 panel 内再叠一圈背景、标题、圆角和大 padding。长日志、表格、编辑器应有明确且有限的滚动容器；保留标题/工具条可达。

### 菜单方案

首选 **原生 ContextMenuBuilder + 声明式 PopupMenu + Mantine 主题 CSS**，最大限度复用原生行为和键盘导航。需要真正 Mantine 控件的输入区可以在同一 React 树内呈现；若完整使用 Mantine Menu，则只做 Shell 局部的呈现适配，直接使用原生 Action，不定义 WorksplitMenuAction 等公共协议。

不要直接把 `showPopupMenu()` 的自建 root 当作 Mantine 子树。不要在每个菜单上再包一个独立 MantineProvider 来补洞。Portal 可以保留祖先 Provider，独立 root 不会。

原生 builder 的条目不全是普通命令：`content` 可能是加入现有组的选择器、组名输入或颜色选择器。不能丢弃这些内容，也不能把它们嵌进可点击的 `Menu.Item` 后让父项抢走键盘和点击。若需统一为 Mantine 输入，直接提交 `Actions.updateNodeAttributes` / `Actions.moveNode`，保留原生模型。

菜单必须具备：指针和键盘入口、方向键、Escape、适当焦点返回、屏幕边缘定位、禁用状态、危险动作分组、可访问名称。内嵌输入允许空格/方向键编辑，颜色不作为唯一含义。菜单关闭后若目标已不存在，焦点回到有效工作区目标，不回到已卸载节点。

### 能力与语义清单

| 对象 | 首轮应有的能力 | 实现/语义约束 |
| --- | --- | --- |
| 中央单标签 | 固定/取消固定、关闭、移动/拆分、加入新组或现有组、移出组 | 原生 pin 只属于 TabNode；不可给整个 TabGroup 伪造 pinned 字段 |
| TabGroup | 改名、颜色、折叠/展开、解除分组、移动整组 | 原生属性/Actions；组内内容仍是原文档 |
| TabSet | 最大化/还原、容器关闭、容器相关移动入口 | 遵守 native enable flags、关闭资格和内容守卫 |
| Border | 显示/收起、split/overlay、调整尺寸、工具重新打开 | Border 不伪装中央 pin；无受支持能力时不显示空命令 |
| 溢出菜单 | 全部候选可发现、清晰活动状态、键盘选中 | 使用 `onShowOverflowMenu` 的候选和 `onSelect`，不重建选择规则 |
| 全局 | 入口查找、重新打开固定工具、显式布局重置 | 不建立第二份 opened tabs 状态 |

固定分组里的单标签会把它移出该 TabGroup，放进中央容器原生 pinned run；解除固定不保证重新加入旧组。pin 会将 preview 转为普通文档。菜单文案和测试必须承认这些原生语义。不要实现“整个组固定”来凑功能。

组改名应长期保存在布局；文档标签改名如启用，则接受后续路由 metadata 可能更新标题的规则，不承诺一个目前没有实现的永久标题覆盖层。

### 批量关闭的范围必须可理解

上游 `closeAll/closeOthers/closeRight` 枚举可见 strip tabs，**不包含折叠 TabGroup 的隐藏成员**。不得将它们标为毫无限制的“关闭全部”而隐瞒范围。

首轮优先复用原生 builder，并将范围明确标为“关闭其他可见标签”“关闭右侧可见标签”等；完整容器关闭使用 `Actions.deleteTabset`，覆盖隐藏成员并遵守原生保护规则。若产品需要额外的“关闭组内标签”，在调用时从原生 children 获取全体成员，提交一个纯删除 Action group，并清晰处理不可关闭成员。

禁止循环 `await close(id)` 模拟原子批量关闭。用纯删除 `Actions.group`：后续任何守卫拒绝时一个标签都不删除。保存已发生的副作用不因此回滚。TabSet 关闭可能保留 non-closeable 直接子项；如果 TabGroup 包含不可关闭成员，会保留整组，不应通知“工作区已全部关闭”。

所有 builder 都传入 `onAction` 并提交 `workbench.dispatch()`。默认 builder 会直接调用 Model，可能绕过 dirty 决策。`canDispatch` 只做同步预检，不是审批或资源预留；实际执行仍检查回执。菜单关闭、快速二次操作、目标已删除都应有明确结果，不假装成功。

## 8. 路由与浏览器历史：先做最小真实接入

当前 `app/router/index.tsx` 使用 browser history，旧 `WorkspaceEditorGrid` 又协调标签与 URL，`WorkbenchDocumentRenderer` 手写 pathname 分发。三者不能原封不动叠到 Worksplit 上。

目标是：

1. 文档 route tree 只渲染内容及内容局部 Provider。不得把当前会再次渲染 `WorkbenchShell` 的完整 route tree 放进每个文档 Router，否则产生递归 Shell。
2. 同一份 route 定义用于多个独立文档 Router；不手工复制一份路由清单或按 pathname 选择组件。
3. Shell 共享 Management/Product/Mantine/session providers 位于文档 Router 外；每个 opened renderer 的 owner 位于其内容寿命内。
4. 工作区内浏览器地址只有 Worksplit 的 `connectBrowser()` 写入，文档 Router 使用 Worksplit 供应的 memory history。不要保留一个同时写同一 URL 的外层 browser Router。
5. `frame: standalone` 仍是有意义的公开能力。首轮可以用明确的页面入口分流与完整页面导航跨越 workspace/standalone 边界；同一工作区内导航保持 SPA。不要为避免重构而让 standalone 页面递归落入普通标签。
6. 对 `history-outside-scope` 作显式宿主处理。不能吞掉 issue 后让地址栏和画面永久不一致；跨页面边界可 reload 当前目标，离开含 dirty 内容的工作区需有明确的文档离开提示。非 Worksplit 历史不得伪造 scope/index 来绕过保护。
7. basepath 只在约定位置规范化一次，route params/search/hash 都保留。不得拼接两次前缀或通过 `as never` 掩盖 Router 类型冲突。

把普通导航、同路由 search 改变、实例复用、新开副本、前进后退、导航阻止、重定向、未知 URL、子路径部署和 standalone 深链纳入验收。外链、下载、修饰键及新窗口沿用浏览器行为。

**先贯通两个内置页面和一个真实插件页面。** 完成该最小纵向接入后再替换全部旧 Shell 接线；不得先写几千行菜单和主题，最后才发现双 browser history 冲突。

## 9. 插件入口与资源寿命

插件 publication 声明的 tab/route 是入口信息，不是服务器控制客户端停靠树的指令。保留 canonical identity、路由与授权，但可将原先插件内部的自绘入口标签改为导航列表/菜单，选择后打开真正的 Worksplit 文档。`placement.group` 用作目录分类，不自动建 TabGroup 或锁定布局。

固定 Shell 工具可以注册到 Worksplit tools；动态插件页面通过有 Router 的文档打开。不要将插件 inventory 直接变为可变 tools registry，也不为此扩展 Worksplit 插件协议。

必须保留：

- 一个浏览器 document 一条 authenticated Cap’n Web 物理 session；StrictMode 和标签副本不能新增 socket。
- Management QueryClient 属于 authenticated session；每个 MF Bridge 打开有私有 renderer owner/cache。不能将 RPC stub、opened handle 或订阅塞进通用 Query cache。
- 同一插件页面打开两份时产生独立 open/owner；移动已有标签保持原 owner，不重新 open。
- 关闭释放顺序遵守 **Bridge destroy → host facade close → opened handle dispose**，晚到结果 consume/dispose，不能重新更新旧 React state。
- 静态 Content、interactive Content 和 federated View 各自沿用当前资源边界，不为统一工厂强行创建空远程 lease。
- Remote 是独立 React root，不能读取 Shell 私有 Router/Worksplit Context。继续通过已有窄 host facade 导航、报告 title/dirty 和反馈。
- 用户主动关闭与权限/session/publication 失效不同。既有失效策略销毁 UI 并要求完整 reload，不能被 dirty 守卫无限阻止，也不能偷偷接新 generation 的 roots。

优先复用 `WorkbenchContentController`、现有 activation、runtime/session 等真正的业务/资源模块。不要因为名称有 Controller 就一概删除。旧 workspace controller 的布局和标签职责才是替换对象。

### Dirty、保存与反馈

dirty 与编辑 revision 来自真实编辑模型，不从 DOM 或修改时间猜测。保存失败保留输入和标签；用户关闭决策在异步保存后重新验证。批量 dirty 关闭提供 `getCloseRevision`，否则 Worksplit 会拒绝，不能用恒定 token 绕过。

决策弹窗用 Mantine，绑定请求目标和版本，不能读取一个随焦点变化的全局 active tab。回执 `rejected`、`superseded`、`failed`、`closed` 含义不同；`cleanupErrors` 要报告清理失败阶段，不能假装恢复了已关闭资源。业务错误保留领域信息，不只发一个笼统 toast。

Shell 只借用 workspace session。实例不能因主题切换、Shell rerender 或 effect replay 被重新创建/销毁。创建、connect/start 和最终 dispose 的 owner 要写清楚；不得在带副作用的 React state initializer 中新建整套外部资源。

## 10. 旧 Pane Kit 和自定义分区的处理

完全 FlexLayout 化意味着旧 Shell `WorkbenchSplitView`/editor grid、固定 plugin rail/assist/bottom dock 和其宽度/显隐持久化协议退出工作区。

当前还导出 `WorkbenchPaneLayout` / `WorkbenchPane`，其 navigation/primary/inspector 角色带宿主 split driver、responsive drawer、顶栏控件和持久化。这是一套独立分区协议，**不能仅改内部组件后宣称已完成收敛**。

本次源码搜索未发现 packages/plugins/projects 中独立业务消费者，主要命中实现、Shell 接线与公共面测试；接手时重新搜索整个仓库、docs、模板和实际项目。若仍无真实消费者，直接移除未被使用的 Pane Kit exports、renderer bridge 接线、专属控件和测试，按公开契约变更添加 Tegami。不要为假设外部用户保留兼容 wrapper。

若发现真实消费者，逐个明确其交互：普通详情/表单排列改为组件内 CSS/Mantine 布局；真正需要工作区级停靠的内容改为有明确资源所有者的文档或固定 Shell 工具，并同步调用方。不要把同一个远程 React root 的 arbitrary children 拆到多个 Shell tabs，也不要为保留旧三栏效果引入嵌套 Model 或新远程 pane 协议。

“普通内容布局可以使用 CSS Grid/Flex”不等于保留宿主旧分区系统。无需让每个表单分组、业务选项卡或卡片都变为 Worksplit 文档；只有可独立打开、停靠、关闭的工作内容进入工作区。

## 11. 持久化、恢复与重置

持久化分为原生 Worksplit snapshot 和独立 Shell 偏好。订阅必要变化并合并写入，拖动期间不每帧序列化整棵树。异步写入读取最新快照；pagehide/teardown 做合理补写，但不承诺浏览器强杀时必然保存。

快照不含 RPC handle、运行时 Router、业务 draft 或服务对象。验证版本、workspace 身份和结构；异常提供“保留现场并重试/显式重置”的可理解反馈，不能 runtime 暗中修复坏契约。存储不可用不阻塞打开和编辑，但应给出有界、可发现的持久化失败提示。

旧 workspace/grid 格式与新格式不兼容。没有需要保留的真实布局时，采用新的存储 key 并说明旧布局不恢复；确有数据需保留时提供一次性显式转换工具，转换后移除旧 reader。不要自动迁移所有旧 JSON 以追求伪兼容。

从快照恢复仍要重新验证插件 availability/权限，恢复 URL 不代表资源授权。失效入口显示可关闭的错误/不可用状态，不能静默换成首页并报告恢复成功。后台标签维持合理懒加载；不要启动时全部 open RPC。

“恢复默认布局”与“清空所有内容”分开。首轮可在说明后关闭工作区、通过全部必要守卫，再重建默认实例；不能把 unsupported Model replacement 暗中用于跳过生命周期。若部分保存已发生，要诚实报告；布局重置不撤销业务提交。

采用上述关闭后重建方式时，必须说明会关闭内容，且纯删除批次需要先满足 pin/non-closeable 资格：不自动解除固定，不用 `dispose()` 强制越过拒绝。受保护内容使重置不可执行时给出具体原因。仅在已有内容安全结束后重建；无损重排可以以后用原生移动操作实现，不作为首轮强行扩展库的理由。

## 12. 实施位置与删除清单

以下路径相对 `packages/workbench/shell/src/`，用于定位，不要求机械保留文件名：

| 当前入口 | 迁移处理 |
| --- | --- |
| `app/index.tsx` | 调整 workspace/session 创建和 Provider 层级 |
| `app/router/index.tsx`、`routes/` | 拆出内容路由与页面入口，统一 basepath/history 所有权 |
| `app/workbench/WorkbenchShell.tsx` | 新 Shell 布局与工具组织，移除旧 split/rail 编排 |
| `app/workbench/shell/WorkspaceEditorGrid.tsx` | 删除自绘标签、dnd-kit、grid 和 URL 接线 |
| `app/workbench/shell/WorkbenchDocumentRenderer.tsx` | 删除手写 pathname 分发，使用实际文档 Router |
| `app/workbench/store.ts`、`tabs.ts`、`state.ts` | 删除平行 tabs/grid/focus 协调；有独立业务价值的偏好移到其所有者 |
| `app/workbench/split/` | 清理旧 editor layout、tabState、plugin split/storage 和未再使用的 SplitView 包装 |
| `app/workbench/RemotePaneLayout*` | 按上节处理旧 Pane Kit，而非永久保留另一套宿主布局 |
| `app/workbench/shell/WorkbenchStatePersistence.tsx` | 改为新 snapshot 与 Shell 偏好持久化 |
| `workbench/runtime.tsx`、activation/Content 模块 | 保留真实客户端资源契约，接新文档生命周期 |
| `app/workbench/styles*` | 删除旧 grid/tab/dock CSS，集中原生 FlexLayout 主题映射 |

可以按 owner 新建少量模块：workspace session、document routes、Mantine/native menus、snapshot storage。不要要求每项都抽成类或包；两个简单函数足够的地方不要加 service interface。

删除旧符号后搜索全部源码、exports、测试、docs、engineering 和模板生成入口。`engineering/FRONTEND.md` 中“Worksplit 不知道 route/persistence”和“Workspace controller 拥有 tabs/grid”的旧事实必须更新，不能让实现与工程文档长期冲突。公开行为写入 `docs/workbench/`；内部边界写入领域工程页，不在提案保留第二份现行手册。

## 13. 建议实施阶段与每阶段完成条件

### A. 建立真实纵向接入

- 固定新版依赖，明确 session owner 与 document route tree。
- 两个内置页面 + 一个真实 Content/MF 页面在原生工作区运行。
- 打开、复用、独立副本、移动、关闭、deep link、basepath 与前进后退通过。
- 用实际插件验证 open/close/失效，确认单 socket、独立 owner 和正确释放。

完成条件：不存在双 browser history 写入，Shell 不递归，每个文档独立且共享服务范围正确。若现有 Worksplit API 真正阻塞，在此阶段修复，不扩展未来功能。

### B. 全量替换工作区与交互

- 内置页面与插件入口统一接入；移除旧 grid/tabs/router 分发。
- 配好原生分组、pin、Border、溢出和菜单；建立 Mantine 主题映射。
- 重新组织导航与工具，清理 Pane Kit/旧 chrome。
- 处理快捷键、焦点、dirty 决策、错误和不可用入口。

完成条件：没有新旧工作区状态双写，所有保留业务入口可达，布局移动不重建内容。

### C. 恢复与最终验收

- 新快照、存储失败、明确重置、旧数据处理落实。
- 小窗口、浅/深色、键盘菜单、真实插件撤回及生产制品验收。
- 删除旧代码/样式/依赖与过时文档，补 Tegami。

完成条件：下列验收矩阵全部有证据或具体说明未验证边界。不能以“类型通过、页面能打开”宣布大重构完成。

每阶段可分别提交可审查变更；同一功能闭环内的契约与调用方一起修改。不要合并一个默认启用但无法完成基本工作流的半成品。

## 14. 验收矩阵

| 场景 | 必须观察的结果 | 证据边界 |
| --- | --- | --- |
| 同 URL 重开 / 显式副本 | 复用与多实例不同；副本有独立 owner/draft | 集成 + 真浏览器 |
| 移动/拆分/分组/pin | 内容 DOM、输入、滚动和 opened owner 保留 | 真浏览器 + 资源计数 |
| 分组管理 | 创建、加入、移出、名称、颜色、折叠/展开、整组移动 | 原生 UI 操作 |
| pin 与 TabGroup | pin 后退出组、进入 pinned run；关闭保护和 preview 提升正确 | 浏览器 |
| Mantine 菜单 | Provider/主题有效；键盘和输入不冲突；无残留 portal | React 集成 + 浏览器 |
| 非活动标签右键 | 动作作用于目标标签；URL/编辑快捷键不错误切换 | 浏览器 |
| 标签/组已删除后菜单操作 | 菜单关闭或明确拒绝，不修改同名新资源 | 竞态回归 |
| 批量 dirty 关闭 | 后续拒绝/编辑 revision 改变时零标签删除；保存失败保留输入 | 有等待点的集成回归 |
| 折叠组与批量关闭 | “可见标签”范围与完整 TabSet 关闭符合文案 | 浏览器 |
| Border 与最大化 | 工具切换保留文档 URL；显式激活揭示目标 | 浏览器 |
| 前进/后退/重定向/阻止 | 地址与已接受内容一致，拒绝不留幽灵历史 | 真浏览器 |
| basepath/standalone/未知地址 | 深链、刷新、离开工作区有明确行为 | 真浏览器/真实服务 |
| 插件并行打开与撤回 | 独立 opened roots；晚到结果释放；失效遵守 full reload 契约 | 真实 RPC + MF |
| StrictMode / rerender / 主题切换 | 不重复 socket/open/subscription，不误 dispose | 集成 + 实际观测 |
| 快照恢复与坏数据 | 合法恢复保留分组/pin/布局；非法输入明确反馈 | 集成 + 刷新 |
| 存储不可用/显式重置 | 工作可继续，反馈不丢失；重置不绕过关闭规则 | 集成 |
| 大量标签、长列表和小窗口 | 可发现、可关闭、无无限滚动泄漏；相同动作无资源增长 | 浏览器与必要测量 |
| 浅/深色与错误页面 | 焦点、边界、菜单和状态可辨识，无双重外框 | 截图 + 人工复核 |

已有回归集中在 `packages/workbench/shell/tests/`。优先沿用并重写实际契约覆盖：`workbench-route-continuity`、`workbench-declared-route-integration`、`workbench-state-persistence`、`workbench-federated-availability`、`workbench-content-activation/controller/interaction`、`workbench-client`、`session-reload`、`runtime-updates`。旧 editor-grid/pane-controls 测试随被删除实现替换为用户行为测试，不能删除后不补覆盖。

检查入口以实际 scripts 为准，当前可用：

```sh
pnpm --filter @pluxel/workbench typecheck
pnpm --filter @pluxel/workbench test
pnpm --filter @pluxel/workbench build
pnpm lint:frontend-types
```

另对变更文件执行普通 lint，对公开导出、声明和真实制品执行相关仓库检查。涉及 Worksplit 源码时在其 checkout 运行对应 test/typecheck/lint/build，必要时运行公开包消费和 browser 测试。不要为只改主题而重跑整个后端部署矩阵，也不要用 stubbed Model 测试代替原生拖拽与菜单。

真实在线操作遵循开发控制台指南：先发现既有 Vite 实例，固定绝对 root/准确 instance，通过普通 TypeScript 导出函数验证 RPC、生命周期和日志。没有在线实例时明确报告缺口，不用隔离 test host 冒充。浏览器用于验证真实 UI；后端状态判定仍通过控制台/权威报告。

## 15. 接手者交付要求与自检

开始实施先提交简短的源码事实和切分说明，然后持续推进，不为每个菜单位置或文件名重新向用户确认。用户已允许重做交互；合理实施选择由你负责。真正改变业务/权限/生命周期契约的决定必须给出具体理由与验证。

每个设计选择至少回答一个问题：它减少了哪份重复状态？保护了哪个 owner？减少了哪次不必要操作？让什么失败更容易恢复？若均无法回答，删掉该抽象。

最终交付需包含：

1. 可运行的新 Workbench，用户入口覆盖清单与有意改变的交互说明。
2. 被删除的旧状态/布局/菜单代码范围，以及实际依赖来源。
3. 原生能力矩阵的落实情况；受支持功能不因简单包装而丢失。
4. 真实 UI、路由、资源生命周期和制品检查结果；未验证部分明确列出。
5. 更新后的领域工程文档、公开用法和必要 `.tegami/*.md`，不手改版本。
6. 每项新增 Worksplit API 的真实阻塞证据；没有阻塞则保持现有公开面。

本提案实施完成后，将当前事实归入 `engineering/FRONTEND.md` / `WORKBENCH.md` 与 `docs/workbench/`，本文件删除或缩为尚未完成边界。历史交给 Git，不长期维护两套架构描述。
