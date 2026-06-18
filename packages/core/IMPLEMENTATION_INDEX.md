# @pluxel/core — Implementation Index (for LLM)

目标：索引 core 的公共导出、关键注册点与依赖边界，避免误把 runtime/loader-hmr 逻辑塞进 core。

仓库级约束与设计目标见：

- `docs/CORE.md`
- `docs/CONFIG.md`
- `docs/GOVERNANCE.md`
- `docs/proposals/README.md`

## Public Surface (package exports)

- `packages/core/package.json`
  - `.` → `packages/core/src/index.ts`
  - `./env` → `packages/core/src/env.ts`
  - `./services` → `packages/core/src/services/index.ts`
  - `./logger` → `packages/core/src/logger/index.ts`

## Core Entry

- `packages/core/src/index.ts`
  - `Context`、`Plugin`/`BasePlugin`、decorators、runtime 生命周期基建
- `packages/core/docs/runtime-update/DESIGN.md`
  - runtime declaration update / HMR 支持的核心重设设计、性能预算、迁移阶段和被否决方向
- `packages/core/docs/runtime-update/STATUS.md`
  - runtime update 重构当前已完成、未完成、下一步接手顺序和快速验证命令
- `packages/core/docs/runtime-update/RATIONALE.md`
  - runtime update 重构是否值得推进、dynamic/static 收益差异、性能损益和停止规则

## Services

- `packages/core/src/services/index.ts`
  - core-level services 聚合（events/effects/config 等；不包含宿主能力）

## Logger

- `packages/core/src/logger/index.ts`
  - logger 服务与 UI log store 的基础构件
