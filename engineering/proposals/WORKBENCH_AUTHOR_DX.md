# Workbench React 作者 API：renderer scope 与 per-open resource owner

> 状态：核心决策已进入当前架构。本文只保留决策摘要、实施证据与尚未验证或延后的边界，不是当前 API 权威。
> 当前契约以 [Workbench 工程文档](../WORKBENCH.md)、[Frontend 工程文档](../FRONTEND.md) 和
> [Workbench 用户文档](../../docs/workbench/index.md) 为准。

## 问题摘要

Workbench 的 View/Attachment 通过 object-capability RPC 获得一次打开专属的 API root。React 页面若直接处理这层
transport，会反复编写同一组机械逻辑：

- 从 renderer entry 向子组件层层传递 `api`、`host` 和 cache；
- 手工 detach DTO、释放 transport result，并防止 late result 写入已卸载组件；
- 为 `snapshot/watch` 重写 subscribe-before-read、coalescing、retry 和 teardown；
- 自行把 route params、principal、session epoch 与 open handle 编入全局 cache key；
- 在 definition 的 browser projection 丢失类型后补显式 generic 或断言。

这不只是代码量问题。Capability root、subscription、AbortController、cache 和 mutation 都必须归属于同一次 open；
React component mount 不是这个远端生命周期的可靠 owner。因此 API 需要同时提供 descriptor-bound scope 和 per-open owner。

## 已定决策

### Descriptor-bound scope

`createWorkbenchRenderer(descriptor)` 把一个 scope 绑定到一个 exact View 或 Attachment descriptor。Descriptor 同时提供
TypeScript 推导和 runtime provenance；跨 scope 使用 resource 或 invalidation target 会 fail-fast。

Renderer-specific scope module 优先与 descriptor entry 同名，例如 `overview` 对应 `overview.scope.ts` 与
`overviewScope`。Entry、scope 和构建错误因此可以直接互相定位。

`scope.render(Component)` 与低层 scope hook 复用同一份 exact descriptor projection。实现通过共享的
`resolveWorkbenchHookValue()` 完成映射；`render()` 不需要在内部调用公开 `useWorkbench()`。

### Module-scoped immutable declarations

`scope.query()` 与 `scope.mutation()` 在 module evaluation 时声明领域读取、写入和 freshness 关系。Resource 本身
immutable，不保存“最近一次”API root、cache 或 observer，也不提供无法判定 open handle 的全局命令式刷新。

作者 API 保持扁平：

- `watch` 和 `invalidates` 直接位于 resource options，不增加单层 namespace；
- unkeyed query 本身是 exact invalidation target；
- keyed query 必须显式选择 `.target(input)` 或 `.all()`；
- 静态关系使用 `invalidates: [query]`，依赖 mutation input 时才使用 callback；
- 权威 watch 必然覆盖 commit 时，不为同一 mutation 重复声明 `invalidates`。

### Per-open renderer owner

每次 Bridge mount 创建一个 renderer owner。相同 descriptor 同时打开多次，也不共享 API root、query data、watch、
retry、mutation 或 invalidation。Workbench 不提供 global `QueryClient`，也不要求作者维护 session/open identity。

| 对象                       | 创建时机                   | 持有内容                                            | 结束时机                           |
| -------------------------- | -------------------------- | --------------------------------------------------- | ---------------------------------- |
| renderer scope             | renderer module evaluation | exact descriptor、React context、provenance token   | module/HMR replacement             |
| query/mutation declaration | renderer module evaluation | frozen options、opaque identity                     | module/HMR replacement             |
| renderer owner             | 每次 Bridge mount          | exact roots、host、cache、watch、timer、abort state | Bridge destroy/open close          |
| query observer             | 每次 Hook mount            | 当前 key 的 active interest                         | Hook cleanup                       |
| mutation state             | 每个 `useMutation()`       | single-flight 状态与本次调用结果                    | Hook cleanup；已接受写入仍归 owner |

核心不变量：

1. Module-scoped declaration 不持有 mutable current instance。
2. Hook 只能从匹配 scope 的 React Context 取得 owner。
3. Query cache、key、observer 和 invalidation 不跨 open handle、session epoch 或 scope。
4. Owner close 从一条路径终止 watch/retry，abort 可取消工作，并拒绝新的提交。
5. 无法取消的 late result 仍必须完成 detach/dispose，但不能更新已关闭 renderer。

### Portable DTO ownership

普通 query/mutation 的 React state 和 cache 只能保存 detached portable DTO。这层限制不可省略：Cap’n Web result 可能带
transport ownership 或 capability，React cache 却可能跨 render、unmount 和异步 settle 存活；直接缓存 proxy 会让释放时机、
可变性与 late-result 行为不可验证。

Framework 因此统一验证、深复制、深冻结 DTO，并恰好释放一次 top-level transport result。作者不再手写
`detach(await api.method())`，正常调用也不需要显式 result generic。

Portable DTO 不是所有领域协议的唯一表达。Callback、progress、cancel、lossless event 与 capability handle 继续使用
`useWorkbench(exactDescriptor)`、`useRemoteValue()` / `createRemoteValue()` 和
`detachWorkbenchPortableValue()` 等低层 capability escape hatch；它们不进入普通 query cache。

### Typed invalidation

Invalidation target 携带 scope provenance 和 resource identity，不暴露 global string key。Mutation 在调用远端方法前验证
targets，并在 settle 后、owner 仍 active 时标 stale；RPC reject 或 result detach failure 也执行已声明 invalidation，因为远端
写入可能已经发生。Mutation success 不等待后续 query read 完成。

### 有意保持的小表面

当前 API 只承诺 per-open query/mutation 所需语义：明确的 `enabled`、`staleTime`、有限 retry、cancellation signal、
single-flight mutation 与稳定错误码。`mutate()` 服务 event handler 的 fire-and-observe，`mutateAsync()` 只用于消费 result
或显式编排流程。Mutation result 若只是下一份 snapshot 的重复副本，领域 command 返回 `void` 并交给 watch/invalidation；
只有 UI 确实消费的 domain result 才返回 portable DTO。API 借用熟悉词汇，但不暴露 TanStack Query、raw cache 或
transport result，也不假装兼容其完整状态机。

## 实施证据

核心 ownership 与 portable boundary：

- [portable-value.ts](../../packages/runtime/src/workbench/portable-value.ts)
- [renderer-scope.tsx](../../packages/runtime/src/workbench/renderer-scope.tsx)
- [renderer-scope.type-probes.tsx](../../packages/runtime/src/workbench/renderer-scope.type-probes.tsx)
- [workbench-renderer-query.test.tsx](../../packages/runtime/tests/workbench/workbench-renderer-query.test.tsx)
- [workbench-client.test.ts](../../packages/runtime/tests/workbench/workbench-client.test.ts)

Browser semantic projection：

- [semantic-lowering.ts](../../packages/rolldown/src/workbench/semantic-lowering.ts)
- [workbench-semantic-lowering.test.ts](../../packages/rolldown/tests/workbench-semantic-lowering.test.ts)

真实 scope 已覆盖不同形态：

- [Auth setup](../../plugins/auth/src/ui/setup.scope.ts)
- [Package Manager](../../plugins/package-manager/src/ui/manager.scope.ts)
- [Wretch settings](../../plugins/wretch/src/ui/settings.scope.ts)
- [Fonts manager](../../plugins/render/fonts/src/ui/manager.scope.ts)
- [Fonts Attachment](../../plugins/render/fonts/src/ui/selection.scope.ts)
- [Report Studio](../../projects/plugin-host/src/showcase/ui/studio.scope.ts)

## 仍延后

以下能力没有进入当前公共契约；只有出现可测量需求并闭合 owner/lifecycle 语义后再设计：

- inline `scope.useQuery(...)` convenience；
- result-derived invalidation；
- polling、stream patch sink 或 background synchronization；
- queued、parallel 或 latest-only mutation mode；
- optimistic update 与 rollback；
- cross-open cache、dedupe 和 devtools；
- portable `Date`、`URL`、binary 等扩展类型；
- parameterized View 的正式迁移与代表性端到端验证。

## 持续验收边界

后续变更至少保持：

- 同一 descriptor 并行 open 完全隔离，close/replacement 后没有 cache、watch、timer 或 mutation owner 泄漏；
- query subscribe-before-read，失效通知可合并，后台失败保留最近成功 snapshot；
- 所有 fulfilled DTO，包括 superseded/closed 后的 late result，都经过 portable 验证与 top-level disposal；
- scope、key、resource budget、closed 和 mutation single-flight 失败维持稳定 code；
- semantic lowering 保持 exact View/Attachment API type，且拒绝跨 renderer 或间接 definition boundary；
- 高层 query/mutation 不吞并需要 capability identity 或 lossless ordering 的协议；
- 新 convenience API 必须减少真实业务样板，同时明确 identity、错误、并发、取消和资源上限。

更细的默认值、状态和错误恢复方式只维护在当前工程/用户文档及 tests 中，不在本 proposal 复制。
