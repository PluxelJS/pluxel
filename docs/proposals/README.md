# Proposals

这里记录未实现提案和已落地设计记录。不要只凭本目录判断当前 API；当前实现以代码、包内 README、`../CORE.md`、`../RUNTIME.md`、`../HMR.md`、`../TOOLCHAIN.md` 等领域文档为准。

已完成的 runtime-dynamic split、loader HMR 收敛、runtime-static route、以及 `@pluxel/rolldown` 工具链合并不再保留独立 proposal 文档；需要考古时从 git history 读取旧原文。

## Workbench View Model

状态：提案。

未来方向是 host-owned `WorkbenchView`：

- editor area
- sidebar
- panel

每个区域都可以 tab-aware，但语义不同：

- editor tabs：页面实例、close behavior、dirty protection。
- sidebar tabs：切换上下文 helper views。
- panel tabs：切换 logs/tools。

这个模型用于替换当前更零散的 plugin tabs/context/dock 概念，但目前不是当前 UI 行为。

## Plugin UI Cleanup

状态：未来清理。

方向：

- 继续收窄 plugin UI authoring surface。
- 保持 builtin/custom frontend docs 和 demos 对齐。
- 减少 extension loader/runtime state duplication。
- SignalDB authoring 收敛到少数稳定 access patterns。
- 在 MF2/Vite 上游行为足够稳定前，继续隔离构建状态。
- 增加 extension loader、interaction session lifecycle、plugin UI build isolation 的 focused tests。

非目标：不要发明第三条产品路径，也不要引入新的 universal state framework。

## Vite-Owned Runtime Routes

状态：已实现。

目标是把 static/dynamic 宿主入口统一成 host-owned Vite plugin + `defineXxxRuntimeConfig(...)`
配置文件。设计记录见 `vite-owned-runtime-routes.md`。

## Runtime Concept Pruning

状态：提案。

Vite-owned runtime routes 落地后，下一批值得大幅出清的概念包括 runtime web paths 去 HMR 化、route capability 合并 route dev/module runtime、dynamic package manager 下沉为 route feature、plugin contribution 命名收敛，以及 plugin control state mutation 收窄。前三项已推进；剩余方向见 `runtime-concept-pruning.md`。

## Core DI V2

状态：prototype/future architecture notes。`@pluxel/core-di` 当前仍是 internal/private prototype。

方向：

- graph-first。
- explicit declarations。
- graph snapshots 可检查。
- incremental graph compile 成为一等设计目标。
- cache/lifetime semantics 保持 minimal 且 plugin-biased。

非目标：

- 不是通用企业 DI framework。
- 不是 decorator-magic container。
- 不是 `diod` drop-in clone。

参考实现/笔记：

- `packages/core-di/README.md`
- `packages/core-di/DESIGN.md`
- `packages/core-di/benchmarks/core-di-vs-diod.md`

## Logger Redesign

状态：已落地的设计记录。

设计记录见 `logger-redesign.md`。核心原则是不要重造 LogTape 抽象，而是把 Pluxel 的 context、plugin log policy、caller policy、runtime UI store 等语义显式编译到 LogTape config/filter/sink。

必须保留 workbench 配置插件日志策略的能力，但策略应成为独立 runtime state，由 LogTape filter 读取；网页不直接配置 LogTape。

## Promotion Rule

提案实现后：

1. 把已实现行为迁入对应当前领域文档。
2. 删除或缩短本文件里的提案段落。
3. 如果 public API 变化，更新相关包 README。
4. 包内文档只保留实现相关说明，不重复仓库级设计。
