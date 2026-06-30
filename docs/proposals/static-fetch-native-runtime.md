# Static Fetch-Native Runtime

状态：设计目标和网络模型审计。

本文记录 static 路线的目标形态：`runtime -> runtime-static` 可以被 `tsdown` 静态打包成最小 JavaScript，运行在任意 fetch-native 环境中，例如 Node fetch server、Vite preview/dev bridge、Cloudflare Workers、Bun、Deno Deploy 或其他 WinterTC-style host。

dynamic 路线不追求这个目标。dynamic 可以继续依赖 Vite runner、workspace scan、package manager、module graph、HMR replacement 和 Node/Vite 能力。

HTTP 框架选择不再作为开放抽象目标：Pluxel static runtime 以 Elysia 作为唯一 HTTP route framework。最小化目标不是移除 Elysia，而是在 Elysia + core plugin runtime 的前提下，避免把 dynamic/dev/control-plane/Node-only 服务打进 production static bundle。

## 目标

static 路线的生产入口应该是一个 fetch-native kernel：

```ts
export default {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		return app.fetch(request, env, executionCtx)
	},
}
```

Pluxel static runtime 在这个模型里只负责：

- 启动 fixed plugin catalog。
- 提交 core lifecycle。
- 提供基于 Elysia 的 plugin-scoped HTTP route/mount table。
- 暴露一个稳定的 `fetch(request, env?, ctx?) -> Response`。
- 通过显式适配器接入持久化、日志、assets、vault 和 host capabilities。

宿主负责：

- 监听端口或提供平台 `fetch` 入口。
- 选择部署平台和 adapter。
- 决定是否启用 control-plane、GraphQL、SSE、runtime web UI。
- 决定 assets 如何提供，例如 bundled manifest、KV/R2、静态站点、外部 CDN。

## 非目标

- 不把 dynamic HMR 做成 Worker-native。
- 不让 static 继承 loader scan/package/cache/module replacement。
- 不为了兼容旧入口保留重的默认依赖。
- 不把 Vite、GraphQL、SSE、Node fs、Vault、runtime web UI 作为 static production 的必需依赖。
- 不为多个 HTTP framework 设计额外 adapter 层；Elysia 是唯一 route framework。
- 不把 logger 过度抽象成平台插件系统；logger 必然存在，但 sink 必须可替换。

## 插件自由度

插件 HTTP 能力以 Elysia 为主入口，最终仍编译到 fetch boundary：

```ts
type HttpHandler = (
	request: Request,
	env?: unknown,
	ctx?: unknown,
) => Response | Promise<Response>

type HttpBoundary = Elysia | HttpHandler | { fetch: HttpHandler }
```

插件可以选择：

- `ctx.http.plugin.routes((app) => app.get(...))`。
- `ctx.http.plugin.elysia()` 创建插件作用域 Elysia app。
- `ctx.http.plugin.mount(...)` 作为低层 escape hatch，用于 GraphQL Yoga 这类已经提供 fetch 的库。

Elysia 是 Pluxel 的唯一 HTTP route framework，不需要再为 Hono、Express 或任意 router 做一层 framework-neutral authoring 抽象。`mount(...)` 只是为了接入 fetch-native 子系统，不代表 Pluxel 支持多个 HTTP framework。

## 目标包边界

推荐拆成清晰的 public surfaces：

- `@pluxel/runtime-static/fetch`
  - production fetch-native static kernel。
  - 可以 import Elysia。
  - 不 import Vite、Rolldown、chokidar、Node http、Node fs 默认实现、GraphQL control-plane、SSE control-plane 或 Vault 默认实现。
  - 可以被 app 使用 `tsdown` 直接 bundle。
- `@pluxel/runtime-static`
  - 仍可导出通用 static host 类型和 `defineStaticRuntime(...)`。
  - 生产入口应尽量转向 `./fetch`。
- `@pluxel/runtime-static/vite`
  - dev-only Vite route。
  - 拥有 static source transform、config reload、static HMR、source UI dev capability。
- `@pluxel/runtime/node`
  - Node `IncomingMessage` / `ServerResponse` adapter。

如果不想增加太多 package subpath，至少要保证 fetch production subpath 不会因为 barrel export 把 Vite/Node-only/control-plane/Vault 默认实现拉进 bundle。

## 当前模型审计

当前方向正确的部分：

- `HttpHandler` 已经是 `Request -> Response`，并预留 `env` / `ctx` 参数。
- `HttpBoundary` 已经允许 Elysia、函数或 `{ fetch }`，可以覆盖普通 Elysia routes 和少量 fetch-native escape hatch。
- `HttpService.fetch` 是 runtime 对外网络入口。
- dynamic Vite route 已经通过 fetch bridge 挂进宿主 Vite server。
- static host 示例也通过 `host.ctx.http.fetch(request)` 对接外部 Node server。

当前影响最小 fetch-native bundle 的部分：

- `HttpService` root router 直接依赖 Elysia；这是可接受的，但需要避免它顺带拉入 control-plane、Node fs 和 dev-only 模块。
- `@pluxel/runtime/services` barrel 同时导出 Elysia、Node adapter、GraphQL、SSE、fs、vault 等能力，容易让 production static bundle surface 变重。
- `@pluxel/runtime` 的 side-effect `runtime/register` 一次性注册所有 runtime services，缺少 static fetch kernel preset。
- `HttpService` 默认 control-plane 是开启的，默认 UI assets 是 `static-built`，会自然牵引 GraphQL/SSE/web/static asset serving。
- 多个服务默认使用 `process.cwd()` 或 Node fs backed storage；fetch-native 环境必须显式替换这些默认项。
- `@pluxel/runtime-static` 的 package 依赖包含 `@pluxel/rolldown`、`chokidar` 和 Vite peer，这些属于 dev/static-HMR surface，不应该污染 production fetch surface。
- `runtime-static/vite` 里保留了一套本地 request/response proxy，可以收敛到共享 fetch adapter，减少重复。

## 优化方向

### 1. 保留 Elysia，但瘦身 HTTP production surface

当前 root app 可以继续由 Elysia 负责，但 production surface 应只包含：

```text
Elysia root
-> plugin-scoped Elysia routes / mounted fetch boundaries
-> optional static assets fallback
-> optional HTML/control-plane fallback
-> not-found
```

这层只需要处理：

- base path normalize。
- mounted route replace/dispose。
- owner effect cleanup。
- error boundary。
- optional fallback handler。

收益：

- 插件作者只面对 Elysia，不需要理解多 framework adapter。
- HTTP route table 仍然直接暴露 fetch-native host boundary。
- 不引入额外 framework-neutral router。
- Worker-native target 更容易通过。

### 2. 引入 static fetch preset

新增一个最小 runtime service preset，只注册 static production 必需项：

- config service，默认 memory 或 explicit adapter。
- runtime state，默认 memory 或 explicit adapter。
- plugin data，默认 disabled 或 explicit adapter。
- Elysia-backed HTTP fetch service。
- verification，默认 private/no-op。
- vault，默认 disabled 或 explicit adapter。
- extension service，仅当插件 UI assets 需要时启用。
- logger，始终存在，但只要求 sink 可配置。

不要在 fetch preset 中默认启用：

- internal GraphQL control-plane。
- package manager。
- loader/dynamic services。
- Vite/HMR/dev services。
- Node fs backend。
- file logger。
- Vault。

### 3. Control-plane 显式 opt-in

fetch-native production host 应默认是最小业务 runtime：

```ts
createStaticFetchRuntime(definition, {
	controlPlane: false,
	uiAssets: false,
	vault: false,
	state: memoryState(),
	config: memoryConfig(),
	logger: {
		sinks: [consoleSink()],
	},
})
```

需要 runtime web UI 时再显式启用：

```ts
createStaticFetchRuntime(definition, {
	controlPlane: {
		web: true,
		rpc: true,
		sse: true,
	},
	uiAssets: bundledAssets(manifest),
	vault: workerKvVault(env.PLUXEL_VAULT),
})
```

这样 static runtime 可以覆盖两类场景：

- 最小 serverless plugin runtime。
- 带 Pluxel control-plane 的完整宿主。

### 4. Assets 改成 provider 模型

不要让 static fetch kernel 默认从文件系统读 `dist/public`。生产 assets 应该来自显式 provider：

```ts
type AssetProvider = (request: Request) => Response | undefined | Promise<Response | undefined>
```

可选 provider：

- bundled manifest provider。
- Workers KV/R2 provider。
- external CDN redirect/provider。
- Node fs provider。
- disabled provider。

Node fs provider 放在 Node adapter surface，不进入 fetch kernel。

### 5. 平台能力用 adapters 注入

fetch-native runtime 不应该假设：

- `process.cwd()` 存在。
- Node fs 存在。
- Node streams 存在。
- file logger 可用。
- long-lived local disk 可用。

这些能力应通过 options 注入：

- config store。
- runtime state store。
- plugin data store。
- log sink。
- vault key store。
- asset provider。
- crypto provider，如果平台需要特殊实现。

Cloudflare Workers 这类平台可以提供 KV/Durable Object/R2 adapters；Node 可以提供 fs adapters。

logger 不需要拆成复杂平台抽象。它是必然服务，只要保留 sink 注入即可：

```ts
logger: {
	sinks: [consoleSink(), runtimeUiSink()],
}
```

file sink、runtime UI sink、test sink、remote sink 都是 sink，不是新的 runtime service kind。

### 6. 保留 dynamic 的重能力

dynamic route 继续拥有：

- Vite runner。
- workspace scan。
- package install/remove/load。
- moduleGraph。
- loader batch replacement。
- source UI HMR compile。

不要为了 fetch-native static 目标削弱 dynamic 的开发体验。两条 route 共享 core lifecycle 和 runtime protocol，但不共享 dev/runtime machinery。

## 建议迁移顺序

1. 新增 `@pluxel/runtime-static/fetch` production entry，并明确它可以依赖 Elysia。
2. 引入 static fetch preset，避免 `runtime/register` 一次性注册所有服务。
3. 给 static fetch entry 建立 bundle guard 测试：禁止 Vite、Rolldown、chokidar、Node http、Node fs、GraphQL control-plane、SSE control-plane、Vault 默认实现出现在 production import graph。
4. 把 `runtime-static/vite` 的 proxy 收敛到共享 fetch adapter。
5. 再移除旧 heavy defaults，static production 默认 control-plane off、assets disabled、vault disabled、state/config memory 或 explicit。

## 成功标准

- 一个 static app 可以通过 `tsdown` 打成单个 ESM worker entry。
- production import graph 可以包含 Elysia，但不包含 Vite/Rolldown/chokidar/Node http/fs/control-plane/Vault 默认实现，除非用户显式选择对应能力。
- 插件 HTTP route 以 Elysia 为唯一 route framework，并保留 fetch mount escape hatch。
- vault、runtime web UI、GraphQL/SSE control-plane、file storage 都能按需挂上，不影响最小 static bundle。
- logger 始终可用，并能自由配置 sink。
- dynamic HMR 行为不被 static fetch kernel 约束。
- Node、Vite、Cloudflare Workers 等环境只差 adapter，不差 runtime core。
