# Workbench vNext delivery plan

> 本文是重构顺序、保留资产和验收 gate。实现不得通过兼容层放宽
> [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md)。

## Landing rules

1. 每个 slice 必须交付一个可运行 vertical fixture、owner cleanup tests 和 production-like integration test；
2. 先建立 vNext path，再一次性切换 workspace producers；不长期运行两个 public profiles；
3. 迁移现有语义与成熟算法，不迁移旧 Contract/Port/grant/SSE/custom artifact public concepts；
4. 新 public noun 必须先证明 `View`、`Attachment`、direct capability 与 by-value data 无法表达真实 fixture；
5. 每个 slice 稳定后把事实写回 `engineering/` 与 `docs/`；用户可见 public package 变化添加 Tegami
   pending changelog。

## Logical package boundaries

先冻结 import/lifecycle boundary，不要求第一天拆成独立 npm packages：

| Entry                          | 责任                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `runtime/capnweb`              | pinned `RpcTarget`/`RpcStub`/`RpcPromise`/stream/dispose re-export；无 RPC DSL            |
| `runtime/web/session`          | WS-only Cap’n Web auth/control owner、bootstrap、epoch 与 typed Management projection     |
| `runtime/workbench`            | browser-safe `define/view/attachment/entry/tab/route` 与 phantom descriptors              |
| Plugin `ctx.workbench`         | server-only factories、required Attachment binding 与 atomic `publish()`                  |
| `runtime/workbench/client`     | opened handle、remote-value/transfer helper；不创建 socket、不加载 remote                 |
| `runtime/workbench/react`      | `useWorkbench`/`useRemoteValue`、host facade 与 Pane Kit；无 public Provider/Bridge props |
| `runtime/workbench/federation` | one MF Runtime、fixed Runtime Plugin、remote registration 与 Bridge orchestration         |
| `@pluxel/core/federation`      | producer config、manifest/build identity、fixed shared policy                             |

Dependency rules：

- `runtime/workbench` 根入口无 React、Plugin Context、Node builtin、MF Runtime 和 side effect；
- browser-safe API/definition 只能 import browser-safe Cap’n Web/value types；
- `runtime/web/session` 不 import React/MF，不定义 generic transport adapter；
- `client` 不持有 page session root；opened handle 只持有 `openView()` 返回的 direct roots；
- `react` 不 import official Shell router/store/Worksplit；
- `federation` 是唯一 host MF integration；Plugin 和 Shell 不注册自己的 Runtime Plugin/share policy；
- server publication 只从 Plugin instance 的 `ctx.workbench.publish()` 暴露；
- OIDC/cookie commit 与 signed file transfer 保留 narrow HTTP entry，不成为第二 dynamic API transport。

## Required fixtures

| Fixture                        | 必须覆盖                                                       | 不得出现                                   |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------ |
| PackageManager/settings        | local View、snapshot/update/watch、zero props renderer         | Contract/resource/client facade            |
| FontManager                    | bounded list/by-ID CRUD、create returns snapshot、task/file    | collection resource、per-row root          |
| Font collection consumer       | provider catalog + consumer selection、missing/fallback        | duplicate provider watch、provider scan    |
| Wretch managed settings        | provider-only Attachment、exact `consumer.node`                | consumer Context/facade、optional provider |
| Parameterized account document | server route rematch、independent roots、dirty/title cleanup   | browser-supplied params、per-account View  |
| Diagnostics                    | history/live tail、task cancel/progress、signed download       | SSE、unbounded callback queue              |
| BotManager                     | ordinary TS topology helper、explicit per-platform publication | Feature/Bot hub/account publication        |
| PluginPart composition         | owning Plugin 聚合静态 entries/bindings 并一次 publish         | Part owner、Part publication/producer      |
| Non-React Shell                | same built producer + same concrete host packages              | alternate loader/session/renderer adapter  |

FontManager 的唯一 vertical truth 是
[`FONT_COLLECTION_EXAMPLE.md`](FONT_COLLECTION_EXAMPLE.md)。通用调用面见
[`EXAMPLES.md`](EXAMPLES.md)，不要在 fixture 中再发明另一套 authoring shape。

## Current asset preservation gates

Cutover 前，下列已成熟语义必须有等价或更强 proof：

| Current asset                                       | vNext landing requirement                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| React Context、stable value、`useSyncExternalStore` | generated wrapper/descriptor hook 的 tear-free、wrong-descriptor、unknown-property 和 StrictMode tests   |
| owner effects、mount rollback、withdrawal           | publication/opened root 在 stop、replacement、rollback、factory timeout/late resolve 后 bounded cleanup  |
| target retain 与 StrictMode microtask replay        | replay 不重复 socket、MF registration、factory、Bridge 或 subscription                                   |
| PluginPart owner aggregation                        | reachable Part entry 归 owning Plugin definition/generation；Part 不独立 publish 或拥有 producer         |
| candidate module staging 与 atomic activation       | failed build 不进入 inventory；dev commit 后整页重载；pinned revision 失败不回退旧 artifact              |
| canonical route 与 host-owned workspace             | exact/parameterized precedence、server rematch、dirty/title、Pane Kit 与 workspace persistence tests     |
| `liveQuery` coalescing/revision/gap/last snapshot   | 作为 optional internal helper 支撑 Plugin-declared `snapshot/list/watch`，或以测量证明可删除             |
| frozen reflection-safe host record                  | ordinary record 未知属性返回 `undefined`；不建立 Workbench observable Proxy                              |
| platform validation/quota                           | auth/profile/identity/route/layout/build/lifecycle envelope 与 frame/queue/in-flight hostile-input tests |
| disabled zero cost                                  | endpoint/auth backend/producer/compiler/watcher/client allocation 全部为零                               |

现有证据入口：

- [`packages/runtime/src/workbench/ui-runtime.tsx`](../../../packages/runtime/src/workbench/ui-runtime.tsx)
  与 [`workbench-ui-runtime.test.tsx`](../../../packages/runtime/tests/web/workbench-ui-runtime.test.tsx)；
- [`packages/runtime/src/services/workbench.ts`](../../../packages/runtime/src/services/workbench.ts)
  与 [`WorkbenchRegistry.ts`](../../../packages/runtime/src/services/workbench/WorkbenchRegistry.ts)；
- [`packages/workbench-app/src/workbench/client.ts`](../../../packages/workbench-app/src/workbench/client.ts)
  与 [`workbench-client.test.ts`](../../../packages/workbench-app/tests/workbench-client.test.ts)；
- [`WorkbenchArtifactService.ts`](../../../packages/runtime/src/services/workbench/WorkbenchArtifactService.ts)；
- [`WorkbenchLiveQueryService.ts`](../../../packages/runtime/src/services/workbench/resources/WorkbenchLiveQueryService.ts)
  与 [`ui-live-query.ts`](../../../packages/runtime/src/workbench/ui-live-query.ts)；
- [`ui-pane.tsx`](../../../packages/runtime/src/workbench/ui-pane.tsx) 与
  [`management-validation.ts`](../../../packages/runtime/src/web/management-validation.ts)。

保留的是 lifecycle、rollback、coalescing、revision/last-success guard 和 boundary hardening。它们可以降为
internal helper；不得重新暴露 resource address、schema registry、SSE variant 或 custom artifact loader。

## Implementation slices

### Slice 0: contract and type probes

交付：

- frozen Profile 1 constants 与 package dependency rules；
- `View<Api extends RpcTarget>`、`Attachment<ProviderApi extends RpcTarget, ConsumerApi extends RpcTarget = never>`、flat `define()` 和 exact mapped binding types；
- `Api extends RpcTarget`、natural target return -> upstream `RpcStub<Api>` projection，以及 object-result/disposal-only subscription type probes；
- View/Attachment declaration identity 在 server lowering、producer wrapper 中一致；consumer placement 精确嵌入 provider identity；
- PluginPart/shared helper 只生成普通 record；reachable entry lowering 到 owning Plugin，Part 没有 publication/producer identity；
- browser-safe Cap’n Web value/type probes；
- descriptor-bound hook projection type tests；provider-only record 精确省略 `consumer`；
- code inventory gate，拒绝新增 Model/Query/Channel/Collection/Feature/Port/grant public kind。

Exit gate：public surface 能编译 canonical examples，且没有 transport/loader/renderer config。

### Slice A: WS auth and Cap’n Web foundation

交付：

- `/__pluxel/runtime/session` 与每 document 唯一 session owner/唯一 `newWebSocketRpcSession()` call；
- pre-auth root、password/TOTP/WebAuthn/provider challenge、same-socket principal capability transfer；
- OIDC/cookie narrow handoff、logout、principal/provider revocation；
- Management query/mutation/callback 与 Workbench bootstrap/open envelope；
- callback/observer/child target/stream/dispose，message/frame/queue/in-flight quotas；
- Node production、owned Vite、frontend proxy `ws: true` 与 supported reverse proxy real-socket tests；
- Vite HMR/control/business upgrade arbitration、heartbeat、drain、`1012` restart 与 forced settlement；
- ready 后 disconnect 的完整 teardown + 每 history entry 单次 disconnect-reload budget，以及 initial/repeated failure 的硬失败页；
- bootstrap/domain retained callback `dup()`/dispose、subscription target disposal 与 callback/stream/task bounded cleanup。

Exit gate：route/code inventory 不存在 Management/Workbench HTTP batch、SSE、EventSource、polling、resume
或 fallback；同一 document 不 reconnect，disconnect 后 capability graph 在 deadline 内归零。

### Slice B: MF and direct View foundation

交付：

- 每 page 一个 MF Runtime 与 fixed trusted Runtime Plugin/shared policy；
- `workbench.entry()` -> isolated Vite/MF producer -> standard Manifest/Snapshot -> exact Bridge expose；
- flat publication、capability-free layout 与 `openView()` direct root(s)/params/federation ref；
- closed `OpenViewResult` codes 与 malformed/programming/transport rejection boundary；
- generated Bridge wrapper、zero props entry、descriptor Context 与 host facade；
- sync/async factory atomic admission、timeout/withdrawal/late-resolve disposal；
- candidate revision staging、pinned-revision no-fallback、dev full reload 与 destroy-before-result-dispose；
- generation/publication/descriptor/build/roots/Bridge atomic activation tuple，不允许跨 tuple 混接；
- official Shell 和 non-React Shell 使用同一 producer/concrete packages。

Exit gate：未打开 View 的 factory/subscription/manifest/expose allocation 为零；one page/one MF Runtime、
React/ReactDOM single winner 与 wrong-descriptor fail-fast 均有 runtime proof。

### Slice C: local View recipes

迁移 PackageManager、FontManager、Diagnostics 和 parameterized Account fixture：

- snapshot/mutation/watch、bounded page/by-ID CRUD；
- `createRemoteValue` subscribe-before-read、coalescing、sequence/epoch guard 与 cleanup；
- subscription 只 dispose child stub/RpcPromise；server disposer 取消 observer 并释放 retained callback；
- Font collection create returns complete snapshot，update 返回 actionable invalid IDs；
- task capability、producer-side progress coalescing、signed transfer ticket；
- server-derived params、dirty/title/transfer destroy cleanup；
- Plugin-owned domain validation 与 platform envelope validation 分离。

Exit gate：1/100/10,000 rows 只改变 page result；root/View/route/expose/socket inventory 不变。

现有 `liveQuery` 只能作为 optional implementation helper 接到 Plugin 自己声明的
`snapshot/list/watch`。至少迁移一个 current test/call site 证明 helper 确实减少重复；否则删除。

### Slice D: Attachment

迁移 Wretch、provider-only Font selection 与 provider+consumer Font collection picker：

- exact committed required edge；
- provider factory 只获得 `consumer.node`；
- provider + optional consumer generic/runtime shape 一致；
- picker provider catalog 与 consumer selection 各一个 subscription；
- provider delete 后 projection 为 `missing`，不自动改写 consumer state；
- provider/consumer/opened View joint withdrawal；
- attachment-only consumer 不产生 MF producer。

Exit gate：runtime/code inventory 不存在 provider scan、Port/resource map、alias、priority、fallback、
consumer Context escape hatch 或 duplicate provider subscription。

### Slice E: BotManager source composition

用 ordinary TS helper 生成 Telegram/KOOK/Milky/Discord final View entries，publication 保持各平台显式。
共享 navigation group 只展开为 final route metadata，conflict 在 publication 前拒绝。

Exit gate：四个平台仍有独立 owner/failure/withdrawal；helper 不增加 registry、protocol kind、network
request、persistent identity 或中心 BotManager Plugin。

### Slice F: one-time cutover

所有 workspace producers 通过前述 gates 后一次删除：

- Cap’n Web HTTP batch、Management/Workbench SSE、`EventSource` 与 `text/event-stream` glue；
- Contract/Extension/Port/resource/grant authoring 与 RPC/liveQuery browser wiring；
- Workbench-specific artifact manifest/loader、ad-hoc federation wrapper 与 public Bridge props；
- compatibility aliases、protocol negotiation、旧 session path 和长期双栈 flags。

随后更新 `WORKBENCH.md`、`FRONTEND.md`、`TOOLCHAIN.md`、相关 domain docs 与 user docs。

Exit gate：repository route/import/export/config inventory 只剩 Profile 1；所有 current preservation gate
有对应 test/measurement。

## Structural conformance

必须自动化验证：

1. 1/10/100/1000 targets、每个 1/4/16 entries；layout read 的 API root/lease/remote allocation 始终为 0；
2. local View 打开只增加一个 root；Attachment 只增加 provider + optional consumer roots；
3. 同时打开 1/10/100 Views 仍只有一个 control WS 与一个 MF Runtime；
4. socket force-close 后 roots、observers、tasks、provider/principal leases 在 deadline 内归零；
5. unopen View 不调用 factory、不注册 manifest、不请求 expose；
6. async factory reject、timeout、withdrawal、late resolve 后没有 partial root/publication；
7. 每个 accepted factory call 返回 fresh root wrapper；同一 target instance 重复作为 Workbench root export 时在 transfer 前拒绝；
8. exact route 优先；ambiguous parameterized patterns 与 navigation group metadata conflict 原子拒绝；
9. flat binding missing/extra/wrong-kind/reserved keys 在 publication 前拒绝；
10. server/producer/wrapper 对 declaration identity 产生相同结果，consumer placement 精确匹配 nested provider identity；rename 改变 identity，source path/chunk hash 不参与；
11. wrong descriptor/expose 在任何 Plugin API call 前失败；renderer public export 是零 props component；
12. `openView()` 每种 closed failure 返回零 root，且 raw result 立即 dispose；success handle 只拥有一个顶层 result disposer；malformed/programming/transport failure 仍 reject；
13. failed artifact candidate 不替换 inventory；pinned revision 失败不加载旧 artifact；dev commit 后整页重载；
14. ready socket break 后 teardown；同一 document 的 session constructor 调用数恒为 1，同一 history entry 的 disconnect reload 不超过 1；
15. retained-callback fixture 必须先 `dup()`，每次 callback result 必须 await/dispose；subscription dispose 后 observer 与 callback imports 归零；
16. generation 内尝试 conditional entry、append/remove 或 second publish 原子拒绝；
17. StrictMode replay 不重复 socket、runtime、factory、Bridge、subscription 或 transfer；
18. disabled Workbench/Management 的 server/browser/toolchain allocation 为零。

## Single-WS performance gates

Profile 1 必须在 production carrier 与 proxy 上测量：

1. layout/open/mutation、最大合法 page、log tail 与 task progress 并发时，control/mutation p95/p99、
   queued bytes 与 heap 驻留低于 release threshold；
2. invalidation/progress burst 被 coalesce，log overflow 以 domain gap/termination 表达，queue 不无界增长；
3. oversized snapshot/result 在发送前稳定失败，并要求 pagination 或 signed transfer；
4. upload/download/archive bytes 的 network trace 不出现在 Cap’n Web frames；
5. consumer stall、View close 和 socket close 后 callback/stream/task queue 在 deadline 内归零；
6. internal scheduler 可调，但 public API 不出现 priority、lane、channel 或第二 control socket。

Threshold 数值必须与 benchmark fixture 一起提交并进入 CI/release dashboard，不能只记录手工观察。

## Release gate

切换只有在以下条件同时成立时进行：

- 全部 required fixtures 通过 functional、lifecycle、hostile-input 与 real-carrier tests；
- official + non-React Shell conformance，one control WS/one MF Runtime 和 MF shared winner 有可观测证据；
- current preservation table 每项有新 test、明确 internal landing 或测量支持的删除决定；
- Profile 1 route/config/import inventory 没有 HTTP/SSE/old artifact/Contract/Port fallback；
- 文档和 changelog 已反映最终 public behavior；
- rollback 单位是完整 deployment/profile revision，不在同一 page 恢复双栈。
