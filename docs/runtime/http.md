---
title: 插件 HTTP
description: 直接用 generation-scoped 原生 Elysia 2 application 暴露 API、webhook、流式响应和 WebSocket。
---

业务 HTTP 是常驻 Runtime 能力，与 Workbench 是否启用无关。每个 Plugin generation 严格惰性地拥有一个真实的
Elysia 2 application；Plugin 和它的全部 PluginPart 通过 `ctx.elysia` 取得同一个 instance。Pluxel 不包装 route builder，
也不在 Elysia path 外再拼接 Plugin namespace。

## 最小路由

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/runtime'

type Order = { id: string }

// ---cut---

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		this.ctx.elysia
			.get('/health', () => ({ ok: true }))
			.get('/orders/:id', ({ params }) => this.findOrder(params.id))
	}

	private findOrder(id: string): Order {
		return { id }
	}
}
```

这里的真实地址就是 `/health` 和 `/orders/:id`。需要共同前缀时直接使用 Elysia 的 `group()`：

```ts no-twoslash
this.ctx.elysia.group('/orders', (app) =>
	app
		.get('/health', () => ({ ok: true }))
		.post('/webhooks/payment', ({ body }) => this.acceptPayment(body)),
)
```

最终地址是 `/orders/health` 和 `/orders/webhooks/payment`。`/__pluxel` 是宿主 control plane 的保留 namespace，Plugin
不能在其中声明路由。路径与访问策略正交：公开路径不会自动获得匿名访问，鉴权、签名校验、租户判断、CORS 和速率限制仍由
明确的 Elysia plugin、业务 handler 或宿主策略实现。

fork 或多个 Plugin 若要同时提供 HTTP，必须声明彼此不冲突的最终路径。不要从 Plugin identity 或 fork id 猜测 URL；路径本身
就是产品 contract。

## 直接使用 Elysia 能力

`ctx.elysia` 是上游 `Elysia` instance，不是 facade 或 Proxy。schema、model、macro、hook、guard、derive、resolve、error handler、
cookie、stream 和普通 function plugin 都按 Elysia 2 API 使用。需要这些 API 的 Plugin package 直接依赖 `elysia`；
`@pluxel/runtime` 不重新导出 Elysia 或它的官方 plugin。

发布给其他宿主使用的 Plugin package 应把宿主支持的 Elysia 精确版本同时声明为 `peerDependencies` 和 `devDependencies`：peer
保证运行时复用宿主 singleton，dev dependency 则供本 package 编译、测试和编辑器解析。不要把 Elysia 打进 Plugin bundle，也不要让
Plugin 自带另一份 runtime copy。当前 Runtime 锁定 `2.0.0-beta.7`，对应声明为：

```json
{
	"peerDependencies": {
		"elysia": "2.0.0-beta.7"
	},
	"devDependencies": {
		"elysia": "2.0.0-beta.7"
	}
}
```

应用仓库内的 private Plugin 也必须通过 workspace catalog 解析到同一个版本；不能用宽范围产生第二份 Elysia。这个约束同时覆盖
`elysia` 根入口和 `elysia/websocket` 等 subpath。

`staticApplication()` freezer 会把 Elysia package 当前公开的全部 subpath 解析到 Runtime-owned singleton；dynamic Vite/ModuleRunner
使用同一 host singleton bridge。这样 source-linked checkout 即使出现不同的 pnpm 物理路径，Plugin 的 `elysia`、
`elysia/type`、`elysia/websocket` 和官方 plugin 仍与 `ctx.elysia` 属于同一份上游 runtime。当前还没有在 catalog ingestion
阶段校验 Plugin manifest 的 Elysia version range，因此 exact peer/dev dependency 仍是作者必须遵守的 package contract。

freezer 还会在宿主与 Plugin module 求值前，通过 Elysia 公开的 `setupTypebox()` 一次性安装 TypeBox 的 type、system、value、
schema、compile namespace 与 `exact-mirror`。因此 schema 可以在已经搬离 source workspace 的 frozen distribution 中惰性编译；
产物不依赖相对生成 chunk 的同步 `createRequire()` 查找。这个 wiring 只是补齐上游公开 runtime dependency，不替换 `t`、schema
或 validator，也不增加 Pluxel schema facade。

Elysia 2 的 route schema 位于 handler 之前：

```ts no-twoslash
import { t } from 'elysia'

this.ctx.elysia.post(
	'/orders',
	{
		body: t.Object({
			customerId: t.String({ minLength: 1 }),
			items: t.Array(t.String(), { minItems: 1 }),
		}),
	},
	async ({ body, status }) => {
		const order = await this.createOrder(body)
		return status(201, order)
	},
)
```

在 HTTP 边界校验 params、query、headers 和 body。HTTP DTO 是外部 contract；不要直接返回数据库 row、Plugin instance、
Context、Error object 或带 credential 的 SDK response。

可复用的业务路由写成普通 Elysia function plugin，不需要 Pluxel adapter：

```ts no-twoslash
import type { Elysia } from 'elysia'

function ordersApi(service: OrdersService) {
	return (app: Elysia) =>
		app.group('/orders', (app) =>
			app.get('/:id', ({ params }) => service.find(params.id)),
		)
}

protected override init() {
	this.ctx.elysia.use(ordersApi(this.orders))
}
```

## 按所有权组织大型路由

URL 层级是产品协议，Plugin 依赖图是生命周期协议；两者可以长得相似，但不能互相代替。先决定谁应当随谁启动、失败、替换和撤销，
再决定 path。按下面的信号选择 route owner：

| 需求                                                   | 组织方式                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| 一组 route 共享发布版本、鉴权、hook 和撤销边界         | 一个 Plugin 拥有 Elysia app，内部用普通 function plugin 拆模块       |
| webhook、WebSocket 或 API 需要独立启停、失败隔离或 HMR | 对应能力成为独立 Plugin，直接使用自己的 `ctx.elysia`                 |
| provider、adapter 等动态集合只贡献状态或处理器数据     | 一个 Plugin 拥有固定 ingress，其他 Plugin 向 typed registry 注册数据 |
| Plugin 只有领域能力，没有入站 HTTP                     | 不读取 `ctx.elysia`，保持 Elysia application 严格惰性                |

### 固定产品 API 由 ingress 依赖领域能力

对于已知且需要一起发布的 route tree，让 HTTP ingress Plugin 通过 constructor 依赖领域 Plugin，再在自己的 app 中组合普通
Elysia function plugin。不要让领域 Plugin 反向依赖 ingress，也不要把 ingress 的 app 暴露给其他 Plugin 修改：

```ts no-twoslash
function roomRoutes(rooms: Rooms) {
	return (app: Elysia) =>
		app.get('/rooms', () => rooms.list()).get('/rooms/:id', ({ params }) => rooms.get(params.id))
}

function queueRoutes(queue: Queue) {
	return (app: Elysia) =>
		app
			.get('/queues/:id', ({ params }) => queue.list(params.id))
			.post('/queues/:id/items', ({ params, body }) => queue.add(params.id, body))
}

@Plugin()
export class MusicApiPlugin extends BasePlugin {
	constructor(
		private readonly rooms: Rooms,
		private readonly queue: Queue,
	) {
		super()
	}

	protected override init() {
		this.ctx.elysia.group('/music/api', (app) =>
			app.use(roomRoutes(this.rooms)).use(queueRoutes(this.queue)),
		)
	}
}
```

这些 function plugin 没有独立 Plugin identity、config 或 lifecycle；它们只是同一个 Elysia owner 内的代码组织。修改任一模块会建立新的
`MusicApiPlugin` generation，并原子替换完整 route tree。不要为拆文件而创建更多 Pluxel Plugin。

### 动态扩展使用固定 ingress 与 registry

当 provider 集合可以动态出现、消失或 HMR replacement 时，不要让它们向一个已经运行的 app 追加 route。Elysia app 会在 Plugin
初始化后 compile/seal，跨 Plugin 修改还会失去 route ownership。让一个 Plugin 声明固定 route，动态 Plugin 只注册有明确清理语义的数据：

```ts no-twoslash
type DiagnosticSource = Readonly<{
	id: string
	snapshot(): Readonly<{
		status: 'healthy' | 'degraded' | 'unavailable'
		metrics: Readonly<Record<string, string | number>>
	}>
}>

@Plugin()
export class DiagnosticsPlugin extends BasePlugin {
	private readonly sources = new DiagnosticSourceRegistry()

	registerSource(source: DiagnosticSource): () => void {
		return this.sources.register(source)
	}

	protected override init() {
		this.ctx.elysia.group('/music', (app) => app.get('/diagnostics', () => this.sources.snapshot()))
	}
}
```

贡献者通过普通 Plugin 依赖或可选 `definePluginRef()` 调用 `registerSource()`，并把返回的 disposer 交给当前 generation effects：

```ts no-twoslash
this.plugins.use(Diagnostics, (diagnostics) =>
	diagnostics.registerSource({
		id: 'platform.voice',
		snapshot: () => this.currentDiagnostics(),
	}),
)
```

`plugins.use()` 同时建立 lifecycle edge：Diagnostics provider 出现、消失或 replacement 时，调用它的 consumer 会重启。若
consumer 本身拥有不应被诊断系统 HMR 打断的长连接、播放器或其他昂贵资源，把 contribution 放在已有的产品集成 Plugin；没有合适
集成层时，再建立一个只拥有这条跨域集成 lifecycle 的小 Plugin。它通过 constructor 依赖业务能力，并可选依赖 ingress：

```ts no-twoslash
const Diagnostics = definePluginRef<DiagnosticsPlugin>()

@Plugin()
export class VoiceProductIntegrationPlugin extends BasePlugin {
	constructor(private readonly voice: VoiceGatewayPlugin) {
		super()
	}

	protected override init() {
		this.plugins.use(Diagnostics, (diagnostics) =>
			diagnostics.registerSource(voiceDiagnosticSource(this.voice)),
		)
	}
}
```

这样 Diagnostics replacement 只重启轻量集成层，不会反向重启 `VoiceGatewayPlugin`。只有当重启业务 Plugin 本来就是正确语义时，
才在业务 Plugin 本体声明 optional integration；该业务 Plugin 自己拥有的 command registration、临时状态和其他 effects 也会一起重建。
如果这些资源同样不能中断，就使用示例中的专用小型集成 Plugin。不要用 ambient event handshake 隐藏这条真实依赖。

这样 contributor replacement 只撤销旧 source 并注册新 source；固定 ingress、鉴权和 schema 不发生 late mutation。source ID、重复注册、
snapshot 上限、错误隔离与 disposer 幂等性属于 registry contract。请求期 snapshot 应读取已经拥有的有界内存状态，不执行平台探测；
需要异步采集时由 owner 调度并缓存 snapshot。聚合层必须按公开 DTO 逐字段投影并运行时校验，不用对象 spread 把 contributor 的额外字段
带到 HTTP 边界；TypeScript 类型不能阻止 token、连接地址、内部 Error 或第三方 SDK 对象意外进入运行时对象。固定 ingress 还应直接用
Elysia 原生 `response` schema 声明完整 HTTP DTO，让运行时响应校验、序列化和 OpenAPI 继续只有一个上游契约。

异步聚合还要单独记录 source-set revision：采集中发生注册或撤销时，丢弃已失效结果，再从最新 source set 重算；普通领域事件和周期采样
应合并 refresh demand，不能持续使正在进行的有效采集失效。要求 source 集合精确的 endpoint 只等待当前 refresh barrier；普通领域事实
采用事件触发与周期采样的最终一致语义，纯读取本身不标记新变化或重新采样。事件订阅可以稍后收到新 snapshot，但不能在撤销后重新发布
旧 generation 的 contribution。

以下模式会破坏边界，应改用上面的 owner 或 registry：

- `featurePlugin -> apiPlugin.elysia.get(...)`：依赖方向倒置，route 无法随 contributor 精确撤销；
- 自定义 `registerRoute()` / `mountRoute()`：重新制造一套弱于 Elysia 的作者 API；
- 运行中向 app 追加 route：越过 native compile/seal 与 generation publication；
- 用 standalone `new Elysia()` 拼接 Pluxel Plugin：server lifecycle、hook 和 WebSocket owner 可能分裂；
- 只为共享 path prefix 建立核心 Plugin：`group()` 或普通常量已经能表达 namespace，prefix 本身不是 lifecycle。

宿主拥有 listener、port、TLS、process shutdown 和物理 server policy。Plugin 调用 application 的 `listen()` / `stop()` 会立即
失败；`setup()` / `cleanup()` 也会立即失败，因为 Elysia 2 beta.7 尚未公开供外部 carrier 驱动的 attach/detach epoch。Plugin 也不
调用 Server view 的 `stop()`、`reload()`、`ref()` 或 `unref()`，不选择 srvx/runtime adapter。srvx 的接入属于宿主 carrier 工作，
不是 Plugin 的第二套 Web 作者 API。

handler 取得的 `server` 是 generation-scoped、carrier-backed view。`url`、`port`、`hostname` 和 `development` 反映当前宿主 listener；
`id` 是本 generation 内稳定的 virtual-server value，不是物理 listener identity。`server.url` 每次返回独立 `URL`，修改它不会重配
listener。Node carrier 还支持 `server.requestIP(request)` 读取该请求的远端 address、port 和 IP family；把其他来源或已经脱离当前
owner invocation 的 `Request` 传入会明确失败。

## WebSocket

Node production carrier、static Vite 和 dynamic Vite 已通过真实 listener 验证 Elysia 2 的基础业务 WebSocket。作者仍直接使用
Elysia，不需要 Pluxel WebSocket facade：

```ts no-twoslash
import { websocket } from 'elysia/websocket'

this.ctx.elysia.use(websocket()).ws('/events', {
	open(socket) {
		socket.subscribe('orders')
	},
	message(socket, message) {
		socket.send({ type: 'echo', message })
	},
	close(socket) {
		socket.unsubscribe('orders')
	},
})
```

当前 Node 路线支持基础 `open` / `message` / `close` dispatch、send 和 pub/sub。同名 topic 会自动限定在 owning Plugin generation，
不会跨 owner 广播。replacement 或 owner stop 会先 abort connection owner signal，再以 `1012 Service Restart` 关闭该 owner 的 socket；
其他 owner 的连接不受影响。若 transport 没有回报 close，宿主会在有界等待后终止连接并释放 generation lease。

Vite 始终先保留自己的 HMR protocol/path，只有非 HMR 且命中当前 Elysia `.ws()` route 的 upgrade 才进入业务 carrier。

## PluginPart 与 Elysia scope

同一 generation 的 root Plugin 和所有 Part 共享相同的 application identity。Part 可以直接注册路由：

```ts no-twoslash
class MetricsPart extends PluginPart<OrdersPlugin> {
	protected override init() {
		this.ctx.elysia.get('/orders/metrics', () => this.snapshot())
	}
}
```

这也表示 Part 不是 Elysia semantic isolation boundary。root 与 Part 按实际 children-before-owner 注册顺序共同组成一个 app，hook、
model、macro、store 和 named plugin dedupe 遵循 Elysia 在该 app 内的规则。需要独立路径治理、hook 隔离、启停或撤销的组成应成为
真正 Plugin。

不同 Plugin generation 则各自拥有独立 app。一个 Plugin 的 global hook、store 或 error handler 不会因为宿主组合顺序作用到另一个
Plugin 或 control plane。

## Finalization 与生命周期

Plugin 和所有 Part 的 `init()` 成功后，Runtime 会等待 lazy Elysia modules，检查 route inventory，再调用 Elysia 2 自己的
`app.compile()` 固化 application。compile 会 seal 同一个 instance；generation running 后继续增加 route、hook、store 或 decorator
会由 Elysia 2 fail-fast。

作者不需要保存 publication handle。配置或源码变化建立新 generation；不要在 running generation 内原地改 route tree。finalization
失败不会发布部分路由；成功 contribution 与 Core running projection 一起提交。Plugin stop、replacement 或 rollback 后，
旧 generation 不再接收新请求。

请求进入 app 前会取得 owner generation lease。返回 streaming `Response` 时，lease 延伸到 body close、cancel 或 error；generation
停止会 abort handler 看到的 `request.signal`，并等待已经接纳的 response settle。无法响应 signal 的任意 JavaScript 仍受宿主 drain
timeout 约束，Runtime 不会假装能同步终止它。

长期 background task 不应挂在某个 HTTP request Promise 上。把它建模为 owner-bound worker/queue，再让 endpoint 只提交任务或查询状态。

## 挂载已有 Fetch application

已有 WinterTC-style Fetch application 使用 Elysia 原生 `mount()`：

```ts no-twoslash
this.ctx.elysia.mount('/legacy', (request) => legacyRouter.fetch(request))
```

请求仍从整个 generation contribution 的 admission 与 cleanup 边界进入；Pluxel 不再定义另一套 Fetch boundary 或 mount handle。

## 当前 Elysia 2 与 carrier 边界

Runtime 当前锁定 Elysia `2.0.0-beta.7`。已经验证并作为当前 contract 的是 Fetch HTTP route、普通 Elysia composition、native
compile/seal、atomic generation publication、stream lease、owner withdrawal，以及上述三条 Node listener 路线的基础业务 WebSocket。
以下能力仍不能按“所有 runtime 上完整等同原生 Elysia server”使用：

- Elysia `setup()` / `cleanup()` 尚无公开 external attach/detach runner。直接注册会 fail-fast；把带隐藏 lifecycle callback 的 standalone
  Elysia instance 再通过 `.use()` 合并也不属于受支持路径。Pluxel 不读取 beta private fields 自行模拟。
- 目前只有 Node production、static Vite 和 dynamic Vite carrier 完成 conformance；尚无第二个 Bun、Deno 或 Worker carrier，因此
  “portable application seam”不等于已经证明跨平台 transport parity。
- crossws 的 portable socket API 尚不能实现 Elysia socket 的主动 `pong()`。不同 runtime 的 send 返回值、backpressure 和 buffered
  byte 语义也尚未完成精确对齐，不应据此编写跨 runtime 流控协议。
- Elysia application-level WebSocket tuning 尚未完整投影到共享 carrier，例如全部 payload、compression、idle timeout 和 transport
  tuning 不能视为每个 Plugin 独立拥有的设置。
- Runtime 会拒绝相同 method 与相同声明 path 的跨 owner 冲突，也会拒绝 `/__pluxel`；但 beta 的 public inventory 尚不足以证明所有
  canonical-equivalent pattern 都能与 Elysia matcher 完全一致地预检，例如仅参数名不同的 pattern。当前应给每个业务 API 使用明确、
  唯一的首段 namespace，并用真实请求覆盖边界。

这些限制属于 Elysia/carrier seam，不会通过增加 Pluxel Web wrapper 来掩盖。Node 已验证范围内可以使用业务 WebSocket；依赖上述
portable parity 或 tuning 的应用应等待对应 conformance 完成。

## 错误边界

区分可预期的请求错误与 lifecycle 失败：

| 情况                             | 处理                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| 参数、权限或状态冲突             | 使用 Elysia status/Response 返回明确 4xx DTO                    |
| 上游超时或临时不可用             | 返回领域定义的 5xx/503，并保留 server log cause                 |
| 未知请求异常                     | 交给 Elysia error boundary，向外返回不含敏感信息的通用错误      |
| reserved path、route conflict 等 | generation start failed；不发布该 contribution                  |
| Plugin 根本无法继续提供能力      | 触发 lifecycle failure/restart，而不是持续提供半失效的 HTTP 500 |

不要把 stack、token、内部文件路径或完整上游 response body 直接返回客户端。

## 测试

Runtime test host 的 `host.fetch()` 会经过真实 directory、generation admission 和 sealed Elysia app，但不打开端口：

```ts no-twoslash
const response = await host.fetch(new Request('http://local.test/orders/42'))
```

至少验证：

- success 和 validation failure；
- 最终产品 path；
- Plugin remove/replacement 后旧 route 返回 404；
- stream cancellation 与 owner stop（若 handler 返回 stream）；
- auth/signature failure 不泄露内部错误；
- Workbench disabled 时业务 route 仍工作。

`host.fetch()` 不执行 HTTP Upgrade，也不证明真实 listener disconnect、WebSocket close code、backpressure 或 HMR arbitration。需要这些
carrier 能力时必须使用 Node production、static Vite 或 dynamic Vite 对应的 ephemeral real-listener integration test；不能用普通 Fetch
response 代替。完整 test host 配置见[测试 Pluxel 插件](../development/testing.md)。
出站请求可以使用官方 [Wretch Plugin](../plugins/wretch.md) 或领域 HTTP client，不要与入站 Elysia application ownership 混在一起。

## 效率模型

未读取 `ctx.elysia` 的 generation 不创建 Elysia app。已发布请求先由 immutable business directory 选择 owner contribution，再进入该
owner 的 sealed Elysia app；这是一次有意识的两级 routing，用来隔离跨 Plugin global hook、store、plugin dedupe 与 generation withdrawal。

目前没有同场 benchmark 可以证明这条路径“接近裸 Elysia”或给出跨机器延迟承诺。后续 benchmark 应比较 plain Elysia 与 1/10/100/1000
contribution 的 directory delegate、snapshot build、stream drain；如果两级 lookup 成为主要瓶颈，应优化内部 dispatcher，而不是把
route index 或 carrier tuning 变成 Plugin API。
