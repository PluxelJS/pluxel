# Proposals

这里仅记录未实现或未来设计。不要把本文件内容当成当前 API；当前实现以 `../CORE.md`、`../RUNTIME.md`、`../HMR.md` 等领域文档为准。

## 1. Static Suite Runtime Route

状态：提案。当前没有 `@pluxel/static-suite` 包，没有 runtime static-suite subpath，也没有 static route HMR adapter。

详细设计见 `runtime-routes.md`。这里仅保留摘要，避免把未来路线误写成当前 runtime 实现。

问题背景：

- 企业应用常常有固定且明确的插件总量。
- 插件可以从一个 suite entry 静态导入并统一 export。
- 动态 install/scan/package loading 未必是核心价值。
- 更重要的是配置声明、配置落盘、网页配置、启动时严格检查、插件未启动时报错，以及可控 HMR 边界。

目标模型：

```text
@pluxel/runtime common host layer
  -> loader route        scan/package/dynamic module
  -> static suite route  known catalog/strict startup
```

static suite 应该是 runtime 的一条路线，而不是 core-only host，也不是替代 runtime。它和当前 loader route 的关系必须保持清楚：

- loader route 是当前实现，覆盖 scan/package/dynamic module/HMR replaceModule。
- static suite route 是未来提案，覆盖 known catalog/strict startup/bounded HMR。
- runtime common host layer 承载两条路线共享的 config persistence、web config APIs、plugin status projection、ops/control-plane、plugin UI protocols。
- core 仍只负责 plugin graph、DI、lifecycle 和 config validation。
- HMR 仍 attach 到 runtime，不反向进入 runtime common layer。

文档隔离规则：当前 loader route 写在 `../RUNTIME.md` 和 `../HMR.md`；static suite 细节写在 `runtime-routes.md`，本文件只保留摘要索引。实现前不要把 `definePluginSuite`、static startup report 或 static HMR adapter 写进当前实现文档。

核心方向：

- static suite 复用 runtime common 的配置、ops、web config、plugin UI protocols。
- static suite 不复用 loader 的 scan/package/cache/dynamic module map。
- HMR 复用 Vite runner/watch/moduleGraph，但通过 static suite adapter 提交 known plugin ctors。
- 插件集合 drift 默认报错。

## 2. Workbench View Model

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

## 3. Plugin UI Cleanup

状态：未来清理。

方向：

- 继续收窄 plugin UI authoring surface。
- 保持 builtin/custom frontend docs 和 demos 对齐。
- 减少 extension loader/runtime state duplication。
- SignalDB authoring 收敛到少数稳定 access patterns。
- 在 MF2/Vite 上游行为足够稳定前，继续隔离构建状态。
- 增加 extension loader、interaction session lifecycle、plugin-build isolation 的 focused tests。

非目标：不要发明第三条产品路径，也不要引入新的 universal state framework。

## 4. Core DI V2

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

## 5. Ops V2

状态：提案笔记。

方向：

- lightweight op descriptor。
- doc/schema 必填。
- runtime/CLI/MCP/workbench adapters 放在 core op descriptor 外。
- runtime read models 和 registry internals 分离。

如果未来存在 `packages/ops/docs/core-v2.md` 或 adapter V2 笔记，应继续视为提案，不自动升级为当前全局架构。

## 6. Promotion Rule

提案实现后：

1. 把已实现行为迁入对应当前领域文档。
2. 删除或缩短本文件里的提案段落。
3. 如果 public API 变化，更新相关包 README。
4. 包内文档只保留实现相关说明，不重复仓库级设计。
