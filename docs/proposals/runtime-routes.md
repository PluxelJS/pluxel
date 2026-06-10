# Runtime Routes Proposal

状态：未来设计提案。当前没有 `@pluxel/static-suite` 包，没有 runtime static-suite subpath，也没有 static route dev mode。当前已实现路线是 `@pluxel/runtime-loader` 的 loader route，runtime common 已经开始通过 plugin catalog 契约和 loader route 解耦。未来 loader dev mode 收敛见 `runtime-loader-dev-mode.md`。

## 为什么单独成文档

这个设计不是一个普通 feature，而是 runtime 模型的大改：

```text
core
  -> runtime common host layer
       -> loader route
       -> static suite route

runtime-loader dev mode
  -> Vite/watch/runner source submission
  -> loader batch replaceModule
```

如果只塞进 `README.md` 的小节，LLM 很容易把未实现路线误读成当前 runtime 行为。这个文档只讨论未来路线和迁移边界；当前实现仍以 `../CORE.md`、`../RUNTIME.md`、`../HMR.md` 为准。

## 目标

Pluxel 需要同时支持两类插件生态：

- loader 插件生态：插件来源动态，依赖 workspace scan、package install、module catalog、runtime replacement。
- static suite 插件生态：插件总量固定明确，入口文件静态 export 所有插件，企业应用更关心配置、启动检查、可控 replacement 边界和部署确定性。

这两类生态不应该分裂成两套 runtime。它们应该共享 runtime common host layer，只在 catalog resolution、startup policy 和 route-specific management 能力上分叉。

## 分层模型

```text
@pluxel/core
  owns plugin graph / DI / lifecycle / config validation

@pluxel/runtime common
  owns services / config persistence / ops / web APIs / plugin UI protocols / status read models

runtime loader route
  owns scan / package / dynamic module catalog / loader batch replacement

runtime static suite route
  owns known catalog / strict startup / plugin set drift policy

runtime loader dev mode
  owns Vite runner / watch / moduleGraph / dev-time source execution
  submits through loader batch replaceModule
```

core 不知道 route。runtime common 不知道 loader dev mode。dev mode 属于 loader route，不按 route 做抽象 adapter。

## Runtime common layer

两条路线必须复用：

- config persistence、profile、patch/reset ops。
- web config API 和 workbench config UI。
- plugin status projection 和 startup report projection。
- ops/control-plane carrier：CLI、RPC、MCP、workbench。
- plugin UI protocols：packaged remote、builtin/doc、SignalDB、RPC、SSE。
- HTTP service、root services、vault/fs 等宿主能力。

这些能力属于 runtime，不应该为了 static suite 复制到 core，也不应该复制成一个新的 runtime 包。

## Loader route

状态：当前实现。

负责：

- workspace/plugin entry scan。
- package install/remove/cache。
- module id 到 plugin ctors 的映射。
- enabled bit 到 core registry draft 的同步。
- loader batch replacement。
- loader dev mode source submission。
- dynamic catalog 状态、missing dependency、enabled-but-stopped 解释。

当前 loader 热替换路线：

```text
file change
-> Vite moduleGraph
-> runner import
-> loader batch replaceModule
-> sync affected runtime modules
-> core commit
```

loader route 的重度逻辑不应该泄漏到 static suite route。

## Static suite route

状态：未来提案。

适合：

- 插件集合固定且明确。
- 一个入口文件 export 所有插件。
- 部署时不需要动态 install/scan/package。
- 启动时要严格知道哪个插件没启动、为什么没启动。
- replacement 边界希望限制在插件或 suite entry 粒度。

## Static suite route 需要的内容

static suite route 不只是“把插件数组 register 到 core”。它至少需要这些部分：

1. Suite declaration
   - 描述固定插件集合。
   - 描述默认 enabled 集合。
   - 允许绑定 suite-level metadata，例如 suite name、version、profile policy。
   - 可选声明 replacement boundary。

2. Known catalog resolver
   - 从 suite entry 得到稳定插件清单。
   - 给每个插件建立稳定 id/name、ctor、schema metadata、dependency metadata。
   - 不依赖 workspace scan、package install、dynamic module map。

3. Startup planner
   - 合并 suite defaults、runtime persisted config、enabled/disabled 状态。
   - 对每个插件做 config validation。
   - 构造 core registry draft。
   - 选择 strict/fail-soft 启动策略。

4. Startup report
   - 明确每个插件状态：started、disabled、config-invalid、dependency-missing、start-failed。
   - 明确失败归因：插件名、schema key、依赖、异常、是否阻塞 suite。
   - 给 CLI/RPC/MCP/workbench 使用同一个 read model。

5. Config bridge
   - 复用 core schema/default validation。
   - 复用 runtime file/memory/readonly persistence。
   - 复用 web config form 和 patch/reset/validate ops。
   - 不要求插件来自 loader registry。

6. Route-neutral plugin status model
   - 用 plugin id/name 表达状态。
   - common 状态不依赖 loader module id。
   - 需要给 UI/诊断展示来源时，用只读 `source` 字段表达 loader/static-suite。
   - route-specific diagnostics 放在 capability/diagnostics 字段，不污染 common API。

7. Static dev replacement
   - 默认不实现，也不继承 loader dev mode。
   - 如果未来证明 fixed catalog 需要独立 dev replacement，应放在 static suite 自己的 dev 子路径。
   - 重新 import suite entry 或 plugin boundary、漂移检查、known plugin replacement 都属于 static route 自己的设计，不进入 runtime common。

8. Route-specific ops
   - common plugin/config ops 保持 route-neutral。
   - loader install/scan/package/cache 这类能力只暴露为 loader-specific ops。
   - static suite 的 drift check、startup report、strict restart 暴露为 static-specific ops。

9. Diagnostics
   - 启动前检查 suite declaration。
   - 检查插件 name/id 冲突。
   - 检查配置 schema 是否可提取。
   - 检查 replacement boundary 是否能映射到 known plugins。

可能的 authoring 形态：

```ts
export const suite = definePluginSuite({
	plugins: [PluginA, PluginB],
	enabled: ['PluginA', 'PluginB'],
	config: {
		PluginA: {},
		PluginB: {},
	},
	dev: {
		entries: [import.meta.url],
		boundary: 'plugin',
	},
})
```

启动目标：

```text
load runtime config snapshot
read suite catalog
resolve enabled plugins
ensureValidated(plugin, schemaMap)
register enabled ctors
commitStrict()
return StartupReport or fail
```

默认策略：

- 插件集合 drift 默认报错。
- enabled plugin 未启动默认进入 startup report，并可配置为 fail-fast。
- 配置 schema 校验失败必须归因到插件和 schema key。
- static suite 不依赖 workspace scan/package/cache。

## Dev replacement 路线

当前只承认 loader dev mode 这一条路线。Vite runner、watch 和 moduleGraph 属于 `@pluxel/runtime-loader` 的 dev 子路径，提交到 loader batch。

loader dev replacement：

```text
changed source
-> runner import dynamic module
-> loader.replaceModule(moduleId, exports)
-> loader sync affected modules
-> core commit
```

static suite dev replacement 不是当前目标：

```text
changed source
-> runner import suite entry or plugin boundary
-> suite adapter resolve known plugin ctors
-> validate plugin set drift
-> replace known plugin ctor(s)
-> core commit strict or report
```

static route 如果未来实现 dev replacement，优化点应来自 fixed catalog 本身：

- 不需要 scan 整个 workspace。
- 不需要维护动态 module catalog。
- 可以用 suite declaration 限制 replacement 边界。
- 可以在插件集合变化时直接报错，而不是尝试猜测动态目录状态。

但不要为了这个未来可能性在 runtime common 中预留 `HmrAdapter`、`RouteHmrAdapter` 或多 runner 抽象。loader dev mode 的完整设计见 `runtime-loader-dev-mode.md`。

## Runtime API 重构方向

当前 runtime API 很多地方天然假设 loader 存在：module id、scan、package、loader registry、replaceModule、enabled-but-stopped 等概念会出现在状态解释和控制面里。static suite route 如果直接复用这些 API，会显得笨重且语义不干净。

未来应该把 runtime API 分成三层，但不要做成可无限扩展的 route plugin 系统：

```text
route-neutral common API
  plugin status / plugin config / lifecycle ops / UI protocols

route-specific management API
  loader: scan / install / remove / package cache / dynamic module diagnostics
  static-suite: startup report / drift check / suite restart / boundary diagnostics

internal route adapter API
  runtime common 启动时持有一个明确 route implementation
```

route-neutral API 应避免暴露：

- module id。
- package install/cache。
- workspace scan result。
- loader batch。
- dynamic module replacement。

route-neutral API 应使用：

- plugin name/id。
- lifecycle stage。
- config schema/default/layout。
- source/capabilities read model。
- diagnostics read model。

这样网页配置可以和 loader route 共用，但不会继承 loader 的动态目录心智模型。workbench 可以展示同一个插件配置页，同时在 diagnostics 区域根据 `source` 展示不同解释。

推荐的内部形态是两个明确实现，而不是靠字符串 `kind` 做业务分发：

```ts
interface RuntimePluginCatalog {
	startup(): Promise<RouteStartupReport>
	restartPlugin(pluginId: string): Promise<RouteChangeReport>
	describePlugins(): Promise<RoutePluginSnapshot[]>
	describeCapabilities(): RouteCapabilities
}

class LoaderRuntimeCatalog implements RuntimePluginCatalog {
	replaceModule(moduleId: string, exports: unknown): Promise<RouteChangeReport>
}

class StaticSuiteRuntimeCatalog implements RuntimePluginCatalog {
	replaceKnownPlugin(pluginId: string, ctor: PluginCtor): Promise<RouteChangeReport>
	checkDrift(): Promise<StaticSuiteDriftReport>
}
```

runtime common 启动时只接收一个 catalog 实例。需要区分 loader/static-suite 的地方，应该通过 TypeScript 的具体类型、构造路径或 route-specific ops 解决，不要让 common 层到处写 `if (kind === ...)`。

字符串来源字段只适合 read model：

```ts
type PluginSource =
	| { type: 'loader'; moduleId: string }
	| { type: 'static-suite'; suite: string }
```

这个字段用于 UI、日志、诊断和序列化，不作为核心生命周期分发机制。

## 外部 host 显式组合网络面

状态：未来展望，尚未实现。

如果要把两条路线做得更彻底，runtime common 不应该因为配置项自动决定要不要挂载 package-manager、workspace tools、workbench UI 或 route-specific backend routes。更清晰的模型是：runtime common 只提供网络和协议 primitives，外部 host/bootstrap 显式组合需要的后端路由和前端 UI。

runtime common 负责提供：

- `HttpService`、RPC、SSE、MCP server carrier。
- runtime web protocol、config persistence、ops、status projection。
- plugin UI remote/builtin/doc protocol。
- route-neutral plugin catalog 契约和 read model。

route package 负责提供可选择挂载的能力：

- loader route：package-manager GraphQL/RPC、workspace MCP tools、scan/package diagnostics、动态插件 UI 面板。
- static suite route：startup report、drift check、strict restart、suite config UI、边界诊断。

host 负责显式组合：

```ts
const runtime = createRuntimeHost(...)

mountRuntimeCommonApi(runtime)

const loader = installLoaderRoute(runtime)
mountLoaderPackageManagerApi(runtime, loader)
mountLoaderWorkspaceTools(runtime, loader)
mountWorkbenchUi(runtime, {
	config: true,
	packageManager: true,
})
```

static suite 的组合可以完全不同：

```ts
const runtime = createRuntimeHost(...)

mountRuntimeCommonApi(runtime)

const suite = installStaticSuiteRoute(runtime, suiteDeclaration)
mountStaticStartupReportApi(runtime, suite)
mountSuiteConfigUi(runtime, suite)
mountWorkbenchUi(runtime, {
	config: true,
	startupReport: true,
})
```

这样 runtime common 不默认拥有任何路线的产品面；loader 和 static suite 都只是复用 runtime 的网络能力，然后各自选择要暴露什么控制面、什么前端 UI。配置仍然重要，但配置只描述业务状态和持久化策略，不负责偷偷改变 host 挂载拓扑。

这也意味着当前 contribution registry 未来可以继续收敛：从副作用式注册 GraphQL/RPC/MCP，逐步变成显式 `mount*` 函数。目标态不保留旧入口兼容；host 应按能力显式组合，避免 runtime common 背上 loader route 的默认心智负担。

## 与 config/web config 的关系

static suite 不能重做配置系统。它应该复用：

- core 的 `configs.use(...)`、`cfg(schemaMap)`、schema defaulting、validation snapshot。
- runtime 的 file/memory/readonly persistence。
- runtime 的 patch/reset/validate ops。
- workbench 的 config form/layout UI。

企业场景的“便携高效”主要来自这里：固定插件目录减少加载不确定性，runtime 共同配置能力保留运维和 UI 能力。

## 实现顺序

1. 已开始把 runtime common 和 loader-specific 代码边界标清：`@pluxel/runtime-loader` 承载 loader/scan/package/package-manager/workspace tools。
2. 已给当前 loader route 补 plugin catalog adapter，并通过 runtime API contribution registry 保持现有 GraphQL/RPC/MCP 入口。
3. 按 `runtime-loader-dev-mode.md` 把独立 HMR 概念收敛进 loader dev mode，并删除旧 `@pluxel/hmr` 入口。
4. 设计 static suite declaration 和 startup report 类型。
5. 实现 static route startup，不接 dev replacement。
6. 把 workbench/ops/status 投影统一到 route-neutral read model。

## 非目标

- 不把 static suite 做成 core 功能。
- 不新增替代 runtime 的第二个 runtime 包。
- 不让 runtime 依赖 loader dev mode、Vite、watch 或 source runner。
- 不把 loader route 的 scan/package/cache 强行复用到 static route。
- 不保留 `@pluxel/hmr` 或旧 HMR 配置入口作为兼容层。
- 不把 `definePluginSuite` 写成当前 API，直到实现落地。

## 文档归属

- 当前 core/runtime/hmr 行为：`../CORE.md`、`../RUNTIME.md`、`../HMR.md`。
- 未来 loader dev mode 收敛：`runtime-loader-dev-mode.md`。
- 未来 runtime route 分叉：本文件。
- 提案总入口：`README.md`。
- 实现后再把已完成部分迁入当前领域文档，并删减本文件。
