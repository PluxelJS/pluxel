# Proposals

这里仅记录未实现或未来设计。不要把本文件内容当成当前 API；当前实现以 `../CORE.md`、`../RUNTIME.md`、`../HMR.md` 等领域文档为准。

## 1. Runtime Dynamic HMR Mode

状态：已采纳并进入实现态。独立 `@pluxel/hmr` 包不再保留，入口收敛到 `@pluxel/runtime-dynamic/hmr` 和 `@pluxel/runtime-dynamic/plugin`。

详细设计见 `runtime-dynamic-hmr-mode.md`。

核心方向：

- HMR 不再是独立包或独立 route，而是 `@pluxel/runtime-dynamic` 的 HMR mode。
- loader 继续拥有 dynamic catalog、scan、package、module registry、`replaceModule` 和 batch commit。
- HMR mode 只负责把 Vite/watch/runner 的 source change 转成 loader batch。
- 目标态只保留 `@pluxel/runtime-dynamic/hmr` 和 `@pluxel/runtime-dynamic/plugin` 两个 HMR 相关 subpath；diagnose/workspace/Vite helper 都归入 `/hmr`。
- 标准入口使用 `defineLoaderHmrConfig`、`createLoaderHmrHost`、`installLoaderHmr`、`LoaderHmrService`、`LoaderHmrSummary` 等命名。
- 不保留 `@pluxel/hmr`、`@pluxel/hmr/*`、`pluxel.hmr.jsonc` 或任何 re-export/facade/deprecated wrapper。

## 2. Runtime Static Route

状态：提案/骨架已建。当前已有 `@pluxel/runtime-static` 包骨架和 tsdown 构建配置，但还没有 runtime-static startup 实现，也没有 runtime-static HMR mode。

详细设计见 `runtime-routes.md` 和 `runtime-static-route.md`。这里仅保留摘要，避免把未来路线误写成当前 runtime 实现。

目标模型：

```text
@pluxel/runtime common host layer
  -> runtime-dynamic route  scan/package/dynamic module/HMR
  -> runtime-static route   known catalog/startup report/static HMR
```

runtime-static route 面向固定插件目录：

- static entry 静态导入并 export 所有插件。
- `defineStaticRuntime(...)` 只声明固定插件目录。
- `createStaticRuntimeHost(..., { configService })` 选择配置路径、模式或 snapshot。
- runtime config `enabled` set 决定启动哪些插件；空 enabled set 表示全部 disabled。
- startup report 用插件名解释 started、disabled、config-invalid、dependency-missing、start-failed、drift。
- static HMR 通过 Vite SSR import definition，按 plugin name 替换同名 ctor，并只提交 affected enabled plugins。

文档归属：

- `runtime-routes.md`：runtime common / dynamic / static 的分层索引。
- `runtime-static-route.md`：static route API、startup 和 HMR。
- 当前行为仍以 `../CORE.md`、`../RUNTIME.md`、`../HMR.md` 为准。

## 3. Workbench View Model

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

## 4. Plugin UI Cleanup

状态：未来清理。

方向：

- 继续收窄 plugin UI authoring surface。
- 保持 builtin/custom frontend docs 和 demos 对齐。
- 减少 extension loader/runtime state duplication。
- SignalDB authoring 收敛到少数稳定 access patterns。
- 在 MF2/Vite 上游行为足够稳定前，继续隔离构建状态。
- 增加 extension loader、interaction session lifecycle、plugin-build isolation 的 focused tests。

非目标：不要发明第三条产品路径，也不要引入新的 universal state framework。

## 5. Core DI V2

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

## 6. Ops V2

状态：提案笔记。

方向：

- lightweight op descriptor。
- doc/schema 必填。
- runtime/CLI/MCP/workbench adapters 放在 core op descriptor 外。
- runtime read models 和 registry internals 分离。

如果未来存在 `packages/ops/docs/core-v2.md` 或 adapter V2 笔记，应继续视为提案，不自动升级为当前全局架构。

## 7. Promotion Rule

提案实现后：

1. 把已实现行为迁入对应当前领域文档。
2. 删除或缩短本文件里的提案段落。
3. 如果 public API 变化，更新相关包 README。
4. 包内文档只保留实现相关说明，不重复仓库级设计。
