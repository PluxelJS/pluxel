# @pluxel/runtime

`@pluxel/runtime` 是 Pluxel 的 **runtime kernel**：提供可组合的 runtime services（loader / package / http / config / plugin-interaction / logging…），以及这些服务对外暴露的 **稳定路由/协议**（例如 `ctx.http.fetch`、Web SDK、internal APIs）。

设计目标：

- **只靠 `new Context()` 就能建立 runtime**：服务是按需实例化的；宿主可以自己决定 config/storage/HTTP 暴露方式。
- **不包含任何 Vite/HMR 逻辑**：开发期能力由 `@pluxel/hmr` “附加”到同一个 `Context` 上。
- 依赖链清晰：runtime 只做 “核心服务与协议”；HMR 负责 “Vite + watch + workspace source execution”。

## 快速使用（生产/非 HMR）

最小宿主通常只需要：

1) `new Context()`（带必要的 service config）
2) 暴露 `ctx.http.fetch` 到你的 HTTP server / edge runtime

```ts
import { Context } from '@pluxel/runtime'

const ctx = new Context({
	profile: 'prod',
	configService: { mode: 'file', path: './data/runtime/config.json' },
	pluginData: { dir: './data/plugin-data' },
	packageService: {
		policy: { allowInstall: false, allowUninstall: false },
		state: { enabled: true, file: './data/runtime/package-state.json' },
	},
	http: {
		controlPlane: { web: true, rpc: true, sse: true, auth: 'none' },
		uiAssets: 'static-built',
	},
	extensionService: { mode: 'registry-only' },
})

export const fetch = (req: Request) => ctx.http.fetch(req)
```

## 开发期（Vite/HMR）

runtime 本身不启动 Vite。开发期请使用 `@pluxel/hmr`：

- `startHmrHostFromConfig(...)`：标准入口（diagnose + new Context + start）
- （可选）`attachHmrRuntime(ctx, { workspaceSnapshot })`：如果你已有自定义 `Context`，可用低级 attach 做启动期 wiring

## 当前设计判断

当前状态已经可以视为稳定提交点：

- runtime / hmr 的实现边界已经清晰；
- `plugin-interaction` 的核心状态已经收口，不再有多层 registry/service 绕行；
- `tsc` 和关键测试链路都已恢复稳定。

本轮没有继续做的事情，也是刻意的：

- 没有为了“语义更纯”把 runtime 内部的 `hmr` 命名大规模改掉；
- 没有再拆出更多 control-plane / host / bridge 概念；
- 没有继续细分 `ExtensionService` 为更多小服务。

原因是这些变化目前大多只会增加概念，而不会明显提升性能、可读性或维护效率。

如果后续继续重构，建议只在下面两种情况再动：

- 出现第二种非-HMR host，需要复用同一套 control-plane 协议；
- `ExtensionService` 或 internal API 再次明显膨胀，已经影响日常理解与修改成本。

## Subpath / 约定

- `@pluxel/runtime/services`：runtime services 的公开类型与导出（例如 `BuiltinPluginSpec`、`HttpHandler` 等）
  - 包含宿主能力：`ctx.root.fs`（原子写 + memory backend）、`ctx.vault`（加密存储）
- `@pluxel/runtime/logger`：日志与 UI log store（`ensurePluxelLogging` 等）
  - Node-only file sink（daily rotation by prefix path）也放在这里（`createDailyTimeRotatingFileSink`）
- `@pluxel/runtime/web`：浏览器侧 SDK / UI 协议常量
- `@pluxel/runtime/frozen`：冻结宿主生成器（`buildFrozenHost()`）
- `@pluxel/runtime/shared`：给 `@pluxel/hmr` 复用的纯工具（不依赖 Vite dev server；包含统一的 path/realpath/glob 逻辑）
- `@pluxel/runtime/internal`：HMR 与 runtime 的 glue（dev-handles / module-runtime / paths + dev-only compile helpers）

> 约束：应用层如果需要 “启动方式/宿主组合”，建议放在应用自己（例如 `packages/plugins/host/scripts/*`），而不是放回 runtime。

## 维护与发布（给维护者/agent）

仓库级约束与设计目标统一写在：

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`
- `docs/SERVICES.md`
