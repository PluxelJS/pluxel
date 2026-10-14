# Frontend：会话、状态与资源

Workbench frontend 是一个固定 Shell，既能直接渲染 Content，也能按需加载完整 Plugin applications。业务 HTTP 与 Workbench 正交；
Workbench 不得成为 Plugin 核心能力的启动前提。

本页维护 Shell 状态、文档身份和资源所有权。交互取舍先读 [Workbench 设计规则](WORKBENCH_DESIGN.md)，操作说明见[工作台使用与排查](../docs/workbench/operations.md)，按风险选择回归见[验收指南](WORKBENCH_FLEXLAYOUT_VALIDATION.md)。

| 本次修改                       | 先定位                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| 登录、连接、session 撤回       | [一个 document，一条 session](#一个-document一条-session)                              |
| 缓存、mutation、订阅           | [三类前端状态](#三类前端状态)、[React state correctness](#react-state-correctness)     |
| Content/MF 打开与清理          | [Layout 和 entry activation](#layout-和-entry-activation)、[Host facade](#host-facade) |
| 标签、导航、布局恢复           | [原生工作区与文档路由](#原生工作区与文档路由)                                          |
| 插件目录、侧栏、日志、配置目录 | [内置编辑器滚动与目录](#内置编辑器滚动与目录)                                          |

## 固定边界

Management client/react 拥有认证会话与管理 DTO；Workbench client/react/federation 拥有 layout/opened handle、per-open renderer 和 activation。Definition、browser-safe projection、MF singleton 与 Bridge contract 统一见 [WORKBENCH](WORKBENCH.md)，本页只记录 Shell 的状态与 UI 所有权。

## 一个 document，一条 session

`client.tsx` 在 module scope 创建 document-unique `RuntimeSessionClient` 和初始 bootstrap promise，避免 React StrictMode
重复建立 physical WebSocket。`/__pluxel/runtime/session` 上依次完成：

1. authentication-required bootstrap；
2. password/TOTP/OIDC challenge；
3. authenticated ready bootstrap；
4. Management + Workbench capabilities；
5. layout/openEntry、Content push、Plugin API、logs follow 和 observer callbacks。

Workbench App 把 Workbench capability 视为硬要求；management-only bootstrap 不能渲染一个“部分可用”的 Shell。
认证 authority、publication inventory 或 socket epoch 失效时，页面销毁当前 UI 并要求完整 reload。没有 feature reconnect、
旧 root恢复或备用 API transport。

MF manifest、JS/CSS、字体/图片等静态文件仍走 HTTP；Content plan 随现有 `openEntry()` RPC 返回，不增加 artifact
HTTP fetch。浏览器提交 single-use ticket 写入 `HttpOnly` cookie 也使用一个 fixed same-origin POST。这些 HTTP 端点不承载
Management 或 Plugin RPC。

## 三类前端状态

同一个 document 共用一条 Cap’n Web session，不代表所有 React 状态共享 owner、cache 或更新协议。Frontend 按事实分成三层：

| 状态                      | 生命周期                       | 实现                                                                         | 不负责                                              |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Shell local UI            | document / workspace           | FlexLayout Model、Worksplit 文档协调、React 局部状态                         | RPC cache、capability ownership                     |
| Shell Management snapshot | authenticated document session | Shell 私有 `@tanstack/react-query` `QueryClient` + `RuntimeManagementClient` | descriptor/scope provenance、per-open root disposal |
| Plugin renderer resource  | 单次 `openEntry()` / Bridge    | `createWorkbenchRenderer()` 创建的 per-open owner，内部使用 Query Core       | Shell workspace、跨 open cache                      |

Shell 不复用 Plugin renderer adapter，也不伪造 descriptor 或 opened owner。`RuntimeManagementClient` 已经负责 Cap’n Web
result 的 transport 元数据移除与释放；领域 parser 验证原树并直接构造最终 frozen snapshot，只有不透明数据叶子需要独立复制。React Query 只负责本地 DTO 的去重、缓存、竞态隔离、loading/error
状态和失效。Query cache 中禁止存放 `RpcStub`、opened handle、subscription 或其他需要显式释放的对象。

Shell 的 QueryClient 与 authenticated session 同寿命，在 `App` 内创建，session epoch 销毁时整体清空。Query key 统一从
`managementQueryKeys` 生成，并使用 canonical node identity。默认 `retry: false`、`networkMode: 'always'`、
`refetchOnReconnect: false`；浏览器 online 状态不能代表现有 WebSocket 可用，socket broken 仍由 session gate 要求完整 reload。
普通 snapshot 允许 stale window 与 window-focus refresh。Mutation 按实际受影响的 read model 精确失效；若写入结果为
`unknown` 或 transport 在提交后断开，则先取消旧 fetch，再等待 authoritative refetch，不能让 mutation 前的晚到结果成为最终状态。

共享 transport 也不等于 snapshot 自动实时。当前 Management 普通读取没有统一 change feed，实时一致性来自本地 mutation
invalidation、显式刷新与 focus freshness；不能用短轮询冒充 WebSocket push。只有具备权威变更源与单调 revision 的领域才应增加
push invalidation。Plugin snapshot/watch 继续 subscribe-before-read，日志等有序连续流继续使用专用协议、gap recovery 与有界
buffer；layout、Content controller、entry activation、workspace draft 也不进入 React Query。

## Layout 和 entry activation

Workbench layout 是 capability-free immutable snapshot。它包含 target、placement、openable identity、owner revisions 和
discriminated pinned Content/MF reference，不包含 Content plan 或任意 Plugin API dictionary。

Shell 打开页面时执行一个原子 activation：

```text
current layout entry
  -> openEntry(expected layout revision)
  -> static Content: validate portable plan -> Shell render
  -> interactive Content: validate plan/presentation -> subscribe only when it has data -> Shell render
  -> federated View: fresh root(s) -> pinned MF/Bridge activation
```

纯 Markdown Content open 只做短 owner admission；返回 immutable plan 后立即释放，不创建 imperative root、MF/Bridge 或
server-side opened lease。Interactive Content 保留一个 framework-owned root；Federated View 只有整个 tuple 成功才成为 active：

```text
target node + owner generation lease
+ layout/publication revision + descriptor identity
+ producer build revision + expose
+ opened root(s) + one Bridge instance
```

失败 candidate 会 destroy Bridge（若已创建）、关闭 host facade，并 dispose single-owner opened handle。关闭 active
View 的顺序同样固定为 Bridge destroy → host facade close → opened handle dispose。旧 renderer 不能接新 roots，新 renderer
也不能接旧 roots。

## Renderer

Content renderer 只消费 client boundary 二次验证后的封闭 AST/presentation，并以 React semantic elements 输出。Text 由 React escaping；
没有 raw HTML、runtime Markdown parser、图片或 Plugin component。Fragment DOM id 用每个 mounted Content 的 `useId()` scope，
同一文档打开多次也不会碰撞。

含 data 的 Content 先 subscribe，再按 sequence 接受 callback、manual load 与 action 的 full-state outcome；action-only Content 不创建
observer。初始失败显示 retry，已有 data 后失败保留值并标记 stale。当前 action control 在 pending 时禁用，跨 control 重叠由 server
lane 返回 busy；带 `confirm` 文案的 action 先用 host confirm。Dialog/embedded form 复用 Config portable field adapter 与 `AutoForm({ fields })`，server
validation issues 映射到字段；validation/domain/unexpected failure 保留 draft，成功清理。Content close 后 observer 和 late unary result
都不能更新 React state。

Renderer 每次 Bridge mount 都有独立 owner 与 cache；Shell 不共享其 QueryClient，也不把 transport-owned capability 放入 React state。公开 resource API、Provider/CSS 与 DTO consumption 见 [renderer resources](../docs/workbench/renderer-resources.md)；其生命周期约束见 [WORKBENCH](WORKBENCH.md#renderer-resource-与撤回)。

## Host facade

Remote 只得到固定 appearance、feedback、受限 relative navigation、document 状态与显式借用的 unary Management 操作。Navigation/document 不适用时为 null；路径必须通过规范形式校验，dirty/title registration 随 per-open handle 撤销。它不取得 raw socket、MF Runtime、Shell store 或私有 Provider。

公开 navigation facade 校验规范路径，不接受 query/hash。目标 frame 由当前完整 committed directory 和 canonical URL 决定，
不能只检测 `workbench-standalone` 前缀，也不能由 `openDocument()` 强制覆盖成 shell。文档标题和 `meta` 直接写入原生 Model 的
`name` / `helpText`，检查 Action 回执；View 只在自己首次覆盖时借用当前原生值用于撤销，不能把打开前的过期标题写回新页面。

## 原生工作区与文档路由

### 一个布局所有者

已认证 browser document 持有一个 `WorkspaceSession`；这里的 browser document 不等于工作区标签。Shell 借用 session 中的 Worksplit 实例。FlexLayout Model 是标签、TabSet、TabGroup、Border、顺序、pin、尺寸和最大化的唯一事实来源；Worksplit 拥有文档身份、独立 Router/history、MRU、复用和关闭协调。业务 dirty、revision、draft 和保存结果属于具体文档。禁止第二套 tabs/grid store 或将只读投影反向同步回 Model。

每个文档用 `createAppRouter({ history })` 消费同一生成 route tree，history 由 Worksplit 提供并在内存中保存。路由只渲染内容，不递归创建 Shell；Management、Product、Mantine 和 session providers 位于文档 Router 之外。`connectBrowser()` 是工作区浏览器地址的唯一写入者，固定工具取得焦点不改变活动文档 URL。

### 导航与身份

- 普通 Shell 入口交给活动文档注册的 Router 导航，经过离开确认；没有活动文档才创建文档。标签外的“+”复制当前已提交地址，在源标签后创建独立 Router 和 opened owner，不复制草稿。
- 内部 `to`、解析后的 search/hash 与浏览器公开 href 分开。文档地址取 TanStack `publicHref`；不能把带 basepath 的 href 再作为 `to`。恢复的惰性文档也使用同一 Router parser。
- `frame: standalone` 使用完整页面导航跨越工作区边界；它的 browser Router 与工作区 history 不同时运行。站外链接、下载、修饰键和新窗口行为交给浏览器。
- Publication 文档身份使用 canonical descriptor key，publication group 仅组织业务入口，与原生 TabGroup 无关。标题来源是 committed publication、相同 canonical owner 的 displayName 或 compiled route title；不得借用其他 fork 或未发布 owner 的名称。插件配置页完成详情读取后更新为实际插件名。
- 原生 Model 拥有已提交的名称，复用和恢复不重新投影默认名称。Host/F2 标题更新检查 Action 回执，撤销遵守 [Host facade](#host-facade) 的借用边界。

中央文档移动、拆分、pin、分组、折叠和最大化保留内容实例；真正关闭或替换路由才清理原 activation。单文档 Router 错误只影响该文档，允许重试，不卸载全局 Shell。

### 动作与关闭

Shell 呈现原生 `onContextMenu` / `onShowOverflowMenu`，保留 React Provider ancestry，通过 `workbench.dispatch()` 提交 Actions 并检查实际回执。可见标签的批量操作不包含折叠组隐藏成员，文案必须准确表达范围。完整容器关闭与纯删除 Action group 由 Worksplit 一次预检全部内容守卫；拒绝时不逐个删除。已成功的业务保存不因后续拒绝而回滚。

工具区域的位置和可达性由 `session.tsx` 约束，见下一节；文档不得移动到工具 Border，菜单和分组操作也不能绕过限制。

### 持久化与恢复

`WorkspaceSnapshotStorage` 保存 Worksplit snapshot：原生 Model 和文档恢复信息。RPC handle、Router、业务 draft、dirty 和服务对象不进入快照。存储 key 的版本由 `snapshot.ts` 的 `workspaceStorageKey()` 定义，并由浏览器 origin 与 UI basepath 隔离；只读当前版本，不双读、双写或运行时迁移旧布局。

恢复验证 workspace、结构与实际 publication/权限。已保存节点要求明确 `type` 和容器 `children`；不能让 Model 将损坏数据补齐为默认布局。只有源码初始 layout 可以使用原生缺省字段。坏快照保留现场，由用户显式修复或重置；后台恢复的文档惰性打开，不同时发起所有插件的 open RPC。

连续变化合并写入，`pagehide`、页面隐藏和 teardown 补写；相同序列化结果不重复写盘。读取或结构校验失败不写回默认值。显式恢复默认布局先协调文档关闭与 pin/关闭保护，再写默认快照并完整导航。存储失败需可发现地报告，但不能阻塞普通打开和编辑；不保证浏览器强制终止或存储故障时的持久性。

Remote 不 import Worksplit、Shell router、布局 store 或宿主私有 Provider。内容使用 CSS Flex/Grid、Mantine 和容器响应式布局，独立页面通过 publication 声明，不再建立第二套宿主分区协议。

## Module Federation policy

每 document 只有一个 MF Runtime。Shell 建立 fixed shared winners 后才按需加载 exposes；未打开的 View 不请求其 expose，Content-only 不产生 producer。完整 shared、CSS、candidate 与更新契约见 [WORKBENCH](WORKBENCH.md#mf2-与-react-bridge)。Frontend 不实现页内 revision swap 或 old-remote fallback。

## 内置编辑器滚动与目录

### 导航和目录

官方 ActivityRail 始终独立于可收起工具区，只展示 `navigationItems.ts` 中的官方入口，并与全局查找共享入口来源。`/apps` 聚合显式 navigation 的业务 route，使用 navigation label、publication group 和 canonical owner 组织；`/plugins` 进入管理工作区。业务入口与插件管理不按 owner 混为一类，`/apps` 聚合页本身不登记插件 owner。

`PluginNavigation` 在管理工作区呈现唯一 `PluginCatalog`，沿用分组、DnD、多选和管理持久化；中央索引只提供选择提示，不再渲染第二个目录。全局 `WorkspaceNavigation` 是入口查找投影，不拥有管理目录状态。目录高亮比较 canonical plugin route；业务页面高亮同时比较 owner 和精确 entry key。

### 区域与可见性

| 区域            | 官方工具                                          | 插件扩展                                                 |
| --------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `border_left`   | `navigation` 提供目录，默认仅在插件管理展开       | 当前 owner 已打开的 left 面板，独立原生标签              |
| `border_right`  | `plugin-inspector` 内部只含“插件信息”与“最近日志” | 当前 owner 已打开的 right 面板，与官方工具分开的原生标签 |
| `border_bottom` | 无                                                | 当前 owner 已打开的 bottom 面板                          |

中央 TabSet 仅承载文档。官方工具固定且不能关闭或拖动；插件面板可关闭并在声明 region 内排序，不跨 Border、不进入中央。`session.tsx` 的放置策略校验所有动作入口，菜单和分组也不能绕过。左边只有官方目录时隐藏冗余原生标签条，有插件面板时保留原生标签条。

`show` 表达区域是否有适用内容，`selected: -1` 表达用户收起偏好。收起仍保留已打开标签，关闭才移除插件面板节点；不能根据声明同步时把用户关闭的面板重新添加。图标/文字模式由左 Border config 保存，官方工具内部选择与插件原生标签选择分开。

### 插件上下文与面板资源

已渲染的详情/声明路由将 canonical owner 登记到所属 `WorkbenchDocumentState`。面板上下文只读取 Worksplit 活动文档 owner，不从浏览器 URL、displayName 或 provider 猜测。Attachment 匹配 consumer `target.node`；作者声明仍使用原有 `workbench.panel()`，见[上下文面板](../docs/workbench/panels.md)。

`PluginPanelDirectory.tsx` 拥有当前 owner 的面板发现与可用性投影，官方信息扩展列表和 `WorkspaceNavigation` 共用它，并通过 `WorkspaceSession.openPanel(entry)` 打开；声明解析、排序、可用性与打开路径不能各写一套。面板默认按需打开，identity 使用 canonical owner 与 descriptor key，重复打开揭示已有原生节点而不创建副本。停止插件的入口不能标成可打开；已保存但声明撤回的节点显示不可用并允许关闭。

`panelTabs.tsx` 定义面板 identity、原生节点与当前声明 activation；`session.tsx` 协调打开、区域策略和 owner 切换。每个 owner 保留其未关闭原生面板的布局。活动节点由 Model 拥有，非活动 owner 布局存于 Border config 的 UI archive。切换 owner 时卸载旧 activation，保存旧 owner 布局并恢复新 owner 的未关闭标签；用户关闭从该布局移除，切回或刷新不能再次自动出现。snapshot 只保存 canonical owner、entry key、region 与 UI 属性，不保存 LayoutEntry、renderer、RPC handle 或旧 producer。恢复 activation 必须重新匹配当前 committed declaration，不能把保存节点当作权限或 publication authority。

面板沿用 `WorkbenchEntryView` 的 Content/MF activation，不创建文档 Router/history。上下文只有 Plugin owner，不自动传入当前 bot/会话等实体参数，也不获得中心文档的 `host.document`；实体编辑与草稿归中央文档。原生 Border 的 show、selected 和 owner 决定可见性；隐藏、切换面板、关闭或 owner 变化时释放 opened handle、Bridge 与 observer，再次显示 fresh open。布局恢复不承诺面板草稿保留。

### 日志读取与展示

右侧官方“插件面板”内部的“最近日志”与“插件信息”切换，插件扩展不进入这组内部标签。它拥有当前 owner 的最近 10 条日志；标题、策略和完整页入口固定，仅记录区域滚动。切换标签、收起右侧或 owner 变化时释放订阅。完整日志使用独立 `/logs?plugin=…` 文档，`plugin` 是 canonical reference，保留 fork 身份；显式打开不替换原配置文档。日志文档筛选由其路由拥有，不跟随后来激活的其他插件；`router/logsSearch.ts` 拒绝非法引用，不能静默退回全局日志。

日志实现位于 `app/log_viewer/`，按资源、展示和页面组合分层：

| 所有者                              | 责任                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `useLogStream` / `logStreamStore`   | 每个读取实例独立订阅与有界缓存；先订阅后读取、epoch 切换隔离、seq 排序去重与缺口恢复；清理后晚到结果不能回写 |
| `LogRow` / `LogList` / `LogDetails` | 行格式、虚拟化列表和详情/复制；只消费记录和回调，不创建订阅、定义路由或强制停靠宽度                          |
| `LogPreview`                        | 组合当前插件最近 10 条的读取与紧凑呈现，不携带完整页筛选和详情布局                                           |
| `LogsPage` / `LogFilters`           | 组合完整阅读、筛选、跟随与按需详情；筛选表单只拥有未应用草稿，路由拥有已应用条件                             |
| `LogPolicyPopover`                  | 右侧最近日志标题后、完整插件日志页标题后共用的策略入口；消费共享 Management Query cache                      |

缓存和等待绘制的增量都必须有界，不能只有可见列表有限。reset/clear、筛选变化和卸载分别撤销旧读取的提交资格；同一 seq 只能在所属 epoch 中解释。界面区分初次读取、实时接收、空结果与错误，重试重新打开当前读取，不新建 transport。清空仅清理当前读取实例的显示缓存，不删除服务端日志。

策略写入与日志订阅使用各自的管理协议。策略 mutation 按 session 串行，执行时读取共享 revision；写入前与成功提交 cache 前取消旧查询，避免不可取消 RPC 的晚到 GET 覆盖新策略。失败先取消旧读取，再执行权威 readback，不用本地乐观值伪装写入成功。

### 文档内编辑和滚动

配置编辑器由插件详情文档拥有。`FormToc` 与 `ContentOutline` 只读取本实例 config anchors / Markdown headings，不扫描其他编辑器或 federated DOM。目录可用性依据实际 anchors，不依据 scrollHeight；没有跨文档目录 claim 或右侧 portal registry。配置目录在编辑器内按需展开，滚动容器必须受所属文档尺寸约束。

配置提交、baseline 和晚到结果约束见[配置实现入口](../packages/workbench/shell/src/app/plugins/config/README.md)。交互取舍见 [Workbench 设计](WORKBENCH_DESIGN.md)，视觉状态与密度见[视觉规则](../packages/workbench/shell/color-design.md)。

## React state correctness

- module-scoped session 和 bootstrap promise 保证 StrictMode 不重复连接；
- Shell 与共享 session providers 在工作区导航时保留；每个文档独立 Router/error boundary，不能用活动 pathname key 重建整棵应用；
- Plugin detail 表单与视图属于具体文档和 canonical node，相同插件的并行文档不共享 draft；
- WorkspaceSession 在已认证入口创建，Shell effect replay 不新建实例；最终 teardown dispose Worksplit，再释放其中的内容 owner；
- Content/View activation 和 handle/Bridge cleanup 用 mount count + microtask cleanup 吸收 effect replay；
- `useRemoteValue` render 只构造本地 store，commit 才订阅/读取；依赖切换隔离 owner，effect replay 复用资源，晚到订阅仍需释放；
- 跨组件共享事实使用 `subscribe/getSnapshot` store；
- 空 array/object 和 Context value 保持稳定 identity；
- Content state 与 remote read 使用 sequence/epoch guard，旧结果不覆盖新 target/route；
- renderer query/mutation cache 属于 per-open owner，StrictMode replay 不重复 subscription，teardown 后 late result 只释放不提交；
- structured query key canonicalize 后才进 cache，typed invalidation 只解析当前 renderer scope 的 resource；
- mutation per-hook single-flight，并在 active owner 中于 settle 后执行预先验证的 invalidation；
- mutation handler 显式 await/catch 或用 `void` 表达有意忽略；
- UI state 永不保存已释放的 Cap’n Web proxy。

## 实现入口

- `packages/workbench/shell/src/client.tsx`
- `packages/workbench/shell/src/app/managementQuery.tsx`
- `packages/workbench/shell/src/workbench/client.ts`
- `packages/workbench/shell/src/workbench/runtime.tsx`
- `packages/workbench/shell/src/app/workbench/`
- `packages/workbench/shell/src/app/workbench/session.tsx`
- `packages/workbench/shell/src/app/workbench/document.tsx`
- `packages/workbench/shell/src/app/workbench/snapshot.ts`
- `packages/workbench/shell/src/app/router/`
- `packages/services/src/management/web/session/`
- `packages/workbench/src/workbench/client.ts`
- `packages/workbench/src/workbench/portable-value.ts`
- `packages/workbench/src/workbench/react.tsx`
- `packages/workbench/src/workbench/renderer-scope.tsx`
- `packages/workbench/src/workbench/react-internal.tsx`
- `packages/workbench/src/workbench/federation.ts`
- `packages/workbench/shell/src/app/workbench/WorkbenchContentRenderer.tsx`

## 验证

Shell 测试位于 `packages/workbench/shell/`，client/resource 测试位于 `packages/workbench/tests/`。覆盖 StrictMode 单连接、query cache 不持有 capability、旧请求不覆盖 mutation 后权威快照、每次 open 独立资源、late result 只释放不提交，以及 Bridge → facade → handle 关闭顺序。

浏览器回归验证真实 session epoch/full reload、MF/React root 隔离、单一 browser history 所有者、多个独立文档 Router、布局持久化、原生菜单/拖拽/分组/焦点与窄窗口可达性。只改纯状态算法时用所属状态模块测试；真实连接、Bridge/CSS 或资源泄漏不能以纯状态测试代替。

按改动选择测试与真实浏览器场景见 [Workbench 验收指南](WORKBENCH_FLEXLAYOUT_VALIDATION.md)。测试入口描述保护范围，既往通过结果不能代替本次变更验证。
