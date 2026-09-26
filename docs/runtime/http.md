---
title: 插件 HTTP
description: 在插件中添加 HTTP API、webhook 和 WebSocket，并验证路由与热更新行为。
---

要给插件增加 API 或 webhook，在 `init()` 中通过 `this.ctx.require(ElysiaApp)` 声明路由即可。宿主显式安装 `elysia()` 服务并负责接入请求，关闭 Workbench 也不影响业务 HTTP。`standardServices()` 与 `servicesPreset()` 默认安装该服务。

下面的插件可以加入 [快速开始](../getting-started/index.md) 创建的应用。`ctx.require(ElysiaApp)` 使用 Elysia 2 原生 API，路由路径就是最终 URL，不会自动添加插件名前缀。

| 要做什么                     | 本页路径                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| 新增 API/webhook             | [最小路由](#最小路由) → [输入与 Elysia 能力](#直接使用-elysia-能力) → [测试](#测试) |
| 加 WebSocket                 | [WebSocket](#websocket)与[已验证 carrier 范围](#当前-elysia-2-与-carrier-边界)      |
| 拆分路由或动态扩展           | [所有权](#按所有权组织大型路由)，先选 generation owner                              |
| 更新后 404、停止后请求未退出 | [发布与生命周期](#finalization-与生命周期)、[错误边界](#错误边界)                   |
| 自己接入 listener            | [独立 Host](#独立-host)                                                             |

## 最小路由

```ts twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { BasePlugin, Plugin } from '@pluxel/core'

type Order = { id: string }

// ---cut---

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		this.ctx
			.require(ElysiaApp)
			.get('/health', () => ({ ok: true }))
			.get('/orders/:id', ({ params }) => this.findOrder(params.id))
	}

	private findOrder(id: string): Order {
		return { id }
	}
}
```

把 `OrdersPlugin` 加入宿主清单与自动启动项，启动应用后，用终端显示的 origin 请求 `/health`，应得到 `{"ok":true}`；请求 `/orders/42` 应得到 `{"id":"42"}`。若返回 404，先确认插件已运行、请求发往同一宿主端口。

这里的真实地址就是 `/health` 和 `/orders/:id`。需要共同前缀时直接使用 Elysia 的 `group()`：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
this.ctx
	.require(ElysiaApp)
	.group('/orders', (app) =>
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

### 与产品 SPA 和 Workbench 共用 origin

HTTP 服务保留 `/__pluxel`；不会强制业务路由使用 `/api` 或其他前缀。同一 listener 上的请求按以下边界仲裁：

```text
/__pluxel/**                 -> Management / Workbench
匹配 Plugin HTTP/WS route    -> owning Plugin generation
Workbench document path     -> Workbench shell
其余 navigation             -> 产品 SPA fallback
```

因此 Plugin 显式声明 `GET /settings` 时会优先于产品 SPA 的 `/settings`。这是产品选择的最终路径所有权，不是 Host 可以从两个
独立 Router 自动判定的冲突。应用可以约定 `/api`、`/webhooks` 等首段来降低误用，但 Pluxel 不把团队惯例升级为框架限制；真正需要
提供独立产品页面的 Plugin 也可以拥有明确的 mount point，并自行配置该前端的 Router basename 与 asset base。

Workbench contribution 不通过业务 HTTP route 抢占产品页面。Shell 在 `workbench.uiBasePath` 下组织其逻辑路由，框架 API、session、
federation artifact 与 Shell asset 均留在 `/__pluxel/**`。包含产品 SPA 的 host 通常使用
`workbench.uiBasePath: '/__pluxel/workbench'`。

## 直接使用 Elysia 能力

`ctx.require(ElysiaApp)` 是上游 `Elysia` instance，不是 facade 或 Proxy。schema、model、macro、hook、guard、derive、resolve、error handler、
cookie、stream 和普通 function plugin 都按 Elysia 2 API 使用。需要这些 API 的 Plugin package 直接依赖 `elysia`；
`@pluxel/core` 不重新导出 Elysia 或它的官方 plugin。

发布给其他宿主使用的 Plugin package 应把宿主支持的 Elysia 精确版本同时声明为 `peerDependencies` 和 `devDependencies`：peer
声明与宿主互操作的兼容意图，dev dependency 则供本 package 编译、测试和编辑器解析。实际 singleton 还依赖构建与加载解析。不要把 Elysia 打进 Plugin bundle，也不要让
Plugin 自带另一份 runtime copy。当前 HTTP 服务锁定 `2.0.0-beta.7`，对应声明为：

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

静态构建与动态开发都复用宿主的同一份 Elysia，包含其公开子入口。源码关联可能产生不同的 pnpm 物理路径，但插件仍须声明上述精确版本；当前加载流程不会替作者验证所有版本范围。

Elysia 2 的 route schema 位于 handler 之前：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { t } from 'elysia'

this.ctx.require(ElysiaApp).post(
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
import { ElysiaApp } from '@pluxel/services/elysia'
import type { Elysia } from 'elysia'

function ordersApi(service: OrdersService) {
	return (app: Elysia) =>
		app.group('/orders', (app) =>
			app.get('/:id', ({ params }) => service.find(params.id)),
		)
}

protected override init() {
	this.ctx.require(ElysiaApp).use(ordersApi(this.orders))
}
```

## WebSocket

Node production carrier、static Vite 和 dynamic Vite 已通过真实 listener 验证 Elysia 2 的基础业务 WebSocket。作者仍直接使用
Elysia，不需要 Pluxel WebSocket facade：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
import { websocket } from 'elysia/websocket'

this.ctx
	.require(ElysiaApp)
	.use(websocket())
	.ws('/events', {
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
业务 WebSocket 成功升级后不会进入 Host 的页面 fallback，因此可以与 Workbench 或应用 SPA 共用同一 listener。

## PluginPart 与 Elysia scope

同一 generation 的 root Plugin 和所有 Part 共享相同的 application identity。Part 可以直接注册路由：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
class MetricsPart extends PluginPart<OrdersPlugin> {
	protected override init() {
		this.ctx.require(ElysiaApp).get('/orders/metrics', () => this.snapshot())
	}
}
```

这也表示 Part 不是 Elysia semantic isolation boundary。root 与 Part 按实际 children-before-owner 注册顺序共同组成一个 app，hook、
model、macro、store 和 named plugin dedupe 遵循 Elysia 在该 app 内的规则。需要独立路径治理、hook 隔离、启停或撤销的组成应成为
真正 Plugin。

不同 Plugin generation 则各自拥有独立 app。一个 Plugin 的 global hook、store 或 error handler 不会因为宿主组合顺序作用到另一个
Plugin 或 control plane。

## Finalization 与生命周期

Plugin 和所有 Part 的 `init()` 成功后，HTTP 服务会等待 lazy Elysia modules，检查 route inventory，再调用 Elysia 2 自己的
`app.compile()` 固化 application。compile 会 seal 同一个 instance；generation running 后继续增加 route、hook、store 或 decorator
会由 Elysia 2 fail-fast。

作者不需要保存 publication handle。需要改变 route tree 时，显式 restart 或由源码更新建立新 generation；配置保存本身不会自动重启。finalization
失败不会发布部分路由；成功 contribution 与 Core running projection 一起提交。Plugin stop、replacement 或 rollback 后，
旧 generation 不再接收新请求。

请求进入 app 前会取得 owner generation lease。返回 streaming `Response` 时，lease 延伸到 body close、cancel 或 error；generation
停止会 abort handler 看到的 `request.signal`，并等待已经接纳的 response settle。无法响应 signal 的任意 JavaScript 仍受宿主 drain
timeout 约束，HTTP 服务不会假装能同步终止它。

框架内部挂载的 Management/Workbench endpoint 也接收组合了请求取消与 Host 关闭的 `request.signal`。Host 等待其 `fetch()` 完成；endpoint 自行拥有返回后的流或 WebSocket session。传入的 carrier 保留物理 ingress 的 `requestIP()` 和 upgrade 身份，派生 Request 不改变认证所依赖的连接地址。

长期 background task 不应挂在某个 HTTP request Promise 上。把它建模为 owner-bound worker/queue，再让 endpoint 只提交任务或查询状态。

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

服务 test host 的 `host.http.fetch()` 会经过真实 directory、generation admission 和 sealed Elysia app，但不打开端口：

```ts no-twoslash
const response = await host.http.fetch(new URL('/orders/42', host.http.origin))
```

至少验证：

- success 和 validation failure；
- 最终产品 path；
- Plugin remove/replacement 后旧 route 返回 404；
- stream cancellation 与 owner stop（若 handler 返回 stream）；
- auth/signature failure 不泄露内部错误；
- Workbench disabled 时业务 route 仍工作。

`host.http.fetch()` 不执行 HTTP Upgrade，也不证明真实 listener disconnect、WebSocket close code、backpressure 或 HMR arbitration。需要这些
carrier 能力时必须使用 Node production、static Vite 或 dynamic Vite 对应的 ephemeral real-listener integration test；不能用普通 Fetch
response 代替。完整 test host 配置见[测试 Pluxel 插件](../development/testing.md)。
出站请求可以使用官方 [Wretch Plugin](../plugins/wretch.md) 或领域 HTTP client，不要与入站 Elysia application ownership 混在一起。

## 挂载已有 Fetch application

已有 WinterTC-style Fetch application 使用 Elysia 原生 `mount()`：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
this.ctx.require(ElysiaApp).mount('/legacy', (request) => legacyRouter.fetch(request))
```

请求仍从整个 generation contribution 的 admission 与 cleanup 边界进入；Pluxel 不再定义另一套 Fetch boundary 或 mount handle。

## 按所有权组织大型路由

URL 层级是产品协议，Plugin 依赖图是生命周期协议；两者可以长得相似，但不能互相代替。先决定谁应当随谁启动、失败、替换和撤销，
再决定 path。按下面的信号选择 route owner：

| 需求                                                   | 组织方式                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| 一组 route 共享发布版本、鉴权、hook 和撤销边界         | 一个 Plugin 拥有 Elysia app，内部用普通 function plugin 拆模块       |
| webhook、WebSocket 或 API 需要独立启停、失败隔离或 HMR | 对应能力成为独立 Plugin，直接使用自己的 `ctx.require(ElysiaApp)`     |
| provider、adapter 等动态集合只贡献状态或处理器数据     | 一个 Plugin 拥有固定 ingress，其他 Plugin 向 typed registry 注册数据 |
| Plugin 只有领域能力，没有入站 HTTP                     | 不读取 `ctx.require(ElysiaApp)`，保持 Elysia application 严格惰性    |

### 固定产品 API 由 ingress 依赖领域能力

对于已知且需要一起发布的 route tree，让 HTTP ingress Plugin 通过 constructor 依赖领域 Plugin，再在自己的 app 中组合普通
Elysia function plugin。不要让领域 Plugin 反向依赖 ingress，也不要把 ingress 的 app 暴露给其他 Plugin 修改：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
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
		this.ctx
			.require(ElysiaApp)
			.group('/music/api', (app) => app.use(roomRoutes(this.rooms)).use(queueRoutes(this.queue)))
	}
}
```

这些 function plugin 没有独立 Plugin identity、config 或 lifecycle；它们只是同一个 Elysia owner 内的代码组织。修改任一模块会建立新的
`MusicApiPlugin` generation，并原子替换完整 route tree。不要为拆文件而创建更多 Pluxel Plugin。

### 动态扩展使用固定 ingress 与 registry

当 provider 集合可以动态出现、消失或 HMR replacement 时，不要让它们向一个已经运行的 app 追加 route。Elysia app 会在 Plugin
初始化后 compile/seal，跨 Plugin 修改还会失去 route ownership。让一个 Plugin 声明固定 route，动态 Plugin 只注册有明确清理语义的数据：

```ts no-twoslash
import { ElysiaApp } from '@pluxel/services/elysia'
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
		this.ctx
			.require(ElysiaApp)
			.group('/music', (app) => app.get('/diagnostics', () => this.sources.snapshot()))
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

`plugins.use()` 建立真实依赖边；provider 变化会重启 consumer。业务长连接不应因此重启时，把这条可选集成放在独立的轻量 integration Plugin，由它依赖业务 Plugin 并登记/撤销 source。

Registry 自己负责稳定 ID、重复注册、结果上限与幂等 disposer。请求读取已采集的有界 snapshot，并按公开 DTO 投影、校验；不把 SDK 对象、凭据或任意额外字段带到 HTTP。异步聚合须丢弃已撤销 source 的迟到结果。HTTP 输出使用 Elysia 原生 `response` schema。

以下模式会破坏边界，应改用上面的 owner 或 registry：

- `featurePlugin -> apiPlugin.elysia.get(...)`：依赖方向倒置，route 无法随 contributor 精确撤销；
- 自定义 `registerRoute()` / `mountRoute()`：重新制造一套弱于 Elysia 的作者 API；
- 运行中向 app 追加 route：越过 native compile/seal 与 generation publication；
- 用 standalone `new Elysia()` 拼接 Pluxel Plugin：server lifecycle、hook 和 WebSocket owner 可能分裂；
- 只为共享 path prefix 建立核心 Plugin：`group()` 或普通常量已经能表达 namespace，prefix 本身不是 lifecycle。

## 当前 Elysia 2 与 carrier 边界

HTTP 服务当前锁定 Elysia `2.0.0-beta.7`。已经验证并作为当前 contract 的是 Fetch HTTP route、普通 Elysia composition、native
compile/seal、atomic generation publication、stream lease、owner withdrawal，以及上述三条 Node listener 路线的基础业务 WebSocket。
以下能力仍不能按“所有 runtime 上完整等同原生 Elysia server”使用：

- Elysia `setup()` / `cleanup()` 尚无公开 external attach/detach runner，直接注册会 fail-fast。带隐藏 lifecycle callback 的 standalone instance 也不能通过 `.use()` 绕过；listener 所有权见[独立 Host](#独立-host)。
- 唯一受支持的接入是 Node srvx 与 Vite 开发接线；不承诺 Bun、Deno 或 Worker adapter。
- crossws 的 portable socket API 尚不能实现 Elysia socket 的主动 `pong()`。不同 runtime 的 send 返回值、backpressure 和 buffered
  byte 语义也尚未完成精确对齐，不应据此编写跨 runtime 流控协议。
- Elysia application-level WebSocket tuning 尚未完整投影到共享 carrier，例如全部 payload、compression、idle timeout 和 transport
  tuning 不能视为每个 Plugin 独立拥有的设置。
- HTTP 服务会拒绝相同 method 与相同声明 path 的跨 owner 冲突，也会拒绝 `/__pluxel`；但 beta 的 public inventory 尚不足以证明所有
  canonical-equivalent pattern 都能与 Elysia matcher 完全一致地预检，例如仅参数名不同的 pattern。当前应给每个业务 API 使用明确、
  唯一的首段 namespace，并用真实请求覆盖边界。

这些限制属于 Elysia/carrier seam，不会通过增加 Pluxel Web wrapper 来掩盖。Node 已验证范围内可以使用业务 WebSocket；上述未支持的 tuning 不能作为应用依赖。

## 独立 Host

安装 `@pluxel/services` 与 `elysia`；Elysia 是 HTTP 服务的可选 peer，不会随其他服务安装。

`elysia()` 安装 generation-scoped Elysia application；生产 Node 接线统一使用 srvx。
`listenElysia()` 使用 Host 的请求分发，并拥有 listener 和 Host 的关闭；不需要重复传 handler。

```ts no-twoslash
import { createHost } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { listenElysia } from '@pluxel/services/elysia/node'

const host = await createHost({ plugins: [MyRoutes], services: [elysia()] })
await host.startNode(MyRoutesAddress)
const listener = await listenElysia(host, { hostname: '127.0.0.1', port: 3000 })
// 应用结束时关闭 listener 与 Host。
await listener.close()
```

需要直接调用 Fetch 请求边界时，使用 `/elysia` 的 `createElysiaHandler(host)`；调用者负责关闭 Host。
`ElysiaApp` 仅供 Plugin/Part 使用。底层 directory、endpoint/fallback 和 carrier 接线属于框架内部，
不提供第二套公共 server API 或可替换 adapter。Management 与 Workbench 复用同一请求分发。

宿主拥有 listener、port、process shutdown 和物理 server policy，部署 ingress、反向代理或平台拥有 TLS。Plugin 调用 application 的 `listen()` / `stop()` 会立即
失败；`setup()` / `cleanup()` 也会立即失败，因为 Elysia 2 beta.7 尚未公开供外部 carrier 驱动的 attach/detach epoch。Plugin 也不
调用 Server view 的 `stop()`、`reload()`、`ref()` 或 `unref()`，不选择 srvx/runtime adapter。srvx 的接入属于宿主 carrier 工作，
不是 Plugin 的第二套 Web 作者 API。

handler 取得的 `server` 是 generation-scoped、carrier-backed view。`url`、`port`、`hostname` 和 `development` 反映当前宿主 listener；
`id` 是本 generation 内稳定的 virtual-server value，不是物理 listener identity。`server.url` 每次返回独立 `URL`，修改它不会重配
listener。Node carrier 还支持 `server.requestIP(request)` 读取该请求的远端 address、port 和 IP family；把其他来源或已经脱离当前
owner invocation 的 `Request` 传入会明确失败。
