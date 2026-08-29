# WS-required Cap’n Web control plane

> 本文是 authentication、Management、Workbench dynamic API 和 server push 的唯一 transport authority。
> WebSocket/Cap’n Web 的 mandatory status 与 fixed choices 由 [`PLATFORM_CONTRACT.md`](PLATFORM_CONTRACT.md) 决定。
> Plugin publication 如何产生 layout/opened View 见 [`PUBLICATION.md`](PUBLICATION.md)；MF artifact 不经过本协议，见
> [`FEDERATION.md`](FEDERATION.md)。

## 一条连接是产品契约

固定 path：

```text
/__pluxel/runtime/session
```

Browser 从 document URL 派生 `ws:`/`wss:` scheme。Production 仍服从 Management physical ingress 的 secure transport policy；
不发布 absolute endpoint、cross-origin endpoint 或 transport preference config。

每个 Workbench page 恰好一个 host-owned session owner，任意时刻最多一条 physical control socket。Shell、Management screens、builtin
documents 与全部 Remote Views 都消费该 owner 注入的 facade。连接数不随 target、View、ViewApi、child capability 或 Plugin 数增长。
Remote View 不取得 raw root stub、socket 或 session factory。

“一条连接”只约束 Management/Workbench control plane。Plugin-owned business application 仍可在自己的
route/lifecycle 下提供独立 WebSocket；它不能承载 platform capability，也不能作为 control socket 的
fallback。Carrier 必须按本文后述优先级区分 HMR、control 与 business upgrade。

该 endpoint 只接受 WebSocket upgrade，不同时接受 Cap’n Web HTTP batch。vNext 不实现：

- SSE/`EventSource`、polling 或 per-resource socket；
- `auto | ws | http`、protocol negotiation 或 fallback callback；
- WebSocket 失败后的 silent downgrade；
- transport-neutral `RpcTransport` public abstraction。

Browser 没有 WebSocket、proxy 拒绝 upgrade、carrier 没有 listener 或 handshake timeout 时进入统一硬失败页，不加载 Plugin remote。

## Platform SSE 不存在

Profile 1 不是“优先 WS、保留 SSE 备用”，而是从 Workbench/Management platform inventory 完全删除 SSE：

- 没有 Management events、Workbench events、logging stream 或 progress 的 SSE route；
- browser packages 不 import/construct `EventSource`；
- server 不实现 `text/event-stream`、`Last-Event-ID`、SSE retry、heartbeat comment 或 compatibility redirect；
- historical log/list 通过同一 Cap’n Web ViewApi，live tail 使用 callback/stream，archive/file export 才使用普通 HTTP download；
- migration 完成后 route/code/package assertion 必须证明平台内 SSE client/server 数量为 0。

Plugin-owned business application 仍可以自行提供 HTTP/SSE；它不进入 Management/Workbench root、不会被 conforming host packages 自动消费，也不能作为
platform WS failure fallback。

## Session root 是最小 authority

下列是 Profile 1 的固定 root shape；只有 authentication challenge payload 的 exact schema 由纵向 prototype 冻结：

```ts
type RuntimeBootstrap =
	| Readonly<{
			kind: 'authentication-required'
			profile: 1
			authentication: RuntimeAuthenticationTarget
	  }>
	| Readonly<{
			kind: 'management'
			profile: 1
			management: RuntimeManagementTarget
	  }>
	| Readonly<{
			kind: 'workbench'
			profile: 1
			management: RuntimeManagementTarget
			workbench: WorkbenchControlTarget
	  }>

interface RuntimeSessionRoot extends RpcTarget {
	bootstrap(observer: RuntimeSessionObserver): RuntimeBootstrap
}

interface RuntimeAuthenticationTarget extends RpcTarget {
	state(): RuntimeAuthenticationSnapshot
	submit(input: unknown): RuntimeAuthenticationStep
}

interface WorkbenchControlTarget extends RpcTarget {
	layout(input: unknown): WorkbenchLayoutSnapshot
	openView(input: unknown): OpenViewResult
}

type OpenViewInput = Readonly<{
	target: unknown
	descriptor: unknown
	location?: Readonly<{ path: string }>
	expectedLayoutRevision: number
}>

type OpenViewResult =
	| Readonly<{ ok: true; value: OpenedView }>
	| Readonly<{
			ok: false
			code:
				| 'layout_changed'
				| 'target_unavailable'
				| 'factory_failed'
				| 'factory_timeout'
				| 'quota_exceeded'
	  }>

type OpenedView =
	| Readonly<{
			kind: 'local'
			api: RpcTarget
			params: Readonly<Record<string, string>>
			federatedViewRef: unknown
	  }>
	| (Readonly<{
			kind: 'attachment'
			params: Readonly<Record<string, string>>
			federatedViewRef: unknown
	  }> &
			(
				| Readonly<{ provider: RpcTarget; consumer?: never }>
				| Readonly<{ provider: RpcTarget; consumer: RpcTarget }>
			))
```

`openView()` 的 success branch 在一次 Cap’n Web result 中 transfer direct API root、server-derived params 和 pinned federation reference；没有中间
`ViewSessionTarget`，也没有后续 `api()` round trip。Concrete browser client 验证 Workbench 自己拥有的 result envelope，并建立只存在于本地的
disposable View handle。Await 后的顶层 object result 自带 Cap’n Web disposer：failure branch 验证后立即
dispose；malformed envelope 在 reject 前 dispose；success branch 把整个 result 的唯一 ownership 转入 handle。Envelope 内的 Plugin API stub
及其后续 domain payload 不由 Workbench 解释。Server 把返回的 API wrapper 绑定到一个 internal
lease；local View 只有一个 remote root，Attachment 只有 provider + optional consumer roots。

Failure code 只表达 platform admission，具体 factory cause 进入受保护 diagnostics。Malformed envelope、platform programming error 与 broken
connection 仍 reject；Plugin domain failure 不被包装成这些 code。失败 branch 绝不包含 root 或 partial handle。

Attachment 的两个 envelope branch 由已验证的 exact descriptor 决定：provider-only branch 必须没有 `consumer` key，provider+consumer branch 必须有
且只能有一个 `consumer` root。Concrete client 不把 raw optional field 直接暴露给 Plugin；descriptor-bound hook 仍返回两种精确 record。

Cap’n Web 把返回的 `RpcTarget` 转成 remote stub。Stub 不是 DTO，不能 persist、serialize 到 URL、跨 page 共享或跨 connection epoch
复活。Server 可以保留 internal diagnostics ID，但 browser protocol 不接收 `grantId`、resource namespace、role string 或“旧 token 换新
stub”API。

Browser 类型直接使用 pinned Cap’n Web 的 `RpcStub<Api>`。Server method 声明自然同步/异步返回类型，
stub 按 `Awaited<server return>` 自动产生可 await/pipeline 的 RPC result；child target resolve 为
`RpcStub`，object result 带负责其全部 nested stubs 的顶层 disposer。Stub runtime 本身不知道 server
method inventory，只有 TypeScript generic 提供静态 shape。Workbench 不再建立 Server/Client interface pair、method descriptor 或 proxy DSL。API 文件只允许
pinned `RpcCompatible` 支持的 by-value/capability shape；type/lint/import boundary 尽早检查 declaration，上游 serializer 最终拒绝实际 unsupported
custom class/cyclic value。Workbench 不增加第二套 runtime value validator。

同一 ownership rule 适用于 platform calls：session owner 持有当前 `bootstrap()`/authentication object
result 的顶层 disposer；状态转移时先验证并接管新 result，再 dispose 被替换的旧 result。纯 by-value
`layout()` result 在验证并投影为 local snapshot 后立即 dispose。Host 不从这些 result 中 detach nested stubs，也不逐个释放。

## Authentication 也属于 Cap’n Web

WebSocket upgrade 成功只表示 transport/physical admission 成功，不表示身份已认证。Initial root 只允许 protocol bootstrap 和 narrow
authentication capability；未认证对象图不能触达任何 Management/Workbench domain target。

Authentication flow：

1. exact same-origin `Origin`、TLS/physical peer 和 pre-auth quota 通过后建立 socket；
2. 有效同源 HttpOnly cookie 可以让首次 `bootstrap()` 直接返回 ready capability；
3. 否则返回 `RuntimeAuthenticationTarget`；不需要顶层导航的 password/TOTP/WebAuthn/provider challenge 在同一 socket 完成；
4. 成功结果直接 transfer 绑定 authentication provider generation 与 principal lease 的 Management/Workbench stubs；
5. browser 不保存 bearer token，也不为每个 RPC 重复发送 authorization metadata。

需要 OIDC top-level navigation 的 step 返回窄 navigation instruction，而不是假装能够在当前 socket
完成。Browser 导航会终止当前 document/session；callback 只提交 HttpOnly cookie，新 document 再建立
它唯一的 control session，并由首次 `bootstrap()` 取得 ready capability。旧 socket 的 stub 不会转移到
新 document。

`RuntimeAuthenticationStep` 是封闭、运行时验证的 challenge/result state machine。失败 code 不泄漏 account/provider enumeration facts；
attempt、message bytes、CPU/work factor、并发和 authentication deadline 都有独立 pre-auth 上限。

Principal expiry、provider withdrawal、logout 或 revocation 不在旧 object graph 内 re-auth。Server 先关闭 privileged admission，abort/drain
已接纳调用，然后结束整个 socket epoch；下一条连接重新 bootstrap。这样同一 socket 永远不混合两个 principal generation。

### HTTP 只保留浏览器硬边界

WebSocket message 不能可靠执行 HttpOnly `Set-Cookie`，也不能完成 OIDC top-level navigation。因此仅允许：

- OIDC redirect/callback；
- 消费 Cap’n Web 签发的 single-use、short-lived、commit-only ticket 的 same-origin HttpOnly cookie commit。

这些 endpoint 不返回 access state、Management data、layout 或 capability。当前 socket authority 不依赖 cookie commit；cookie 只用于下一次
bootstrap，以及后续受保护的 HTTP artifact/file fetch。Shell 在 commit 成功前不请求这些受保护资源。Bearer token 不进入 URL、fragment、
`Sec-WebSocket-Protocol`、browser storage 或日志。

同源且通过 physical ingress 的未认证连接应完成 upgrade，再用 authentication capability 表达
`authentication-required | access-unavailable | ready`。因此不存在 HTTP access-state/login JSON API。Upgrade 失败只表示 transport/
physical admission failure。

## Direct capability，不再叠加 grant protocol

`openView()` 把 network input 作为 `unknown` 验证成 `OpenViewInput`，再校验 structured target、canonical descriptor identity、layout revision、authenticated principal lease
与 quota。`location.path` 必须是 canonical target-relative path；server 用 declared route 重新匹配 params，browser 不能直接注入 params。Plugin-specific
authorization 留在 factory/target。

Admission 通过后才用 frozen principal projection、server-derived params 和 opened-view `AbortSignal` 调用 sync/async factory。Runtime 在固定
deadline 内等待 fresh、尚未作为 Workbench root export 的 resolved `RpcTarget`，然后在同一个 result 直接返回 API root。Local View 只返回一个 root；Attachment 只返回 provider 与 optional
consumer API root。Browser-safe TypeScript generic
连接 factory、stub 与 descriptor-bound renderer Context；raw protocol 不提供 resource/method namespace lookup。普通返回值保持 by-value，Plugin API 可以按需返回
observer/task/subscription 等原生 Cap’n Web child target，Workbench 不登记或反射它们的方法。

Attachment provider factory 额外得到 platform-issued `consumer.node`，只用于关联该 canonical consumer node 已有的 consumer-owned state；consumer
reference 自身的 admission/有效期仍绑定 exact consumer generation。Provider 与 optional consumer factory 必须全成功才 transfer roots；任一 reject、timeout、
withdrawal 或 non-`RpcTarget` result 都 abort 共用 signal、dispose completed/late targets，并且不创建 partial opened handle。

Capability 可以共享 Plugin 自己拥有的 backing/subscription，但不能合并 target/provider owner 或放宽 withdrawal。Server-side revocation 使 retained
stub 后续调用得到 stable `capability_expired`；socket break 则使整个 graph broken。两者不能混为通用 `internal_error`。

## Duplex push 直接使用 API callback capability

不在 WebSocket payload 上另造 namespace/event JSON router：

- authentication/layout/lifecycle 通过 bootstrap 时传入的 narrow `RuntimeSessionObserver`；
- ViewApi 可以接受 declared narrow observer，发布 invalidation、domain event、log 或 progress；
- long operation 可以返回 declared Task/Subscription target；
- 只有真正 byte backpressure 用例才返回 Cap’n Web stream。

Observer/receiver 只能调用其声明的窄方法，不获得 Shell store、router、其他 View 或 raw transport。Callback queue、message bytes、in-flight RPC、
active child stub 与每 principal session 数全部有界。

`watch()` 的默认取消语义是返回 child capability，并由 caller dispose stub/RpcPromise；不再为 subscription 增加重复的 `close()` RPC method。
对应 server target 用幂等 `[Symbol.dispose]()` 取消 domain observer。任何 server code 只要在 call
settle 后继续持有传入的 callback/observer stub——包括 bootstrap observer、watch 与 tail——都必须遵守
上游 caller-disposes 规则先 `dup()`，并在对应 session/subscription disposer 中释放 duplicate。
Callback invocation 返回的 `RpcPromise` 也必须 await 或立即 dispose，不能用 `void callback()` 丢弃。
Opened View signal/owner withdrawal 仍是独立的最终撤销边界。Task 的 `cancel()` 是允许取消工作后继续读取 terminal state 的领域操作，因此不由 stub disposal 取代。

Cap’n Web 只解决 invocation、serialization、pipelining 与 capability transport，不替 Plugin 定义领域信任边界。Workbench 只防御性解析自己拥有的
`RuntimeBootstrap`、authentication step、`OpenViewInput`、layout/federation reference、identity/revision 和 lifecycle envelope；这些 platform-owned
values 在进入内部状态前仍是 `unknown`。取得 ViewApi 后，method input/result、snapshot、event、业务授权与错误语义都属于 Plugin：它可以选择
Valibot、Standard Schema、手写 parser、既有 domain service，或在已知可信的内部路径不重复校验。Workbench 不读取 schema、不生成 validator，也不把
domain failure 改写成 platform error。

### 一条有序 WS 的负载纪律

单 socket 不通过公开 priority/channel/QoS API 解决拥塞。Profile 1 固定采用更小的约束面：

- method/callback/result 都受粗粒度 message byte ceiling；Plugin 应把大 snapshot 分页，file/archive bytes 必须走 signed HTTP ticket；
- invalidation 与 progress producer 在进入 transport 前合并为 latest，log tail 使用 bounded queue；overflow 由领域 API 明确报告 gap 或结束订阅；
- platform runtime 内部对 control/mutation 与 callback/stream output 做 bounded fair scheduling，但 Plugin 不能设置 lane 或权重；
- 已编码的大 frame 无法抢占，因此 oversized result 在 frame admission/encoding 时直接拒绝，不靠第二条 socket 绕过 head-of-line blocking；
- conformance 在同时运行 layout/mutation、log tail、progress 与最大合法 page 时测量 bounded control latency 和 bounded memory。

这些是 transport 实现与测试门槛，不增加 Workbench wire kind。若 Cap’n Web runtime 无法在单 WS 上满足该门槛，Profile 1 阻塞，而不是新增 SSE、
per-feature socket 或公开 scheduler abstraction。

## 显式 capability 所有权

页面级 session owner 是唯一能调用 `newWebSocketRpcSession()` 的对象，并公开幂等 `dispose()`/`Symbol.dispose`。官方 App 把 validated
Management facade 和 Workbench clients 注入 UI；Remote View 不直接看到 page/session root stub。

Opened View renderer 收到的是 host-owned root 的 borrowed `RpcStub<Api>`。Workbench 不增加 `retain()/dup()/transferOwnership()` 作者 API，也不让
renderer 取得 session/transport disposer；Bridge/handle 仍是 root 的唯一 platform lifecycle owner。Plugin 直接取得的 child stub 或未 await 的
`RpcPromise` 沿用上游 caller-disposes 规则；await 得到的 object result 也必须由直接调用代码或 owning helper dispose。官方 remote-value/task
helpers 必须代作者释放自己创建的 result/subscription/task。Server target 可以实现
`[Symbol.dispose]`，但 Workbench 的 withdrawal gate 会在 View/owner close 时独立撤销所有 retained duplicates，不依赖 GC 或等待最后一个 stub dispose。

Client cleanup 顺序：

1. Tab/View close 先 destroy MF Bridge，阻止 remote cleanup 后继续发起调用；
2. remote cleanup 释放自己取得的 object results、child stubs、observers、tasks/subscriptions；host 清除 document/transfer；
3. local/Attachment handle 只调用一次 retained `openView()` 顶层 result disposer，由它释放 local API 或 provider/optional consumer roots；internal lease 最后一个 root 释放后执行 target disposer/lease cleanup 并 abort signal；
4. page/session owner dispose root stub 并关闭 socket；
5. server socket close 即使 browser 未 cleanup 也幂等释放全部 target、observer、lease 与 subscription。

不依赖 GC 或 `FinalizationRegistry` 保证远程回收。Host 内部可以 ref-count/`dup()`，但不向 Plugin author 暴露 raw stub refcount、transport
disposer 或 ownership transfer primitive。

## Disconnect 终止 document epoch

```ts
type RuntimeConnectionState =
	| Readonly<{ kind: 'starting' }>
	| Readonly<{ kind: 'authentication-required' }>
	| Readonly<{ kind: 'ready' }>
	| Readonly<{
			kind: 'unavailable'
			cause: 'authentication' | 'service-restart' | 'transport' | 'unsupported'
	  }>
```

每个 document 只有一个隐式 connection epoch，不把 epoch string 暴露成 resume/reconnect API。Root broken 后：

1. session owner 原子进入 terminal unavailable，禁止新 mutation；
2. destroy 全部 Remote Bridges，清理 host document/transfer，再 dispose opened handles 与 root stub；
3. 废弃旧 snapshots、callbacks、streams 和 pending promises，不逐调用 retry 或 replay；
4. 如果该 document 曾进入 `ready` 且当前 history entry 的 host-only disconnect-reload budget 未消费，Shell 先标记该 entry，再触发一次 full-document reload；新 document 从 canonical URL/workspace persistence 重新 bootstrap；
5. 如果 initial socket/bootstrap 从未 ready，或 reload 后的新 document 再次失败，显示硬失败页并提供显式 reload，不在后台循环创建 socket；用户动作先重置该 entry 的 budget。

`1012 Service Restart`、transport break 与 authentication expiry 都遵循同一 page teardown；区别只用于失败页/导航文案。一个 document 内
`newWebSocketRpcSession()` 恰好调用一次，不存在 in-place reconnect、backoff session loop、root recreation 或 partial workspace recovery。
Disconnect-reload budget 只是防刷新循环的 browser navigation flag，不进入 RPC/layout，不保存 principal、stub、snapshot
或 workspace authority。

Domain cache/stale-data policy 属于 Plugin helper，不由 Workbench session 恢复。Artifact candidate 的
提交边界见 [`FEDERATION.md`](FEDERATION.md)。Close reason string 不是程序协议，browser 只消费上面的 closed state。

## Physical ingress 与 security

Upgrade 前必须：

- exact 校验 expected `Origin`，阻止 cross-site WebSocket hijacking；
- 验证 secure transport 与 physical peer 至少有权尝试 Management authentication；
- 执行 per-peer connection/rate/quota admission；
- 持有 authentication provider generation lease，ready 后再绑定 principal lease；
- 对 Cap’n Web pipelining、昂贵 operation、send/receive queue 单独限额。

Provider withdrawal、principal revocation、logout 或 host shutdown 主动结束 socket。Remote View JS 仍是同源可信代码，不是 sandbox；Cap’n Web
capability 只限制正常 component boundary，不能防御已经在同一 origin 执行的恶意 renderer。

Stable error families：

- session/bootstrap：`profile_unsupported | capability_unavailable | quota_exceeded`；
- authentication：`authentication_required | authentication_failed | authentication_expired | access_unavailable | attempt_limited`；
- capability/lifecycle：`capability_expired | capability_unavailable | quota_exceeded`。

Malformed platform control envelope 与 programming exception reject 并进入 diagnostics；Plugin domain API 自己决定 result/error contract。
Authentication expiry、service restart 与 transport break 由 session owner 投影为
`RuntimeConnectionState`，不按 exception/close message 猜测。

## Vite carrier arbitration

Node production、static Vite 与 dynamic Vite 使用同一个 host-owned control route inventory/carrier。Control endpoint 不是 Plugin generation 的
`ctx.elysia.ws()` route，不能被 business wildcard 覆盖。

Vite-owned HTTP server 的 upgrade 优先级固定为：

1. `vite-hmr`/`vite-ping` protocol + exact configured HMR path；
2. `GET /__pluxel/runtime/session` 的 non-HMR upgrade；
3. generation-scoped business WebSocket matcher；
4. 都不匹配时不抢占其他 Vite/plugin listener。

独立 Workbench frontend dev server proxy 同一 path 时必须配置 `ws: true`，保留 Cookie/`Origin`/`Host` 语义，并运行真实 socket test。Vite
middleware mode 没有自有 `httpServer`/upgrade listener；安装 Management/Workbench 时 startup fail-fast，不让 UI 运行后才静默失败。

## Reverse proxy contract

Reverse proxy 支持是部署 contract，不是 fallback：

- upstream 支持 HTTP/1.1 Upgrade，并保留 expected origin/host/cookie；
- control path 不经过 cache、body buffer 或 request retry；
- proxy idle timeout 大于 carrier heartbeat window；
- heartbeat、idle、drain 是 host policy，不是 Plugin config；
- replacement/shutdown 先停止新 upgrade，再对 active socket 发 `1012 Service Restart`，有界等待后强制 close；
- 每次成功 upgrade 绑定一个 upstream 直到 socket close；proxy 不重试、迁移或在 replicas 间恢复
  Cap’n Web object graph；仅当 authentication/ticket/artifact state 不是共享或自校验状态时，跨 HTTP
  request/new-document 的部署才额外需要 session affinity；
- 当前 physical-peer policy 不信任 `Forwarded`/`X-Forwarded-For`，loopback upstream 仍不受支持；trusted proxy 必须作为独立
  security contract，不由“启用 WS”隐式放宽。

Close code 只表达 coarse transport lifecycle。Domain failure 继续使用 Cap’n Web result/stable error code。

## Transport 否决条件

- Remote View 创建第二个 control session 或取得 raw root/socket；
- 未认证 root 暴露 Management/Workbench target；
- 出现 HTTP batch、SSE、polling、access-state/login JSON API 或 fallback config；
- 在 stub 上叠加 grant/resource/method namespace lookup；
- `openView()` 返回中间 session/resource target，再额外调用一次才能取得 exact API；
- Workbench 要求 ViewApi schema、method descriptor、contract hash、generated validator 或统一 domain error；
- disconnect 后 resume 旧 stub、透明 retry mutation 或 replay transient callback/stream；
- disconnect 后在同一 document 再次创建 session、重新 open roots 或原地恢复 workspace；
- subscription 同时要求 `close()` RPC 与 stub disposal，或 server 未 `dup()` 就跨 call 保留 callback capability；
- 依赖 GC 回收 server resource；
- Vite middleware mode、proxy upgrade failure 或 unsupported browser 被伪装成正常运行；
- close reason/message、exception text 或 bearer URL 被当成 public auth/domain protocol。
