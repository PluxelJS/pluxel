# Direct RPC testing

> 状态：问题分层与候选最小 API，尚未采纳或实现。本文不表示 Runtime 当前已经提供通用的 Elysia RPC mount API。

## 决策问题

不经过 Workbench、由业务 Plugin 自己暴露的 RPC 应如何测试？尤其是 Plugin 在 `ctx.elysia` 上注册 endpoint 时，哪些测试可以
进程内完成，哪些测试必须启动真实 carrier？

候选结论是：不要把“纯 RPC”作为一个测试层。它至少包含两个独立契约：

```text
RpcTarget object contract
  !=
Elysia-mounted RPC endpoint contract
```

第一层验证 method、input、result、child capability、callback、error 和 disposal，可以使用 local Cap'n Web stub，不需要 Runtime host。
第二层还验证 route、protocol negotiation、request/connection admission、generation withdrawal 和 physical carrier；它必须根据实际
transport 使用 `host.http.fetch()` 或 ephemeral real listener。

Workbench RPC 是第三种 publication/session contract，继续由 [`WORKBENCH_RPC.md`](WORKBENCH_RPC.md) 的
`host.workbench.open()` 负责。三者不能合并成带 `mode` 或 `transport` flag 的万能 helper。

## 当前架构事实

`ctx.elysia` 是 Plugin generation 拥有的原生 Elysia application。Runtime 可以看到 route inventory、sealed application 和 owner
generation，但不知道某条业务 route 是否承载 Cap'n Web、JSON-RPC、tRPC、GraphQL subscription 或 Plugin 私有协议。

当前 `@pluxel/runtime/capnweb` 固定公开 `RpcTarget`、`RpcStub` 类型与 WebSocket session bridge；仓库没有一个 Plugin 作者可以调用的
通用 `ctx.elysia.rpc(path, target)` Pluxel mount API。因此 test host 不能仅凭 URL 发现 target，也不能诚实地提供：

```ts
host.rpc.open('/orders/rpc')
```

除非未来先建立生产 RPC mount/transport contract，否则这个测试 API 会反向发明生产语义，并把 raw Elysia route 误装成 Runtime-owned
RPC registry。

## 第一层：纯 RpcTarget object contract

### 目标

验证一个 target 从 RPC caller 看见的行为，而不是直接执行 class method：

- 参数与返回值经过 Cap'n Web 的 copy/capability boundary；
- method 返回 child `RpcTarget` 时得到 `RpcStub`；
- callback、`dup()` 和 disposal ownership 正确；
- malformed input 在 target 自己的 authoritative validation 被拒绝；
- throw/rejection 从 client 侧以 RPC failure 可观察；
- target 或 child capability dispose 后不能继续使用。

它不验证 Elysia、URL、HTTP Upgrade、WebSocket 或 Plugin lifecycle。

### 候选 API

在 `@pluxel/runtime/test` 提供一个独立于 host 的 helper：

```ts
import { createLocalRpcClient } from '@pluxel/runtime/test'

using api = createLocalRpcClient<OrdersApi>(new OrdersTarget(service))

await expect(api.order('42')).resolves.toEqual({ id: '42' })
```

候选签名：

```ts
export function createLocalRpcClient<Api extends RpcTarget>(target: Api): RpcStub<Api>
```

如果 implementation class 与 public API interface 不是同一类型，允许通过显式 generic 指定 author contract；不得接受 method name 或
untyped handler map：

```ts
using api = createLocalRpcClient<OrdersApi>(new OrdersTarget(service))
```

helper 内部只构造 Cap'n Web local `RpcStub` 并把其原生 disposable contract 原样返回。它不 deep-mock target，不 catch/reclassify method
failure，也不创建 Runtime Context。名称使用 `local`，明确它没有物理 transport；不使用 `mockRpc()`，因为执行的 target 和 Cap'n Web
capability membrane都是真实实现。

### 为什么需要 helper 而不是直接调用 target

下面的测试不能证明 RPC contract：

```ts
const target = new OrdersTarget(service)
await target.order('42')
```

它不会观察 RPC deep-copy、returned capability、callback ownership 或 broken stub。`createLocalRpcClient()` 的价值只有这一点，不应继续
包装成 assertion DSL。

### 为什么不把 constructor 加进 production capnweb entry

当前 production `@pluxel/runtime/capnweb` surface 有意保持固定 profile。纯测试需求不足以扩大 Plugin/browser production API。
`createLocalRpcClient()` 位于 test-only entry，可以在内部使用 Cap'n Web `RpcStub` constructor，同时只向调用方承诺一个 local client。

如果后续发现 Plugin 作者在非测试代码中也有合法 local capability composition 需求，应另行评估 production export；不能让 test helper
预先决定该公共契约。

## 第二层：挂载到 ctx.elysia 的 RPC endpoint

### 先按 transport 分类

“挂到 Elysia”只说明 route owner，不说明 RPC transport。测试必须先回答 endpoint 如何承载 RPC：

| Endpoint                        | 普通 Runtime test host                           | 必须验证的额外边界                                    |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Fetch/HTTP request-response RPC | 可以通过 `host.http.fetch()`                     | method/path、body、status、headers、RPC encoding      |
| streaming HTTP RPC              | 可以通过 `host.http.fetch()`，并消费/cancel body | stream cancellation、owner drain                      |
| WebSocket RPC                   | `host.http.fetch()` 不支持 Upgrade               | real listener、subprotocol、frames、disconnect、close |
| 自定义 raw Elysia protocol      | 由 Plugin 自己提供 client/codec                  | 对应 protocol 的真实 request/connection boundary      |

测试 API 不应仅因返回值是 `RpcTarget` 就猜 transport。

### Fetch/HTTP RPC

若 production endpoint 是 Fetch-compatible HTTP RPC，Plugin integration test 应使用当前真实 dispatcher：

```ts
await using host = createRuntimeTestHost()
await host.start(OrdersPlugin)

const response = await host.http.fetch(
	new Request('http://local.test/orders/rpc', {
		method: 'POST',
		body: encodedRpcRequest,
	}),
)

expect(response.status).toBe(200)
```

如果协议已经有 framework-neutral client，它应允许注入 `fetch`：

```ts
const client = createOrdersRpcClient({ fetch: host.http.fetch, origin: 'http://local.test' })
```

这里优先改善具体 RPC client 的 Fetch injection，而不是给 Runtime host 增加一个不知道 codec 的 `rpc()` 方法。测试仍经过 immutable
directory、generation admission、sealed Elysia application 和 response body lifecycle。

在没有 production HTTP Cap'n Web adapter contract 前，不为测试单独导出 `newHttpBatchRpcSession()` 或复制一套 server adapter。

### WebSocket RPC

WebSocket 不能用 `host.http.fetch()` 或 local `RpcStub` 证明。正确 integration shape 是：

```text
Plugin ctx.elysia WebSocket route
  -> Runtime Node carrier on ephemeral loopback port
  -> real WebSocket
  -> newWebSocketRpcSession<Api>()
  -> RpcStub<Api>
```

当前普通 `@pluxel/runtime/test` host 不打开端口，因此不应给它增加看似可用的 `host.rpc.websocket()`。如果真实 Plugin 用例重复证明
需要公共样板，应在 Node-owned test entry 设计一个 real-listener fixture，例如候选：

```ts
import { createNodeRuntimeTestHost } from '@pluxel/runtime-node/test'

await using host = createNodeRuntimeTestHost()
await host.start(OrdersPlugin)
using api = await host.websocket.rpc<OrdersApi>('/orders/rpc')
await expect(api.order('42')).resolves.toEqual({ id: '42' })
```

这只是未来 API 的形状约束，不是当前采纳提案。只有以下前置条件成立后才设计具体签名：

1. 至少两个真实 Plugin 以同一个受支持 Cap'n Web/Elysia mount contract 暴露业务 WebSocket RPC；
2. Node test host 已能以 production carrier 启动 ephemeral listener 并可靠 cleanup；
3. subprotocol、Origin、authentication 和 connection principal 的 owner 已明确；
4. helper 返回的 stub、socket、listener 和 host 有无歧义的 teardown 顺序；
5. static/dynamic route 与 Node production 是否需要共同 conformance 已决定。

在这些条件前，具体 Plugin 可以保留一条 package integration fixture，通过真实 Node listener 和
`newWebSocketRpcSession<Api>()` 连接；不要把 feasibility adapter 提升成公共 Runtime API。

## Plugin lifecycle 的测试组合

一个挂载业务 RPC 的 Plugin 通常需要三组测试，而不是一个万能端到端 case。

### Target contract

```ts
using api = createLocalRpcClient<Api>(createTarget(service, signal))
```

快速覆盖 method、validation、child capability、callback 和 disposal。target factory 应是 Plugin 自己拥有的普通函数/对象边界，不需要
为测试把它变成 public production API。

### Route publication与 withdrawal

HTTP route 使用 `host.http.fetch()`；WebSocket route 使用真实 Node carrier。至少断言：

- Plugin running 后 endpoint 可连接；
- required auth/admission 生效；
- stop/replacement 后新连接不可建立；
- 已打开 connection/capability 被 abort/broken；
- target cleanup 与 generation drain settle。

### 外部依赖

RPC target 内部访问上游 HTTP、database 或 queue 时，替换上游 adapter，不替换入站 RPC。这样测试仍覆盖 RPC validation、Plugin state
和 cleanup，同时不依赖真实第三方服务。

## 与 Workbench RPC 的关系

Workbench 可以安全提供 `host.workbench.open()`，因为 production 已经有 definition、publication registry、layout、session、principal、
open admission 和 returned-root lifecycle。test driver 只是把现有 contract 投影为低样板调用。

直接 Elysia route 没有这些统一 metadata。`createLocalRpcClient()` 只处理 target object；它不能接收 URL，也不能声称 entry 已挂载。
反过来，`host.workbench.open()` 不能用于测试业务 RPC route，因为 Workbench session 的 principal、quota、factory timeout 和
publication withdrawal 都不是业务 endpoint 的协议。

共享的是底层 Cap'n Web capability model，不是 host test API。

## 明确不提供

本提案不提供：

- `host.rpc.open(url)`：Runtime 不知道 raw Elysia route 的 RPC protocol；
- `createLocalRpcClient(target, { transport })`：local object 与 physical carrier 不是一个 option 差异；
- 自动扫描 Elysia route handler 取得私有 target；
- 绕过 route/auth 直接从运行中 Plugin 抽取 target；
- 通用 method string dispatcher；
- 用 local stub 宣称 WebSocket integration 已通过；
- 为测试新增第二套 Cap'n Web codec 或 mount contract。

## 验收条件

`createLocalRpcClient()` 只有满足以下条件才值得成为 public test API：

1. 至少两个真实 Plugin/package 的 target tests 能删除直接 method call 或手写 `RpcStub` internal import；
2. type test 证明 interface、child capability 和 callback 转换为正确 `RpcStub` 类型；
3. 参数与返回值不和 target 共享可变 identity；
4. target throw、async rejection 和 malformed input 保留可观察语义；
5. root/child/callback 的 `dup()` 与 disposal 没有 leak；
6. 文档明确声明它不验证 Elysia mount 或 transport；
7. 同一个 Plugin 仍至少有一条与其实际 transport 匹配的 mounted endpoint integration test。

业务 WebSocket helper 在前述五个前置条件成立前不进入 implementation plan。

## 后续决策

如果 Pluxel 要正式支持 Plugin 直接在 Elysia 上发布 Cap'n Web RPC，需要先在 production architecture 中回答：

- mount 是普通 Elysia plugin/function，还是新的 Runtime capability；
- target 是 per-request、per-connection 还是 generation singleton；
- principal/authentication 从哪里进入；
- path、subprotocol、limits 和 error contract 由谁拥有；
- owner stop/replacement 如何使 connection 与 child capability broken；
- enabled capability 是否增加 route、transport 或 artifact 成本；
- Node 之外的 carrier 支持范围。

这些是 production API 与 lifecycle 问题，不能由 test helper 偷偷决定。
