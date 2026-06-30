# Runtime Concept Pruning

状态：提案。

这份文档记录 Vite-owned runtime routes 落地后的下一批概念出清点。目标不是继续横向加能力，而是识别仍然带有旧路线、旧命名或多套并行模型的地方，把它们压缩成更少、更明确的 runtime 设计。

## 判断标准

一个点值得大幅重构，通常满足至少两条：

- 同一个事实有两套写法、两套 store 或两套 lifecycle。
- public 或 docs 名称暴露了实现细节，例如 HMR、extension、bridge、adapter。
- static/dynamic 都复用的 runtime common 仍以 dynamic/HMR 名字对外。
- route-owned 能力绕过 `Context.runtimeRoute`，通过 WeakMap、attach handle 或全局 side table 注入。
- control-plane 暴露固定方法，但只有某条 route 真正支持，其他路线只能运行时报错。
- 测试需要围绕旧概念写反向断言，而不是验证唯一正向模型。

## 1. Runtime Web Paths 去 HMR 化

状态：已实现。

### 现状

`@pluxel/runtime` common web/control-plane 已统一为 route-neutral runtime 命名：

- `RUNTIME_INTERNAL_API_BASE`
- `RUNTIME_TRANSPORT_PATHS`
- `RUNTIME_EXTENSIONS_*`
- `RUNTIME_SECURITY_*`
- `runtimeExtensionArtifactPath(...)`
- `runtimeSignalDbCollectionPath(...)`

这些常量定义在 `packages/runtime/src/web/paths.ts`，并从 `packages/runtime/src/web.ts` 对外导出。路径不只服务 dynamic HMR；static route 的 HTTP、RPC、SSE、GraphQL、extension manifest、安全验证也复用它们。

### 问题

HMR 命名把 runtime web protocol 错误地绑定到 dynamic 开发路线：

- static route 使用这些协议时看起来像在依赖 HMR。
- browser/runtime clients 读起来像 debug-only transport。
- 安全验证、日志、RPC、SignalDB 都不是 HMR 能力，却被 HMR 前缀污染。
- 旧 HMR base URL 会让 runtime control-plane 被误解成 dynamic HMR 专属协议。

### 目标设计

建立 route-neutral 的 runtime web path model：

```ts
RUNTIME_INTERNAL_API_BASE = '/__pluxel/runtime'
RUNTIME_TRANSPORT_PATHS = {
	rpc: '/rpc',
	graphql: '/graphql',
	sse: '/sse',
	signaldb: '/signaldb',
}
RUNTIME_EXTENSIONS_MANIFEST_PATH = '/extensions/manifest'
```

命名原则：

- URL path 归 runtime web protocol，不归 HMR。
- HMR 只可以拥有 dev-only endpoint，例如 loader batch、debug runner、workspace diagnosis。
- static/dynamic route 都只消费 runtime path constants。

### 迁移策略

这是 public browser surface，已按一次性迁移落地：

1. 新增并使用 neutral constants/helper，内部实现全部迁移。
2. 删除旧 `HMR_*` 出口，不保留 alias。
3. runtime control-plane base URL 迁到 `/__pluxel/runtime`。

### 成功标准

- `packages/runtime/src/web/paths.ts` 不再以 HMR 作为 runtime transport 的主命名。
- `packages/runtime/src/web.ts` public export 使用 `RUNTIME_*`。
- static/dynamic smoke 不依赖 HMR 命名即可访问 RPC/SSE/GraphQL/extension manifest。
- 文档中只有 dynamic loader 开发流程使用 HMR 词。

## 2. Route Capability 合并 Route Dev 和 Module Runtime

状态：已实现。

### 现状

runtime common 已有 `Context.runtimeRoute`：

- catalog
- lifecycle
- config metadata
- dependencies
- source
- api

旧实现里 source UI compiler、worker bundler、loader module cache 曾通过 runtime common side table 接入。当前已经收敛到 `ctx.runtimeRoute.dev` 和 `ctx.runtimeRoute.modules`。

### 问题

这是上一次 install/attach API 清理后仍然存在的内部同类问题，现已清理：

- route 能力不再分散在 `ctx.runtimeRoute` 和 side table 多处。
- 名字不再暗示“把 HMR attach 到 Context”，而是 route 启动时拥有 capability。
- static route 的 source UI 开发能力不再伪装成 dynamic HMR wiring。
- `runtime/plugin.ts` 为 route-neutral authoring API，只读取 route dev capability。

### 目标设计

把 route-owned 能力并入 `RuntimeRouteCapabilities`：

```ts
type RuntimeRouteCapabilities = {
	catalog: PluginCatalogRead
	lifecycle?: PluginLifecycleControl
	configMetadata?: PluginConfigMetadataRead
	dependencies?: PluginDependencyRead
	source?: PluginSourceRead
	api?: RuntimeApiCapabilities
	modules?: RuntimeModuleRuntime
	dev?: RuntimeDevCapabilities
}

type RuntimeDevCapabilities = {
	uiSource?: {
		bind(ctx: Context, options: { entryPath: string }): () => void
	}
	worker?: {
		watch(ctx: Context, tsEntry: string, options: RuntimeWorkerWatchOptions): Promise<() => Promise<void>>
	}
	batches?: {
		last(): unknown
		wait(options?: unknown): Promise<unknown>
		waitForStable(options?: unknown): Promise<unknown>
		waitForIdle(options?: unknown): Promise<void>
		executeFiles?(files: string[], keepOrder?: boolean): Promise<void>
	}
}
```

关键变化：

- route 启动时设置完整 `ctx.runtimeRoute`。
- route 关闭时由 route lifecycle/effects 清理 capability。
- `ui(...)` 和 `worker(...)` 只读 `ctx.runtimeRoute.dev`。
- module cache/normalize/drop 归 `ctx.runtimeRoute.modules`。
- 删除 route dev/module runtime side table。
- dev-only extension compiler 通过构造参数接收 module store，不再暴露 `attachStore` 生命周期 API。

### 非目标

- 不把 dev-only capability 变成 core service。
- 不让 runtime common 启动 Vite。
- 不把 static route 伪装成 dynamic HMR route。

### 成功标准

- runtime common 中没有 route dev/module runtime side table setter。
- `runtime/plugin.ts` 只读取 `ctx.runtimeRoute.dev`。
- static/dynamic 只通过 `RuntimeRouteCapabilities` 暴露 route-owned dev 能力。
- static/dynamic 构造 dev compiler 时一次性提供 store，不再使用 attach-style 后补状态。

## 3. Plugin UI / Extension / Interaction 命名收敛

### 现状

插件前端贡献链路同时使用多套概念：

- authoring bridge：`ui(...).bind(ctx)`
- runtime service：`ctx.ext.ui`
- service 类名：`ExtensionService`
- runtime browser contract：plugin UI / extension manifest / interaction surface / interaction offer
- UI API：
  - `ctx.ext.ui.remote.packaged()`
  - `ctx.ext.ui.builtin.doc(...)`
  - `ctx.ext.ui.interaction.surface(...)`
  - `ctx.ext.ui.interaction.offer(...)`

`ExtensionService` 同时维护 compiled remote modules、builtin docs、interaction surfaces/offers/sessions、manifest version、artifact path resolution。

### 问题

这块已经能工作，但概念层数偏多：

- `extension` 和 `plugin UI` 混用，读者很难判断哪个是产品概念，哪个是实现概念。
- `ctx.ext` 同时承载 RPC/SSE/SignalDB/UI，名字像 extension namespace，但实际是 plugin interaction services。
- `ExtensionService` 是 remote module registry、builtin registry、interaction registry、manifest store 的组合体。
- interaction surface/offer 是很强的产品模型，却藏在 `ctx.ext.ui.interaction` 下面。

### 目标设计

建立唯一的 plugin contribution model：

```text
plugin contribution
  -> ui module      compiled remote / packaged remote
  -> ui document    host-rendered document/form/status
  -> interaction    surface / offer / session
  -> transport      rpc / sse / signaldb
```

API 命名应反映这个模型，而不是继续扩展 `extension`：

```ts
ctx.contribution.ui.module.packaged()
ctx.contribution.ui.document(...)
ctx.contribution.interaction.surface(...)
ctx.contribution.interaction.offer(...)
ctx.contribution.rpc.expose(...)
ctx.contribution.sse.expose(...)
ctx.contribution.signaldb.collection(...)
```

实现可以拆成三个内部 store：

- `UiModuleStore`：compiled/packaged remote module manifest 和 artifact roots。
- `UiDocumentStore`：host-rendered builtin/document contribution。
- `InteractionStore`：surface/offer/session matching 和 session lifecycle。

`ExtensionService` 这个大类应消失或退化为组合 facade；长期 public docs 不再使用 extension 作为主概念。

### 迁移策略

这个面影响插件作者 API，不能只靠重命名：

1. 先在文档中冻结目标模型，明确 `extension` 是旧实现名，不是新概念。
2. 新增贡献 API，保持 authoring bridge `ui(...)` 可映射到 `ui.module`。
3. 内部拆 store，manifest 仍可保持当前 wire format。
4. 最后删除或收窄 `ctx.ext.ui.*`。

### 成功标准

- `docs/FRONTEND.md` 使用 plugin contribution model 解释链路。
- `ExtensionService` 不再是 remote/builtin/interaction/session 的单一大类。
- 作者侧只需要理解 contribution，而不是 extension/remote/builtin/interaction 四套入口。
- Browser manifest 可以继续叫 manifest，但不把实现名泄漏回作者 API。

## 4. Dynamic Package Manager 变成 Route Feature

状态：已实现。

### 现状

`RuntimeRpcApi` 不再固定暴露 package manager 方法。runtime common 只提供 route feature discovery/lookup：

```ts
features(): string[]
feature('packageManager'): PackageManagerFeatureApi
```

package install/remove/reload 只属于 dynamic route。static route 没有 `packageManager` feature，workbench 调用前通过 `features()` 判断可用性。

dynamic route 内部的 package manager 已拆成窄内部边界：

- `PackageService`：ready/init/config defaults/policy/facade。
- `PackageMutationService`：install/installMany/uninstall/remove/reinstall。
- `PackageLoadRuntime`：load/reload/retry/runtime cache/state restore/sync。
- `PackageInventoryService`：inventory/load issue/dependency read model。

### 问题

package manager 已经是 dynamic route 的可选管理面，不是 runtime common 的固定 RPC 方法。`PackageService` 也不再聚合全部 package manager 实现：

- PackageService 只保留 facade、ready/init、config defaults、policy enforcement。
- mutation、load runtime、inventory read model 作为独立内部模块，route feature handle 不再依赖一个过宽 service 实现。
- 用户侧看到 install/remove API 时容易误解为 Pluxel 的通用插件模型，而不是 dynamic route 的管理能力。

### 目标设计

把 package manager 下沉为 route feature contribution：

```ts
type RuntimeRouteCapabilities = {
	api?: RuntimeApiCapabilities
	features?: RuntimeRouteFeatures
}

type RuntimeRouteFeatures = Readonly<Record<string, RuntimeRouteFeatureHandleFactory>>
```

control-plane 读取 route feature manifest：

```ts
rpc.features()
rpc.feature('packageManager').mutate(...)
```

类型化 client 保留 feature handle 类型，但入口是 feature-discovered，不是 runtime common 固定方法。

PackageService 内部已经拆成更清晰的三个部分：

- `PackageMutationService`：install/remove/uninstall/reinstall。
- `PackageInventoryService`：inventory/load issues/read model。
- `PackageLoadRuntime`：把 package artifact 变成 plugin constructors 并提交 route lifecycle。

### 成功标准

- static route RPC surface 不出现 package manager 方法。
- runtime common 不再硬编码 `package()`。
- workbench/control-plane 通过 feature availability 决定是否访问 package manager。
- install/remove 语义只出现在 dynamic route feature 文档里。
- `PackageService` 不再直接实现 install/remove、inventory projection、runtime cache invalidation 三条路径。

## 5. Config State 和 Runtime State 的边界再收窄

### 现状

配置和运行状态已经有清晰大边界：

- core config declaration/validation/defaults
- runtime config persistence/profile/watch
- runtime state enabled/forks/groups/dependency overrides

但控制面读写仍散在多个 usecase：

- plugin config patch/reset
- plugin status actions
- plugin groups
- fork ensure
- dependency target override
- base provider selection

### 问题

这些能力本质都是 plugin control state mutation，但 API 按 UI 页面和历史功能增长：

- enabled/fork/group/dependency/base provider 的写模型分散。
- startup report、status overview、config schema、runtime state snapshot 是不同 read model。
- 很多测试容易绑定到具体 usecase，而不是绑定到“plugin control state transaction”。

### 目标设计

建立统一的 plugin control state command model：

```ts
type PluginControlCommand =
	| { type: 'enable'; plugin: string }
	| { type: 'disable'; plugin: string }
	| { type: 'patchConfig'; plugin: string; patch: Record<string, unknown> }
	| { type: 'setGroup'; group: PluginGroupInput }
	| { type: 'ensureFork'; baseName: string; forkId: string; enable?: boolean }
	| { type: 'setDependencyTarget'; plugin: string; index: number; targetName: string | null }
	| { type: 'selectBaseProvider'; plugin: string; baseToken: string; providerName: string | null }
```

runtime common 提供一个 transaction usecase：

```ts
applyPluginControlCommands(ctx, commands)
```

各页面/RPC 只做薄包装。这样状态变更的验证、日志、审计、rollback/partial failure 策略可以集中。

### 成功标准

- runtime control-plane mutation 入口减少。
- status/config/dependency/group/fork 仍可独立读，但写路径共享同一个 transaction core。
- 启动报告和控制面 mutation 都能复用同一套 validation result 结构。

## 推荐优先级

1. **Route Capability 合并 Route Dev 和 Module Runtime**  
   已推进。它延续 Vite route ownership 清理，把 dev/module runtime 从 attach/side-table 概念收敛到 route capability，且不改用户 URL。

2. **Runtime Web Paths 去 HMR 化**  
   已推进。runtime common web/control-plane 使用 `RUNTIME_*` 命名，base URL 迁到 `/__pluxel/runtime`，旧 `HMR_*` 出口不保留 alias。

3. **Dynamic Package Manager 变成 Route Feature**  
   已实现。runtime common RPC 不再固定暴露 `package()`；dynamic route 通过 `packageManager` feature 提供 install/remove/reload/retry，内部 package manager 已拆成 mutation/load runtime/inventory 三个窄模块。

4. **Plugin UI / Extension / Interaction 命名收敛**  
   收益最大，但影响作者 API 和 UI manifest 解释，需要先完成设计文档和迁移策略。

5. **Config State 和 Runtime State 的边界再收窄**  
   适合作为控制面整理，不应抢在前四项之前做。

## 暂不建议动的点

- `@pluxel/runtime-dev` 私有包：当前边界已经清晰，作为 inlined implementation glue 可以保留。
- Core DI V2：已有独立 proposal，不应混进 runtime route 清理。
- Workbench view model：已有提案，和 runtime concept pruning 相关但不阻塞。
- runtime web URL 是否迁到 `/__pluxel/runtime`：已随 web path 去 HMR 化完成。

## 下一步切法

建议下一轮只做 **Plugin UI / Extension / Interaction 命名收敛** 的设计冻结：

```text
ctx.ext.ui / ExtensionService
-> contribution.ui / contribution.interaction / contribution transport
-> 内部 store 拆分设计
-> 作者 API 迁移策略
```

package manager feature 边界已经清楚，下一步不应继续扩展 package manager，而应处理仍然暴露旧 extension 概念的作者侧 API。
