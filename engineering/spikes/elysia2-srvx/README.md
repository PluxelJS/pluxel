# Elysia 2 + srvx Public Carrier Spike

验证日期：2026-08-27。

> [!NOTE]
> 本文记录的是 spike 当时的上游能力与发布判断，不是当前 Runtime contract 或实现状态。
> 下文所有“当前”“目前”“尚未”和 PASS/BLOCKED 状态都只指验证日期的实验快照；后续实现已越过其中部分发布判断。
> 当前架构与用户可依赖的 API 以 [`../../RUNTIME.md`](../../RUNTIME.md)、
> [`../../PLUGIN_SYSTEM.md`](../../PLUGIN_SYSTEM.md) 和 [`../../../docs/runtime/http.md`](../../../docs/runtime/http.md) 为准。

锁定版本：

- `elysia@2.0.0-beta.7`
- `srvx@0.12.7`
- `crossws@0.4.12`
- Node `24.16.0`
- Bun `1.3.14`

本目录只验证 [`../../proposals/NATIVE_ELYSIA_APPLICATION.md`](../../proposals/NATIVE_ELYSIA_APPLICATION.md)
依赖的上游公开 API。代码没有导入 `elysia/dist/*`、srvx private chunk，也没有读取 Elysia 的 `~ext`、`~routes`、`~generation`
等字段。它不是准备移入 Runtime 的 carrier 实现。

## 当时结论（历史）

方向成立，但在该 spike 时间点不能开始一次性 public API 切换。

基础 application/carrier 链已经得到真实证明：Elysia 2 的公开 modules、route inventory、native seal、custom adapter、WS upgrade data
和 global handler，可以通过 srvx + crossws 在一个 listener 上运行多个隔离 owner；Node 与 Bun 的基本 HTTP/WS 都已通过。

当时的发布门槛仍被三个上游能力阻塞：

1. Elysia 2 beta.7 没有 public external attach/detach lifecycle epoch，custom adapter 也无法从公开 API 正确运行
   `.setup()`；`app.stop()` 不能安全充当 virtual detach。
2. `app.routes` / `app.history` 没有来自实际 compiled router 的 canonical matcher signature。Runtime 无法在不复制 Elysia grammar
   的情况下可靠判断跨 owner 等价 route，也无法证明 delegate directory 与 owner matcher 完全一致。
3. 当前公开 WS carrier contract 不能完整保留 Elysia 能力：application-level `websocket(options)` 没有公开的 resolved inventory，
   crossws `Peer` 没有 portable `pong()`，而 send/backpressure status 也不保证与 Elysia 的数字返回语义一致。

因此可以继续实现 Runtime-private application contribution、directory 和 carrier skeleton，但不能先删除旧 API 并对外宣称
`ctx.elysia` 已经是完整原生 Elysia。

## 结果矩阵

| 验证项                               | 结果             | 证据与边界                                                                                                                                      |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通 function plugin                 | PASS             | `.use((app) => app.get(...))` 无 Pluxel wrapper                                                                                                 |
| async/lazy module                    | PASS             | `await app.modules` 后 route 已进入公开 inventory；module rejection 可直接作为 finalization failure                                             |
| `app.routes` HTTP/WS inventory       | PASS             | 公开返回 `method`、`path`、handler/hooks；WS method 为 `WS`                                                                                     |
| `app.compile()` native seal          | PASS             | 返回同一 instance；route、decorate、state、hook 的 late mutation 均抛 `app was sealed`                                                          |
| public custom adapter                | PASS             | `createAdapter({...WebStandardAdapter, websocket: true})` 可构造 carrier-aware Elysia app                                                       |
| owner Server view                    | CONDITIONAL PASS | HTTP handler 需 `app.fetch(request, ownerView)`；WS upgrade 还需设置公开的 `app.server = ownerView`。两处同时满足时 handler/WS 均看到正确 owner |
| external `.setup()` attach           | BLOCKED          | custom adapter 的 `listen()` 会执行，但 Elysia 注册的 `.setup()` 不会执行；没有 public lifecycle runner                                         |
| external `.cleanup()` detach         | BLOCKED          | `app.stop()` 会控制 server、运行 cleanup 并清空 `app.server`，不是 contribution detach seam                                                     |
| 作者侧 `stop()` fail-fast            | BLOCKED          | 即使 virtual `server.stop()` 抛错，Elysia 仍运行 cleanup、清空 server，最后才 reject；不能做到“报错且无副作用”                                  |
| Elysia WS upgrade data               | PASS             | public `server.upgrade(request, { headers, data })` 的 `data` 包含 immutable route callbacks、validation 和 request context                     |
| one global WS handler / multi owner  | PASS             | 一次 `buildGlobalWSHandler()` 服务两个 sealed owner；并发连接分别得到 `a`、`b` 的 server identity 与 callback                                   |
| srvx Node listener + crossws         | PASS             | `srvx/node.serve()` + `crossws/server/node.plugin()` 完成真实 HTTP 与 upgrade；srvx 公开 `server.node.handler/server`                           |
| Bun carrier baseline                 | PASS             | 相同 application/owner bridge 通过 `srvx/bun` + `crossws/server/bun` 完成真实 HTTP 与 WS                                                        |
| 已有 Node listener/Vite 类接入       | CONDITIONAL PASS | srvx public Node handler 与两个 path-arbitrated crossws adapters 可共享一个 Node listener；尚未运行真实 Vite HMR client conformance             |
| owner connection tracking/drain      | CONDITIONAL PASS | crossws public `Peer.close/terminate` 与 owner `Set<Peer>` 足以按 owner drain；尚未验证 bounded force-close 与 callback settlement              |
| owner topic isolation                | CONDITIONAL PASS | crossws namespace 与 topic prefix 均可用公开 API 实现；尚未完成 pub/sub conformance matrix                                                      |
| 完整 Elysia WS socket surface        | BLOCKED          | crossws public `Peer` 没有 `pong()`；部分 adapter 的 `send()` 可返回 `void`，无法保留 Elysia numeric send status                                |
| application-level WS tuning          | BLOCKED          | `websocket({ idleTimeout, maxPayloadLength, ... })` 的 resolved options 不在 `app.routes` 或另一个 public capability inventory 中               |
| async plugin 生成的 method inventory | PASS             | `await app.modules` 后 public `autoHead()` 生成的 `HEAD` route 同时进入 `routes` 与 `history`                                                   |
| canonical route collision key        | BLOCKED          | 参数名不同的等价 route 被 compile 接受且后注册者获胜；inventory 没有来自 compiled router 的 canonical matcher signature                         |
| `strictPath` matcher identity        | BLOCKED          | loose 与 strict app 的 `routes` / `history` 完全相同，但 `/single/` 的实际结果分别是 200 与 404                                                 |
| `URLPattern` 作为替代 authority      | FAIL             | `URLPattern('/single')` 不匹配尾斜杠，Elysia 默认匹配；Node 也没有公开的 pattern language-equivalence API                                       |

`CONDITIONAL PASS` 表示公开 API 足以证明基础机制，不代表 proposal 的完整生命周期、错误、stream、topic 或 shutdown contract 已经通过。

## 公开 API 组合

### Application finalization

可以直接采用：

```js
await app.modules
const routes = app.routes
app.compile()
```

这三步不需要复制 Elysia app，也不需要访问 private generation。`compile()` 后 Elysia 自己负责 seal。

`app.routes` 适合作为 declared inventory、精确声明重复检查、reserved-path 检查和实验性的 directory registration 输入；目前不适合单独
作为 semantic collision authority。Runtime 最多能可靠拒绝 method 与 declared path 都完全相同的跨 owner route；
`/users/:id` 与 `/users/:name` 这类 canonical collision 不能诚实保证。

必须先 `await app.modules` 再读取 inventory。public `autoHead()` 是正面证据：settlement 前只有 `GET`，settlement 后生成的 `HEAD`
也进入 `routes` / `history`。但 route entry 仍只有 declared method/path，没有 compiled matcher identity；`PublicRoute.compile()` 编译的是
单 route handler，也不返回 matcher key 或 language。

### Route matcher 证据

新增 probe 覆盖了不能被 path 字符串启发式合并的边界：

- `/users/:id` 与 `/users/:name` 匹配同一请求；Elysia 接受两者，registration order 改变实际 winner；
- `/optional/:id?` 与 `/optional/:name?` 对省略参数、尾斜杠和有参数请求表现相同，同样由后注册者获胜；
- static 与 optional、parameter 与 wildcard 会重叠，但 Elysia 的 static/parameter precedence 与 registration order 无关；它们不是
  应被“一有交集就拒绝”的 canonical collision；
- `all()` 在 inventory 中写作 method `*`；同 path 的 concrete `GET` 始终优先，其他 method 进入 `*` route；
- loose 与 `strictPath: true` application 可以拥有完全相同的 inventory，却有不同的尾斜杠匹配集合。

这些事实同时排除了两个看似简单的替代方案。Pluxel 自己把 `:name` 替换成占位符，会复制 optional、wildcard、encoding、尾斜杠和
未来 Elysia grammar；把所有有交集的 pattern 都判冲突，则会拒绝 Elysia 本来用 precedence 明确定义的合法组合。

有限 literal probe 或 `URLPattern.test()` 只能为挑选出的 witness 提供样本，不能证明两个 matcher language 等价。`URLPattern` 也不是
Elysia router authority：同一个 `/single` declaration，前者默认不接受 `/single/`，后者在 `strictPath` omitted 时接受；Node 24.16.0
没有 `URLPattern.compareComponent` 之类的公开 language-equivalence/intersection API。

fixture lockfile 中的 `memoirist` 是 Elysia 的 transitive implementation dependency，不是 `elysia` 的 public export 或稳定 contract，因此
spike 刻意不直接 import。即使当前版本的底层 router 能拒绝部分 parameter-name duplicate，Pluxel 仍需自行补齐 Elysia 的
`strictPath`、method alias、optional/wildcard 与 adapter/AOT 行为；这仍然是在复制上游 matcher，而不是 public seam。

### HTTP owner context

Web Standard fetch 的第二个参数把 server 传入 handler context：

```js
const response = await app.fetch(request, ownerServerView)
```

只设置 `app.server` 不会让普通 HTTP handler 的 `server` 有值。WS route 当前反过来从 `app.server` 找 `upgrade()`，所以 spike 同时做：

```js
app.server = ownerServerView
await app.fetch(request, ownerServerView)
```

两者都是当前 public surface，但这仍是一个不够明确的双入口。最好由 Elysia external attachment epoch 固定 server view，避免调用方遗漏
其中一个。

### WebSocket bridge

可工作的公开链是：

```text
owner app.fetch(upgradeRequest, ownerServerView)
  -> ownerServerView.upgrade(request, { headers, data })
  -> crossws.setWebSocketHooks(request, owner hooks)
  -> srvx/crossws performs native upgrade
  -> one elysia/ws.buildGlobalWSHandler() dispatches through data callbacks
```

`data` 已包含 Elysia route 的 `open/message/drain/close/ping/pong` callback、validator 和 request context。owner token 可以作为额外字段
加入 data，并同时放入 crossws public connection context；不必查 mutable owner registry，也不必读取 Elysia WS private state。

[`carrier.mjs`](./carrier.mjs) 展示了最小协议适配。它故意对没有真实语义的 physical-control method 抛错，也故意把 `pong` 标为
unsupported，而不是用 no-op 冒充成功。

### srvx production 与已有 listener

production Node 可以直接使用：

```js
import { plugin } from 'crossws/server/node'
import { serve } from 'srvx/node'

const server = serve({
	fetch: dispatcher,
	plugins: [plugin({})],
})
```

已有 Node listener（Vite）需要一个显式 upgrade arbiter：

```text
Node request  -> srvx public server.node.handler
Node upgrade  -> if Vite HMR path: Vite WS
                 else if business directory match: crossws Node adapter
                 else: reject/yield according to host policy
```

测试用两个 crossws adapter 模拟 HMR 与 business WS，证明一个 listener 上的 HTTP/upgrade seam 可行。真实 Vite 测试仍必须覆盖 HMR
protocol/path、unmatched upgrade、listener disposal 和 HMR restart；不能把本项的 conditional pass 写成 Vite 已通过。

另一个需要上游修复的小问题：`crossws@0.4.12` 的 `crossws/adapters/node` runtime export 是 `default`，但对应 `.d.mts` 声明的是 named
`nodeAdapter`。JavaScript spike 可运行，TypeScript production binding 不应靠 cast 或 private import 绕过，应先修正 package export/type
一致性。

## 为什么 virtual `app.listen()/stop()` 不成立

公开 `ElysiaAdapter` 确实允许实现一个不打开 port 的 `listen(app)`，并给 `app.server` 安装 virtual view。但 beta.7 的行为是：

```text
new Elysia({ adapter }) -> adapter.setup(app)      # construction extension
app.listen()            -> adapter.listen(app)     # Elysia setup callback 没运行
app.stop()              -> server.stop()
                         -> Elysia cleanup callback
                         -> app.server = undefined
```

这里的 `adapter.setup` 是 adapter construction hook，不是作者注册的 `app.setup()` lifecycle。

如果 virtual `server.stop()` 为保护共享 listener 而 fail-fast，Elysia 仍会执行 cleanup、清掉 server，随后才把 stop error 抛给调用者。
因此以下两件事不能同时实现：

- host 用 `app.listen()/stop()` attach/detach contribution；
- Plugin 作者调用相同方法时 fail-fast 且 application 完全无副作用。

不能用 closure flag、sentinel option 或 monkey patch `app.stop` 把这个差异藏进 Pluxel adapter；那会重新制造 Pluxel-only lifecycle
规则，并且第三方 Elysia plugin 仍无法可靠判断 epoch。

## 建议的上游 seam

### Elysia external application epoch

需要一个不控制 physical listener 的 public API，形状可以是：

```ts
const epoch = await attachElysia(app, ownerServerView)
await epoch.detach()
```

语义必须保证：

- attach 在流量发布前运行全部 `setup()`；
- setup partial failure 会运行已经登记的 cleanup；
- detach exactly once 运行 cleanup，但不调用 physical `server.stop()`；
- setup/cleanup handler 看到同一个 attached Server view；
- late cleanup registration 与 failure aggregate 沿用 Elysia 自己的 contract；
- physical `app.listen()/stop()` 可以由 custom adapter 明确拒绝，拒绝时不 seal、cleanup 或清空 attached state。

这个 API 可以放在 `elysia/adapter`，不一定成为 Plugin 经常使用的 instance method。关键是 host 不读取 callback array，也不自己重放
Elysia lifecycle。

### Elysia WS carrier capability

custom adapter 还需要一个 public resolved capability：

```ts
type AttachedWebSocketCapability = {
	handler: WebSocketHandler<WSConnectionData>
	options: ResolvedWebSocketServerOptions
}
```

它应包含 `websocket(options)` 与 route options 按 Elysia precedence 合并后的 server-level tuning，并明确哪些设置必须全 listener 统一、哪些
可 per connection。现在只导出 `buildGlobalWSHandler()`，不足以恢复 `idleTimeout`、`maxPayloadLength`、compression 等完整语义。

### crossws carrier parity

建议 crossws：

- 为 public `Peer` 增加 portable `pong()`，或明确 capability negotiation；
- 给 send/backpressure 返回建立可映射的稳定语义，或让 Elysia adapter 明确知道 capability 缺失；
- 让 `crossws/server` plugin 接受/返回 caller-owned AdapterInstance，便于 server-level publish、owner drain 与 disposal；
- 修正 `crossws/adapters/node` runtime/type export 不一致。

### Route canonicalization

Elysia 应公开从实际 application router 派生的 route matcher signature，例如：

```ts
type RouteMatcherSignature = Readonly<{
	kind: 'http' | 'websocket'
	methods: readonly string[]
	canonicalPattern: string
}>

const signatures: readonly RouteMatcherSignature[] = app.matcherSignatures
```

`app.routes[i].matcherSignature` 也可以，但 application-level inventory 更不容易漏掉 async plugin 生成的 method alias。该 seam 必须：

- 在 `await app.modules` 后覆盖最终有效 route，包括 `autoHead()` 一类上游 plugin 生成的 alias；
- 与实际 compiled router 对 static、parameter、optional、wildcard、encoding 与 trailing slash 的语义完全一致；
- 已解析 `strictPath`，并为 matcher-language 等价的 pattern 给出可稳定比较的 `canonicalPattern`；
- 明确 `*`、concrete method、`HEAD` 与 `WS` 的 method/kind 交集语义；
- 只规范化 matcher identity，不把 static/parameter/wildcard 的普通 precedence overlap 误报为 collision。

另一个可接受形状是由 Elysia 自己实现并导出的：

```ts
canonicalizeRoute(method, path, { strictPath })
```

但独立函数必须复用与 compiled router 相同的实现和版本，并与 settled application inventory 一起使用；Pluxel 不能维护它的复制品。
没有这项 seam 时，只能拒绝 exact declared path，不能给出可靠的跨 owner canonical conflict diagnostics。

## 建议的实现切分

在上游 seam 补齐前，可以并行实现以下 Runtime-private 边界：

```text
runtime/application
  Elysia authoring slot, modules, public inventory, compile/seal
  no srvx, crossws, node:*, Bun, Deno, or Vite imports

runtime/dispatcher
  immutable owner directory, admission, HTTP/body/WS leases
  Request/Response + internal carrier capability only

carrier/srvx-common
  srvx Fetch handler, signal/stream/shutdown conformance harness

carrier/node
  srvx/node listener, crossws Node upgrade, production lifecycle

carrier/bun
  srvx/bun + crossws Bun binding using the same application/dispatcher suite

carrier/vite
  srvx Node handler attachment and explicit HMR/business upgrade arbitration
```

不要把 [`carrier.mjs`](./carrier.mjs) 搬进 `packages/runtime`。它的作用是证明公开 callback handoff 可行，并把剩余 upstream gaps
变成可复现事实。

## 运行

从仓库根目录执行：

```sh
cd engineering/spikes/elysia2-srvx
pnpm install --ignore-workspace --frozen-lockfile --config.minimum-release-age=0
pnpm test
```

`minimum-release-age=0` 只用于这个锁定 integrity 的隔离 fixture：目标 beta 在验证当天发布，会被仓库的常规新包等待期拒绝。

Bun conformance：

```sh
mise x bun@1.3.14 -- bun engineering/spikes/elysia2-srvx/spike.bun.mjs
```

预期 Node 十项测试全部通过，并输出：

```text
Bun srvx/crossws/Elysia owner carrier: PASS
```
