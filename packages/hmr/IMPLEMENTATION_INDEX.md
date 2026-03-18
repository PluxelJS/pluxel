# @pluxel/hmr — Implementation Index (for LLM)

目标：索引 HMR/Vite 的实现入口、dev host wiring、以及从配置到启动的依赖链。

## Maintainer References

仓库级约束与设计目标（权威）见：

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`

## Public Surface (package exports)

- `packages/hmr/package.json`
  - `.` → `packages/hmr/src/index.ts`（low-level attach + Vite config helpers + `HMRService`）
  - `./host` → `packages/hmr/src/host.ts`（host composition + profiled store materialization）
  - `./diagnose` → `packages/hmr/src/diagnose.ts`（single export hub for config/discovery/profile helpers）
  - `./snapshot` → `packages/hmr/src/snapshot.ts`（HmrWorkspaceSnapshot 类型与断言）

## Entry

- `packages/hmr/src/index.ts`
  - `setPluxelRuntime('hmr')`
  - type-only：`packages/hmr/src/dev/context-augment.ts`（扩展 `Context.Config` 的 dev-only keys）
  - 显式 exports（避免 `export *`）：
    - env helper：`applyHmrEnvOverrides`（`packages/hmr/src/dev/runtime.ts`）
    - low-level attach：`attachHmrRuntime` / `startHmrRuntime`（`packages/hmr/src/dev/attach-runtime.ts`）
    - Vite fetch plugin：`createFetchDevServerPlugin`（`packages/hmr/src/dev/vite-fetch-plugin.ts`）
    - Service：`HMRService`（`packages/hmr/src/dev/hmr/HMRService.ts`）
    - Vite config helpers：`buildHmrViteConfig` / `resolveFsAllowList` / `resolveHMRDependencyConfig`（`packages/hmr/src/dev/hmr/config.ts`）

## Dev Host Wiring (核心)

- `packages/hmr/src/host.ts`
  - 内部 wiring：创建 `HMRService`、安装 module adapter、设置 dev handles、注入 UI extension compiler（通过 `ctx.config.extensionService.compiler`）
  - 标准启动路径：`createHmrHostFromConfig` / `startHmrHostFromConfig`

## HMR Service (Vite + Runner + Pipeline)

- `packages/hmr/src/dev/hmr/HMRService.ts`
  - 管理 Vite dev server 生命周期、runner、执行入口、builtins preload 等
- `packages/hmr/src/dev/hmr/pipeline.ts` / `runner.ts` / `workspace-entry-resolver.ts`
  - 入口解析、模块图跟踪、变更管线
- `packages/hmr/src/dev/hmr/runtime-shims.ts`
  - dev runtime 的 shim（为 runner 执行环境提供一致性）

## Singleton Bridging (重要约束)

- `packages/hmr/src/dev/hmr/config.ts`
  - `REQUIRED_BRIDGE_MODULES`：runner 必须与 host 共享单例的模块集合（避免 decorator/DI token 重复）
  - `REQUIRED_BRIDGE_PROVIDERS`：把“逻辑模块”映射到真正提供实现的 host 模块
    - 例如：`@pluxel/context` 被 workspace 内联到 `@pluxel/core` 时，runner 需要把 `@pluxel/context` 映射到 `@pluxel/core`，避免评估第二份实现

## Extension Compile (dev-only)

- `packages/hmr/src/dev/extensions/ExtensionCompilerService.ts`
  - 使用 `BundlerService` 生成 browser bundle
  - 与 runtime 的 vendor/JSX 逻辑对齐：调用 `@pluxel/runtime/internal`
    - `normalizeJsxRuntime` / `toBrowserBundleResolve` / `transformVendorImports`

- `packages/hmr/src/dev/compile/bundler/*`
  - bundler worker：`bundle-worker.mjs`
  - module graph：`moduleGraph.ts`

## Diagnose → Snapshot

- `packages/hmr/src/diagnose/config.ts`
  - `readHmrConfigV1` / `writeHmrConfigV1` / schema
- `packages/hmr/src/diagnose/diagnose.ts`
  - `diagnoseWorkspace(...)`：解析 workspace、生成 `HmrWorkspaceSnapshot`
- `packages/hmr/src/snapshot.ts`
  - `HmrWorkspaceSnapshot` 结构与断言（host 的输入边界）

## Host Composition (标准启动方式)

- `packages/hmr/src/host.ts`
  - `createHmrHostFromConfig` / `startHmrHostFromConfig`
    - diagnose → new `Context`（来自 `@pluxel/runtime`）→ 内部 wiring → `hmr.start()`
  - store/materialize helpers：来自 `@pluxel/runtime/internal`（paths/profile materialize）
