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

Contract placement 由 host 映射为 route、Tab、header、dock 或 capability slot。同一 View 可以拥有多个 placement，
placement identity 来自 owner + View + normalized slot/path，不依赖数组 index。

global layout 可以下发 route navigation metadata，但打开 target screen 后才取得 resource grant并加载实际引用的
bundle。builtin document 由 host 渲染且只用于只读内容；交互流程使用 React View + typed RPC。

## Updates and isolation

registry 与 artifact store 可由 host 共享，但 owner registration、Binding 和 cleanup 保留 immutable Context。
bundle-only HMR 复用 resource lease；plugin stop/replacement 撤销旧 lease。不同 target 不共享 grant，但可以共享
底层 transport connection。

## React state correctness

- `packages/components/src` 与 `packages/valibot-form/src/web` 强制检查 Hooks 调用、完整依赖和 render 期间的组件身份稳定性；
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
