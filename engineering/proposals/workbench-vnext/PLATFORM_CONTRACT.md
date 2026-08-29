# Closed Workbench platform contract

> 本文是 Workbench vNext 的最高优先级 contract。其他主题文档只能细化，不能替换、降级或增加 profile freedom。
> 文中“必须/不得”是 cutover gate，不是默认建议。

## 一个 profile，不是两个可插拔子系统

Workbench vNext 只有一个受支持 profile：

```text
Pluxel Workbench Profile 1
  = MF 2.0 Runtime + Manifest/Snapshot + host Runtime Plugin + React Bridge
  + Cap'n Web over one same-origin WebSocket
  + Pluxel Plugin graph + atomic publication + opened-View withdrawal
```

MF 2.0 与 Cap’n Web/WS 是同级、不可拆分的 platform ABI：

- MF 2.0 不是 artifact loader implementation detail；
- WebSocket 不是 Control Plane transport option；
- Cap’n Web capability 不是可以换成 REST DTO 的 SDK facade；
- Bridge 不是可以换成 local React component import 的 renderer adapter；
- Plugin graph/publication 不是 MF remote registry 的附属 metadata。

缺少其中任一项的 browser host、carrier、proxy 或 Plugin artifact 都不是 degraded Workbench，而是不支持 vNext。

## Profile 1 固定选择

| Boundary             | Profile 1 唯一选择                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Shell                | 任意 conforming browser Shell；official Shell 是 reference implementation                       |
| Origin               | Shell、control socket 与 protected artifacts same-origin                                        |
| Control endpoint     | `/__pluxel/runtime/session`                                                                     |
| Dynamic transport    | Cap’n Web over WebSocket only                                                                   |
| Connection topology  | 每 page 同时恰好一个 host-owned control session                                                 |
| Platform push        | Cap’n Web callback/stream over the same session；无 SSE/EventSource                             |
| Authentication       | pre-auth Cap’n Web capability -> same-socket principal capability transfer                      |
| HTTP auth exceptions | OIDC navigation/callback 与 single-use HttpOnly cookie commit                                   |
| Disconnect           | 结束整个 epoch；fresh bootstrap/read；不 resume/replay/transparent retry                        |
| Artifact protocol    | standard MF 2.0 `mf-manifest.json`/Snapshot only                                                |
| Browser module host  | 每个 conforming Shell 拥有单个 `ModuleFederation` instance                                      |
| Host policy          | Pluxel-owned fixed Runtime Plugin + fixed shared policy                                         |
| Producer compiler    | host-owned Vite + MF 2.0 Vite plugin；每 producer 在 isolated worker/process build              |
| Mandatory shared     | React/ReactDOM、MF React Bridge、Workbench React runtime/client、Pane Kit                       |
| Renderer             | Plugin View 固定 React Bridge；Shell framework 可为 React/Vue/Svelte/vanilla                    |
| UI lifecycle         | `loadRemote` -> Bridge render/update/destroy -> opened View handle dispose                      |
| Registration         | one definition + sync/async typed root factories -> one atomic `PublishedTarget` per generation |
| Dynamic API          | local View 一个 direct root capability；Attachment 为 provider + optional consumer capability   |
| View open context    | server-derived principal/route params + `AbortSignal`；browser 不得注入 principal/params        |
| Open result          | 一次返回 direct root(s) + params + federation ref；无中间 session target 或第二次 API lookup    |
| Browser facade       | fixed navigation/document/transfer/notify/confirm；不暴露 Shell private state                   |
| Deployment           | tested Node carrier、owned Vite HTTP server 和 explicitly supported reverse proxy               |
| Unsupported          | cross-origin Shell、Vite middleware without listener、untrusted loopback proxy、no-WS browser   |

Profile 1 不发布选择这些值的 config。可配置的是业务内容，不是平台骨架。

## 平台中立来自固定契约，不来自可替换基础设施

WebSocket、Cap’n Web 与 MF 2.0 都不绑定 official Shell framework。MF Bridge 官方目标就是 cross-framework application-level
render/destroy，因此 Profile 1 可以同时保持 closed infrastructure 与 platform-neutral host。

Profile 1 的 portability 定义为：

1. 同一个 built Plugin producer 可以在任何 conforming Shell/deployment 中运行；
2. Shell 可以使用 React、Vue、Svelte 或 vanilla，只需提供 DOM/Bridge host boundary；
3. Shell 必须直接消费同一 concrete session/client/federation packages，不自行重写协议；
4. compatibility 只由 profile version、manifest/build revision 和 conformance suite 判断；
5. producer 与 host 都不 import official Shell private router/store。

下列目标明确放弃：

- external Shell 独立重写 layout/session/artifact state machine，而不使用 Profile 1 concrete packages；
- external host 自选 transport、auth flow、MF instance topology、Runtime Plugin、share scope 或 renderer ABI；
- “只实现 management API，不使用 WS/MF，也算 Workbench-compatible”；
- 为 host 发布 replaceable loader、renderer、transport 或 session SPI。

Official Shell 是 reference implementation，不是唯一 platform。External Shell 只有完整复用 concrete packages 并通过同一 conformance
suite 才能声明支持；不提供“部分兼容”或 alternate adapter path。

## 开放业务能力，关闭基础设施扩展点

Plugin 作者可以声明：

- 原生 Cap’n Web `RpcTarget` methods、callbacks、streams 与 child targets；
- Views、routes、labels、module-relative renderer entry 与普通 TypeScript definition builders；
- required dependency Attachment 的 provider API 与 optional consumer API；
- 自己选择的 domain validation、authorization、error/result 与 compatibility policy；
- Plugin business HTTP 与真实文件传输。

Plugin、Shell integrator 与 deployment config 不得扩展：

- control path、transport、serialization 或 connection count；
- authentication wire protocol、principal propagation 或 reconnect strategy；
- artifact manifest、remote loader、MF Runtime instance 或 Runtime Plugin list；
- share strategy/scope、React singleton policy 或 per-Plugin compiler；
- Bridge lifecycle、renderer registry 或 host capability namespace；
- grant/token lookup、session resume、event replay 或 offline mode；
- publication/resource/Feature runtime registry 或 Attachment provider discovery；
- collection runtime identity、global collection resolver 或 per-row capability registry。

这条边界有意牺牲 host freedom，以删除 adapter、negotiation、fallback、cross-product tests 和 ambiguous lifecycle owner。

## Cooperative Plugin trust boundary

Workbench 是 installed Plugin 之间的 UI/RPC coordination，不是 public API gateway，也不把同源 MF renderer 当作不可信 sandbox。平台只防御和验证
自己拥有的协议：authentication/profile、Plugin/View identity、canonical route rematch、layout/build revision、publication key、connection/frame/queue
quota 与 lifecycle transition。

取得 ViewApi capability 后，domain input、authorization、业务不变量、stable result、分页/操作上限与 API compatibility 全部属于提供该 API 的
Plugin。Plugin 可以使用 Valibot、Standard Schema、手写 parser 或已有 service，也可以在可信内部调用中不增加重复校验；Workbench 不读取 schema、
不生成 method wrapper、不把 domain validation failure 改写成 platform error。

这不是让 server 信任任意浏览器值。会修改持久状态或访问敏感数据的 Plugin method 仍必须在自己的 domain boundary 执行业务校验与授权。区别在于
owner 是 Plugin，不是一个不了解领域语义的 Workbench validator framework。

## Public complexity budget

Plugin-facing Workbench surface 冻结为 `View<Api>`、`Attachment<ProviderApi, ConsumerApi = never>`、flat frozen definition、一次 `publish()` 和固定 host
facade。每个 local View/placed Attachment 恰好一个 placement，provider Attachment 没有 placement；descriptor 已携带 kind，definition/publication
不重复 `views`/`attachments` 容器。API generic 只是
TypeScript phantom；server factory 返回 `RpcTarget & Api`，零 props renderer 通过 descriptor-bound `useWorkbench()` 直接取得上游
`RpcStub<Api>`/`RpcPromise<T>`，没有 public Bridge props、`CapabilityContract`、schema registry、method descriptor 或第二套 Server/Client type。
Layout、publication、opened-view lease、MF registration 和 WS scheduling 是 platform internal facts，不要求 Plugin 作者配置。

新增 public noun/helper 必须同时满足：至少让两个真实 workspace fixture 的调用点变短；不增加 registry、wire kind、owner 或 independent lifecycle；
无法用 direct capability + by-value data + fixed facade 表达。仅为了 code generation、hook 命名、理论 host freedom 或未来可能性，不足以扩张 API。

## Concrete packages，不发布 replaceable interfaces

Official 与 external conforming Shell 都直接组合下列 browser-safe 具体实现：

| Entry                          | Contract ownership                                                       |
| ------------------------------ | ------------------------------------------------------------------------ |
| `runtime/web/session`          | Cap’n Web WS、auth/bootstrap、root ownership 与 dispose                  |
| `runtime/capnweb`              | pinned `RpcTarget`/`RpcStub`/`RpcPromise` re-export；不增加 RPC DSL      |
| `runtime/workbench`            | browser-safe definition/entry/placement descriptors                      |
| `runtime/workbench/client`     | typed root projection、opened View handle、remote-value/transfer helpers |
| `runtime/workbench/federation` | one MF Runtime、fixed Runtime Plugin、opened View/Bridge                 |
| `runtime/workbench/react`      | descriptor-bound hooks、Pane Kit 与 host facade；无 public Bridge props  |
| `@pluxel/core/federation`      | manifest/build identity 与 fixed shared policy                           |

这些 concrete packages 可以是 public browser entry，但不得在它们前面再定义 `RpcTransport`、`ArtifactLoader`、`RendererHost`、
`PortableWorkbenchHost`、`AuthAdapter` 或 compiler adapter。Internal test seam 可以 mock concrete dependency，但不能晋升为 public
extension point。`runtime/workbench` 根入口必须无 React、Plugin Context、Node 或 server side effect，使同一 frozen definition 可安全进入 Plugin server
module 和 MF remote；server publication 只由 Plugin instance 上的 `ctx.workbench.publish()` 提供。

## 整体版本，不做子协议协商

Bootstrap 携带单一 Workbench profile version。Host build inventory 同时 pin Cap’n Web、MF Runtime/Bridge、platform shared 和
Pluxel protocol implementation 的 compatible versions。

Versioning 规则：

- 一个 host release 只运行一个 active profile version；
- browser 不协商 `transport`, `renderer`, `artifact`, `auth` 子版本；
- profile mismatch 在 authentication/bootstrap 后、任何 remote load 前 hard fail；
- server 不保留旧 endpoint、alias、HTTP compatibility 或 manifest adapter；
- rolling replacement 对旧 socket 发 `1012 Service Restart`，新 page/epoch 加载新的整体 profile；
- breaking change 通过 new profile + one-time deployment cutover，不在同一 page 双栈运行。

MF 官方 Runtime API 以 `ModuleFederation` instance 为中心，Runtime Plugins 修改 manifest/load/share 行为，Bridge 提供 application-level
render/update/destroy lifecycle。Profile 1 直接采用这些 concrete extension points，并由 Pluxel host 独占配置权；不会在它们外面再包一层
“更 portable”的抽象。

## Conformance 是支持条件

“支持 Workbench vNext”必须同时通过：

- one page/one WS/one MF Runtime 的 runtime probe；
- official Shell 与至少一个 non-React external Shell fixture 运行同一 built producer；
- auth challenge -> principal capability transfer -> revocation/close；
- capability-free layout 与一次直接返回 root(s)/params/federation ref 的 `openView()`；
- parameterized document server rematch，browser 不能注入 principal/params；
- sync/async local/Attachment factory 全有或全无；timeout/withdrawal/late resolve 后 target bounded cleanup；
- Wretch consumer-owned state 只得到 server-only exact consumer node，不暴露 Context/facade；
- exact/parameterized route precedence 与 navigation group metadata conflict deterministic rejection；
- dirty/title/transfer 在 Bridge destroy 时清理，再释放 opened View roots；
- signed upload/download ticket 传 bytes，Cap’n Web frame 不承载文件；
- 单 WS 下 control/mutation 对 bounded snapshot、logs/progress 的 latency/memory fairness probe；
- Bridge destroy-before-opened-view-dispose；
- Node、Vite HMR/control/business WS arbitration 与 supported proxy real listener tests；
- Manifest/expose/shared/Bridge failure classification；
- no HTTP batch/SSE/polling/fallback/resume 的 code and route inventory assertion；
- owner/provider replacement 后全部 stub/observer/lease/subscription bounded cleanup。

只通过 TypeScript shape test、mock transport 或 isolated MF loader test 不构成 profile conformance。

## Contract veto

出现下列任一项，必须停止实现并回到 profile review：

- 为兼容某 host 引入第二种 transport、loader、renderer 或 auth protocol；
- 把 WebSocket/MF 其中之一降成 optional capability；
- 发布 replaceable host/transport/artifact SPI；
- 让 Plugin 或 conforming Shell 绕过 concrete host package，注册自己的 Runtime Plugin、share policy 或 raw Cap’n Web root；
- 让 Profile 1 同时支持多个 renderer ABI、connection topology 或 reconnect policy；
- 让 dynamic domain row 创建新的 layout、View、MF producer、socket 或全局 provider lookup；
- 在 Cap’n Web 之上恢复 Model/Query/Channel/Collection resource protocol/registry；
- 强迫 Plugin 为 ViewApi 声明 Standard Schema、method descriptor、contract hash 或 generated validator；
- 让 browser 注入 principal/route params，或把 raw request/auth provider target 交给 View factory；
- 让 Attachment consumer reference 暴露 Context/consumer instance/service locator，或让 navigation group 获得 registry/lifecycle；
- 给 remote 暴露 async `beforeClose` callback、generic HTTP client、Shell router/store 或 raw socket；
- `openView()` 返回中间 resource/session target，再通过第二次调用取得 API；
- 通过 config flag 恢复 HTTP batch、SSE、plain ESM、local Component 或 old Contract/Port path；
- 为 rolling migration 长期运行两个 profile；
- 未通过真实 carrier + MF Bridge integration test 就声明兼容。
