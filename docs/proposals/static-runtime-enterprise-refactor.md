# Static Runtime Enterprise Refactor

状态：重构方案。

本文基于当前代码审计，描述如何把 static runtime 路线重构成尽可能轻、适合企业后端开发、同时保留 Pluxel 插件能力的生产路径。

目标不是把 Pluxel 变成通用 server framework。目标是：

- static runtime 可以被 `tsdown` 打成小的 fetch-native ESM。
- HTTP route framework 固定为 Elysia。
- 插件生命周期、依赖、配置、effects、logger 保持可用。
- GraphQL 视作 HTTP 能力的一部分，可以作为默认加载能力。
- config/state file persistence、plugin data、file logger 默认存在并优化实现。
- runtime web UI、management panel、ext、SSE 属于同一个网页管理 bundle，共同进退。
- Vault 是真正插件按需引入的服务。
- 服务根据配置和运行环境 fail fast。
- 保留一个很窄的 `PersistenceService`；它不是 Node fs 镜像，而是 runtime 自用持久化能力边界。
- dynamic route 继续保留 Vite/HMR/scan/package manager，不受 static 最小化目标约束。

## 概念预算

这次重构要主动减少 public 名词。static runtime 对使用者只应该有少数稳定概念：

- runtime config：`defineStaticRuntimeConfig(...)`，唯一描述 runtime 怎么启动。
- direct launcher：`createStaticRuntime(config)`，创建 runtime 并暴露 `fetch`。
- Vite launcher：`staticRuntimeVitePlugin({ config })`，只负责 host-owned Vite dev/build 链路。
- 默认上下文：HTTP、logger、config/state/plugin data、persistence、registry/effects/events。
- 显式大能力：`vault` 和 `web-management`。

不要再引入这些二级概念：

- `static fetch preset` / `managed preset`。主入口就是 static fetch；web-management 通过显式 import 进入。
- framework adapter registry。Elysia 是唯一 route authoring surface；fetch mount 是低层逃生口。
- asset subsystem。业务静态资源用 Elysia route/mount；管理 UI assets 随 web-management。
- plugin service declaration。插件需要可选能力就 import 对应模块并直接使用。
- runtime service manager。startup 直接检查默认能力和已 import 的大能力，不暴露一个新的管理服务。

已完成的 config/Vite 分离不能回退，但边界是：

- `vite.config.ts` 是 host-owned Vite 配置，只负责安装 `staticRuntimeVitePlugin({ config: './pluxel.static.ts' })`。
- `pluxel.static.ts` 是 route-neutral static runtime config，它基本决定 runtime 怎么启动。
- `defineStaticRuntimeConfig(...)` 应从 `@pluxel/runtime-static` 主入口导出，不依赖 Vite；`@pluxel/runtime-static/vite` 可以为兼容 re-export，但文档推荐从主入口 import。
- 同一份 runtime config 可以被 Vite 插件加载，也可以被 production entry 直接 import 后传给 `createStaticRuntime(config)`。
- `@pluxel/runtime-static` 主入口不拥有 Vite dev server、SSR loader、watcher 或 HMR；这些仍只属于 `/vite` route。

## 当前代码事实

`Context` 已经具备按需服务模型：

- 服务模块 import 后，`@Injectable` / `@RootService` 会把 getter 注册到 `Context.prototype`。
- 服务实例是 lazy 的，只有访问 `ctx.foo` / `ctx.root.foo` 时才构造。
- TypeScript 通过模块增强把服务挂到 `Context.Services` / `Context.RootServices`。
- `Context.extend()` 共享实例池，`isolate()` 可以隔离 context-scoped service。

因此“少数可选服务由插件自己 import，例如 vault，从而获得类型增强和实际增强”是符合现有机制的方向，不需要重写 DI。默认能力不需要都做成按需服务；否则概念会过多。

当前阻碍 static 最小化的是入口和服务实现边界：

- `@pluxel/runtime` 顶层 import `./runtime/register`，一次性注册 runtime common 的所有服务。
- `runtime-static` 从 `@pluxel/runtime` 和 `@pluxel/runtime/services` 引入 `Context`、`bootstrapHostVault`、`ConfigService`、`RuntimeStateStore` 等，间接拉入重 barrel。
- `StaticRuntimeHostImpl.prepare()` 无条件等待 `configService`、`runtimeState`，并无条件 `bootstrapHostVault(this.ctx)`，导致 vault 无法真正按需。
- `ConfigService` 和 `RuntimeStateStore` 顶层 import `chokidar`，即使使用 `memory` mode 也会进入 import graph。
- `FsService` 顶层 import Node fs，即使使用 memory backend 也会进入 import graph；更根本的问题是它太像 Node fs 镜像，需要改名并收窄成 `PersistenceService`。
- `PluginDataService` 顶层 import `chokidar`，默认使用 fs storage；它应该保留为默认能力，但去掉 watcher 等非必要重依赖。
- `HttpService` 使用 Elysia 是正确方向。GraphQL 可以作为 HTTP 能力保留；管理面板、SSE、runtime web UI 应作为一个网页管理 bundle，不默认拉入最小路径。
- `ExtensionService` 顶层 import Node crypto/fs，用于 packaged UI artifact 和 manifest；它应属于网页管理 bundle，而不是 static core。
- `createRuntimeLogging()` 顶层 import `node:fs/promises` 和 file sink；file logger 可以默认存在，但实现应直接面向现代 JS fs API 并避免额外重抽象。

## 目标形态

### Static App Entry

企业后端 static app 可以复用同一份 runtime config。

```ts
// pluxel.static.ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { OrdersPlugin } from './plugins/OrdersPlugin'
import { AuditPlugin } from './plugins/AuditPlugin'

export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin, AuditPlugin],
	enabled: ['OrdersPlugin', 'AuditPlugin'],
	http: {
		graphql: true,
		management: false,
	},
	logger: {
		sinks: ['console', 'file'],
	},
})
```

生产入口直接 import 这份 config：

```ts
// worker.ts
import { createStaticRuntime } from '@pluxel/runtime-static'
import config from './pluxel.static'

const runtime = await createStaticRuntime(config)

export default {
	fetch: runtime.fetch,
}
```

Vite dev/build 入口也指向同一个文件：

```ts
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		staticRuntimeVitePlugin({
			config: './pluxel.static.ts',
		}),
	],
})
```

这里复用的是 runtime config 对象；不能复用的是 Vite SSR load、watch、HMR 和 build-time lowering 机制。

如果某个插件需要 vault，它自己 import vault 服务：

```ts
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime-static'

@Plugin({ name: 'SecretsPlugin' })
export class SecretsPlugin extends BasePlugin {
	override async init() {
		const kv = this.ctx.vault.kv()
		await kv.set('ready', true)
	}
}
```

bundle 结果默认包含企业后端常用的 static 能力：HTTP/Elysia/GraphQL、plugin lifecycle、config/state persistence、plugin data、logger/file logger。Vault 这类不一定使用且语义较重的能力，由插件 import 后进入 bundle。

### Host API

`@pluxel/runtime-static` 主入口应提供 direct static/fetch launcher。不要再引入一个让用户困惑的 `./fetch` 入口；`./vite` 只保留 Vite launcher。

```ts
type StaticFetchRuntime = {
	ctx: Context
	fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>
	start(): Promise<StaticRuntimeStartupReport>
	stop(): Promise<void>
}
```

实现上可以由当前 `defineStaticRuntime(...)` + `createStaticRuntimeHost(...)` 演进而来，但 public 目标应尽量收敛成：

- `defineStaticRuntimeConfig(...)`：纯 runtime config helper，主入口导出，生产和 `/vite` 共用。
- `createStaticRuntime(config)`：生产 runtime factory，返回 `{ ctx, fetch, start, stop }`。

`defineStaticRuntime(...)` 如果保留，只作为兼容 alias，避免同时存在两套含义相近的 define helper。

direct launcher 只允许依赖：

- `@pluxel/core`
- Elysia
- GraphQL HTTP capability
- static catalog/lifecycle code
- config/state persistence
- plugin data
- logger core + console/file sinks
- explicitly imported optional services such as vault

它不应依赖：

- Vite / Rolldown / chokidar
- Node http / Node streams
- Vault implementation
- runtime web UI / ExtensionService artifact loader / management panel bundle
- dynamic loader/package/scan

## 服务组合规则

### 1. 默认能力不要拆成一堆服务概念

`@pluxel/runtime-static` 主入口默认提供企业后端常用基础能力：

- `ctx.http`，Elysia + GraphQL。
- `ctx.configService`。
- `ctx.runtimeState`。
- `ctx.pluginData`。
- `ctx.logger`，console/file sink 都可用。
- `ctx.registry` / `ctx.effects` / `ctx.events`。

这些能力不需要插件或 host 分别 import。重构目标是优化它们的实现和依赖，而不是把它们拆成更多概念。

### 2. 少数可选 bundle

只保留少数真正有意义的组合边界：

- `@pluxel/runtime/services/vault`：插件按需引入，提供 `ctx.vault` / `ctx.root.vaultAdmin`。
- `@pluxel/runtime/services/web-management`：网页管理 bundle，一次性引入 management panel、runtime web UI、`ctx.ext`、RPC/SSE/SignalDB/UI 交互、runtime UI log sink。

dynamic route 的 loader/package/scan 仍在 `@pluxel/runtime-dynamic`，不属于 static 默认能力。

网页管理能力共通进退，不再拆成 ext、SSE、runtime web UI、management panel 多个独立概念。需要它时引入一个 bundle；不需要时整个 bundle 不进 static 主入口。

### 3. 服务应显式 fail fast

服务 fail-fast 规则：

- **未 import 可选服务模块**：TypeScript 不应看到对应 `ctx.service`；如果绕过类型直接访问，运行时应是明确的 missing-service 错误。
- **已 import 但环境不满足**：服务第一次构造或 `prepare()` 阶段抛出带 service id、原因、修复建议的错误。
- **默认服务环境不满足**：例如 file persistence 或 file logger 在目标运行时没有可用 fs API，应在 startup/preflight 报错，提示切换 memory/database/KV backend 或关闭对应 sink。
- **服务被配置为 disabled**：公共方法应 fail fast，除非该服务明确设计为 no-op。
- **生产不支持的 backend**：不要 fallback 到 Node 或 memory；必须报错。

示例：

```ts
throw new RuntimeServiceUnavailableError('vault', {
	reason: 'missing_crypto',
	message: 'VaultService requires globalThis.crypto.subtle.',
	hint: 'Use a Workers/Bun/Deno runtime with WebCrypto or disable vault.',
})
```

static host 在 startup 直接检查默认能力和已 import 的大能力即可，不需要新增 `ctx.runtimeServices` 这类管理服务。检查结果写入 startup report；失败时抛出明确错误。

不要为了少数服务再引入复杂的 plugin service declaration。Vault 这种能力由插件 import 后直接使用；如果环境不满足，服务 fail fast，core lifecycle report 已经能记录插件启动失败。

## 需要拆分的具体模块

### 1. `@pluxel/runtime` 顶层入口

现状：

```ts
import './runtime/register'
```

这对静态最小包不友好。建议改成：

- `@pluxel/runtime`：插件作者默认入口，导出 `BasePlugin`、`Plugin`、`Context`、`Config` 等基础 API，并只注册 static/common runtime services。
- `@pluxel/runtime/register/full`：dynamic/dev 使用的完整注册入口。
- `@pluxel/runtime-static`：production static 主入口，只依赖 `@pluxel/runtime` 的 common surface，不依赖 full runtime；暴露 `defineStaticRuntimeConfig(...)` 和 `createStaticRuntime(...)`。
- `@pluxel/runtime-static/vite`：保留 `staticRuntimeVitePlugin(...)`，继续承载已实现的 host-owned Vite route；可以 re-export `defineStaticRuntimeConfig(...)` 兼容旧 config 文件，但新文档不推荐从 `/vite` import config helper。

插件推荐从 `@pluxel/runtime` import authoring API；只有 vault、web-management 等额外能力才使用子路径显式增强。

### 2. `ConfigService` / `RuntimeStateStore` / plugin data

三者作为默认能力保留，但实现要轻：

- 默认 file persistence 可用，面向现代 JS fs API。
- memory/database/KV backend 可通过配置切换。
- 依赖窄 `ctx.root.persistence`，而不是各服务自己探测环境。
- persistence backend 应声明 `durable` / `ephemeral` / `readonly` capability。Worker 临时 fs 这类环境可以作为 `ephemeral` backend 工作，但 startup/preflight 必须明确提示它不是持久存储。
- 不在顶层 import `chokidar`；watcher 只属于 dev 或显式 watch mode。
- plugin data 默认存在，提供轻量 file-backed persistence；需要数据库/KV 时换 backend。

### 3. 把 `FsService` 改成 `PersistenceService`

不要删除这层抽象；要删除的是“完整 Node fs 镜像”的抽象。公共服务应改名为 `PersistenceService`，挂在 `ctx.root.persistence`。它表达 runtime 数据是否可持久、可写、可列举，而不是表达底层是不是文件系统。

- 大部分现代 JS 后端环境已经提供某种 fs 或存储 API，但语义不同。例如 Worker 的 fs 可能只是临时文件本地读写，不代表 durable persistence。
- runtime 需要统一判断 config/state/plugin-data/file-logger 当前落在 durable、ephemeral 还是 readonly backend。
- 企业后端更常见的是数据库、KV、对象存储、平台绑定，而不是统一文件系统。
- 直接让每个服务自己探测 fs 会造成重复和不一致。
- 旧 `FsService` 容易把 Node-only import 拉进最小 bundle，所以要拆后端、保留窄接口。

建议接口只保留 runtime 服务复用所需的能力：

```ts
type PersistenceCapability = 'durable' | 'ephemeral' | 'readonly'

type PersistenceEntry = {
	key: string
	kind: 'file' | 'directory'
	size?: number
	updatedAt?: Date
}

type PersistenceNamespace = {
	get(key: string): Promise<Uint8Array | undefined>
	getText(key: string): Promise<string | undefined>
	put(key: string, value: Uint8Array | string, options?: { atomic?: boolean }): Promise<void>
	delete(key: string): Promise<void>
	list(prefix?: string): AsyncIterable<PersistenceEntry>
	stat(key: string): Promise<PersistenceEntry | undefined>
}

type PersistenceService = {
	capability: PersistenceCapability
	namespace(name: string): PersistenceNamespace
	preflight(requirement?: { durable?: boolean; writable?: boolean }): Promise<void>
}
```

`namespace()` 是关键：config、state、plugin-data、file-logger、vault 等服务都通过自己的 namespace 复用同一个 backend，避免路径拼接和权限语义散落在各服务里。

backend 可以是 file、memory、database、KV、object storage、Durable Object 或 host 自定义实现。file backend 只是其中一种实现，不应污染公共 API。

它不应该暴露完整 Node fs API，不应该默认带 watcher，不应该在基础入口顶层 import Node-only backend。插件如果需要业务文件能力，仍应依赖业务 service，例如 `ctx.storage`、`ctx.blobs`、`ctx.documents`，不要把 `PersistenceService` 当通用文件系统使用。

### 4. `HttpService`

保留 Elysia，但调整默认：

- GraphQL 是 HTTP 能力，可默认存在。
- `management` 默认 false。
- web-management bundle 只有 import 对应 bundle 或配置启用后才挂。
- 不设计独立 asset subsystem。业务 assets 用 Elysia route/mount；管理 UI assets 随 web-management。

`HttpService` 的最小职责：

- Elysia root app。
- plugin-scoped route base。
- `ctx.http.plugin.routes(...)`。
- `ctx.http.plugin.mount(fetchBoundary)` escape hatch。
- GraphQL over HTTP。
- `ctx.http.fetch(request, env?, executionCtx?)`。

### 5. `VaultService`

Vault 必须完全 optional：

- 从 static `prepare()` 移除无条件 `bootstrapHostVault(this.ctx)`。
- `bootstrapHostVault` 只由显式 import 的 vault 模块负责，不放进 static host 默认流程。
- `vault` / `vaultAdmin` 注册由 `@pluxel/runtime/services/vault` 提供。
- Vault preflight 检查 WebCrypto、identity material、persistence backend；失败直接给 `service-unavailable`。

### 6. Web management bundle

`ctx.ext`、SSE、runtime web UI、management panel 作为一个 bundle 进退，不再拆成多个产品概念：

- `@pluxel/runtime/services/web-management`
  - 插件管理面板。
  - runtime web UI。
  - `ctx.ext`：RPC/SSE/SignalDB/UI 交互。
  - runtime UI log sink。
  - 必要的 packaged UI artifact loader。

web-management 通过显式 import 进入：

```ts
import '@pluxel/runtime/services/web-management'
```

然后 host 配置决定是否挂管理路由：

```ts
export default defineStaticRuntimeConfig({
	name: 'orders-api',
	plugins: [OrdersPlugin],
	http: {
		management: true,
	},
})
```

纯运行时配置开关不能同时满足“默认不进 bundle”和“打开后自动可用”：如果同一个最小入口静态 import 了 web-management bundle，即使配置为 false，bundle 也已经变重。因此不要为了便利再引入 managed preset；保持显式 import 这一条路。

插件 UI authoring bridge `ui('./ui')` 在 static production 中应该只在 web-management bundle 存在时可用。否则 fail fast：

```text
[pluxel/runtime] Plugin UI service is not registered. Import @pluxel/runtime/services/web-management or disable plugin UI.
```

### 7. Logger

logger 是必然存在的基础服务，不需要过度抽象。

重构目标：

- core `LoggerService` 保持默认存在。
- logger configuration 接受 sinks。
- console sink 和 file sink 在基础入口可用。
- file sink 实现应轻量，避免额外 Node-only helper 抽象；目标环境没有 fs 时 fail fast 或要求关闭 file sink。
- UI sink 属于 web-management bundle。
- plugin log policy persistence 默认 file-backed，可通过配置换 backend。

示例：

```ts
logger: {
	sinks: [consoleSink()],
}
```

## Static Host Startup Flow

新的 startup 顺序：

```text
import selected service modules
-> create Context from @pluxel/runtime-static main entry
-> build fixed catalog
-> install HTTP routes
-> check default runtime requirements
-> validate plugin config
-> register enabled plugins
-> core commit
-> expose ctx.http.fetch
```

`prepare()` 不应主动访问 optional service。它只应访问必需服务：

- `ctx.configService`
- `ctx.runtimeState`
- `ctx.pluginData`
- `ctx.http`
- `ctx.logger`
- `ctx.registry`
- `ctx.effects`

## Bundle Guard

为 `@pluxel/runtime-static` 主入口增加 import graph 测试：

允许：

- `@pluxel/core`
- `@pluxel/context`
- `elysia`
- GraphQL HTTP capability
- `@logtape/logtape`
- lightweight file persistence/logger implementation
- small schema/runtime utilities

禁止，除非对应测试显式 import service：

- `vite`
- `@pluxel/rolldown`
- `chokidar`
- `node:http`
- `node:stream`
- `age-encryption`
- dynamic loader/package/scan modules
- web-management bundle modules

测试方式：

- 对 `@pluxel/runtime-static` 做 tsdown bundle。
- 扫描输出 import specifiers。
- 运行一个最小 Elysia plugin route smoke test。
- 再分别测试默认 file persistence/file logger、`+vault`、`+web-management` 组合。

## 迁移顺序

1. 把 `@pluxel/runtime` 顶层改成插件作者默认入口，只注册 static/common services；full registration 移到 `@pluxel/runtime/register/full`。
2. 把 `@pluxel/runtime-static` 主入口改成轻量 production static/fetch 入口；`@pluxel/runtime-static/vite` 保持开发期入口。
3. 移除 static host `prepare()` 中的无条件 vault bootstrap。
4. 优化 `ConfigService` / `RuntimeStateStore` / `PluginDataService` 默认 file persistence，移除顶层 `chokidar` 和 `ctx.root.fs` 依赖，统一改用 `ctx.root.persistence`。
5. 用 `PersistenceService` 替换 `FsService`，拆后端并标记 durable/ephemeral/readonly capability。
6. 调整 `HttpService` static defaults：GraphQL HTTP capability 保留，management off；业务 assets 走 Elysia route/mount，管理 UI assets 随 web-management。
7. 把 management panel / ext / SSE / runtime web UI 合并成 web-management bundle，避免默认注册 `ctx.ext`。
8. 优化 logger sinks：console/file 默认可用，UI sink 归入 web-management。
9. 增加默认能力和已 import 大能力的 startup checks。
10. 增加 bundle guard 和组合 smoke tests。

## 成功标准

- 最小 static enterprise app 可以打包 core + Elysia + GraphQL HTTP + static lifecycle + config/state/plugin-data/file logger。
- 插件系统仍完整支持 fixed catalog、enable state、dependencies、config validation、effects cleanup、core commit report。
- Vault 插件 import 后类型和 runtime getter 同时可用。
- web-management bundle 未 import 时，`ctx.ext` / management panel / runtime web UI / SSE 不进入 bundle。
- 默认 file persistence、plugin data、file logger 在环境不支持时 startup/preflight 给明确错误。
- Vault 和 web-management 都能按需组合。
- GraphQL 作为 HTTP 能力存在，不再作为独立 service 增加概念。
- `FsService` 被替换为窄 `PersistenceService`，不再是完整 Node fs 抽象。
- dynamic route 不被这些 static production 约束削弱。
