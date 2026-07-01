# Static Fetch-Native Runtime

状态：设计目标和网络模型审计。

本文记录 static 路线的目标形态：`runtime -> runtime-static` 可以被 `tsdown` 静态打包成最小 JavaScript，运行在任意 fetch-native 环境中，例如 Node fetch server、Vite preview/dev bridge、Cloudflare Workers、Bun、Deno Deploy 或其他 WinterTC-style host。

dynamic 路线不追求这个目标。dynamic 可以继续依赖 Vite runner、workspace scan、package manager、module graph、HMR replacement 和 Node/Vite 能力。

但 dynamic 应共享同一套入口心智模型：`pluxel.dynamic.ts` 是 route-neutral runtime config，
`createDynamicRuntime(config)` 可以直接启动 full dynamic runtime，`dynamicRuntimeVitePlugin({ config })`
用同一份 config 接入 host Vite dev server 和 HMR。dynamic 只是默认加载全部 dynamic/full runtime
服务，不需要被 `tsdown` 打成最小 fetch-native 包。

HTTP 框架选择不再作为开放抽象目标：Pluxel static runtime 以 Elysia 作为唯一 HTTP route framework。最小化目标不是移除 Elysia，而是在 Elysia + core plugin runtime 的前提下，避免把 dynamic/dev/control-plane/Node-only 服务打进 production static bundle。

`@pluxel/runtime-static` 主入口应直接承担这个 production static/fetch 目标；`@pluxel/runtime-static/vite` 才是开发期入口。不要再为同一生产语义增加 `./fetch` 子入口。

这不改变已经落地的 config/Vite 分离。准确边界是：

- `vite.config.ts` 是 host-owned Vite 配置，只负责安装 `staticRuntimeVitePlugin({ config })`。
- `pluxel.static.ts` 这类文件是 route-neutral static runtime config，基本决定 runtime 怎么启动。
- `defineStaticRuntimeConfig(...)` 应从 `@pluxel/runtime-static` 主入口导出，不依赖 Vite；`@pluxel/runtime-static/vite` 可以兼容 re-export。
- 同一份 runtime config 可以被 Vite 插件加载，也可以被 production entry 直接 import 后传给 `createStaticRuntime(config)`。
- production 主入口不拥有 Vite dev server、SSR loader、watcher 或 HMR。

## 目标

static 路线的生产入口应该是一个 fetch-native kernel：

```ts
// pluxel.static.ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'

export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin],
})
```

```ts
// worker.ts
import { createStaticRuntime } from '@pluxel/runtime-static'
import config from './pluxel.static'

const runtime = await createStaticRuntime(config)

export default {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		return runtime.fetch(request, env, executionCtx)
	},
}
```

Pluxel static runtime 在这个模型里只负责：

- 启动 fixed plugin catalog。
- 提交 core lifecycle。
- 提供基于 Elysia 的 plugin-scoped HTTP route/mount table。
- 提供 GraphQL over HTTP 能力。
- 暴露一个稳定的 `fetch(request, env?, ctx?) -> Response`。
- 通过 persistence backend、logger sink 和显式 import 的大能力接入外部环境。

宿主负责：

- 监听端口或提供平台 `fetch` 入口。
- 选择部署平台。
- 决定是否启用 management panel、SSE、runtime web UI。
- 用 Elysia route/mount 或外部 CDN 提供业务静态资源。

## 非目标

- 不把 dynamic HMR 做成 Worker-native。
- 不让 static 继承 loader scan/package/cache/module replacement。
- 不为了兼容旧入口保留重的默认依赖。
- 不把 Vite、SSE、Vault、runtime web UI、管理面板作为 static production 的必需依赖。
- 不为多个 HTTP framework 设计额外 adapter 层；Elysia 是唯一 route framework。
- 不把 logger 过度抽象成平台插件系统；logger 必然存在，但 sink 必须可替换。
- 不把 fs 做成完整 Node fs 镜像；保留窄 `PersistenceService`，用于表达 durable/ephemeral/readonly 后端能力。
- 不新增独立 assets/provider 子系统；业务资源走 Elysia，管理 UI 资源随 web-management。

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

- `@pluxel/runtime-static`
  - production fetch-native static kernel。
  - 导出纯 `defineStaticRuntimeConfig(...)`，用于生产和 `/vite` 共用的 runtime config 文件。
  - 暴露 production factory，例如 `createStaticRuntime(...) -> { ctx, fetch, start, stop }`。
  - 可以 import Elysia。
  - 可以 import GraphQL HTTP capability。
  - 不 import Vite、Rolldown、chokidar、Node http、Node stream、Vault 默认实现或 web-management bundle。
  - 可以被 app 使用 `tsdown` 直接 bundle。
- `@pluxel/runtime-static/vite`
  - dev-only Vite route。
  - 导出 `staticRuntimeVitePlugin(...)`。
  - 可以 re-export `defineStaticRuntimeConfig(...)` 兼容旧 config 文件，但推荐从主入口 import 这个 helper，避免生产 config 依赖 `/vite`。
  - 拥有 static source transform、config reload、static HMR、source UI dev 能力。
- `@pluxel/runtime/node`
  - Node `IncomingMessage` / `ServerResponse` fetch bridge。

生产主入口不能因为 barrel export 把 Vite/Node-only/SSE/Vault/management/runtime-web 默认实现拉进 bundle。

## 当前模型审计

当前方向正确的部分：

- `HttpHandler` 已经是 `Request -> Response`，并预留 `env` / `ctx` 参数。
- `HttpBoundary` 已经允许 Elysia、函数或 `{ fetch }`，可以覆盖普通 Elysia routes 和少量 fetch-native escape hatch。
- `HttpService.fetch` 是 runtime 对外网络入口。
- GraphQL 应归入 HTTP 能力，而不是额外 service 概念。
- dynamic Vite route 已经通过 fetch bridge 挂进宿主 Vite server。
- static host 示例也通过 `host.ctx.http.fetch(request)` 对接外部 Node server。

当前影响最小 fetch-native bundle 的部分：

- `HttpService` root router 直接依赖 Elysia；这是可接受的，但需要避免它顺带拉入管理面板、SSE 和 dev-only 模块。
- `@pluxel/runtime/services` barrel 同时导出 Elysia、Node adapter、GraphQL、SSE、fs、vault 等能力，容易让 production static bundle surface 变重。
- `@pluxel/runtime` 的 side-effect `runtime/register` 一次性注册所有 runtime services，缺少轻量 static 主入口。
- `HttpService` 默认 control-plane 是开启的，默认 UI assets 是 `static-built`，会自然牵引 SSE、management/runtime web 和 static asset serving。
- 多个服务默认使用 `process.cwd()` 和旧的 fs-backed storage；fetch-native 环境需要更清晰的 backend 选择和 fail-fast。
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

### 2. 主入口默认注册核心

不要新增 `static fetch preset` 概念。`@pluxel/runtime-static` 主入口本身只注册 static production 必需项：

- config service，默认 file persistence，可配置 memory/database/KV backend。
- runtime state，默认 file persistence，可配置 memory/database/KV backend。
- plugin data，默认 file persistence。
- Elysia-backed HTTP fetch service，包含 GraphQL HTTP capability。
- verification，默认 private/no-op。
- logger，console/file sink 默认可用，UI sink 归入 web-management bundle。

不要在主入口中默认启用：

- vault。
- web-management bundle：extension service / `ctx.ext`、SSE、runtime web UI、management panel、runtime UI log sink。
- package manager。
- loader/dynamic services。
- Vite/HMR/dev services。
- legacy `FsService` / Node fs mirror abstraction。

### 3. Web management 显式 opt-in

fetch-native production host 应默认是最小业务 runtime：

```ts
export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin],
	http: {
		management: false,
	},
	logger: {
		sinks: [consoleSink(), fileSink()],
	},
})
```

需要 runtime web UI 时再显式启用：

```ts
import '@pluxel/runtime/services/web-management'

export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin],
	http: {
		management: true,
	},
})
```

这样 static runtime 可以覆盖两类场景：

- 最小 serverless plugin runtime。
- 带 Pluxel web-management 的完整宿主。

### 4. Assets 不做独立子系统

不要让 static fetch kernel 默认从文件系统读 `dist/public`，也不要为此新增公共 `AssetProvider` 模型。业务资源已经可以用 Elysia route/mount 表达：

```ts
ctx.http.plugin.routes((app) =>
	app.get('/assets/*', ({ params }) => serveAsset(params['*'])),
)
```

管理 UI 资源随 web-management bundle 进入；不启用 web-management 时，static kernel 不关心它。资源可以来自 bundled manifest、KV/R2、外部 CDN 或 filesystem，但这些只是 route/mount 的实现细节，不成为 Pluxel static kernel 的 public 概念。

文件实现可以复用 `PersistenceService` backend，但这不应该成为一个新的 public subsystem。

### 5. 平台能力用少数替换点接入

fetch-native runtime 不应该假设：

- `process.cwd()` 存在。
- fs API 存在。
- Node streams 存在。
- file logger 可用。
- long-lived local disk 可用。

只保留少数替换点：

- persistence backend。
- logger sinks。
- Elysia routes / fetch mount。
- 显式 import 的 `vault` / `web-management`。

默认能力应做环境探测和明确 fallback：

- 有 fs API：默认 file persistence/file logger 可用。
- 没有 fs API：startup fail fast，提示切换 memory/database/KV backend 或关闭 file sink。
- vault 需要 crypto/persistence 时由 vault 自己检查。
- management assets 由 web-management 内部处理。

Cloudflare Workers 这类平台可以提供 KV/Durable Object/R2 adapters；Node/Bun/Deno 这类环境可以直接用自己的 fs API 实现 file backend。Pluxel 需要的是窄 `PersistenceService`，不是通用文件系统服务。

logger 不需要拆成复杂平台抽象。它是必然服务，只要保留 sink 注入即可：

```ts
logger: {
	sinks: [consoleSink(), runtimeUiSink()],
}
```

file sink 默认存在；runtime UI sink 随 web-management bundle 进入；test sink、remote sink 都只是 sink，不是新的 runtime service kind。

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

1. 把 `@pluxel/runtime-static` 主入口改成 production static/fetch entry，并明确它可以依赖 Elysia 和 GraphQL HTTP capability。
2. 让主入口只注册 static 默认核心，避免 `runtime/register` 一次性注册所有服务。
3. 给 static 主入口建立 bundle guard 测试：禁止 Vite、Rolldown、chokidar、Node http、Node stream、Vault 默认实现、web-management bundle 出现在 production import graph。
4. 把 `runtime-static/vite` 的 proxy 收敛到共享 fetch adapter。
5. 再移除旧 heavy defaults，static production 默认 management off、assets disabled、vault disabled，但保留 config/state/plugin-data/file logger 默认能力。

## 成功标准

- 一个 static app 可以通过 `tsdown` 打成单个 ESM worker entry。
- production import graph 可以包含 Elysia、GraphQL HTTP capability、默认 file persistence、plugin data 和 file logger，但不包含 Vite/Rolldown/chokidar/Node http/Node stream/Vault/web-management bundle，除非用户显式选择对应能力。
- 插件 HTTP route 以 Elysia 为唯一 route framework，并保留 fetch mount escape hatch。
- vault 和 web-management bundle 能按需挂上，不影响最小 static bundle。
- logger 始终可用，并能自由配置 sink。
- `FsService` 被替换为窄 `PersistenceService`，不是完整 Node fs 抽象。
- dynamic HMR 行为不被 static fetch kernel 约束。
- Node、Vite、Cloudflare Workers 等环境只差 fetch bridge / persistence backend，不差 runtime core。
