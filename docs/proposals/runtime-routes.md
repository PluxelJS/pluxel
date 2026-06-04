# Runtime Routes Proposal

状态：未来设计提案。当前没有 `@pluxel/static-suite` 包，没有 runtime static-suite subpath，也没有 static route HMR adapter。当前已实现路线仍是 `RUNTIME.md` 里的 loader route。

## 为什么单独成文档

这个设计不是一个普通 feature，而是 runtime 模型的大改：

```text
core
  -> runtime common host layer
       -> loader route
       -> static suite route

hmr
  -> loader HMR adapter
  -> static suite HMR adapter
```

如果只塞进 `README.md` 的小节，LLM 很容易把未实现路线误读成当前 runtime 行为。这个文档只讨论未来路线和迁移边界；当前实现仍以 `../CORE.md`、`../RUNTIME.md`、`../HMR.md` 为准。

## 目标

Pluxel 需要同时支持两类插件生态：

- loader 插件生态：插件来源动态，依赖 workspace scan、package install、module catalog、runtime replacement。
- static suite 插件生态：插件总量固定明确，入口文件静态 export 所有插件，企业应用更关心配置、启动检查、可控 HMR 边界和部署确定性。

这两类生态不应该分裂成两套 runtime。它们应该共享 runtime common host layer，只在 catalog resolution、startup policy、HMR submission adapter 上分叉。

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

@pluxel/hmr
  owns Vite runner / watch / moduleGraph / dev-time source execution

hmr loader adapter
  submits through loader batch replaceModule

hmr static adapter
  submits through known-plugin suite adapter
```

core 不知道 route。runtime common 不知道 HMR。HMR attach 到 runtime，并按 route 选择提交 adapter。

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
- dynamic catalog 状态、missing dependency、enabled-but-stopped 解释。

当前 HMR 路线：

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
- HMR 边界希望限制在插件或 suite entry 粒度。

## Static suite route 需要的内容

static suite route 不只是“把插件数组 register 到 core”。它至少需要这些部分：

1. Suite declaration
   - 描述固定插件集合。
   - 描述默认 enabled 集合。
   - 允许绑定 suite-level metadata，例如 suite name、version、profile policy。
   - 可选声明 HMR boundary。

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
   - `route.kind` 标记来自 `loader` 还是 `static-suite`。
   - route-specific diagnostics 放在 capability/diagnostics 字段，不污染 common API。

7. Static HMR adapter
   - 复用 HMR 的 Vite runner/watch/moduleGraph。
   - 重新 import suite entry 或 plugin boundary。
   - 校验插件集合是否 drift。
   - 替换已知 plugin ctor，再交给 core commit。

8. Route-specific ops
   - common plugin/config ops 保持 route-neutral。
   - loader install/scan/package/cache 这类能力只暴露为 loader-specific ops。
   - static suite 的 drift check、startup report、strict restart 暴露为 static-specific ops。

9. Diagnostics
   - 启动前检查 suite declaration。
   - 检查插件 name/id 冲突。
   - 检查配置 schema 是否可提取。
   - 检查 HMR boundary 是否能映射到 known plugins。

可能的 authoring 形态：

```ts
export const suite = definePluginSuite({
	plugins: [PluginA, PluginB],
	enabled: ['PluginA', 'PluginB'],
	config: {
		PluginA: {},
		PluginB: {},
	},
	hmr: {
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

## 两种 HMR 路线

HMR 仍然拥有 Vite runner、watch 和 moduleGraph，但提交路径按 route 分开。

loader HMR：

```text
changed source
-> runner import dynamic module
-> loader.replaceModule(moduleId, exports)
-> loader sync affected modules
-> core commit
```

static suite HMR：

```text
changed source
-> runner import suite entry or plugin boundary
-> suite adapter resolve known plugin ctors
-> validate plugin set drift
-> replace known plugin ctor(s)
-> core commit strict or report
```

static route 的 HMR 优化点：

- 不需要 scan 整个 workspace。
- 不需要维护动态 module catalog。
- 可以用 suite declaration 限制 HMR 边界。
- 可以在插件集合变化时直接报错，而不是尝试猜测动态目录状态。

## Runtime API 重构方向

当前 runtime API 很多地方天然假设 loader 存在：module id、scan、package、loader registry、replaceModule、enabled-but-stopped 等概念会出现在状态解释和控制面里。static suite route 如果直接复用这些 API，会显得笨重且语义不干净。

未来应该把 runtime API 分成三层：

```text
route-neutral common API
  plugin status / plugin config / lifecycle ops / UI protocols

route-specific management API
  loader: scan / install / remove / package cache / dynamic module diagnostics
  static-suite: startup report / drift check / suite restart / boundary diagnostics

internal route adapter API
  runtime common 调 route adapter，route adapter 调 core registry
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
- route kind。
- route capabilities。
- diagnostics read model。

这样网页配置可以和 loader route 共用，但不会继承 loader 的动态目录心智模型。workbench 可以展示同一个插件配置页，同时在 diagnostics 区域根据 `route.kind` 展示不同解释。

可能的内部形态：

```ts
interface RuntimePluginRoute {
	kind: 'loader' | 'static-suite'
	startup(): Promise<RouteStartupReport>
	restartPlugin(pluginId: string): Promise<RouteChangeReport>
	replaceKnownPlugin?(pluginId: string, ctor: PluginCtor): Promise<RouteChangeReport>
	describePlugins(): Promise<RoutePluginSnapshot[]>
	describeCapabilities(): RouteCapabilities
}
```

这仍然是内部 route adapter，不是插件作者 API。

## 与 config/web config 的关系

static suite 不能重做配置系统。它应该复用：

- core 的 `configs.use(...)`、`cfg(schemaMap)`、schema defaulting、validation snapshot。
- runtime 的 file/memory/readonly persistence。
- runtime 的 patch/reset/validate ops。
- workbench 的 config form/layout UI。

企业场景的“便携高效”主要来自这里：固定插件目录减少加载不确定性，runtime 共同配置能力保留运维和 UI 能力。

## 迁移顺序

1. 先把 runtime common 和 loader-specific 代码边界标清，不改变行为。
2. 给当前 loader route 补内部 adapter 包装，保持 API 不变。
3. 设计 static suite declaration 和 startup report 类型。
4. 实现 static route startup，不接 HMR。
5. 接 static HMR adapter，先只支持 plugin boundary。
6. 把 workbench/ops/status 投影统一到 route-neutral read model。

## 非目标

- 不把 static suite 做成 core 功能。
- 不新增替代 runtime 的第二个 runtime 包。
- 不让 runtime 依赖 HMR。
- 不把 loader route 的 scan/package/cache 强行复用到 static route。
- 不把 `definePluginSuite` 写成当前 API，直到实现落地。

## 文档归属

- 当前 core/runtime/hmr 行为：`../CORE.md`、`../RUNTIME.md`、`../HMR.md`。
- 未来 runtime route 分叉：本文件。
- 提案总入口：`README.md`。
- 实现后再把已完成部分迁入当前领域文档，并删减本文件。
