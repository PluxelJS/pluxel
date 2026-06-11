# Runtime Routes Proposal

状态：分阶段实现中。当前已实现路线是 `@pluxel/runtime-dynamic` 的 loader route；`@pluxel/runtime-static` 已开始提供 fixed catalog startup、startup/change report 和轻量 static HMR，ops/web/MCP 控制面仍待接入。

## 目标模型

Pluxel 保持一个 runtime common host layer，两条插件来源路线复用它：

```text
@pluxel/core
  -> plugin graph / DI / lifecycle / config validation

@pluxel/runtime
  -> config persistence / ops / web config / plugin UI protocols / route-neutral status

@pluxel/runtime-dynamic
  -> scan / package / cache / dynamic module catalog / loader HMR

@pluxel/runtime-static
  -> static definition / known catalog / startup report / static HMR
```

route 只负责插件来源、catalog 和 route-specific diagnostics。runtime common 负责宿主能力与控制面，core 负责生命周期提交。两条 route 可共享的核心不是 loader，而是“catalog plan -> core commit/report”的窄提交流程。

## Runtime Common

两条路线共享：

- config persistence、profile、patch/reset/validate ops。
- web config API 和 workbench config UI。
- plugin status projection 和 startup report projection。
- CLI/RPC/MCP/workbench control-plane carrier。
- plugin UI protocols：packaged remote、builtin/doc、SignalDB、RPC、SSE。
- HTTP service、root services、vault/fs/logging 等宿主能力。

route-neutral API 使用 plugin name/id、lifecycle stage、config schema/default/layout、source/capabilities、diagnostics read model。

## Runtime Dynamic Route

dynamic route 服务动态插件生态：

- workspace/plugin entry scan。
- package install/remove/cache。
- dynamic module id 到 plugin ctors 的映射。
- loader batch replacement。
- loader HMR source submission。
- missing dependency、enabled-but-stopped、dynamic catalog diagnostics。

HMR 路线：

```text
file change
-> Vite moduleGraph
-> runner import dynamic module
-> loader batch replaceModule
-> sync affected runtime modules
-> core commit
```

详细设计见 `runtime-dynamic-hmr-mode.md`。

## Runtime Static Route

static route 服务固定插件目录：

- `defineStaticRuntime(...)` 声明固定插件集合。
- `createStaticRuntimeHost(..., { configService })` 选择 runtime config 来源。
- plugin metadata 形成 known catalog。
- runtime config `enabled` set 选择参与启动的插件。
- startup report 解释每个 known plugin 的结果。
- static HMR 通过重新 import definition 后按 plugin name diff catalog，不经过 dynamic loader replacement。

启动路线：

```text
load runtime config
import static definition
build known catalog
select enabled plugins from runtime config
validate selected plugin configs
produce catalog plan
apply core registry draft
commit selected plugins through core
return startup report
```

详细设计见 `runtime-static-route.md`。

## Route Boundary

```text
runtime common
  plugin status / plugin config / lifecycle ops / UI protocols

runtime-dynamic
  scan / install / remove / package cache / dynamic module diagnostics

runtime-static
  known catalog / startup report / drift diagnostics / static HMR
```

不要把 dynamic loader 的 module registry、module id、`replaceModule(...)` 或 loader batch 抽成 runtime common；这些只服务 dynamic source ingestion。static route 的 source ingestion 是 definition import 和 plugin-name catalog diff。

内部实现可以有一个窄的 catalog 契约：

```ts
interface RuntimePluginCatalog {
	startup(): Promise<RouteStartupReport>
	restartPlugin(pluginId: string): Promise<RouteChangeReport>
	describePlugins(): Promise<RoutePluginSnapshot[]>
	describeCapabilities(): RouteCapabilities
}
```

route-specific 能力留在具体实现上：

```ts
class LoaderRuntimeCatalog implements RuntimePluginCatalog {
	replaceModule(moduleId: string, exports: unknown): Promise<RouteChangeReport>
}

class StaticRuntimeCatalog implements RuntimePluginCatalog {
	replaceKnownPlugin(pluginId: string, ctor: PluginCtor): Promise<RouteChangeReport>
	checkDrift(): Promise<StaticRuntimeDriftReport>
}
```

read model 可以带来源字段，用于 UI、日志、诊断和序列化：

```ts
type PluginSource =
	| { type: 'dynamic'; moduleId: string }
	| { type: 'static'; runtime: string }
```

## Host Assembly

runtime common 提供网络和协议 primitives；host 显式挂载 route 需要的控制面。

dynamic host：

```ts
const runtime = createRuntimeHost(...)
mountRuntimeCommonApi(runtime)

const dynamicRoute = installDynamicRoute(runtime)
mountDynamicPackageManagerApi(runtime, dynamicRoute)
mountDynamicWorkspaceTools(runtime, dynamicRoute)
```

static host：

```ts
const runtime = createRuntimeHost(...)
mountRuntimeCommonApi(runtime)

const staticRoute = installStaticRuntimeRoute(runtime, staticDefinition)
mountStaticStartupReportApi(runtime, staticRoute)
```

配置只描述业务状态和持久化策略；host assembly 决定暴露哪些 route-specific API 和 UI。

## 实现顺序

1. 保持 runtime common 与 runtime-dynamic 的边界清楚。
2. 完成 runtime-static public declaration 和 host skeleton。
3. 实现 runtime-static known catalog 与 startup report。
4. 复用 runtime config/web config/ops/status 投影。
5. 基于 `define`/`start` 分离设计 `@pluxel/runtime-static/hmr`。

## 文档归属

- 当前 core/runtime/hmr 行为：`../CORE.md`、`../RUNTIME.md`、`../HMR.md`。
- dynamic HMR mode：`runtime-dynamic-hmr-mode.md`。
- static route API、startup 和 HMR：`runtime-static-route.md`。
- route 分层索引：本文件。
