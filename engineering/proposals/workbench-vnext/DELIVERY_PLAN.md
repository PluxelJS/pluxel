# Workbench vNext delivery plan

> 本文负责真实样本、package boundary、实施顺序和整体验收。Normative contract 见
> [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md)、[`AUTHORING.md`](AUTHORING.md)、
> [`PUBLICATION.md`](PUBLICATION.md)、[`CONTROL_PLANE.md`](CONTROL_PLANE.md) 与
> [`FEDERATION.md`](FEDERATION.md)。

## 真实样本只验证两个 UI 声明

VNext 不从通用后台或微前端产品想象 API。每个 public abstraction 必须明显缩短真实调用点。

### Wretch

事实只有：consumer 选择 tab placement，Wretch provider 提供 consumer-bound settings API 与 renderer。目标：

- provider 定义一个 `SettingsViewApi`、一个 Attachment 与一个 Bridge expose；
- consumer definition 放置 Attachment，publication 绑定 constructor-injected provider handle；
- provider factory 只用 platform-issued `consumer.node` 关联现有 consumer-owned settings，不能取得 consumer Context/facade；
- 删除 Contract/Port resource map、alias/version、renderer mount 与 candidate scan。

### Fonts 与 Font contribution

三种页面共享同一个 direct-capability model：

- Fonts manager local ViewApi：`list/install/remove/default/watch`，拥有 font catalog、持久化与容量；
- 当前 Canvas/ECharts/Takumi provider-only Attachment：provider API 修改 provider-wide default；
- Font contribution fixture provider + consumer Attachment：provider API 列候选，optional consumer API 写 consumer-specific selection。

List row 不进入 platform。10,000 fonts 仍是一个 bounded `list()` API 的 rows，不是 10,000 个
resources/capabilities。

### BotManager

Telegram、KOOK、Milky、Discord 各自拥有 manager、persistence、connection lifecycle、ViewApi targets 与 publication。`platform-kit` 只提供：

- browser-safe BotAdmin TypeScript APIs/domain values；
- ordinary `defineBotManagerEntries()` TypeScript builder；
- server target helper 与 React Bridge panels。

每个平台只保留 Account/upsert TypeScript shape、domain projector/actions、labels/navigation、diagnostics renderer 与可选 Wretch Attachment。删除四份 route
topology、initial event emit glue、trivial wrapper 与 export map；不建立 Feature runtime entity 或中心 Bot hub。

### Repository coverage matrix

这份提案必须区分当前 workspace 事实与 future fixture，不能用假想案例证明抽象：

| Evidence                               | vNext mapping                                      | 必须证明的边界                                       |
| -------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| PackageManager current local renderer  | local View + snapshot/list/mutations               | 不经 Attachment/Collection，关闭时无残留 observer    |
| Wretch current provider UI/API         | consumer-bound provider-only Attachment            | exact consumer state、consumer 只给 placement/handle |
| Fonts current manager                  | local manager View                                 | paged rows/task/file ticket，不建立 per-font target  |
| Canvas/Takumi/ECharts font consumers   | provider-only Attachment                           | consumer-owned placement 不产生自己的 producer       |
| parameterized Account document fixture | one routed View，多次 `openView()`                 | server rematch params、dirty/title cleanup           |
| current runtime `liveQuery` tests      | server helper backing direct `snapshot/list/watch` | 不恢复 Query resource/wire protocol                  |
| BotManager proposal evidence           | ordinary TS builder fixture                        | 明确标为 fixture；当前 workspace 无 chatbot source   |

其中任何一行如果需要新 platform noun，必须先记录 direct capability 失败的具体调用点和 lifecycle，不以“未来可能复用”为理由扩张设计。

## Current 成熟资产保留 gate

[`CURRENT_COMPARISON.md`](CURRENT_COMPARISON.md) 是 current/vNext 取舍和保留账本的唯一说明。Cutover 不是把 current 全部删除后重新发明；以下
语义必须有等价或更强的 vertical proof：

| Current 成熟资产                                  | vNext 必须提交的 proof                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| React Context、稳定 value、`useSyncExternalStore` | generated wrapper/descriptor hook 的 tear-free、wrong-descriptor 和 StrictMode tests                             |
| owner effects、mount rollback、grant withdrawal   | publication/opened root 在 stop/replacement/rollback/late resolve 后 bounded cleanup                             |
| target retain 与 StrictMode microtask replay      | replay 不重复 socket、MF registration、factory、Bridge 或 subscription                                           |
| candidate module setup 与 last-known-good         | Manifest/expose/shared/Bridge 任一步失败保留上一完整 revision，不能恢复 withdrawn authority                      |
| canonical route 与 host-owned workspace           | exact/parameterized precedence、server rematch、dirty/title、Pane Kit 和 workspace persistence tests             |
| `liveQuery` coalescing/revision/gap/LKG 算法      | 至少一个 fixture 以 internal helper 支撑 direct `snapshot/list/watch`，或用测量证明可以删除                      |
| frozen reflection-safe host record                | host facade 对未知属性返回普通 `undefined`，不引入 Workbench Proxy DSL                                           |
| platform input validation 与 quota                | auth/profile/identity/route/layout/build/lifecycle envelope、frame/queue/in-flight bounds 的 hostile-input tests |
| disabled zero cost                                | endpoint/auth backend/producer/compiler/watcher/client allocation 全部为零                                       |

这些 proof 只继承语义和算法，不恢复 Contract/resource/Port/grant/SSE/custom artifact public path。任一成熟资产没有落点时，Slice F 不得删除 current
implementation。

## 常见交互 coverage gate

Vertical fixtures 必须用 direct ViewApi 覆盖：

| 情境                   | Fixture                                              |
| ---------------------- | ---------------------------------------------------- |
| read/update settings   | Wretch snapshot/update/reset                         |
| live state             | Bot status snapshot + observer invalidation          |
| paged CRUD             | Fonts/Bot `list/get/create/update/remove`            |
| object document        | Bot account child capability 或 bounded get          |
| parameterized document | Account route rematch + independent opened roots     |
| logs/events            | historical list + callback/stream                    |
| long operation         | font install/rebuild TaskTarget + cancel/progress    |
| file transfer          | single-use HTTP upload/download ticket               |
| dirty/title            | fixed `host.document` + destroy cleanup              |
| foreign provider UI    | Wretch/Fonts Attachment                              |
| consumer-owned choice  | Font provider API + consumer selection API           |
| multi-page reuse       | four BotManager definitions from ordinary TS builder |

如果其中某项必须引入新的 Workbench resource kind，先证明 direct declared capability 为什么不能诚实表达；不能只因希望生成 hook 而扩张 wire protocol。

## Logical package boundaries

先冻结 import/lifecycle boundary，不要求第一天拆 npm package：

| Entry                          | 责任                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `runtime/capnweb`              | pinned `RpcTarget`/`RpcStub`/`RpcPromise`/stream/dispose re-export；不增加 RPC DSL                  |
| `runtime/web/session`          | WS-required Cap’n Web auth/control owner、typed Management projection                               |
| `runtime/workbench`            | browser-safe `define/view/attachment/entry/tab/route` 与 phantom API descriptors                    |
| Plugin `ctx.workbench`         | server-only exact target factories、required Attachment binding、atomic `publish()`                 |
| `runtime/workbench/client`     | local opened View handle、optional `createRemoteValue()`、transfer；不建 socket/MF/domain validator |
| `runtime/workbench/react`      | named `useWorkbench`/`useRemoteValue` hooks 与 Pane Kit；不导出 Bridge props/provider               |
| `runtime/workbench/federation` | one MF host、Runtime Plugin、opened View/Bridge orchestration                                       |
| `@pluxel/core/federation`      | producer/host shared policy、manifest/build facts                                                   |

Dependency rules：

- browser-safe API types/definition 只 import side-effect-free `runtime/workbench` declarations，不 import React、Plugin、Context、Node builtin 或 MF Runtime；
- `runtime/capnweb` 只固定平台使用的 Cap’n Web runtime identity/version，不包装 method schema 或生成 validator；
- `runtime/web/session` 不 import React/MF，也不定义 generic transport adapter；
- `client` 不创建 socket、不加载 remote、不持有 page root；
- `react` 不 import official router/store/Worksplit；
- definition 同时被 Node Plugin 与 remote renderer import，因此 `runtime/workbench` root 必须保持 browser-safe；server implementation 只从 Plugin
  Context 暴露 `ctx.workbench.publish()`；
- `federation` 是唯一 concrete MF host integration，只依赖 MF Runtime、Bridge/DOM 和 session client；
- OIDC/cookie commit 留在 narrow HTTP auth entry，其他 authentication/session state 属于 Cap’n Web；
- business files 只用 capability-signed HTTP ticket，不引入第二 dynamic API transport。
- `client` 的 View handle 只拥有 `openView()` 直接返回的 roots；wire 上没有额外 `ViewSessionTarget.api()`。

## Implementation slices

切片按风险降序排列，每片必须是 vertical proof。

### Slice 0：freeze closed Profile 1

冻结 single profile、concrete packages 与 conformance inventory。删除 replaceable host/renderer/transport 方向，并明确
Model/Query/Channel/Collection/Feature 不成为 vNext runtime protocol。

### Slice A：WS auth + native Cap’n Web foundation

- `/__pluxel/runtime/session` 与唯一 browser session owner；
- pre-auth root、same-origin/secure admission、provider/principal lease 与 quota；
- password/TOTP/WebAuthn/provider challenge、same-socket capability transfer、cookie/OIDC handoff；
- pinned `RpcTarget`、callback/observer、child target、stream 与 dispose primitive；不增加 capability/schema DSL；
- API/type probes 直接使用上游 `RpcStub<Api>`/`RpcPromise<T>`，type/build 与 serializer tests 拒绝不兼容 browser/server values；
- Management query/mutation、logout 与 callback 全部走同一 object graph；
- platform-owned bootstrap/auth/open/layout envelope 防御性解析，Plugin API payload 保持 opaque；
- Node production、static/dynamic Vite、standalone `ws: true` proxy 和 production proxy real-socket tests；
- HMR/control/business WS arbitration、`1012` drain 与 forced settlement。
- bounded message/callback queue 与 internal fair scheduling probe；oversized snapshot fail，file bytes 不进 Cap’n Web frame。

没有 HTTP access-state/domain API、HTTP batch、SSE、polling、fallback 或 transport abstraction。

### Slice B：MF + direct ViewApi foundation

- one Shell/one MF Runtime；
- official Shell 与 non-React external Shell fixture 消费相同 concrete packages；
- definition -> producer、View -> Bridge expose；
- flat definition/publication record、single placement、module-relative `workbench.entry()` 与 descriptor-bound React Context hook；
- generated Bridge wrapper 独占 props/provider，Plugin 默认 export 是零 props component；
- `openView()` 一次返回 direct typed ViewApi root(s)、server-derived params 与 federation ref，不经过 resource/grant/session lookup 或第二次 RPC；
- sync/async factory 都在 opened-view signal/deadline 内全有或全无，late resolve target 必须 dispose；
- standard Manifest/Snapshot、fixed shared、trusted Runtime Plugin 与 Bridge destroy；
- isolated bounded parallel Vite/MF producer builds。

### Slice C：local View recipes

用 PackageManager、Fonts manager 与 parameterized Account fixture 迁移 settings/live/CRUD/task/file/document recipes。只提供 optional
`createRemoteValue(read/subscribe)` client helper，不发布 Model/Query/Channel server contract。Helper 必须先 subscribe 后 initial read，合并 read
期间 invalidation，最多一个 active read，并用 epoch guard 阻止 stale result 覆盖。证明 fresh epoch re-open、platform envelope validation、
Plugin-owned domain validation、child target cleanup、bounded page read、server-derived params、dirty/title cleanup 与 signed transfer。至少一个 fixture
直接委托已有 domain service/parser，证明 Workbench 不需要读取 schema；另一个 cooperative read-only fixture 可以有意不增加重复 validator。

现有 database/runtime `liveQuery` 若保留，只能成为可选 server implementation helper：把 revision/invalidation/coalescing 接到 Plugin 自己声明的
`snapshot/list/watch`，不生成 Query address、browser client、registry、resume/replay 或新的 wire shape。至少迁移一个现有 test/call site 证明 helper
确实减少重复代码；否则直接删除 helper。

### Slice D：Attachment

迁移 Wretch、provider-only Fonts selector 与 provider+consumer Font fixture。只支持 committed direct required dependency + tab placement，证明：

- provider/optional consumer API generic 在 TypeScript 中一致；
- consumer/provider edge validation，Wretch provider factory 得到 exact node address 但没有 Context/service locator；
- joint withdrawal；
- attachment-only consumer 不产生 producer；
- no scan/Port/resource map/alias/fallback。

### Slice E：Bot TypeScript composition

用普通 `defineBotManagerEntries()` 生成四个平台 final View records。证明一致 navigation group 只是 final route 的 by-value metadata，group
label/icon conflict 在 publication 时确定拒绝；没有 Feature/group identity、registry、protocol、lease 或额外 artifact，每个平台仍独立
publication/failure/withdrawal。

### Slice F：one-time cutover

全部 workspace producer 迁移后一次删除：

- Cap’n Web HTTP batch、全部 Management/Workbench SSE、`EventSource` 与 `text/event-stream` glue；
- resource-oriented Contract/Extension/Port authoring 与 RPC/liveQuery/events wiring；
- custom artifact manifest/loader 与 ad-hoc federation wrapper；
- compatibility alias、protocol negotiation、旧 session path 和长期双栈。

把稳定事实写回 `WORKBENCH.md`、`FRONTEND.md`、`TOOLCHAIN.md` 与 user docs；public package user-visible change 添加 Tegami pending
changelog。

## Structural probes

1. 1/10/100/1000 targets，每个 1/4/16 Views；layout-only read 的 opened-view lease/API/remote allocation 始终为 0；
2. 打开 local View 只增加一个 API root；Attachment 只增加 provider + optional consumer root；wire inventory 没有 session/resource 中间 target；
3. 打开 1/10/100 Views 仍只有一个 control WS 和一个 MF Runtime；
4. force-close socket 后 child targets、observers、tasks、provider/principal leases 在 bounded time 归零；
5. 1/100/10,000 rows 只改变 bounded page result，layout/remote/socket/API root 数不变；
6. 未打开 View 不请求 manifest/expose、不调用 target factory；
7. same domain service 可以在 implementation 内共享 backend，但不同 consumer mutable authority 不被 framework 合并；
8. one Shell + three remotes 只有一个 React/ReactDOM winner；
9. Workbench disabled + Management absent 时 endpoint/producer/compiler/watcher/client allocation 为 0；
10. four BotManager builders 不增加 runtime registry、protocol kind、network request 或 persistent identity；
11. initial read 期间连续 invalidation 只触发一次随后 reread，旧 read/旧 epoch result 永远不能覆盖新 snapshot；
12. async local/Attachment factory reject、timeout、withdrawal 与 late resolve 后，target/lease/root 在 bounded time 归零；
13. exact route 优先 parameterized route；ambiguous parameterized patterns 与 navigation group label/icon conflict 原子拒绝。
14. flat binding 缺 key、多 key、错误 descriptor kind 与 reserved definition key 在 publication 前拒绝；不存在 nested `views/attachments` fallback；
15. wrong descriptor/expose 调用 `useWorkbench()` 在任何 Plugin API invocation 前 fail-fast；provider-only Attachment 的类型与 runtime value 都没有
    `consumer` property；
16. renderer module public export 是零 props component，bundle/import inventory 不出现 public Bridge props/provider 或 server-only
    `runtime/workbench` dependency。

## Single-WS performance gates

单连接是硬契约，因此实现必须用边界和测量证明它，而不是假设后台流量永远很小：

1. 同时运行 layout/open/mutation、最大合法 page、log tail 与 task progress；control/mutation latency 和 total queued bytes 在固定门槛内；
2. invalidation/progress burst 在 producer 侧 coalesce，log overflow 以 API 声明的 gap/termination 表达，任何 callback queue 都不无界增长；
3. 超过 message ceiling 的 snapshot/result 在发送前稳定失败，并要求 pagination 或 signed download ticket；
4. upload/download/archive bytes 的 network trace 不出现于 Cap’n Web frames；
5. 连接关闭或 consumer stall 后 callback/stream/task queue 在 bounded time 归零；
6. runtime 内部 scheduler 可以调整，但 public API 不出现 priority、lane、channel 或第二 control socket。

## Release acceptance

| Gate        | 必须同时成立                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- |
| Profile     | platform-neutral Shell；MF2 + WS mandatory；single version；no replaceable SPI/config freedom |
| Authoring   | View/Attachment + native interface/RpcTarget/RpcStub；all common recipes covered              |
| Publication | one atomic publish；layout read zero API；one-result exact `openView()`                       |
| Transport   | one WS；auth + dynamic API/push；bounded fairness；no SSE/fallback/resume                     |
| Federation  | one MF Runtime；Manifest/expose/Bridge；fixed shared；bounded build                           |
| Migration   | old HTTP batch/SSE/resource-oriented Contract/Port paths deleted；docs/changelogs complete    |

## Global veto conditions

- 为 snapshot/list/event/progress 分别创建 Workbench runtime registry/protocol kind；
- author/server/browser 同一方法仍需 resource token、namespace、grant 与 export 多重 mapping；
- TS composition/Attachment/MF remote 获得与 Plugin graph 平行的 lifecycle；
- layout 携带 callable capability，或 Remote View 创建第二个 socket/root session；
- `openView()` 返回额外 session/resource target 或让 browser 注入 principal/params；
- Workbench 强迫 ViewApi 声明 schema、method descriptor、contract hash、generated validator 或统一 domain error；
- platform-owned control envelope、connection/frame/in-flight/callback queue 没有有界 admission；
- collection/account row 获得 View/capability/MF identity；
- Attachment 接受 arbitrary resources、字符串 provider、scan、priority 或 fallback；
- consumer identity 暴露 Context/consumer instance/service locator，或 navigation group 获得独立 registry/lifecycle；
- remote 依赖 Shell private router/store/Worksplit；
- 保留 HTTP batch、SSE、polling、HTTP login/domain API、fallback 或旧 session resume；
- 在 MF Manifest 外建立 artifact manifest/loader/share resolver；
- public abstraction 没有让 Wretch、Fonts、BotManager 调用点明显变短。

## Prototype questions

只有以下 implementation detail 可以由 fixture 冻结；它们不能增加 platform concepts：

1. `View<Api>` / `Attachment<ProviderApi, ConsumerApi = never>` 如何以最少 conditional types 连接 flat binding record、`RpcTarget & Api` factory 与
   descriptor-bound `RpcStub<Api>` hook projection；
2. `createRemoteValue()` 如何在不增加 server contract 的前提下实现 subscribe-before-read、single-flight、epoch guard 与 React tear-free snapshot；
3. sync/async API factory 返回共享 backing 时，direct root wrapper/internal lease 如何维持每次 open 的 admission/cleanup，并回收 late resolve；
4. action 返回 TaskTarget 与接受 progress observer 哪个 recipe 在真实样本中更短；
5. immutable manifest/signature 与 last-known-good Bridge registration 如何组合；
6. Host control matcher 如何与 Vite HMR/business WS 共用 listener；
7. password/TOTP/WebAuthn/OIDC challenge exact schema 与 cookie handoff；
8. current `liveQuery` 如何只作为 server implementation helper backing `snapshot/list/watch`，或是否应直接删除；
9. Cap’n Web single-WS scheduler/message ceiling 在最大合法 page + callbacks 下的量化门槛。
