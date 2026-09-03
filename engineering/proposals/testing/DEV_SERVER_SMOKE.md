# Dynamic dev server smoke API

> 状态：候选设计，尚未采纳或实现。本文定义真实 Vite/Node listener 的 smoke-test 边界，不改变
> [`COMPOSABLE_HOST.md`](COMPOSABLE_HOST.md) 中 in-process Runtime test host 的职责。当前 launcher 行为以
> [`../../../packages/runtime-dynamic/README.md`](../../../packages/runtime-dynamic/README.md) 为准。

## 决策

coding agent 不应只能在“很快但无物理 carrier 的 test host”和“自己拼装 Vite、端口发现与 teardown”之间选择。dynamic Runtime
应提供一个专门的 test entry，让同一套资源所有权习惯可以用于真实 dev server smoke：

```ts
import { startDevServer } from '@pluxel/runtime-dynamic/test'

await using server = await startDevServer({
	config: new URL('../fixtures/pluxel.dynamic.ts', import.meta.url),
})

const response = await fetch(new URL('/health', server.origin))
expect(response).toHaveProperty('status', 200)
expect(await response.json()).toEqual({ ok: true })
```

这是 physical integration test，不是给 `RuntimeTestHost` 增加 listen mode。它应真实经过：

```text
dynamic config module
  -> Vite config/source graph
  -> semantic lowering + initial reconciliation
  -> Runtime HTTP directory/application carrier
  -> loopback TCP listener
  -> fetch / WebSocket / browser
```

因此它能验证普通 host 故意不覆盖的 config loading、source resolution、Vite middleware、真实 request metadata、WebSocket upgrade、
Workbench assets 和 listener cleanup。普通 Plugin 行为仍优先使用 in-process host；只有 assertion 的可信度依赖这些边界时才承担 dev
server 的启动与 watcher 成本。

## 最小 public surface

首版只在 `@pluxel/runtime-dynamic/test` 导出一个 factory 和它的 lease type：

```ts
export interface DevServerTestLease extends AsyncDisposable {
	/** Loopback HTTP origin, for example http://127.0.0.1:43127/. */
	readonly origin: URL
	/** Idempotently closes every resource owned by this lease. */
	dispose(): Promise<void>
}

export function startDevServer(
	options: Readonly<{
		/** File URL of the real dynamic Runtime config module. */
		config: URL
	}>,
): Promise<DevServerTestLease>
```

`startDevServer()` 的单次 `await` 同时表示 create、listen 和 ready。resolve 前必须完成：

1. 加载并验证 config module；
2. 建立 Vite source graph 与 dynamic Runtime controller；
3. 完成 initial catalog reconciliation 并启动 HMR watcher；
4. 把 application carrier 接到 Vite HTTP server；
5. 在 `127.0.0.1:0` 成功监听，并从实际 socket address 构造 `origin`。

任一步失败都应在 reject 前回收已经取得的资源。factory 不返回半启动 lease，不增加 `ready()` 或可观察的 transitional state。

这里的 ready 表示 server 与 initial reconciliation 已稳定，并不表示 catalog 中每个 Plugin 都 running。`plugins`/`sources` 提供
availability，不应因为 helper 名为 `startDevServer` 就隐式制造 Plugin session intent 或 durable auto-start policy。需要启动目标时，smoke
应通过启用后的真实 Management/Workbench RPC 发出与产品相同的控制请求，或使用 fixture 已显式准备的 runtime state；随后用
`expect.poll()` 等待公开 endpoint 可观察。test lease 不提供一条绕过控制面的捷径。

`config` 只接受 `URL` 是刻意的：test 文件中的相对 URL 以该文件为基准，不依赖 agent、Vitest 或 workspace 的当前工作目录，也不会把
HTTP URL 与文件路径字符串混为一谈。底层 production launcher 可以继续接受自己的 path contract；test entry 在边界完成显式转换。

`origin` 使用标准 `URL`，所以 HTTP、RPC 和 browser smoke 不需要 Pluxel wrapper：

```ts
await expect(fetch(new URL('/api/orders', server.origin))).resolves.toMatchObject({
	status: 200,
})
```

WebSocket 同样使用真实 carrier；调用方从 origin 建立目标 URL 并显式选择协议：

```ts
const socketUrl = new URL('/events', server.origin)
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'

await using socket = await openTestWebSocket(socketUrl)
```

`openTestWebSocket` 若以后被多个 package 证明需要，应属于 carrier-neutral test utility；它不是 dynamic server lease 的方法。首版不为一行
URL 转换增加 `server.ws()`、`server.websocketOrigin` 或 RPC codec。

## 为什么不复用 RuntimeTestHost lifecycle API

两个入口复用的是 mental model，而不是 mutation authority：

| 边界                      | 创建后如何取得 ready state          | Catalog/lifecycle authority                                                | 调用边界                           |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `createRuntimeTestHost()` | `await host.start(Plugin)`          | fixture 直接声明 constructor/fork 与 session intent                        | in-process drivers                 |
| `startDevServer()`        | factory resolve 时整个 server ready | dynamic config/source/HMR 定义 catalog；production control plane 改 intent | `fetch`/WebSocket/browser over TCP |

dev server 上不应出现：

```ts
await server.start(Plugin)
await server.commit(...)
server.require(Plugin)
server.ctx
```

这些方法会绕过正在被 smoke 验证的 config/source loader，或者向 Plugin 测试公开 root authority。若测试需要直接安排 Plugin graph，应回到
`RuntimeTestHost`；若需要验证 source replacement，应编辑 fixture source，并从公开 HTTP/RPC/Workbench 结果观察 HMR。

同理，不给 `createRuntimeTestHost()` 增加 `listen: true`、`mode: 'dev'` 或 `carrier: 'vite'`。这些 flag 会让同一个 method 的 readiness、
性能、错误来源与可验证边界随 options 改变，使测试只看局部代码时无法知道自己是否打开了真实端口和 watcher。

## 生命周期与失败

lease 同时拥有：

1. HTTP/WebSocket application carrier 与 loopback listener；
2. Vite HMR、watcher 与 compiler resources；
3. Runtime controller、Plugin generations 和 capability effects；
4. 该 launcher 建立的其余 cache/child lease。

prototype 必须依据 carrier 的 drain contract 证明无竞态关闭顺序，不在 author API 中公开内部阶段。public guarantee 是 `dispose()` resolve 后
不再持有 listener、watcher、Plugin effect 或后台 task。重复 `dispose()` 必须幂等；多个 teardown failure 使用 `AggregateError` 保留，而不是
只报告最后一个。

startup 与 teardown 不内置短测试 timeout。真实 compiler、migration 或 Plugin drain 的合理时间属于调用环境；Vitest 可以在 test/hook
上设 timeout，外部最终一致状态使用 `expect.poll()` 或 `vi.waitFor()`。helper 自行施加一个隐藏的 5 秒或 30 秒 deadline 会让长任务表现成
随机基础设施失败。需要取消时应最终沿用 launcher 的标准 cancellation contract，而不是另建 `server.waitFor()`。

## 状态安全边界

这个 helper 启动的是调用方提供的**真实 config**。它不得偷偷把 persistence、Vault、Database、config service 或 runtime state 换成
memory backend，否则通过的测试并没有验证声明的 dev server。反过来，直接指向日常或 production config 也可能写入它所声明的 `.pluxel`
目录、Vault 和数据库。

canonical smoke fixture 因此应显式声明隔离状态，例如 memory persistence，或把所有 durable path/backend 指向 test-owned temporary
resources。文档和错误信息必须提醒调用方这一点；coding agent 在未知仓库中不应把 production config 当作 disposable fixture。

首版不冻结 `isolated: true` 或 config overlay API。安全 overlay 必须同时覆盖 config/runtime-state/persistence/database/vault 与路径派生，且不能
无意改变正在验证的 config semantics；在至少两个真实 smoke fixture 证明完整 contract 前，一个布尔值只会制造虚假的隔离保证。

网络固定为 loopback + OS-assigned ephemeral port。test API 不接受 `host`、固定 `port`、`open` 或公网暴露选项；这些是 application launcher/
CLI 的部署责任，不是 smoke fixture 的变量。

## 与更高层测试的边界

这个 lease 足以成为其他工具的底座，但不吸收它们的 API：

- HTTP 与 mounted RPC：使用标准 `fetch(new URL(path, server.origin))`，按 endpoint 的真实 codec 断言；
- WebSocket RPC：使用真实 WebSocket client 和 URL；
- Workbench/browser：Playwright 的 `baseURL` 指向 `server.origin`，DOM 交互只在验证 Shell/renderer 时使用；
- CLI/subprocess/signal/stdout：由独立 launcher acceptance test 启动真实命令，不能用 in-process lease 冒充；
- HMR：修改 test-owned source fixture，通过公开结果等待新 generation 生效；需要 epoch/planning facts 的 framework tests 使用 internal harness。

不要提前设计一个 `startRuntimeServer({ mode: 'static' | 'dynamic' })`。static artifact host 和 dynamic Vite host 的输入、readiness、更新能力
与失败阶段不同；先让 dynamic 的真实用例稳定，再提取被两边调用点证明相同的 carrier lease contract。

## Prototype 验收条件

实现进入 public API 前至少迁移这些真实场景：

1. 通过真实 Management/Workbench control RPC 启动 config 中可用的 Plugin，再以 `fetch` 命中其 HTTP endpoint；
2. mounted RPC 或 WebSocket endpoint 能经过物理 carrier 往返；
3. source edit 后 HMR replacement 可从公开响应观察，旧 WebSocket generation 正确 drain；
4. invalid config/startup 失败不遗留端口或 watcher；
5. `dispose()` 后原 origin 拒绝连接，重复 dispose 不失败；
6. 一个显式 memory fixture 与一个 temp-directory durable fixture 均无跨 test 状态泄漏；
7. Playwright 能直接复用 `origin`，无需取得 Vite server 或 root `ctx`。

只有当这些迁移证明调用方还需要额外 public fact 时才增加 surface。Vite server instance、raw socket/port、controller、root Context、Plugin
instance 和 internal readiness epoch 都不因 framework tests 方便而公开。
