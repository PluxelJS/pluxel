# Current Workbench 对比与保留账本

> 状态：research proposal companion。本文比较当前实现与 Workbench vNext 的候选设计，不改变当前 API 权威。
> 当前事实仍以 [`../../WORKBENCH.md`](../../WORKBENCH.md)、[`../../FRONTEND.md`](../../FRONTEND.md) 和实现/测试为准；vNext
> contract 以 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) 为准。

## 结论

在 Pluxel 已经选择的产品边界内，vNext 比当前 Workbench **明显更清晰，并更可能在常见路径上高效**：调用方是已安装 Plugin、管理客户端很少、
Workbench 可以把 WebSocket 与 MF 2.0 当作硬前提，也不需要独立演进的公网 API gateway。优势来自删除重复 mapping、延迟 capability admission、复用一条
connection 和沿 exact dependency edge 解析 Attachment，不来自“WebSocket 天生比一切都快”。

这不是所有维度的无条件胜利：

- 当前 `liveQuery` patch 在大列表高频局部更新时可能比 vNext 的 bounded page reread 更省带宽；
- 当前 Standard Schema 路径和 Port version 对不可信输入、独立部署或松耦合 provider 更防御、更自由；
- 当前 HTTP request 与独立 SSE stream 能隔离一部分 workload，单 WS 必须用 scheduling、message ceiling 和压力测试证明不会产生不可接受的队头阻塞；
- vNext 第一版平台实现更难，因为 connection epoch、capability withdrawal、async factory rollback、MF Bridge 和公平调度必须一次做对；
- 一次性迁移的工程风险明显高于继续维护当前实现。

因此准确结论是：**vNext 更适合目标 Workbench，而不是抽象意义上全面优于 current**。只有本文件与
[`DELIVERY_PLAN.md`](DELIVERY_PLAN.md) 的保留和性能 gate 全部通过，才可以声称重构成功。

## 作者路径对比

一个普通 local View 的当前路径是：

```text
workbenchContract.define(resources + views + placements)
  -> workbench.extension(contract + entry)
  -> ctx.workbench.mount(extension, workbench.bind.* resources)
  -> createWorkbenchUi(contract)
  -> ui.useResources()
  -> ui.define(exact component map)
```

vNext 路径是：

```text
workbench.define(view<Api>(entry + placement))
  -> ctx.workbench.publish(definition, target factory)
  -> useWorkbench(exact descriptor)
```

两条路径都可以类型安全地完成任务，但 current 要让作者同时理解 resource kind、Contract、Extension、Binding、grant projection 和 UI module export；
vNext 只让作者声明“页面在哪里、打开后拿到哪个 API”。`Api` 在 definition、factory 与 renderer 之间只关联一次，不再由 resource key、grant 和 client facade
重复映射。

跨 Plugin UI 的差距更明显：

```text
current
  Port(id + version + resources)
    -> provider View accepts Port
    -> consumer portOutlet maps resources
    -> consumer binds resources again
    -> runtime scans running dependents and selects/拒绝 candidate
    -> layout emits provider/consumer grants

vNext
  provider Attachment<ProviderApi, ConsumerApi?>
    -> consumer places exact descriptor
    -> publication binds committed direct required dependency
    -> openView returns provider + optional consumer roots once
```

Current Port 在 provider 可被多个未知 consumer 松耦合发现时更灵活；实际 Wretch/Fonts fixture 已经知道 direct required dependency，所以 candidate scan、
version string、resource mapping 和 ambiguous-provider state 都是重复信息。Attachment 有意只覆盖这个已证明场景。

## 分维度判断

| 维度                     | Current                                                                         | vNext                                                                             | 判断与原因                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| local View 作者成本      | Contract、resource、Extension、Binding、UI facade/export 分层                   | 一个 descriptor、一个 factory、一个 hook                                          | **vNext 明显胜出**；同一 API 不再重复命名和映射                                               |
| 跨 Plugin 组合           | Port ID/version、resource map、dependent scan、opaque grants                    | exact required edge + Attachment                                                  | **vNext 明显胜出**于现有 fixture；解析确定且没有候选竞选                                      |
| 动态调用路径             | 每次 RPC 使用短生命周期 Cap’n Web HTTP batch；layout/事件另走 HTTP/SSE          | 同一 persistent Cap’n Web WS object graph                                         | **vNext 更适合少客户端高交互后台**；减少短 session、HTTP envelope、重复 auth/routing          |
| layout 成本              | layout read 会生成 resource grant；Port resolution 扫描 mounted extensions      | layout 只有 by-value description；`openView()` 才创建 root                        | **vNext 胜出**；未打开页面不分配 authority/target/remote                                      |
| 多 document 隔离         | grant 可跨同 target View 复用，RPC factory 按 request 建立                      | 每次 open 有独立 params/signal/root/lease                                         | **取舍**；vNext 多一些 opened-root 状态，但换来精确 route/principal/cancel/withdrawal         |
| 高频大列表               | `liveQuery` 有 stable key、revision patch、完整 order、gap refresh              | 默认 invalidation 后重读 bounded page                                             | **current 的纯带宽可能更强**；vNext 的正确性、作者成本和少客户端场景更简单                    |
| 普通 settings/CRUD       | RPC resource + client facade                                                    | 原生 `RpcTarget`/`RpcStub`/`RpcPromise`                                           | **vNext 胜出**；保留 promise pipelining 与 child capability，不生成第二套 client type         |
| 输入验证                 | Management/liveQuery 有统一 schema 和 deep-freeze；RPC domain 仍由实现负责      | 平台 envelope 统一验证，ViewApi domain 完全归 Plugin                              | **取舍**；vNext 更克制，但不再给 domain API 默认 schema 防线                                  |
| 类型与 runtime exactness | fingerprint + exact resource/binding + exact UI export                          | descriptor identity + exact flat binding + Manifest expose inventory              | **vNext 更诚实**；两者都无法反射 erased method shape，vNext 不再暗示 contract hash 能验证 API |
| owner lifecycle          | mount/resource/grant/artifact 绑定 generation effects；entered RPC 不统一 abort | publication/open root/child/observer 统一 owner gate、abort、drain                | **vNext 目标更强**，但实现风险也更高；必须用真实 withdrawal test 证明                         |
| artifact 更新            | custom Workbench bundle catalog + candidate setup + last-known-good             | standard MF Manifest/Snapshot + per-View Bridge expose + last-known-good revision | **vNext 边界更清楚**；current 的 staged/LKG 算法应保留                                        |
| UI 加载粒度              | 一个 Plugin UI module expose exact View map                                     | 一个 producer 下每个 View 一个 Bridge expose                                      | **vNext 可能更懒加载**，但 expose/manifest 数更多，最终 bundle 必须测量                       |
| transport 隔离           | HTTP request 与多个 SSE stream 可分别失败/排队                                  | 一条 ordered WS                                                                   | **current 有隔离优势，vNext 有连接/状态统一优势**；single-WS gate 决定是否可接受              |
| host freedom             | transport、resource facade 和现有 artifact wrapper 较容易分别替换               | closed Profile 1 concrete packages                                                | **vNext 有意放弃自由度**；换取单一 conformance matrix 和确定 lifecycle                        |
| platform-neutral Shell   | UI contract/browser facade 与 host state 已分离                                 | fixed WS/MF concrete packages，可由非 React Shell 组合                            | **两者都可平台中立**；中立不要求可替换 transport/loader                                       |
| disabled 成本            | 已验证 capability 不安装、backend 不创建                                        | 保持同一 zero-cost rule                                                           | **必须打平**；退化即否决 vNext                                                                |
| 迁移成本                 | 已实现且有测试                                                                  | 一次性切换，删除旧协议                                                            | **current 明显胜出**；vNext 必须靠 vertical fixtures 降低风险                                 |

## 可以声称与不能声称的效率

### 可以由结构直接推导

- Plugin-facing public noun、mapping 和重复 key 更少；
- layout/search/restore 不再创建 grant、API target、subscription 或 remote registration；
- Attachment 从 candidate scan 变成 committed direct edge lookup；
- 同一 page 的 dynamic API/auth/push 不再分别维护 HTTP batch session 与 SSE clients；
- 普通 API 直接使用 Cap’n Web 原生 promise/capability graph，不再经过 `WorkbenchRpcClient` method facade；
- dynamic row 数量不改变 View、producer、socket 或 publication inventory。

### 只能测量后声称

- 单 WS 下 control/mutation 的 p95/p99 latency 比 current 更低；
- 最大合法 snapshot 与 log/progress 并发时不会出现不可接受的 head-of-line blocking；
- per-View expose 的下载 bytes、首次打开时间和内存小于 current single UI module expose；
- opened View root/observer 的驻留内存小于 current grant + request-scoped target 总成本；
- bounded reread 的数据库/网络成本可以替代所有 current `liveQuery` patch 用例。

如果测量失败，先缩小 snapshot、分页、coalesce callback、修正 internal scheduler 或保留 `liveQuery` implementation helper；不能通过恢复第二条 socket、SSE、
public priority/channel 或 resource protocol 绕过 Profile 1。

## Current 成熟资产保留账本

这里保留的是已经被实现和测试证明的**语义与算法**，不是把旧 public API 原样搬进 vNext。

| Current 资产                                                                                                                   | 现有证据                                                                                                                                                                                                  | vNext 落点                                                                                                      | 明确不保留                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| React Context consumption、稳定 Context value、`useSyncExternalStore`                                                          | [`ui-runtime.tsx`](../../../packages/runtime/src/workbench/ui-runtime.tsx)、[`workbench-ui-runtime.test.tsx`](../../../packages/runtime/tests/web/workbench-ui-runtime.test.tsx)                          | generated Bridge wrapper 内部 Provider；descriptor-bound hook；动态 host snapshot 外部订阅                      | public Bridge props、raw Provider、transport Context                                    |
| exact UI export 与 runtime identity check                                                                                      | `createWorkbenchUi(contract).define()` 和 [`public-api.test.ts`](../../../packages/runtime/tests/workbench/public-api.test.ts)                                                                            | descriptor identity、exact flat binding、producer/build revision、exact expose inventory                        | Contract fingerprint 充当 API method hash、手写 component export map                    |
| owner effects、mount rollback、幂等 withdrawal                                                                                 | [`services/workbench.ts`](../../../packages/runtime/src/services/workbench.ts)、[`WorkbenchRegistry.ts`](../../../packages/runtime/src/services/workbench/WorkbenchRegistry.ts)                           | one atomic publication；opened View/root/observer 绑定 target/provider generation                               | 独立 resource/grant lifecycle 和 entered-call 不可取消语义                              |
| target retain、StrictMode effect replay 与 microtask release                                                                   | [`workbench/client.ts`](../../../packages/workbench-app/src/workbench/client.ts)、[`workbench-client.test.ts`](../../../packages/workbench-app/tests/workbench-client.test.ts)                            | one page session/MF owner；Bridge/opened View lease 幂等 replay 与 bounded cleanup                              | React effect 直接拥有 socket/artifact lifecycle                                         |
| candidate module setup、exact revision、last-known-good 原子替换                                                               | [`workbench/client.ts`](../../../packages/workbench-app/src/workbench/client.ts)、[`WorkbenchArtifactService.ts`](../../../packages/runtime/src/services/workbench/WorkbenchArtifactService.ts)           | candidate Manifest/expose/Bridge validation；成功后 revision swap；失败保留旧 renderer                          | Workbench-specific bundle manifest/loader                                               |
| canonical route、exact precedence、host-owned navigation/document/workspace                                                    | [`../../FRONTEND.md`](../../FRONTEND.md)、[`workbench/client.ts`](../../../packages/workbench-app/src/workbench/client.ts)                                                                                | server route rematch、fixed host facade、stable workspace owner                                                 | Shell router/store/Tab ID 暴露给 remote                                                 |
| Pane Kit 的窄 layout contract                                                                                                  | [`ui-pane.tsx`](../../../packages/runtime/src/workbench/ui-pane.tsx)                                                                                                                                      | 继续作为 Profile shared；host 负责 split/drawer/focus/persistence                                               | Worksplit handle、generic slot/layout registry                                          |
| `liveQuery` 的 stable params、revision/generation guard、invalidation coalescing、patch gap refresh、last-known-good 与 bounds | [`WorkbenchLiveQueryService.ts`](../../../packages/runtime/src/services/workbench/resources/WorkbenchLiveQueryService.ts)、[`ui-live-query.ts`](../../../packages/runtime/src/workbench/ui-live-query.ts) | 可选 server/client implementation helper，支撑 Plugin 自己声明的 `snapshot/list/watch`                          | Query resource address、schema registry、SSE wire kind、browser global variant registry |
| frozen reflection-safe record，不用 observable Proxy 表示 grant                                                                | [`ui-runtime.tsx`](../../../packages/runtime/src/workbench/ui-runtime.tsx)                                                                                                                                | host facade/hook result 保持 ordinary stable record；只有上游 `RpcStub` 使用 Cap’n Web 必需的 type-erased proxy | Workbench 自建 method/resource Proxy DSL                                                |
| platform boundary validation、stable error family 和 quota                                                                     | [`management-validation.ts`](../../../packages/runtime/src/web/management-validation.ts)、current live query bounds                                                                                       | 继续验证 auth/profile/identity/route/layout/build/lifecycle envelope 和 connection/frame/queue quota            | Workbench 统一解释 Plugin domain payload/error                                          |
| Workbench disabled zero cost                                                                                                   | [`public-api.test.ts`](../../../packages/runtime/tests/workbench/public-api.test.ts)、[`../../DESIGN_PRINCIPLES.md`](../../DESIGN_PRINCIPLES.md)                                                          | Management/Workbench plane install gate 和 structural allocation probe                                          | null stateful service 或隐藏 compiler/watcher                                           |

保留账本有三条执行规则：

1. 能直接延续的 public 产品语义继续延续，例如 Pane Kit、host-owned navigation、disabled zero cost；
2. 与旧 wire/public concept 绑定的成熟算法降为 internal/helper，例如 `liveQuery` patch 与 module staging；
3. 只保留“更灵活”但没有 current fixture 的能力不进入 vNext，例如 multiple placements、Port candidate discovery 和 transport fallback。

## Current 优势为何仍不迁移

### Port version 与 candidate discovery

它适合 provider/consumer 不共享 exact dependency graph、需要独立协商版本的系统。Pluxel current fixture 恰好相反：consumer constructor 已经持有 required provider，
Workbench 再用 string/version 扫描一次只会产生两个事实来源。vNext 用 package/profile version、exact descriptor 与 committed edge 取代 Port version。

### Standard Schema resource contract

它对公共 API gateway、不可信第三方 producer 和通用 query engine 很有价值。Workbench 是同源 installed Plugin coordination；强制 schema 会重复 Plugin 已有 domain
parser，也无法验证 `RpcTarget` 被擦除的方法集合。vNext 仍严格验证平台 envelope，并要求 mutation 在 Plugin domain boundary 保持授权和不变量。

### Multiple placements

Current 一个 View 可以声明多个 placement，真正同一页面出现在多处时更短。但 current fixture 没有证明该需求，placement index 还会进入 identity。vNext 要求两个
final View entries 复用普通 component/factory，使 route/document identity 显式；出现两个真实 fixture 后才能重新评估。

### Generic incremental list protocol

Current `liveQuery` 已证明 patch 算法有效，但它同时把 database table dependency、schema、variant key、SSE 和 browser cache 固化为 Workbench protocol。vNext 先采用
bounded domain page + invalidation/reread；只有实际带宽 gate 失败时复用算法 helper，不恢复 public Collection/Query resource kind。

### HTTP/SSE workload separation

Current 多条 transport path 可以把某些 failure/queue 隔离开。Profile 1 选择一条 WS 是为了统一 auth、authority、epoch 和 cleanup，不是因为隔离没有价值。它成立的
前提是 oversized result 提前拒绝、callback producer coalesce、bounded fair scheduling 和真实 proxy/carrier 压测全部通过。

## Cutover 审计问题

实施者在删除 current path 前必须逐项回答：

1. 一个 current workspace View 的 declaration、publication、renderer 是否确实更短，且没有隐藏生成第二套 mapping？
2. layout-only read 是否在 heap、server registry、socket trace 和 MF trace 中保持零 opened capability/remote？
3. current owner stop/replacement/rollback/StrictMode 测试是否有等价或更强的 vNext test？
4. current last-known-good artifact 失败场景是否已映射到 Manifest/expose/Bridge candidate swap？
5. current exact/parameterized route、host navigation、Pane Kit 和 workspace persistence 是否没有行为回退？
6. current `liveQuery` fixture 在 bounded reread 下的 bytes/DB cost 是否通过；未通过时 helper 是否仍没有 public resource identity？
7. single WS 同时承载最大合法 page、mutation、layout、log tail 和 progress 时，延迟与 queued bytes 是否有量化门槛？
8. Management/Workbench disabled 时 endpoint、auth backend、producer/compiler/watcher/client allocation 是否仍为零？
9. malformed platform envelope、stale revision、wrong descriptor/expose 和 withdrawn owner 是否在 Plugin API 调用前稳定失败？
10. 删除 Port/Contract/grant/SSE 后，是否仍有真实 fixture 无法由 View/Attachment/direct capability 表达？如果有，先记录具体失败，不添加猜测抽象。
