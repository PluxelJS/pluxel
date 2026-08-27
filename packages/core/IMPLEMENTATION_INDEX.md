# @pluxel/core — Implementation Index (for LLM)

目标：索引 core 的公共导出、关键注册点与依赖边界，避免误把 runtime/loader-hmr 逻辑塞进 core。

仓库级约束与设计目标见：

- `engineering/CORE.md`
- `engineering/CONFIG.md`
- `engineering/GOVERNANCE.md`
- `engineering/LOGGING.md`
- `engineering/proposals/README.md`

## Public Surface (package exports)

- `packages/core/package.json`
  - `.` → `packages/core/src/index.ts`
  - `./env` → `packages/core/src/env.ts`
  - `./services` → `packages/core/src/services/index.ts`
  - `./logger` → `packages/core/src/logger/index.ts`

## Core Entry

- `packages/core/src/index.ts`
  - `Context`、`Plugin`/`BasePlugin`、decorators、runtime 生命周期基建
- `engineering/PLUGIN_SYSTEM.md`
  - 当前唯一 Plugin authoring、slot identity、required/optional graph 与 generation effects 设计
  - runtime update 重构是否值得推进、dynamic/static 收益差异、性能损益和停止规则

## Internal kernels

- `packages/core/src/internal/di/`：plugin-specialized incremental dependency graph；
- `packages/core/src/internal/fsm/`：PluginActor 使用的 baked lifecycle state machine；
- `packages/core/src/plugins/runtime/plugin-service/HostLifecycle.ts`：pre-root package-private generation
  finalization、stable settlement、commit preparation 与原子 publication authority；
- 这些都属于 core 实现，不是 Plugin 作者 API。

## Services

- `packages/core/src/services/index.ts`
  - core-level services 聚合（events/effects/config 等；不包含宿主能力）

## Logger

- `packages/core/src/logger/index.ts`
  - Context logger facade 与 category identity；runtime sinks/store 不在 core
