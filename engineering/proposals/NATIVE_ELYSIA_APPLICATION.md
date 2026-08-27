# Plugin 原生 Elysia 2 Application 与 srvx Carrier

> 状态：accepted，不兼容作者面切换和 Node 生产基线已落地，跨 carrier 能力收口仍在进行。本文同时记录
> 目标态、已落地基线与仍需上游 public seam 的缺口；
> 当前用户 API 与已验证平台范围仍以 [`../RUNTIME.md`](../RUNTIME.md)、[`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 和
> [`../../docs/runtime/http.md`](../../docs/runtime/http.md) 为准。

## 决策摘要

Pluxel 不再向 Plugin 作者提供 `ctx.http.plugin.routes()`、`mount()`、`publicPath`、route handle 或
`createElysiaApp()`。每个 Plugin generation 改为严格惰性地拥有一个真实的 Elysia 2 application：

```ts
import { websocket } from 'elysia/websocket'

protected override init() {
	this.ctx.elysia
		.use(cors())
		.use(websocket())
		.group('/orders', (app) =>
			app
				.get('/:id', ({ params }) => this.find(params.id))
				.ws('/events', {
					message: (socket, message) => socket.send(this.accept(message)),
				}),
		)
}
```

`ctx.elysia` 是上游 Elysia 2 instance，不是 Pluxel facade、Proxy 或重新实现的 route builder。作者直接从 `elysia` 与其公开
subpath、官方/第三方 Elysia packages 导入 schema、capability、macro、plugin 和工具；HTTP route、WebSocket、hook、guard、
model、derive/resolve、error、cookie、trace、stream 与 `mount()` 都继续使用上游 API。Elysia 2 要求
`.use(websocket())` 后声明 `.ws()`，Pluxel 不把这项上游规则藏在隐式 magic 中。

`setup()` / `cleanup()` 是当前唯一明确的 application lifecycle 例外：beta.7 没有外部 carrier 可调用的 public attach/detach
epoch，直接在 `ctx.elysia` 注册会立即 fail-fast；standalone Elysia app 通过 `.use()` 隐藏带入的 lifecycle callback 也不受支持。
Pluxel 不读取 `~ext` 等 private state 冒充兼容。

Pluxel 只保留 Elysia 无法替 Plugin graph 完成的四项职责：

1. 为 generation 创建绑定 host carrier 的 authoring application；
2. 在 `init()` 结束时使用 Elysia 2 自己的 compile/seal generation 固化 contribution；
3. 把 route、request、response body 与 WebSocket connection 绑定到 generation admission/lifecycle；
4. 由 Runtime 构建 immutable dispatcher 并原子发布 ready pointer，host-owned srvx listener/carrier 只读取当前快照。

每个 generation contribution 是一个独立的虚拟 Elysia application。它的 local/scoped/global hook、store、decorator、
model 与 macro 只在该 contribution 内遵循 Elysia 语义，不泄漏进其他 Plugin 或 `/__pluxel` control plane。宿主使用
Elysia route grammar 构造 immutable dispatch snapshot，再把已匹配的 request/upgrade 交给对应 contribution。不能为了少一次
route lookup，直接把所有 owner app `.use()` 进同一个共享 Elysia semantic scope；那会让第三方 plugin 的 global hook、name/seed
dedupe 与 parent extension state 获得跨 Plugin 顺序效应，破坏 owner withdrawal。

URL 不再有 Pluxel 自动生成的 Plugin mount namespace。Plugin 在 Elysia 中声明的 path 就是真实业务 path；`/__pluxel`
继续由 host 保留。当前可靠拒绝的是公开 inventory 中 kind、method 与 declared path 都完全相同的跨 owner route，不采用
last-wins。canonical-equivalent pattern 仍等待 Elysia 暴露 compiled matcher signature；Runtime 不复制 Elysia route grammar。

listener、TLS、process shutdown、`listen()`、`stop()` 和 server-wide policy 仍由 host 独占。业务 dispatcher 是纯
Request/Response + Elysia Server view 边界；srvx 提供 Node、Bun、Deno 等 runtime carrier，具体 WebSocket upgrade 由 carrier 的
公开 WS bridge 补齐。Vite development 必须同时接通 HTTP middleware 与 `upgrade`，不能继续把 Fetch middleware 当作 WebSocket
已受支持。

### 当前实现基线

| 能力             | 2026-08-27 共享树状态                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 作者 API         | `ctx.elysia` 是真实 Elysia `2.0.0-beta.7` instance；旧 `ctx.http.plugin`/`publicPath` 作者协议已移除                               |
| generation       | lazy app、Part 共享、`app.modules`、native `compile()`/seal、owner admission、stream drain 已接入 Core lifecycle                   |
| publication      | 跨 owner settlement、ready immutable directory 和 CommitSummary 前的同步 pointer swap 已实现                                       |
| collision        | 只拒绝 `kind + method + declared path` 完全相同的跨 owner route；canonical-equivalent pattern 尚未可靠检测                         |
| Node production  | `@pluxel/runtime-static` 已通过 srvx Node listener 载入 `@pluxel/runtime-node` carrier，覆盖 Fetch、metadata、disconnect 与真实 WS |
| Node/Vite WS     | Node/crossws bridge、owner topic 隔离、1012 replacement drain 与 Vite upgrade arbitration 已有实现；这仍只是 Node 证明             |
| portable WS      | srvx application/carrier seam 已分层，但 Bun/Deno 第二 carrier 和共享 conformance suite 尚未完成                                   |
| Elysia lifecycle | beta.7 没有 public external attach/detach epoch；`app.setup()` / `app.cleanup()` 在 Plugin app 上立即 fail-fast                    |
| package contract | dynamic singleton bridge 已实现；Plugin `elysia` peer-range admission 尚未接入 static/dynamic 共享 catalog seam                    |

因此“原生 Elysia”已是当前作者 contract，但不等于“Elysia 和 srvx 在所有 runtime 上的每个 server 扩展已验收”。

## 为什么替换原有模型

替换前的实现允许 Plugin 在 callback 中使用真实 Elysia route tree，但作者仍要先理解一套 Pluxel HTTP publication API：

```ts
ctx.http.plugin.routes(build, { publicPath, path, id, app })
ctx.http.plugin.mount(boundary, options)
```

这套模型产生了两个不一致的 application authority：

- Elysia 决定 route、hook、schema、handler 与 response；
- Pluxel 决定 app 创建参数、mount base、boundary identity、replace handle 与 Fetch publication。

当能力只限于普通 HTTP route 时，这层 callback 仍可工作；一旦作者使用 WebSocket、adapter-sensitive plugin、server context、
async Elysia module 或需要理解 application scope 的工具，Pluxel 的 boundary 就不再是透明组合，而会决定上游能力是否真实存在。

原 workspace 使用 Elysia 1.4，production Node launcher 另外拥有一条手写 transport：

```text
node:http IncomingMessage
	-> Web Request
	-> ctx.http.fetch
	-> Elysia WebStandard adapter
	-> Web Response
	-> node:http ServerResponse
```

Elysia 的 WebStandard adapter 不提供 WebSocket registration/upgrade；原 Node listener 和 Vite middleware 也没有把业务
`upgrade` 交给 Plugin route。因此在被替换模型中，`.ws()` 即使存在于作者拿到的 Elysia 类型上，也不是可用能力。继续给
`HttpService` 增加 `ws()`、upgrade handler 或更多 options 只会建立第二套 Elysia server API，方向与本提案目标相反。

## 为什么以 Elysia 2 + srvx 为基线

Elysia 2 不只是版本升级，它删除了原方案中最不可靠的自制边界：

- application 第一次 build/compile 会发布自己的 sealed generation，后续 route、hook、store、decorator 等 authoring mutation
  fail-fast；Runtime 不再复制或 monkey-patch app；
- `app.routes` 是公开 inventory，Runtime 不需要读取 private router table；
- WebSocket 由 `elysia/websocket` 提供可拆分 capability，upgrade data 携带 connection callback/context，适合一个 carrier 服务多个
  owner application；
- Web Standard fetch handler 与 physical listener 分开，正好对应 Pluxel 的 application contribution 与 host carrier 两层；
- srvx 用同一 Fetch-first server contract 覆盖 Node、Bun、Deno、Cloudflare 等 runtime，Pluxel 不再自己维护
  `IncomingMessage -> Request -> Response -> ServerResponse` 转换链。

本文收口时（2026-08-27）workspace 精确锁定 `elysia@2.0.0-beta.7` 与 `srvx@0.12.7`。作者面已切换到
Elysia 2 public contract，但 beta.7 是明确的 conformance baseline，不是对未来 2.x 的模糊兼容承诺。升级到后续
beta/stable 必须重跑 inventory、seal、Server view、WS 与 lifecycle conformance；任何时候都不把 tilde/private field
写进 Pluxel。

srvx 公开 contract 已覆盖 Fetch、streaming、runtime request context 与 server lifecycle；Node 基线另用 crossws 公开 adapter
连接 Elysia 2 可独立安装的 WebSocket capability。这证明了 Node，不能据此推断 srvx 的其他 conditional runtime 已自动
具备相同 WebSocket attachment；第二 carrier 仍需单独验收。

## 目标

- Plugin 作者学习 Elysia application，而不是学习 Pluxel HTTP framework。
- 一个普通 Elysia function plugin 可以不经 adapter wrapper 直接 `.use()`。
- HTTP、WebSocket、stream 和 request cancellation 在 static、dynamic、Vite 与 production carrier 使用同一语义。
- application/dispatcher package 不导入 `node:*`、Bun 或 Deno API；runtime 差异只存在于 srvx carrier binding。
- route publication 与 Plugin generation 原子绑定；start failure、replacement、rollback、disable 与 shutdown 不留下旧 route 或
  connection。
- PluginPart 可以使用同一个 generation application，不产生 Part server、Part route identity 或第二条 lifecycle。
- Workbench disabled/headless 不影响业务 application，也不引入业务 Elysia backend 之外的可选成本。
- Elysia 与其官方 plugin 在一个 host 中解析为同一受支持版本，不因 dynamic package 自带副本产生 adapter、symbol 或 schema 分裂。
- Runtime 可以替换内部 dispatcher、route index 和 platform carrier，而不改变 Plugin 的 Elysia authoring code。

## 非目标

- 不让每个 Plugin 启动自己的 port、listener 或 process。
- 不承诺 Plugin 可以调用 `listen()`、`stop()`、选择 adapter、配置 TLS 或关闭 root server。
- 不把 Hono、Fastify 或任意 framework 抽象成与 Elysia 并列的 public application SPI；已有 Fetch app 通过 Elysia 原生
  `mount()` 接入。
- 不生成包含 dynamic Plugin 闭包的单一 root Eden 类型；类型边界保持在可静态导入的业务 Elysia module。
- 不支持 running generation 原地增删 route。配置变化建立新 generation；Elysia authoring window 与 `init()` 一起结束。
- 不提供自动 auth、匿名 exposure、tenant、rate limit 或 CORS policy；这些继续由明确的 Elysia plugin、业务 handler 或 host policy
  实现。
- 不把 Plugin 当作恶意代码 sandbox。Plugin 仍是受信任 server code，但 accidental cross-owner mutation 与 resource leak 必须被架构阻止。
- 不保留旧 HTTP API 的 alias、兼容 wrapper 或两套并行作者入口。
- 不因为 srvx 有多个 conditional adapter 就宣称整个 Pluxel 已支持所有 runtime；每个 deployment target 仍需通过 database、worker、
  artifact、HTTP 与 WebSocket 的完整 platform conformance。

## 设计假设

本提案建立在以下前提上；carrier spike 或实现验证若推翻任一关键前提，应回到本提案重新决策，而不是用 Pluxel facade
掩盖差异：

- Plugin 是受信任的进程内代码，隔离目标是 ownership、lifecycle 与组合语义，不是安全 sandbox。
- 一个 Plugin generation 是可独立 start、replace、stop 和 drain 的最小 Web application owner；PluginPart 跟随该 owner。
- 路由集合只在 construction/`init()` 阶段声明。运行期变化通过建立新 generation 表达，不依赖原地卸载 Elysia route。
- production 使用共享 srvx carrier；Vite development 复用同一业务 dispatcher，同时保留 Vite 对 HMR upgrade 的所有权。
- 受支持版本的 Elysia 2 能用公开 API 完成 app composition、route inventory、compile/seal 与可独立安装的 WebSocket；srvx/WS bridge
  能把同一个 carrier server view 提供给 owner apps。尚未证明的部分明确留在 carrier spike，不把 private field 固化成架构。
- 同一个 host 必须让 static 与 dynamic Plugin 解析到一个受控 Elysia runtime；当前 singleton identity 已落地，版本约束
  的 pre-lifecycle admission 仍待 sealed package contract。
- 允许内部多一次 route lookup 来换取 Plugin 间语义隔离；只有实测成为主要瓶颈时才优化 dispatcher，作者 API 不随之变化。
- Node 是当前迁移必须通过的 carrier，且至少再用 Bun 或 Deno 完成同一 dispatcher 的 conformance，才能验证“平台独立”不是类型层口号。

## 作者模型

### 最小用法

Runtime Context 公开一个常驻、generation-scoped capability：

```ts
interface RuntimeContext {
	readonly elysia: Elysia
}
```

第一次读取才创建 authoring app；未使用 Web application 的 Plugin 不创建 Elysia instance、route inventory 或 transport lease。
同一 Plugin generation 的 root Plugin 与全部 PluginPart occurrence 取得同一个 app identity。Part 没有独立 enable、restart 或
withdrawal，因此为 Part 再建 owner app 只会引入虚假的 runtime 边界。Part handler 的日志与错误仍可由闭包中的 Part Context
保留 attribution，但 publication、admission 和 drain 都属于 owning generation。

这个共享关系也意味着 Part 不是 Elysia semantic isolation boundary：不同 Part 与 root Plugin 在 children-before-owner 的实际
registration order 中共同组成一个 application，它们之间的 hook、model、macro 与 named plugin dedupe 按上游 Elysia 规则组合。
这是 PluginPart 属于同一 generation 的直接结果；需要隔离 hook、路径治理或独立 withdrawal 的组成应成为真正 Plugin。

```ts
import { Elysia, t } from 'elysia'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		this.ctx.elysia.post('/orders', ({ body, status }) => status(201, this.create(body)), {
			body: t.Object({
				customerId: t.String({ minLength: 1 }),
			}),
		})
	}
}
```

`@pluxel/runtime` 不重新导出 `Elysia`、`t` 或官方 plugin。使用 Elysia API 的 package 直接声明 `elysia` dependency，避免
Pluxel 建立滞后的 re-export surface。

### 为什么不保留第二参数

`ctx.elysia` 是 application capability，不是 registration method，因此没有 `ctx.elysia(build, options)` 或第二参数。当前
`routes(build, options)` 的 `options` 实际包含 `path`、`publicPath`、`id` 和 `app: ElysiaConfig`；新模型逐项消解：

| 旧字段       | 新模型中的归属                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `path`       | 不再拼到隐藏 owner base；直接在 Elysia route/`group()` 中声明最终 path                          |
| `publicPath` | 删除；所有 Elysia path 本来就是产品 root path                                                   |
| `id`         | 删除；一个 generation 只有一个 contribution identity，replacement 由 graph generation 决定      |
| `app`        | 删除 Pluxel options bag；transport/build options 归 host，业务 composition 使用 Elysia 原生 API |

也不改成 `ctx.elysia(options)`：第一次调用特殊、后续调用忽略或冲突，会制造新的 Pluxel lifecycle 规则，PluginPart 还要协调谁先配置。
Elysia constructor-only options 按责任拆分：`adapter`、`serve`、`precompile`、listener 与 TLS 是 carrier/build policy；`prefix`、scope、
schema、cookie 与 hook 尽量使用 `group()`、`guard()`、route options 和普通 Elysia plugin 表达。确有业务语义、却只有 constructor
入口的 Elysia 2 option，应推动上游提供 pre-seal native API 或将其标准化为 host policy，不恢复一个无边界的 `app` bag。

### 可复用业务 API 使用普通 Elysia function plugin

需要独立测试、Eden type 或跨宿主复用时，把业务 route 写成普通 Elysia function plugin：

```ts
export function ordersApi(service: OrdersService) {
	return (app: Elysia) =>
		app
			.use(websocket())
			.group('/orders', (app) =>
				app
					.get('/:id', ({ params }) => service.find(params.id))
					.ws('/events', {
						body: t.String(),
						message: (socket, message) => service.accept(socket, message),
					}),
			)
}

protected override init() {
	this.ctx.elysia.use(ordersApi(this.orders))
}
```

function plugin 接收 host-created app，因此自然取得正确 carrier server view；`websocket()` 只安装 Elysia 2 的上游 WS capability，
不启动 listener。不要为复用 WebSocket route 预先执行 `new Elysia()` 并固定另一条 physical server lifecycle。standalone Elysia
instance 仍可按上游规则 `.use()` 或 `.mount()`，但其 constructor-only config 与 adapter 语义由该 instance 自己负责。

### 路径就是产品 contract

以下 route 的真实地址就是 `/orders/:id`：

```ts
this.ctx.elysia.get('/orders/:id', handler)
```

不再自动改写为 `/__pluxel/plugins/<node-route>/orders/:id`，也没有 `publicPath`。需要 namespace 时使用 Elysia 自己的
`group()`、route prefix module 或显式完整 path。

这项决策有两个直接后果：

- fork、多个 Part occurrence 或多个 Plugin 若声明同一路径，会得到明确 conflict，而不是自动获得不可预测的隐藏 URL；
- forkable HTTP Plugin 若需要同时运行多个 node，应把业务 base path 建模为已校验 config，或者把 HTTP carrier 放在唯一 gateway
  Plugin 中；Runtime 不从 `forkId` 暗中改写公开 API。

`/__pluxel` 及其子路径始终由 host 保留。保留规则在 contribution finalization 时验证，而不是依赖 route registration 顺序。
访问策略与 route path 正交；`/orders` 不表示匿名，`/__pluxel` 也不自动等于公网不可达。

### 挂载 Fetch application

已有 Fetch/WinterTC application 使用 Elysia 原生能力：

```ts
this.ctx.elysia.mount('/legacy', (request) => legacy.fetch(request))
```

Pluxel 不定义 `HttpBoundary`、`HttpHandler` 或额外 mount handle。Fetch boundary 的异常、request body 和 response contract 按
Elysia `mount()` 语义处理，owner admission 位于整个 contribution 外层。

## Elysia 能力边界

“原生 Elysia”指 application authoring 与 request/connection behavior 保持上游语义，不表示每个 Plugin 都拥有物理 server。

| 能力                                       | Plugin contribution contract                                           |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| route、group、guard、schema、model、macro  | 原生支持                                                               |
| use、derive、resolve、decorate、state      | 在本 generation application 内原生支持                                 |
| request/response/error/trace hooks         | 在本 contribution 内原生支持                                           |
| Elysia 2 `trace()` 等显式 capability       | 按上游方式 `.use()`，不由 Pluxel 隐式安装                              |
| local/scoped/global scope                  | 以本 contribution 为 application root；不跨 Plugin 或 control plane    |
| cookie、stream、SSE、file/Response mapping | 原生支持，并增加 owner cancellation/drain                              |
| `mount()` Fetch application                | 原生支持                                                               |
| `websocket()`、`.ws()`、schema、pub/sub    | Node production/Vite 已通过真实 upgrade；第二 carrier 尚待 conformance |
| `request.signal`                           | client disconnect 与 owner generation abort 的组合 signal              |
| handler context 中的 server view           | carrier-backed view；支持已验证能力，物理 stop/reload fail-fast        |
| async/lazy `.use()` module                 | finalization 等待 `app.modules`；失败使 generation start 失败          |
| `listen()` / `stop()`                      | 明确拒绝；listener 由 launcher 独占                                    |
| adapter、serve、TLS、port、hostname        | host config；不属于 Plugin app config                                  |
| Elysia 2 `setup()` / `cleanup()`           | beta.7 缺少 public external epoch；当前在调用点 fail-fast              |

Elysia 2 把 `setup()`/`cleanup()` 作为 application server lifecycle。目标语义仍是将 contribution 视为 virtual application
server：attach 在发布前运行，detach 在 admission 关闭且 request/socket drain 后 exactly-once 运行，并与
Plugin effects 保持严格逆序。但 beta.7 没有公开 external attach/detach lifecycle runner，当前 Runtime 会把 Plugin app 的
`setup()` 与 `cleanup()` 固定为明确抛错的方法。依赖这两个 callback 的第三方 Elysia plugin 尚不在支持面。

后续只能在上游提供 public epoch seam 后按上述目标接入；Pluxel 不读取 callback 私有数组自行模拟。
`listen()`/`stop()` 与 handler server view 的物理 stop/reload 仍 fail-fast：它们改变共享 listener，不属于 contribution。返回对象仍是
实际 `Elysia` instance，第三方 Elysia plugin 不需要识别 Pluxel wrapper。

“平台独立”不表示每个 runtime 的 server 扩展完全相同。Request/Response、stream、WebSocket route 与 lifecycle 是 portable
contract；`requestIP`、per-request timeout、native file promotion 等 server-specific 能力必须逐 carrier 列入 conformance，不能在
Node 上工作后伪装成通用 Elysia 能力。

### Owner Server view 不是物理 listener handle

Elysia handler 会看到上游 `server` 概念，但该值表示当前 virtual application 的 carrier-backed view。它是普通对象，
不是 Proxy；能力按所有权分成以下几组：

| Server surface                                     | Plugin generation 中的语义                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `fetch()`                                          | 重新进入本 owner sealed app，并重新取得 request admission                        |
| `upgrade()`                                        | 只升级当前 carrier ingress，并自动写入 immutable owner token                     |
| `publish()` 与 socket topic API                    | logical topic 在本 owner 内可见，physical backend 可以共享                       |
| `pendingRequests` / `pendingWebSockets`            | 本 owner 的 live lease 计数，不泄漏 root 总量                                    |
| `url` / `port` / `hostname` / `development` / `id` | carrier 的 readonly snapshot；`id` 是 opaque virtual-server value，不作为图身份  |
| `requestIP()`、`timeout()` 等 runtime capability   | 只有进入该 carrier conformance baseline 后才可用；否则在调用点明确 unsupported   |
| `stop()` / `reload()` / `ref()` / `unref()`        | fail-fast；这些方法控制共享 listener、代码 publication 或进程存活，始终属于 host |

`app.listen()` 由 Pluxel Elysia adapter 同样 fail-fast，`app.stop()` 不能绕过 Server view 去关闭 listener。不得用 no-op 模拟这些调用成功，
也不得把 srvx physical `Server` 原样交给 Plugin。若普通第三方 Elysia plugin 只依赖 portable surface，它无需知道这个 view；如果它要求
physical control 或未进入 conformance 的 runtime extension，则 finalization 或实际调用必须给出明确 unsupported，而不是悄悄降级。

## Application ownership

### Authoring app、sealed generation 与 published contribution

Elysia 2 自己负责从 authoring app 进入 immutable generation，Pluxel 不再复制 application：

```text
ctx.elysia authoring app
	-- await modules + app.compile() --> same Elysia instance, sealed generation
	-- route admission -----> staged contribution
	-- runtime commit ------> published dispatch snapshot
```

`ctx.elysia` 只在 Plugin/Part construction 与 `init()` authoring window 中声明 app。Runtime 在 owning Plugin init 和全部
children-before-owner Part init 成功后执行 package-private generation finalizer：

1. 等待 `app.modules`，让 lazy Elysia modules 完全 settle；
2. 从公开 `app.routes` 读取 declared inventory，预检 reserved path；
3. attach stable owner-bound Elysia Server view 与 generation abort；
4. 调用公开 `app.compile()`，让 Elysia 2 build 并 seal 自己的 generation；
5. 捕获 sealed `app.fetch`、route inventory 与 owner execution boundary；
6. 把 contribution 加入当前 Runtime graph operation 的 staged directory，再与其他 owner 做 settlement。

beta.7 基线不执行 external `setup()`/`cleanup()` epoch；这两个 authoring method 已在 app 创建时被固定为
fail-fast。上游提供 public attach/detach seam 后，才能在第 4 步之后增加 lifecycle epoch，而不读私有 callback。

Runtime request path 只引用 sealed fetch generation。Plugin 在 running 后即使保留同一个 `ctx.elysia` 并继续调用 route、hook、store、
decorator 等 authoring API，Elysia 2 也会以“app was sealed” fail-fast；异常本身保持上游语义，只有当它进入 Pluxel lifecycle/request
诊断边界时才附带现有 Context owner。配置或 source 变化通过正常 Plugin restart 创建全新 app，不调用 Elysia 的 internal
new-generation API，也不提供 `replaceRoutes()`。

采用 Elysia 2 native seal 而不是 Pluxel copy/freeze 的原因是：

- `Object.freeze()` 不能冻结 Elysia 内部 route/router collection；
- Proxy 会破坏 Elysia instance identity、反射和第三方 plugin compatibility；
- monkey-patch 全部 mutating methods 会随 Elysia 新 API 漏洞化；
- `.use(authoringApp)` 复制仍可能遗漏新 capability 或保留错误 adapter state；
- Elysia 2 generation seal 正是上游对 compile 后 mutation、route table 与 callback graph 的权威边界。

### Core 与 Runtime 的 lifecycle seam

Core 不能依赖 Elysia。为避免要求作者调用 `commit()`，Runtime 需要一个 package-private generation finalization seam：

```text
construct Plugin + Parts
	-> inject config
	-> init Parts
	-> init Plugin
	-> runtime-owned generation finalizers
	-> publish generation running
```

该 seam 由 root Context host 在创建前固定安装，只允许 Runtime capability 注册；Plugin 不能追加 finalizer，也不能读取其 registry。
finalizer throw 与 Plugin `init()` throw 使用同一个 start-failed、rollback effects 和 dependent blocking 语义。Context kernel 本身仍然
不拥有 prepare/dispose lifecycle，Core 也不识别 HTTP/Elysia 类型。

同一次 graph operation 还需要一个 package-private publication seam：全部 start outcome 确定后、`CommitSummary` 对宿主和 reader
可见前，Runtime 只提交已经预构造好的 immutable dispatcher pointer。这个 callback 不执行 Elysia compile、setup、route matcher build
或任何 Plugin code，只允许 no-fail pointer exchange。Core 只知道“运行一个预安装的 host publication callback”，不知道 Elysia route
或 carrier；Plugin 也不能注册此 callback。这样稳定点的 running projection 与业务 directory 同时可见，不产生“Core 已 running、route
尚未发布”的可观察窗口。

如果不建立这个 seam，Runtime 只能在 Plugin 已被 Core 标记 running 后才发现 async Elysia module failure、reserved path 或 route
collision，届时类型、lifecycle report 和实际 publication 会互相矛盾。不能用 microtask、Elysia `setup()` 或 toolchain 注入模拟
Core finalization。

### Staged directory 与原子 publication

`RuntimePluginGraphCoordinator` 已串行化 catalog/state/HMR operation；Elysia backend 在同一 operation 内维护 staged directory：

```text
committed directory snapshot
	-> remove generations in stop plan from staged state
	-> finalize successful new generation contributions
	-> reject/fail conflicting contribution
	-> build next immutable dispatcher
	-> before CommitSummary publication, swap one pointer
```

旧 dispatcher 在 transition 期间仍可能被并发 request pin 住，因此每个 delegate 都必须在进入 owner app 前取得 generation admission。
旧 generation gate 已关闭时返回短暂 `503 Service Unavailable`；稳定 snapshot 发布后不存在的 route 返回 `404`。不能因为旧 route
仍在 immutable snapshot 中就绕过 owner gate。

每个 contribution 在 finalizer 内已经完成 compile 与 route preflight；staging 期间也必须把下一份 directory matcher 构造完成。
最终 publication seam 只接收 ready pointer，不再运行可能 throw 的 assembly。若 matcher build 或 dispatcher 构造仍可能在该 seam
发现普通 route conflict，说明 preflight 不完整，不能靠回滚旧 generation 或保留旧 pointer 掩盖。无法仅凭公开 route inventory
完成这项证明时，应先取得上游 route-normalization/matcher seam，不能读取 Elysia private router。

## Dispatcher 与隔离

### 为什么不是一个共享 Elysia app

最短实现看似是：

```ts
root.use(pluginAApp).use(pluginBApp)
```

但 Elysia application composition 不只复制 route。Elysia 2 已改善 route-local decorator/store ownership，却仍会把 global hook、
named plugin dedupe 和 parent extension state 带进共享 composition scope。对 `2.0.0-beta.7` 的 probe 中，
`root.use(A).use(B)` 会让 A 的 global `beforeHandle` 执行在 B route 上，而反向 registration order 不会补作用到 A。一个 Plugin
安装 CORS、auth、trace 或 error plugin 后，行为因此可能取决于 composition order；停止 owner 时也很难证明跨 owner callback 已从
所有 route 撤销。

Pluxel 的 ownership 单位是 Plugin generation，不是“所有后端 Plugin 共同维护的 mutable Elysia root”。因此第一版采用两级模型：

```text
carrier ingress
	├─ /__pluxel and management  -> host-owned Elysia app
	├─ business route directory -> one sealed owner Elysia 2 generation
	└─ unmatched navigation     -> host UI/application fallback
```

route directory 使用 Elysia 自己的 route grammar/matcher 注册 delegate route，不自行发明 path parser 或不同 precedence。匹配 owner
后调用该 sealed generation 的 `app.fetch(request, ownerServerView)`，所以 owner app 内部仍执行完整 Elysia hooks、schema、response
mapping、WebSocket upgrade 和 error boundary。
这是一次有意识的 double routing；只有 benchmark 证明它是主要瓶颈，并且上游提供可稳定提取 compiled route handler 的公开 seam 后，
才优化成 direct handler dispatch。不能通过读取 Elysia private router table 换取一次 lookup。

### Route inventory 与 collision

finalization 从上游公开 route inventory 构造以下 runtime-owned fact：

```ts
type ElysiaContributionRoute = Readonly<{
	kind: 'http' | 'websocket'
	method: string
	declaredPath: string
	owner: PluginNodeAddress
}>
```

该类型是 proposal 中的内部说明，不预先承诺 public export。当前 collision key 精确为
`kind + method + declaredPath`：只有三者都相同的跨 owner route 会使新 generation start 失败。`ALL` 与具体
method 可共存，directory 在请求时先选具体 method；static、param 与 wildcard route 继续按 Elysia matcher precedence 处理。

这不是 canonical collision proof。例如 `/users/:id` 与 `/users/:name`、可选/trailing-slash 等 matcher-equivalent 形式尚不会
因“可能匹配同一请求”被拒绝。beta.7 没有一个足以证明完整规范等价的 public compiled matcher signature；
Runtime 不复制 Elysia route grammar 猜测等价性。

已受支持的 exact 跨 owner collision 在 generation settlement 阶段拒绝正在启动的 contribution，错误诊断包含
method、declared path 与双方 owner label。
同一个 owner authoring app 内重复声明的处理继续完全交给 Elysia，不由 Pluxel 改写成另一套规则。

settlement 按 Core 提供的 `started` 顺序检查新 contribution；该顺序来自 provider-first start plan，所以同一
operation 中先被接受的 exact route 使后续冲突 candidate 失败，已发布且未停止的 owner 也优先于新 candidate。
这是 lifecycle settlement 的确定性，不是 route last-wins 或业务 precedence。构建最终 immutable snapshot 时再以 canonical
`ownerKey.localeCompare` 稳定排序，只用于确定性 build/diagnostics；Part 不形成独立 owner 或排序节点。

## HTTP invocation 与 response body

每个进入 owner app 的 request 取得 generation invocation lease。lease 不在 handler Promise 返回时立即释放；如果返回 streaming
`Response`，它延伸到 response body close、cancel 或 error：

```text
route matched
	-> owner gate admit
	-> run complete Elysia application
	-> write/buffer response body
	-> body close/cancel/error
	-> release owner lease
```

adapter 向 Elysia 暴露的 `request.signal` 合并：

- client disconnect / response peer close；
- Plugin generation abort；
- carrier 自己明确配置的 request cancellation。

generation stop 先关闭 admission，再 abort 已接纳 request，然后等待 handler 与 response body settle，最后 drain effects。忽略
signal 的 handler/stream 仍受 Core lifecycle timeout/report 约束；Runtime 不谎称能够同步终止任意 JavaScript。

手动 cancel response body、HEAD/no-body response 与 handler throw 都必须 exactly-once release lease。测试不能只等待
`app.fetch()` 返回，因为 streaming body 此时尚未结束。

## WebSocket ownership

WebSocket 是本提案必须解决的 transport，不是后续在 `HttpService` 旁边增加的可选 helper。

### Upgrade

carrier/Vite ingress 在 upgrade 前读取当前 immutable directory snapshot，使用与 HTTP 相同的 Elysia route pattern 选择 contribution，
然后：

1. 取得 owner generation connection admission；
2. 执行 Elysia `upgrade`、schema、beforeHandle、cookie/header 与 error contract；
3. 由 owner Elysia Server view 把 immutable owner token 和 generation lease 加进 Elysia 2 upgrade data；
4. 由 srvx/WS bridge 完成 runtime-native upgrade。

upgrade 失败或 client 在握手期间离开会释放 lease。被停止 generation 的旧 dispatcher 即使仍被某个并发 upgrade pin 住，也不能接纳
新 connection。

### Connection lifetime

connection lease 从成功 upgrade 延伸到 close/error/forced termination 完成。`open`、`message`、`drain`、`ping/pong`、`close`
与 error callback 始终使用 socket 保存的 owner token，不使用 mutable module-level current owner。

generation stop/replacement：

1. 拒绝新 upgrade；
2. abort owner connection signal；
3. 对旧 generation sockets 发送 `1012 Service Restart`；
4. 给 close callback 和 buffered write 一个 host-bounded graceful window；
5. 到期后 terminate socket；
6. 等待 connection lease settlement，再 drain generation effects。

Plugin disable/shutdown 可以使用不同 close reason，但 code/reason 必须是小型、无敏感信息的 host contract。第一版不公开 per-Plugin
WebSocket drain timeout；真实调优需求出现前由 host 使用一个有界 policy。

topic/pub-sub backend 可以按 root 共享，但每个 owner Server view 必须把 Elysia logical topic 映射到 owner-scoped physical key；
`subscribe()`、`unsubscribe()` 与 `publish()` 对作者保持普通 Elysia 语义，同名 topic 不会意外跨 virtual
application 收发消息。subscription 和 socket 仍由 connection owner 持有，owner stop 只关闭自己的 sockets 和 subscription，不删除
另一个 owner 的同名 logical topic。需要跨 Plugin 通信时使用明确的 Plugin dependency protocol 或 `ctx.events`，不借共享 carrier topic
建立隐藏依赖。carrier spike 必须证明该映射能通过公开 WS/socket seam 完成。

### Elysia 2 WebSocket capability 与 carrier bridge

Elysia 2 的 `websocket()` capability 把 route upgrade 与 carrier-level socket callbacks 分开。目标组合是：

```text
sealed owner app.fetch(upgradeRequest, ownerServerView)
	-> Elysia validates request and calls ownerServerView.upgrade(..., { data })
	-> carrier WS bridge performs native upgrade
	-> one Elysia 2 global socket handler dispatches callbacks from connection data
```

这比 Elysia 1.x 的 per-adapter private WebSocket registry 更符合 generation ownership：socket data 在 upgrade 时已经 pin 到 immutable
owner，不需要 graph replacement 后再查 mutable app registry。carrier 仍需维护 owner -> sockets index，以完成 1012 drain。

Node 实现已通过公开 `elysia/ws`、crossws Node adapter 和 srvx `NodeRequest` 完成这条路径，并保留
owner -> sockets 索引、topic 隔离与 1012 drain。srvx 负责 portable Fetch/listener，crossws 负责当前 Node WS attachment；
Bun/Deno 第二 carrier 尚未证明同一 runtime-private carrier contract 足以吸收它们的 upgrade/close 差异。任何后续实现都不得：

- import `elysia/dist/*`、`@elysiajs/node/dist/*` 或 srvx private chunk；
- 读取 Elysia tilde/private field 提取 WebSocket callback 或 lifecycle callback；
- 复制上游 response composer、router 或 WebSocket message/schema pipeline；
- 在每次 graph commit 重启 listener 或断开无关 Plugin connections。

beta.7 的 global WS handler 与 owner Server view 已可以只用 public exports 实现；external attach/detach lifecycle epoch 仍不可用。
不能为补这一缺口退回 Elysia 1.x Node adapter private backing，也不能把 beta 内部形状固化进 Pluxel。

## Host carrier

### Portable application/carrier seam

application 层只发布下面三类 runtime-private value：

- `(request: Request) => Response | Promise<Response>` business dispatcher；
- Elysia-compatible owner Server view，用于 upgrade、publish、request metadata 与经过验证的 server capability；
- owner-bound HTTP/stream/WebSocket lease registry。

Runtime application directory 拥有 immutable business pointer、owner lease 与 route selection；host HTTP backend 拥有
`/__pluxel` control app 与 SPA/Workbench fallback arbitration。这些都不暴露给 Plugin。

physical carrier 把 dispatcher 接到实际 runtime，拥有：

- listener、host/port 与 signal shutdown；
- HTTP streaming/backpressure 与 client disconnect；
- WebSocket upgrade、connection registry 与 forced drain；
- request metadata 与 physical server capability。

listener callback 和 upgrade callback 都只读取一次 snapshot pointer；已经接纳的 request/socket pin 住相应 contribution lease，不因随后
pointer swap 改投另一个 generation。

production Node launcher 已不再手写 `node:http` 转换链。srvx Node adapter 负责 Request/Response、streaming、backpressure、
disconnect 与 TLS options，`@pluxel/runtime-node` 用 crossws 补上 Node upgrade/connection transport；Pluxel Runtime 只实现
graph-aware dispatch 与 WS ownership。Bun 或 Deno 仍是第二个 portability proof，它必须使用相同 contribution、directory 和
lifecycle code，不允许复制一个 `BunHttpService`/`DenoHttpService`。

### Vite development

static/dynamic Vite route 保留 Vite 对 source、asset 与 HMR client 的所有权。Vite 仍持有它的 Node listener，Pluxel 通过 srvx 的公开
Node handler bridge 接入同一个 portable dispatcher；业务 application 不能只有 Connect HTTP middleware：

- 普通业务 request 进入与 production相同的 directory dispatcher；
- `upgrade` 先排除 Vite HMR path，再用 business WS directory 匹配；
- unmatched request/upgrade 交还 Vite；
- Plugin replacement 只替换 directory snapshot，不重启 Vite server；
- static 与 dynamic mode 使用同一 transport integration，差异仍只在 catalog/source policy。

Vite HMR WebSocket 与业务 WebSocket 的 path arbitration 必须有 integration test；不能以“两个功能单独可用”推断它们在一个 server
上不会抢 upgrade listener。

### Test host

测试不再通过 `ctx.http.fetch` 访问 root service。Runtime/static test host 直接暴露 host carrier：

```ts
const response = await host.fetch(new Request('http://local.test/orders/1'))
```

`host.fetch` 走真实 directory、owner admission 和 sealed Elysia generation，但不打开端口。WebSocket、client disconnect、backpressure
与 carrier conformance 使用真实 ephemeral listener；纯 fake socket 只能覆盖领域 callback，不能替代 upgrade integration。

## Elysia dependency 与 package 边界

Elysia 2 是 host-owned authoring/runtime singleton，而不是每个 Plugin 可以私带任意版本的普通实现依赖。这个 contract
分成两个不可混为一谈的问题：

- **runtime identity**：Plugin 实际执行时，`elysia` 根入口、adapter、WebSocket 与其他公开 subpath 必须解析到 host
  singleton；
- **version admission**：构建/加载计划必须验证 Plugin 声明的 Elysia 兼容 range 是否接受 host 版本，并在
  constructor 进入 lifecycle 与 generation 前再完成 runtime admission。

目标 package contract 是：

- `@pluxel/runtime` 固定一个经过 conformance 验证的 Elysia 2 minor range；
- 发布的 Plugin package 把兼容 range 声明为 `elysia` peer dependency，并可用同 range dev dependency 完成本地编译/测试；不得把另一份
  Elysia bundle 进 Plugin artifact；
- static freezer 把 Elysia、`elysia/websocket` 等 capability 与官方 plugin closure 解析为一个受控实例；
- static 与 dynamic route 在共享 admission seam 验证 Elysia range；dynamic loader 还要将 authoring import 解析到
  host 支持的 singleton；
- 不再使用 `instanceof Elysia` 判断 contribution 类型；contribution 来自 Context capability 的确定 generation slot。

不做 singleton 管理会让 Elysia symbols、schema classes、capability provider、plugin dedupe 和 WebSocket context 在 dynamic source 中分裂。
这不是为了隐藏上游，而是维持“同一个 Elysia application runtime”所必需的 package contract。

### 当前实现边界

当前实现只完成 runtime identity：host 固定 `2.0.0-beta.7`，dynamic Vite/ModuleRunner 将 Elysia 公开入口导向 host
singleton。它**尚未**实现 Plugin manifest 的 semver admission，不得将“实际只加载一份实例”表述为“已证明作者
依赖兼容”。

现有 ingestion 没有可以正确加检查的共享 seam：

- lowering 生成的 `ConcretePluginDefinitionCandidate` 只携带 implementation 与 graph declaration，没有 sealed package dependency
  contract；
- common catalog provenance 只有 module/source/artifact 投影；static catalog 没有 package manifest，dynamic catalog 也只有
  `moduleId`；
- dynamic scanner 能读到部分 package manifest，但它不覆盖 static definition、fixed import 和普通 source entry，因此不能
  成为两种 Runtime route 的语义权威。

在共享 seam 完成之前，发布 Plugin 仍应将 `elysia` 写为与 host 兼容的 peer dependency，并使用匹配的
dev dependency 编译和测试；不发布的 application/private monorepo package 可以使用 workspace 统一的 exact direct
dependency。这些是发布与 workspace policy，不是 Runtime 已经强制的保证。

### 共享 version admission seam

后续不应在 `ScanService` 或 dynamic loader 中现场再造一套 package scanner。Plugin package plan 应成为单一的契约
producer：

1. 从 owning package manifest 读取并规范化 `elysia` peer range，在构建/加载计划阶段先与 host contract 比对；
2. 将已验证的 range、owning package identity 与 lowering ABI version 封存成 runtime-private dependency contract；
3. 由 static freezer 和 dynamic loader 把这个 contract 作为 route descriptor 的数据交给 common catalog，而不是让 Core
   或 catalog 再读 filesystem manifest；
4. 由 common catalog admission 在任何 Plugin lifecycle 进入已发布 generation 前，用 host 的 exact Elysia 版本做一次
   semver 判定，并返回稳定、可诊断的 contract error。

constructor-based static definition 在 Runtime 看到它之前已经经过 JavaScript module evaluation，所以 common catalog 不应虚假承诺
“任意 module 评估前拦截”。static route 的评估前保证来自 freezer/build plan；dynamic 只有在 loader 先拿到 sealed route
descriptor 时才能做同样的 pre-evaluation admission。common catalog 是两条 route 在 lifecycle/publication 前的共享防线，不是
package loader 或 sandbox。

缺失 peer 的 package Plugin、无法解析的 range 与不兼容 range 都应在此失败；application-owned source Plugin 没有发布
package peer contract，它的 Elysia 版本由 host application lockfile 直接控制。这样不会让 static/dynamic 出现两种版本语义，也不会
为了做 admission 而将 filesystem/package-manager 知识泄漏进 Core lifecycle。

srvx 只属于 launcher/carrier package，不进入 Plugin dependency graph，也不由 `@pluxel/runtime` re-export。application/dispatcher package
不得导入 `node:*`；Node/Vite binding 才能导入 `srvx/node`。内部会存在窄 `PlatformCarrier`，但第一版不公开自定义 carrier SPI；等第二个
真实 deployment target 能满足 Runtime 的 database、persistence、worker、artifact 与 WebSocket closure 后，再根据两份实现提取 public
contract。Elysia 自身的 adapter 与 srvx `Server` 都只是该内部实现的组成，不自动等于完整 Pluxel platform adapter。

## Control plane 与 host policy

业务 contribution 永远不能声明 `/__pluxel`。control plane 使用独立 host-owned Elysia app，先经过 AdminAccess policy，再调用既有
runtime use case。Plugin local/global hook、error handler、decorator 或 store 不能影响 management request。

Workbench UI/static fallback 只在 business directory 返回 route-absent 时运行。业务 handler 主动返回 404 仍是已匹配 route 的响应，
不能被 SPA fallback 改写；否则 Plugin 无法表达领域 404。

需要覆盖全部业务 API 的 CORS、auth、request limit 或 observability policy 时，由 launcher 在 business dispatcher 外安装 host policy。
Plugin 内 `.use(cors())` 等 Elysia plugin 只影响该 contribution。两种 scope 必须在文档中分别命名，不能依赖 Elysia contribution
composition order 暗中获得 global policy。

## 失败与诊断

HTTP application 失败不全发生在同一 phase，但都不得产生部分 publication：

- Plugin init/authoring：`setup()` / `cleanup()` 与 physical lifecycle 调用立即 fail-fast，按普通 init failure rollback；
- generation finalization：reserved path、lazy Elysia module rejection、authoring app compile failure、Server view 或 public route
  inventory 无法建立；
- generation settlement：已受支持的 exact 跨 owner HTTP/WebSocket route conflict 拒绝新 candidate；
- host/carrier attach 或请求期：请求了当前 carrier 未提供的 server capability 时明确 unsupported，不做 no-op。

init/finalization/settlement 失败作为 start failure 进入现有 lifecycle report 并阻塞 required dependents。

诊断面使用稳定、封闭的内部 kind，例如 `elysia_reserved_path`、`elysia_route_conflict`、
`elysia_module_failed`、`elysia_compile_failed` 和 `elysia_transport_unsupported`。是否把这些 kind 提升为 public lifecycle error
contract，应由调用方是否需要程序化分支决定；第一版不要暴露 Elysia private error/details。message 可包含安全的 method、path 与 owner
label，不能包含 request credential、body 或绝对文件路径。

请求期未知异常进入 owner logger 并返回通用 500；Elysia 显式 status/Response 与 error handler 保持原语义。WebSocket callback
异常进入 Elysia error contract；无法恢复时关闭该 connection，不让一个 Plugin callback 终止整个 carrier WS server。

## 被否决的替代方案

### 保留 `ctx.http.plugin.routes()` 并增加更多 options

它继续要求作者理解 Pluxel mount、Elysia app config 和 transport capability 三层语义，WebSocket 最终会变成另一个 Pluxel API。
这不能实现扁平认知。

### Plugin 自己 `new Elysia()` 后显式 `ctx.http.mount(app)`

显式 mount 仍是一份第二作者协议；standalone app 还会提前选择 adapter，WebSocket capability 可能与 host carrier 分裂。cleanup 与
finalization 仍需要额外 handle。

### 新建 `ElysiaPlugin extends BasePlugin`

专用 base class 会占用唯一继承位，迫使非 HTTP Plugin 和未来 capability 形成 base-class 矩阵，也让 Elysia integration 进入 Core
Plugin inheritance contract。Context capability 更符合现有 Runtime 组合方式。

### 让 `init()` 返回 Elysia app

`init()` 当前返回 cleanup/disposable。把 Elysia app 加入返回 union 会混淆 publication 与 teardown ownership，并让“同时返回 cleanup 和
app”需要新 wrapper。它还不能覆盖 PluginPart contribution。

### 所有 Plugin 直接修改共享 root Elysia

共享 mutable root 无法撤销单个 generation 的 model、hook、store、macro 与 WebSocket callback；一个 Plugin 失败或 replacement 时也无法
构造隔离 rollback。它与 Plugin owner 模型冲突。

### 把所有 owner app 直接 `.use()` 到一个 root

route 可以工作，但 Elysia global hook、named plugin dedupe 与 parent extension state 会形成共享、顺序相关的 semantic scope。除非
上游提供明确的 application-isolation composition primitive 并通过 conformance 验证，否则不能用这种方式代替 owner dispatcher。

### 每个 Plugin 启动独立 listener，再由 root 反向代理

它让 `.listen()` 看似完整，却引入 port、connection pool、proxy headers、stream 转发、shutdown ordering 和每 Plugin server 预算，完全
违背一个 root backend 与轻量 Plugin generation。

### 继续以 Elysia 1.x / `@elysiajs/node` 为目标

这会让 Pluxel 自己补 application sealing、route inventory 和共享 WebSocket registry，而 Elysia 2 已把这些问题重构成 generation、
public inventory 与可独立安装的 capability。新 public API 没有兼容负担，不应把 1.x adapter 的限制永久写进架构。

### 把 srvx 暴露给 Plugin 作者

srvx 是优秀的 carrier，不是 Elysia application authoring framework。让 Plugin 同时认知 Elysia route 和 srvx handler/middleware 会重新
制造两个作者 authority。Plugin 只看 Elysia 2；srvx 留在 launcher 与 platform binding。

### 永久把 WebSocket 留在未来

本提案的判断依据就是当前 Fetch boundary 不能诚实承载 Elysia application。若第一版不贯通 `.ws()`、upgrade 和 connection drain，
就不能删除旧 API 并宣称新架构解决了能力问题。

## 实施进度

public 作者面只进行了一次不兼容切换，没有保留两套并行 contract。当前进度按能力而不是按 package 分割：

### 已落地

- Elysia 2 beta.7 singleton、真实 `ctx.elysia` instance、lazy generation scope 与 PluginPart 共享；
- package-private generation finalization/settlement/prepare/publish hooks；
- `app.modules`、public `app.routes`、native `app.compile()`/seal、reserved namespace 和 exact declared collision；
- owner Server view、HTTP/stream admission、abort/drain、immutable directory 和 atomic pointer swap；
- Node production srvx carrier、crossws/Elysia WS bridge、request metadata、client disconnect、owner topic 隔离与 1012 drain；
- Node-backed static/dynamic Vite 的共享 Fetch dispatcher 与 business/HMR upgrade arbitration；
- `ctx.elysia` 单一作者入口、`host.fetch` 测试边界、workspace/starter 迁移与旧 Plugin HTTP publication API 删除；
- management/control application 与 business contribution 隔离。

### 已明确降级为 fail-fast

- `app.listen()` / `app.stop()` 与 Server view 的 physical `stop/reload/ref/unref`：它们属于共享 listener；
- `app.setup()` / `app.cleanup()`：beta.7 没有 public external attach/detach epoch，不读取 `~ext` 私有 callback。

### 仍需收口

- Bun 或 Deno 第二 carrier 与 Node 共用的 HTTP/stream/WS/lifecycle conformance suite；
- canonical-equivalent route collision signature；当前只有 exact declared collision；
- Plugin package `elysia` peer range 的 sealed metadata 与 static/dynamic 共享 admission；
- 上游 public external application lifecycle epoch，之后才能实现 `setup()`/`cleanup()` success/rollback/drain；
- 更广的官方 Elysia plugin 与 server-specific capability conformance，以及基于同场数据的 benchmark。

## 最终验收条件

以下是完整目标 gate，不是对当前共享树全部已完成的声明。上节“仍需收口”已明确列出尚未满足的项目。

### 作者 API

- workspace 中不存在 `ctx.http.plugin`、`publicPath`、`ElysiaRouteHandle` 或 Plugin `HttpBoundary` 调用；
- `ctx.elysia instanceof Elysia` 为真，且不是 Proxy；
- 普通 Elysia function plugin 不需要 Pluxel wrapper 即可 `.use()`；
- Elysia schema 与 route chain 推导不经过 Pluxel 重声明；
- finalization 后 route/hook/store/decorator mutation 由 Elysia 2 native seal fail-fast，且不改变 running publication。

### Elysia conformance

- 覆盖 route methods、params/query/header/body/response schema、model、macro、guard、derive/resolve、decorate/store；
- 覆盖 local/scoped/global hook 在单 contribution 内的上游语义，并证明不跨 owner；
- 覆盖 async `.use()` success/failure；
- 覆盖 Elysia `mount()` Fetch app、stream、SSE、file、cookie 和 error handler；
- 覆盖 `elysia/websocket` 与其他 Elysia 2 公开、可独立安装的 capability；
- 覆盖 `setup()`/`cleanup()` success、failure、late cleanup registration 与 exactly-once detach；
- 选择至少三个真实官方 Elysia plugin（含 CORS/OpenAPI 类与一个依赖 request context 的 plugin）做集成，而不是只测自制 fixture；
- 证明 `listen()`/`stop()` 和 physical server stop/reload fail-fast，不是假成功或误关 root listener。

### Lifecycle

- Plugin start failure、Part init failure 和 rollback 不发布 route/socket；
- replacement 后新 request 只进入新 generation；
- disabled/stopped owner 稳定返回 404；
- 旧 snapshot 命中已关闭 gate 时不执行 handler；
- stream lease 延伸到 body settle，client disconnect 与 generation abort 都可见；
- route conflict 只使冲突 generation start 失败，不破坏无关 branch；
- setup failure 不发布 contribution，已登记 Elysia cleanup 与 Plugin rollback 均执行；
- owner drain 等 HTTP body/socket settle 后先执行 Elysia cleanup，再按 effects 逆序执行更早的 Plugin cleanup；
- cached authoring app 不能在 stop 后重新发布 route。

### WebSocket

- static Vite、dynamic Vite、production Node 与第二 conformance carrier 均完成真实 upgrade；
- Vite HMR socket 与 business socket 共存；
- open/message/drain/close/error 与 schema/upgrade headers 保持 Elysia 语义；
- connection 保存 immutable owner token，并在 replacement 以 1012 关闭；
- 同名 logical topic 在不同 owner application 间隔离，subscription/publish 不跨 owner 串线；
- 不配合 close 的 socket 在 bounded window 后 terminate，Core drain 最终 settle；
- 一个 owner stop 不关闭无关 owner connection 或共享 listener；
- 旧 upgrade snapshot 不能越过 closed generation gate。

### Package与宿主

- static/dynamic 解析同一个 host-owned Elysia runtime；
- dynamic package 的 incompatible Elysia range 在执行 Plugin 前被拒绝；
- 使用锁定的 Elysia 2 public exports；实现不 import Elysia/`@elysiajs/node` 私有 dist path 或 srvx private chunk；
- application/dispatcher package 不 import `node:*`、Bun、Deno 或 Vite；
- Node 与至少一个 Bun/Deno carrier 复用同一 dispatcher/lifecycle suite；
- management/control route 不受 Plugin hook/store/error 影响；
- Workbench disabled 时 business Elysia 与 WebSocket 仍可运行，且不创建 Workbench backend；
- 生产 listener shutdown 同时等待 HTTP body、WebSocket 与 Plugin effects，不留下进程保活资源。

## Benchmark 的位置

Benchmark 是实现验收的一部分，但不决定作者模型。先证明能力、ownership 和 failure 语义，再比较：

- 同一 srvx carrier 上 plain Elysia 2 与 directory delegate 的 HTTP 开销；
- 1/10/100/1000 contributions 的 route match 与 snapshot build；
- stream/WebSocket 在 replacement 下的内存与 drain；
- 一次 Elysia route lookup 与 double routing 的相对成本。

结果用于发现需要优化的内部边界，不把 dispatcher、route index 或 carrier tuning 暴露成 Plugin config。没有同场数据时不对外声明
“接近裸 Elysia”或跨机器延迟 SLA。

## 已回答与仍待证明

| 问题                                                           | 当前结论                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| native seal、public routes、lazy modules 能否构造 contribution | 已证明并实现；不读 Elysia tilde/private state                                                           |
| public WS handler 能否服务多 owner                             | Node + crossws 已证明；owner token/topic/drain 已接入，跨 runtime 证明尚缺                              |
| Vite 能否共存 HMR 与 business upgrade                          | Node-backed static/dynamic binding 已接入现有 Vite listener                                             |
| owner Server view                                              | 已有 carrier metadata、requestIP、upgrade、publish 与 owner pending counts；physical controls fail-fast |
| external `setup()`/`cleanup()` epoch                           | beta.7 没有 public seam；当前 fail-fast，等待上游能力                                                   |
| canonical collision signature                                  | public inventory 只能诚实支持 exact declared key；matcher-equivalent 判定尚待上游 seam                  |
| Node 与 Bun/Deno 语义能否共用同一 carrier contract             | Node 已证明；第二 carrier 尚未实现，因而不得宣称已 portable conformance                                 |
| Plugin Elysia peer range                                       | singleton identity 已接入；sealed package contract 与 common admission 尚未实现                         |

后续任何缺口若只能靠长期读取 private field 实现，应保持明确 unsupported/fail-fast 并优先寻找上游 extension
seam，不能在文档中把类型存在写成能力已经完成。
