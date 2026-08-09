# Frontend Architecture

业务 HTTP 与 optional Workbench 是两条独立路径。Workbench 不得成为插件核心能力的启动前提。

## Server/browser boundary

- `@pluxel/runtime/workbench/contract`：browser-safe Contract value；
- `@pluxel/runtime/workbench`：server-only Extension、entry 和 Binding；
- `@pluxel/runtime/workbench/ui`：browser resource facade、React hooks 和 exact View exports。

UI source graph 必须导入 Contract value，不能导入 Extension。Contract module 不能引用 Plugin、Context、provider、
Node builtin 或 server-only package。toolchain 独立构建每个 UI entry，并验证这条反向依赖边界。

普通 View 使用 `ui.useResources()` 取得全部 owner resources。跨插件 renderer 另外使用 `ui.usePort(Port)` 取得当前
consumer outlet 注入的 target-scoped resources。两组 grant 独立。

live-query UI 暴露只读 `useQuery(params)`，返回 `loading | ready | stale | error` 可判别联合，并提供
`getSnapshot()/subscribe()/refresh()`；mutation 走 typed RPC。events 使用 imperative `subscribe()` 和独立 `useConnectionState()`，两者共享底层
multiplex transport。

## Layout and rendering

Contract placement 只有两种产品语义：`plugin.tabs` 把管理 View 放进目标插件工作区，`plugin.routes` 声明可导航页面。
同一 View 可以拥有多个 placement，identity 来自 owner + View + normalized tab/path，不依赖数组 index。不提供尚无真实
消费方的 header、dock、status bar 等通用插槽；出现新产品需求时先确定宿主所有权，再扩展 Contract。

global layout 可以下发 route navigation metadata，但打开 target screen 后才取得 resource grant并加载实际引用的
bundle。builtin document 由 host 渲染且只用于只读内容；交互流程使用 React View + typed RPC。

Remote View 的普通页面切换使用 `useWorkbenchHost().navigate()`，沿用宿主 active Tab 和 dirty-state 策略。集合页需要
打开对象详情时才使用 `openTab()`；Contract 以 `navigation: false` 声明整段参数 route，并通过 `routeParams` 读取匹配参数。
宿主对两种操作统一负责路径归一化、route 存在性与 shell frame 校验；`openTab()` 另外按完整路径去重并恢复标题
metadata。插件不能传入任意宿主 URL，也不应在 bundle 中引入宿主 Tab store、router 或 split implementation。

浏览器只创建一个 `WorkbenchClientRuntime` 实例。它拥有 layout SSE、catalog、按 target 引用计数的 session、route index
以及 Remote module revision。一次 target 更新先加载并 setup 所需 module、校验 Contract 和 route，再原子发布 layout
snapshot；旧 module 在仍被任一 target snapshot 引用时继续存活。React 只订阅 snapshot 和渲染，不拥有 artifact 或 route
生命周期。target 降到零引用后延迟到当前 microtask 末尾回收；React StrictMode 的 effect replay 会立即恢复同一 lease，
不重复请求 layout、加载 Remote 或终止唯一 runtime。Provider cleanup 不把 render-stable runtime 标记为永久 disposed，
真正的 SSE、module setup 和 target snapshot 清理由引用 lease 完成。Workspace tabs、router intent 和持久化由独立
`WorkspaceController` 实例拥有；该实例位于 Router 之上的稳定根 Provider，不随 Shell 或 route tree 重建，也不使用 module-level store。
显式 `openTab()` mutation、navigation intent 和随后 route reconciliation 必须落在同一个 Controller 上。Tab strip 的
`+` 只创建 host-owned clean navigation instance；它不扩大 Remote View capability，也不复制 dirty 或 tab-scoped state。

## Worksplit adapter boundary

`split-like-vscode` 是独立的通用 UI library，只拥有 pane 约束、resize math、React 组件、CSS 与可序列化 layout value；
它不知道 Pluxel plugin、route、Remote View、Tab identity 或持久化政策。Pluxel 只把 `@worksplit/react` 当作普通依赖，
不为它增加 Vite plugin、codegen、virtual module 或 Pluxel-specific library API。

所有直接 Worksplit import 和 pixel/percentage 转换收敛在
`packages/workbench-app/src/app/workbench/split/view.tsx`。Workbench App 以百分比保存布局，只在 pointer、keyboard 或
visibility 变更 commit 后写入 `WorkspaceController`；实时拖动不产生同步持久化。Remote plugin UI 只能使用 `navigate()`、`openTab()` 等
host capability，不能依赖 Worksplit、宿主 router、split adapter 或 workspace store。具体文件职责和修改路由见该目录的
[`README.md`](../packages/workbench-app/src/app/workbench/split/README.md)。

## Updates and isolation

registry 与 artifact store 可由 host 共享，但 owner registration、Binding 和 cleanup 保留 immutable Context。
bundle-only HMR 复用 resource lease；plugin stop/replacement 撤销旧 lease。不同 target 不共享 grant，但可以共享
底层 transport connection。

## React state correctness

- `packages/workbench-app/src` 与 `packages/valibot-form/src/web` 强制检查 Hooks 调用、完整依赖和 render 期间的组件身份稳定性；
  不用 disable 或遗漏依赖表达“只想执行一次”。
- 跨组件共享事实使用带 `subscribe/getSnapshot` 的 store/resource；`useEffect` 只同步外部系统，不在父 effect 中清空由子
  effect 注册的命令式引用。
- 空数组、空对象和 Context value 必须保持稳定身份，避免无事实变化时重复触发 memo、effect 或 transport subscription。
- RPC/HTTP 读操作必须具备 latest-request、AbortSignal 或 resource revision 语义；仅用 mounted boolean 不能阻止旧请求覆盖新
  plugin/route 的状态。
- 配置、mutation 和 lifecycle 控件至少覆盖一次“用户动作 -> 状态变化或 transport 副作用”的测试；仅断言按钮存在不足以验证
  wiring。
- 前端 lint 同时启用 React DOM/Context 正确性、JSX accessibility，以及类型感知的 Promise 和安全字符串化规则；新增异步
  handler 必须显式 await、catch 或用 `void` 表达有意忽略。
