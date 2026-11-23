# Frontend：会话、状态与资源

Shell 将一个已认证浏览器会话组织为多个独立文档和上下文工具。FlexLayout Model 拥有几何与标签，Worksplit 协调文档，业务页面拥有输入和资源。交互理由见 [Workbench 设计](WORKBENCH_DESIGN.md)，操作说明见[工作台使用](../docs/workbench/operations.md)。

## 固定边界

Management client/react 拥有认证会话和管理 DTO；Workbench client/react/federation 拥有 layout、opened handle 和 per-open activation。[Workbench 架构](WORKBENCH.md)维护 publication、Content、MF/Bridge 和服务端租约，本页维护 Shell 状态与浏览器资源。

## 一个 document，一条 session

`client.tsx` 在 module scope 创建唯一 `RuntimeSessionClient` 和 bootstrap promise，React StrictMode 重放不重复建立 WebSocket。`/__pluxel/runtime/session` 依次完成认证 bootstrap、password/TOTP/OIDC challenge 和 authenticated ready，再承载 Management、Workbench、Plugin API、logs follow 与 callbacks。

Shell 要求 bootstrap 包含 Workbench capability。认证、publication inventory 或 socket epoch 失效后销毁当前 UI 并完整 reload。静态 MF/JS/CSS/图片字体通过 HTTP 提供；single-use ticket 通过 same-origin POST 写入 HttpOnly cookie，Content plan 随 `openEntry()` 返回。

## 三类前端状态

| 状态                      | 生命周期                     | 实现与所有权                                                                   |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Shell local UI            | browser document / workspace | FlexLayout Model、Worksplit 文档协调和 React 局部状态                          |
| Shell Management snapshot | authenticated session        | Shell 私有 React Query `QueryClient` 缓存 `RuntimeManagementClient` 的本地 DTO |
| Plugin renderer resource  | 单次 open / Bridge           | `createWorkbenchRenderer()` 创建私有 owner 和 Query Core cache                 |

`RuntimeManagementClient` 清理 transport metadata 并释放 Cap’n Web result，领域 parser 验证原树、构造 frozen snapshot，仅不透明叶子独立复制。Query cache 只保存本地数据，不能保存 stub、opened handle 或 subscription。Layout、Content controller、entry activation、workspace draft 由各自 owner 管理。

Shell 在 `App` 内创建 QueryClient，session epoch 结束时清空。Key 来自 `managementQueryKeys`，使用 canonical node。默认 `retry: false`、`networkMode: 'always'`、`refetchOnReconnect: false`；普通 snapshot 允许 stale window 和 window-focus refresh。

Mutation 精确失效受影响的 read model。结果为 `unknown` 或提交后 transport 断开时，先取消旧 fetch，再等待权威 refetch，防止旧结果覆盖写入。Management 普通读取没有统一 change feed，当前更新来源为本地 mutation、显式刷新和 focus freshness；有权威变更源与单调 revision 的领域可提供 push invalidation。Plugin watch 使用 subscribe-before-read，有序流使用专用协议、gap recovery 和有界 buffer。

## Layout 和 entry activation

Shell 根据 immutable layout 取得 target、placement、descriptor、owner revision 与 pinned Content/MF reference，再调用 `openEntry(expected layout revision)`。打开和回滚流程由 [Workbench](WORKBENCH.md#session-与打开流程)维护。

一个 federated activation 同时绑定 target node/generation lease、layout/publication revision、descriptor identity、producer build revision/expose、fresh roots 和 Bridge。完整候选成功后才发布 active，旧 renderer 与新 roots 不能交叉使用。关闭和失败清理均按 Bridge destroy → host facade close → opened handle dispose 执行。

## Renderer

Content renderer 接收二次验证后的 AST/presentation，输出 React semantic elements。Text 由 React escaping，fragment DOM id 使用每次 mount 的 `useId()` scope；Content 不运行 Markdown parser、raw HTML、图片或 Plugin component。

含 data 的 Content 先订阅，再按 sequence 接受 callback、manual load 和 action 的完整状态；action-only 无 observer。初次失败显示 retry，已有值后失败标 stale。Pending action 禁用对应 control，跨 control 重叠由 server lane 返回 busy，`confirm` 使用 host confirm。

Dialog/embedded form 复用 Config portable field adapter 与 `AutoForm({ fields })`，服务端 validation issues 映射到字段。Validation/domain/unexpected failure 保留 draft，成功清理。关闭后的 observer 和晚到 unary result 不再更新 React。

Federated renderer 每次 Bridge mount 独立持有 owner/cache。公开 resource API 见 [renderer resources](../docs/workbench/renderer-resources.md)，订阅、mutation、portable consumption 与撤回见 [Workbench](WORKBENCH.md#renderer-resource-与撤回)。

## Host facade

Remote 通过 facade 使用 appearance、feedback、受限 relative navigation、document 状态和显式借用的 unary Management。Navigation/document 不适用时为 null；dirty/title registration 随 per-open handle 撤销。

Navigation 校验规范路径，不接受 query/hash。`openDocument({ path, title })` 从当前 owner 的 committed directory 和 canonical URL 解析目标 frame。`openDocument({ plugin, title })` 由 Shell 用节点地址构造内置插件详情路径。标题与 `meta` 写入原生 Model 的 `name` / `helpText`，检查 Action 回执。View 首次覆盖时借用当前原生值供撤销，不能将打开前的旧标题写回已变更的页面。

## 原生工作区与文档路由

### 一个布局所有者

每个已认证 browser document 持有一个 `WorkspaceSession`。FlexLayout Model 拥有 Tab、TabSet、TabGroup、Border、顺序、pin、尺寸和最大化；Worksplit 拥有文档身份、独立 Router/history、MRU、复用与关闭协调；业务文档拥有 dirty、revision、draft 和保存结果。

每个文档通过 `createAppRouter({ history })` 使用同一生成 route tree，history 由 Worksplit 在内存中提供。路由渲染内容，Management、Product、Mantine 和 session providers 保留在文档 Router 之外。`WorkspaceSession.start()` 调用 `instance.start({ browser })` 取得浏览器地址的唯一写入权，工具焦点不改变活动文档 URL。宿主创建、启动和最终 dispose 实例，`<Workbench instance>` 仅绑定视图。

Plugin route 在 match 的 `beforeLoad` 中保存 pathname 到 route context。页面读取该值，使导航期间尚在显示的旧 match 仍解析自己的地址；Shell 和 standalone 共用这一实现。

### 导航与身份

- 普通入口通过活动文档 Router 导航并经过离开确认，无活动文档时才新建。标签外的“+”和 duplicate 复制已提交地址与名称，创建独立 Router/opened owner，草稿仍归原文档。
- 文档公开地址使用 TanStack `publicHref`，内部 `to` 与解析后的 search/hash 分开。带 basepath 的 href 不能再次作为 `to`，惰性恢复使用同一 Router parser。
- `frame: standalone` 通过完整页面导航切换工作区，独立使用 browser Router。站外链接、下载、修饰键和新窗口交给浏览器。
- `documentKey` 表达业务身份：配置按 canonical 路径与 entry，日志按 plugin 筛选；其他路由使用原生已接纳 path/search。`reuse: preserve` 保留原位置，副本使用 `reuse: new`；整个工作区使用 `previewScope: workspace` 保留一份 preview。Publication group 只组织业务入口。
- 标题来自 committed publication、相同 canonical owner 的 displayName 或 compiled route title，插件详情读取后采用实际插件名。Model 拥有已提交名称，复用和恢复不覆盖用户重命名；F2/facade 更新检查 Action 回执，撤销遵守 [Host facade](#host-facade) 的借用边界。

中央文档移动、拆分、pin、分组、折叠和最大化保留内容实例。Activation 在 React effect 中接入 `content.runEffect()`，路由替换、effect cleanup 或正式关闭结束该次使用。React Activity/Suspense 可以保留组件状态而清理 effect，连接遵循实际 effect 寿命。单文档 Router 拥有独立 error boundary 和重试入口。

根 `pnpm-workspace.yaml` 接入 Worksplit 的四份原生补丁；版本、边界和移除条件见 [Worksplit 原生支持](../vendor/split-like-vscode/docs/navigation-support.md)。`scripts/check-worksplit-native.mjs` 由构建/开发任务调用，验证根安装的精确版本、唯一实例和全部补丁。采用版本与宿主证据见 [迁移记录](records/worksplit-adoption.md)。

### 动作与关闭

Worksplit 提供上下文/溢出菜单、键盘操作、popup 关闭和焦点交接。Shell 的 `menus.transform` 添加中文、工具显隐/尺寸、移动目标和在右侧打开副本。布局修改经 `dispatch(Actions...)`，批量关闭经 `close(target)` 一次预检；拒绝保留布局，已成功的业务保存仍有效。

`WorkbenchDocumentRoot` 用 `useContent()` 借用 handle，以单一 `useContentController()` 拥有离开、保存、标题和焦点。子 renderer 在 `content.runEffect(({ signal, defer }) => …)` 中获取资源，成功后立即 defer SDK 释放，await 后检查 signal，晚到结果只释放。

表单 `DocumentEditor` 提供状态 token 和待确认写入。新编辑/写入撤销旧批准，保存期间继续输入仍保留；批准后用本次 request 的 `defer` 暂停原页面交互，直到导航接纳、拒绝或被取代。只读页面声明 `leave: null`，共享服务、草稿和写入回执仍归业务 owner。

正常退出调用 `closeWorkspace`，批准后保存最终快照再交接页面。外部浏览器遍历直接接管已到达 entry；`dispose` 用于最终强制清理，`beforeunload` 保护未保存输入和待确认写入。普通局部组件继续使用普通 effect，`WorkbenchDocumentState` 不另建资源集合。

关闭批准前资源继续工作。原生移除确认后固定已知 cleanup 集合、关闭内容接纳并等待集合结算，尚未完成的 setup 与截取后资源不延长回执。晚到失败走 `onIssue`；程序 close/dispatch/dispose 的失败由 `WorkspaceSession.check()` 处理返回值，原生 UI 操作由 Worksplit 消费回执、上报一次。Standalone 使用 React/AbortController 寿命和相同 SDK 释放顺序。完整规则见 [Worksplit 资源指南](../vendor/split-like-vscode/docs/resource-lifetimes.md)。

### 持久化与恢复

`WorkspaceSnapshotStorage` 保存 Worksplit v2 snapshot：原生 Model 和文档恢复信息。RPC handle、Router、draft、dirty 和服务对象不进入快照。`snapshot.ts` 的 `workspaceStorageKey()` 以版本、浏览器 origin 和 UI basepath 隔离存储，只读取当前版本。

恢复校验 workspace、结构、当前 publication 和权限。持久化节点必须显式包含 `type` 与容器 `children`；原生缺省字段只用于源码初始 layout。坏快照保留供显式修复/重置，后台文档惰性打开。

`snapshotRevision` 触发合并写入，`pagehide`、隐藏和 teardown 补写，相同序列化结果不重复保存；普通查询直接读 Model。读取/校验失败不写回默认值。恢复默认布局先协调关闭和 pin/关闭保护，再删除布局存储并完整导航。退出与交接使用原生移除前捕获的最终快照，并关闭旧 writer。存储失败可发现地报告，普通打开/编辑继续工作。

Remote 使用 CSS Flex/Grid、Mantine 和容器响应式布局，独立页面通过 publication 声明，不导入 Worksplit、Shell router、布局 store 或私有 Provider。

## Module Federation policy

每个 browser document 只有一个 MF Runtime。Shell 建立 fixed shared winners 后按需加载 expose，未打开 View 不请求 expose。Shared、CSS、candidate 和 full reload 规则由 [Workbench](WORKBENCH.md#mf2-与-react-bridge)维护。

## 内置编辑器滚动与目录

### 导航和目录

ActivityRail 独立于可收起工具区，展示 `navigationItems.ts` 的内置入口与用户固定的 publication 页面。`border_left.config.shortcuts` 是唯一偏好存储，`initialShortcuts` 仅在缺失时初始化，`[]` 保持为空。名称、图标、frame 和可用性从当前 layout 解析，失效 target/entry 保留移除入口。

`/apps` 展示 tab 与显式 navigation 的业务 route。目录从共享 Plugin Overview 读取已提交的插件组和组内顺序，按 canonical owner 匹配 publication，组内继续显示 publication 分类。固定列读取自己的侧栏顺序。全局查找额外包含其他 route。`/plugins` 使用唯一 `PluginNavigation` / `PluginCatalog`，保持分组、DnD、多选和管理持久化。中央索引只提示选择。`/apps` 本身不登记插件 owner。目录高亮比较 canonical plugin route，业务页同时比较 owner 和 exact entry key。

### 区域与可见性

| 区域            | 官方工具                                      | 插件扩展                        |
| --------------- | --------------------------------------------- | ------------------------------- |
| `border_left`   | `navigation`，默认仅在插件管理展开            | 当前 owner 已打开的 left 面板   |
| `border_right`  | `plugin-inspector`，内部“插件信息”/“最近日志” | 当前 owner 已打开的 right 面板  |
| `border_bottom` | 无                                            | 当前 owner 已打开的 bottom 面板 |

中央 TabSet 只承载文档。官方工具固定、不可关闭或拖动；插件面板可关闭、在声明 region 内排序。`session.tsx` 对全部动作校验放置，禁止跨 Border 或移入中央。左侧只有官方目录时隐藏重复原生标签条，有插件面板时显示。

`show` 表达区域有无适用内容，`selected: -1` 表达用户收起。收起保留标签，关闭移除插件节点；声明同步不重新补回已关闭节点。左 Border config 保存图标/文字模式，官方工具内部选择独立于插件原生标签。

### 插件上下文与面板资源

详情/声明路由向所属 `WorkbenchDocumentState` 登记 canonical owner，面板读取 Worksplit 活动文档的 owner。Attachment 使用 consumer `target.node`。作者 API 见 [上下文面板](../docs/workbench/panels.md)。

`PluginPanelDirectory.tsx` 统一发现、排序和投影当前 owner 的面板，官方扩展列表和 `WorkspaceNavigation` 共用 `WorkspaceSession.openPanel(entry)`。面板按需打开，canonical owner + descriptor key 确定 identity，重复打开聚焦已有节点。停止插件的入口不可打开，已保存但撤回声明的节点标不可用且可关闭。

`panelTabs.tsx` 定义 identity、原生节点和 activation，`session.tsx` 协调打开、放置与 owner 切换。活动布局由 Model 拥有，非活动 owner 的未关闭布局保存在 Border config archive。切换时卸载旧 activation、保存其布局并恢复新 owner；关闭会移除保存项。Snapshot 只保存 owner、entry key、region 和 UI 属性，恢复时重新匹配当前 committed declaration。

面板沿用 `WorkbenchEntryView` activation，不创建文档 Router/history，也不取得中央文档的 `host.document` 或 bot/会话参数。隐藏、切换、关闭或 owner 变化释放 Bridge、opened handle 和 observer，再次显示 fresh open；业务实体输入和草稿归中央文档。

### 日志读取与展示

右侧官方“最近日志”读取当前 owner 最近 10 条，标题、策略和完整页入口固定，仅记录区滚动。切换标签、收起或 owner 变化释放订阅。完整 `/logs?plugin=…` 文档保留 canonical reference/fork 与独立路由筛选；`router/logsSearch.ts` 拒绝非法引用，显式打开保留原配置文档。

`app/log_viewer/` 按以下所有者拆分：

| 实现                                | 责任                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `useLogStream` / `logStreamStore`   | 每实例订阅与有界缓存；先订阅后读、epoch 隔离、seq 排序去重和缺口恢复 |
| `LogRow` / `LogList` / `LogDetails` | 行、虚拟列表、详情与复制，消费记录和回调                             |
| `LogPreview`                        | 最近 10 条的读取与紧凑呈现                                           |
| `LogsPage` / `LogFilters`           | 完整阅读、筛选、跟随与按需详情；路由拥有已应用条件，表单拥有草稿     |
| `LogPolicyPopover`                  | 两处日志标题旁共用策略入口，消费 Management Query cache              |

缓存及等待绘制的增量均有界。Clear/reset、筛选变化和卸载撤销旧读取的提交资格，seq 只在所属 epoch 中解释。UI 分开呈现初次读取、实时接收、空和错误；重试重新打开当前读取，clear 只清本地显示。

策略 mutation 按 session 串行，执行时读取共享 revision。写入前和成功提交 cache 前取消旧查询；失败也先取消旧读再做权威 readback，避免晚到 GET 覆盖结果。

### 文档内编辑和滚动

`DocumentTabs` 通过当前文档的 Router 接纳分区切换。出站 HTTP 和认证与安全由父路由持有标签栏，子路由渲染面板内容。只有选中的面板挂载内容，离开时释放该面板拥有的编辑器和订阅。

配置编辑器归详情文档。`FormToc` / `ContentOutline` 读取本实例 anchors/headings，目录可用性取决于实际 anchors，滚动容器受所属文档尺寸约束；配置目录在编辑器内按需展开。提交、baseline 和晚到结果见[配置实现](../packages/workbench/shell/src/app/plugins/config/README.md)，视觉状态见[视觉规则](../packages/workbench/shell/color-design.md)。

## React state correctness

跨组件共享数据使用 `subscribe/getSnapshot` store，空 array/object 和 Context value 保持稳定 identity。共享 session/providers 在文档导航时保留；每份 Plugin detail draft 属于具体文档和 canonical node。

Renderer query 的读、缓存和订阅归每次打开的 scope owner。React effect 重放复用同一 owner，关闭后释放晚到的订阅。Content/renderer query 按当前 lease 或 owner 接纳结果。Mutation handler 显式 await/catch 或以 `void` 表达有意忽略。

WorkspaceSession 在已认证入口创建，Shell effect replay 复用实例；最终 teardown 先 dispose Worksplit、结算已知内容，再释放会话。Content/View 的每次 React setup 独立获取资源，旧 setup 的晚到结果经 defer 清理。Renderer cache、key、invalidation 与关闭规则见 [Workbench](WORKBENCH.md#renderer-resource-与撤回)。

## 实现入口

| 修改范围                              | 源码                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Bootstrap / Management cache          | `packages/workbench/shell/src/client.tsx`、`src/app/managementQuery.tsx`                |
| Layout / route directory / activation | Shell `src/workbench/`，activation 位于 `runtime.tsx`                                   |
| 文档 / 放置 / 快照                    | Shell `src/app/workbench/session.tsx`、`document.tsx`、`snapshot.ts`、`src/app/router/` |
| Content UI                            | Shell `src/app/workbench/WorkbenchContentRenderer.tsx`、`WorkbenchContentController.ts` |
| Renderer SDK / federation             | `packages/workbench/src/workbench/`                                                     |
| 认证 / transport                      | `packages/services/src/management/web/session/`                                         |

## 验证

Shell 测试在 `packages/workbench/shell/`，client/resource 测试在 `packages/workbench/tests/`。重点覆盖 StrictMode、DTO cache、晚到结果、每次 open 独立资源，以及 Bridge → facade → handle 释放。

真实浏览器检查 session epoch/full reload、MF/React roots、唯一 browser history、多文档 Router、布局恢复、原生菜单/拖动/分组/焦点与窄窗口可达性。具体场景和已有证据见 [Workbench 验收](WORKBENCH_FLEXLAYOUT_VALIDATION.md)。
