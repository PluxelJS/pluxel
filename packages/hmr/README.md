# @pluxel/hmr

`@pluxel/hmr` 是 Pluxel 的 **dev host wrapper**：负责 workspace diagnose、source execution、watch、以及 HMR。

它不提供另一套 runtime kernel；它做的事情是：

- 读配置、诊断 workspace（生成 `HmrWorkspaceSnapshot`）
- 创建 `@pluxel/runtime` 的 `Context`
- 在启动阶段把 dev-only 能力接到 runtime 的几个最小挂点上（module adapter / dev handles / UI extension compiler）
- 启动 Vite dev server + runner

## 推荐用法（从 JSONC 配置启动）

```ts
import { startHmrHostFromConfig } from '@pluxel/hmr/host'

const { ctx } = await startHmrHostFromConfig({
	root: process.cwd(),
	configPath: 'pluxel.hmr.jsonc',
	profile: process.env.PLUXEL_HMR_PROFILE ?? 'dev',
	logging: true,
})

// ctx.http.fetch 即可挂到任何 HTTP server 上
```

## 可选：对既有 Context 做低级 attach

如果你已经有自己的 `new Context(...)`（自定义 storage、logger、service config 等），可以直接把 dev-only 能力 attach 到这个 `ctx` 上：

```ts
import { Context } from '@pluxel/runtime'
import { attachHmrRuntime } from '@pluxel/hmr'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'

const ctx = new Context({ /* 你的 runtime service config */ })
const snapshot: HmrWorkspaceSnapshot = /* 由 diagnoseWorkspace 得到 */

const { hmr } = await attachHmrRuntime(ctx, { workspaceSnapshot: snapshot })
await hmr.start()
```

约束（不做运行时切换/恢复）：

- attach 是启动时的一次性决定；同一个 `Context` 只应 attach 一次
- 为了确定性，请在触发 `ctx.http` / `ctx.ext.ui` 等服务实例化之前 attach（否则需要你自行 reconfigure 已实例化服务）

## 模块边界

- `@pluxel/runtime`：核心 services / 协议 / 路由导出（不包含 Vite）
- `@pluxel/hmr`：Vite dev server + runner + pipeline + watch（通过 ctx 操作 runtime）

## 启动阶段的“一次性决定”

Pluxel 的开发期模型是 “启动时决定一切”：不会在同一进程里来回切换 “开/关 HMR” 或 “恢复原样”。

这带来两个好处：

- wiring 可以是纯启动逻辑，不需要复杂的运行时切换与回滚
- dev-only 资源（watcher/worker/dev server）统一绑定到 `ctx.effects`，测试和退出时可清理

## runtime 为什么仍然需要少量“挂点”

为了做到 “hmr 只是 runtime 的包裹而不是服务”，runtime 只保留 **dev-only 的最小注入点**，而不包含任何 Vite/HMR 实现：

- UI extension compiler 注入点：runtime 只定义 `ExtensionCompilerApi` 并允许注入实现，缺省时 `bindModule()` no-op
  - 见 `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
- module runtime adapter 注入点：runtime 缺省是 identity adapter，dev host wiring 时替换为 HMR adapter
  - 见 `packages/runtime/src/runtime/module-runtime.ts`
- dev handles 注入点：用 `WeakMap` 挂在 root ctx 上，不进入 DI，不影响生产 runtime
  - 见 `packages/runtime/src/runtime/dev-handles.ts`
- ExtensionService 内部自带 UI extension manifest + module cache；runtime 只暴露最小的 `ExtensionModuleStore` bridge 给 dev compiler
  - 见 `packages/runtime/src/services/plugin-interaction/ExtensionService.ts`
  - `@pluxel/hmr` 会把编译产物缓存到磁盘（默认 `.pluxel/extensions`），进程重启后优先从磁盘 cache 恢复到内存 store，避免重复编译
    - 见 `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`

额外：`@pluxel/runtime/internal` 里还有一些 “给 hmr 复用、但不扩张 public services surface” 的 helper（例如 extension bundle transform / extension module store 类型），原则同上。

## Server-safe 的 `@pluxel/runtime/web/*` 使用约定

`@pluxel/runtime/web` 是给浏览器/插件 UI 使用的复合导出（包含 React 相关类型与 helper）。

在 Node/HMR/服务端路径里：

- 需要路径常量时用 `@pluxel/runtime/web/paths`
- 需要 vendor 列表时用 `@pluxel/runtime/web/vendors`

避免在服务端代码里做 `import { ... } from '@pluxel/runtime/web'` 的 value import，防止把 React-heavy 的模块链路意外带进来。

## 还能怎么简并

- 推荐只用 host 组合（`@pluxel/hmr/host`）；低级 attach 作为“已有 Context 的 escape hatch”，但不要让业务代码分散拼装 wiring。
- 增加 guardrail 测试：禁止服务端实现对 `@pluxel/runtime/web` 做 value import（只允许 type import 或使用 `web/paths`、`web/vendors`）。

## Profiling / 耗时排行日志

HMR 的 “耗时排行 / attribution” 报告是 **可选** 的（避免默认输出过多日志）。

启用方式：

- 环境变量：`PLUXEL_HMR_ATTRIBUTION=info`（或 `debug/trace/warn/error/fatal`）
- 关闭：`PLUXEL_HMR_ATTRIBUTION=0`

对外导出刻意保持精简：

- `@pluxel/hmr`（root）只暴露 low-level attach + Vite 配置工具与 `HMRService`（避免 `export *`）
- `@pluxel/hmr/host`：从 JSONC 配置启动的高层组合入口
- `@pluxel/hmr/diagnose`：读取/校验配置与 workspace 扫描

## 维护与发布（给维护者/agent）

仓库级约束与设计目标统一写在：

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`
- `docs/SERVICES.md`
