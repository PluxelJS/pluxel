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

详细设计见 `runtime-routes.md`。这里仅保留摘要，避免把未来路线误写成当前 runtime 实现。

问题背景：

- 企业应用常常有固定且明确的插件总量。
- 插件可以从一个 static entry 静态导入并统一 export。
- 动态 install/scan/package loading 未必是核心价值。
- 更重要的是配置声明、配置落盘、网页配置、启动时严格检查、插件未启动时报错，以及可控 replacement 边界。

目标模型：

```text
@pluxel/runtime common host layer
  -> loader route        scan/package/dynamic module
  -> runtime-static route known catalog/strict startup
```

runtime-static route 应该是 runtime 的一条路线，而不是 core-only host，也不是替代 runtime。它和当前 loader route 的关系必须保持清楚：

- loader route 是当前实现，覆盖 scan/package/dynamic module/HMR replaceModule。
- runtime-static route 是未来提案，覆盖 known catalog/strict startup/bounded replacement。
- runtime common host layer 承载两条路线共享的 config persistence、web config APIs、plugin status projection、ops/control-plane、plugin UI protocols。
- core 仍只负责 plugin graph、DI、lifecycle 和 config validation。
- loader HMR mode 属于 `@pluxel/runtime-dynamic`，不反向进入 runtime common layer。

文档隔离规则：当前 loader route 和 loader HMR mode 写在 `../RUNTIME.md` 和 `../HMR.md`；runtime-static route 细节写在 `runtime-routes.md`，本文件只保留摘要索引。startup/hmr 实现落地前，不要把 runtime-static 行为写成当前能力。

核心方向：

- runtime-static route 复用 runtime common 的配置、ops、web config、plugin UI protocols。
- runtime-static route 不复用 loader 的 scan/package/cache/dynamic module map。
- runtime-static route 默认不继承 loader HMR mode；如果未来需要 fixed catalog HMR replacement，应作为 runtime-static route 自己的 HMR 子路径另行证明和设计。
- 插件集合 drift 默认报错。

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
