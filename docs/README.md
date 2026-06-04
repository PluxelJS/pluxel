# Pluxel 文档入口

这组文档面向人和 LLM：先给设计边界，再给实现入口，避免每次都扫完整仓库。当前实现和未来设想必须分开；`proposals/README.md` 里的内容不能反推为已实现 API。

## 阅读顺序

1. 先读包边界：
   - `CORE.md`
   - `RUNTIME.md`
   - `HMR.md`
2. 再读横向能力：
   - `FRONTEND.md`
   - `CONFIG.md`
   - `WORKBENCH.md`
   - `OPS.md`
   - `TOOLCHAIN.md`
3. 最后读约束和未来：
   - `GOVERNANCE.md`
   - `proposals/README.md`

## 文件职责

- `CORE.md`：最小插件内核、DI、生命周期、feature/config 声明。
- `RUNTIME.md`：宿主 runtime、loader/package/scan、持久化、HTTP/web 协议。
- `HMR.md`：开发期 Vite runner、watch、moduleGraph、模块替换。
- `FRONTEND.md`：插件 UI、authoring bridge、MF2 remote、SignalDB/RPC/SSE。
- `CONFIG.md`：配置声明、校验、默认值、持久化、网页配置。
- `WORKBENCH.md`：插件工作台、builtin/custom contribution、UI ownership。
- `OPS.md`：operation control-plane、CLI/RPC/MCP/workbench 投影。
- `TOOLCHAIN.md`：build、Vite 分层、lint、test 和发布工具链。
- `GOVERNANCE.md`：依赖方向、公开包、导出、维护规则。
- `proposals/README.md`：未实现或未来设计入口，例如 static suite runtime route、WorkbenchView、Core DI V2。
- `proposals/runtime-routes.md`：未来 runtime 双路线设计，讨论 loader route、static suite route 和两种 HMR adapter。

## 当前与未来

- 当前实现：写在 `CORE.md`、`RUNTIME.md`、`HMR.md`、`FRONTEND.md`、`CONFIG.md`、`WORKBENCH.md`、`OPS.md`、`TOOLCHAIN.md`、`GOVERNANCE.md`。
- 未来或未实现：写在 `proposals/README.md`，大型提案放在 `docs/proposals/*.md`，并由 `proposals/README.md` 索引。
- runtime 当前只有 loader route；static suite / fixed catalog route 是未来路线，不能写成当前实现。
- 如果提案实现，先把已实现行为迁入当前领域文档，再缩短 `proposals/README.md` 或对应提案文档。

## 维护规则

- 不再新增深层文档目录，除非某个领域已经大到单文件无法维护。
- 新文档优先放在 `docs/*.md` 顶层，按包或领域命名。
- 每个当前设计文档都应该同时回答两个问题：为什么这样分层、代码从哪里看起。
- 已实现行为写入对应领域文档；未实现计划只写入 `docs/proposals/`。
- 包内 README 只保留本包入口和本包特有说明，仓库级设计链接到这些顶层文档。

## 旧文档迁移覆盖

旧目录没有按原样保留，但架构级信息按领域迁入了这些顶层文档：

- `docs/architecture/system.md` -> `CORE.md`、`RUNTIME.md`、`HMR.md`、`TOOLCHAIN.md`、`GOVERNANCE.md`
- `docs/architecture/services.md` -> `RUNTIME.md`、`HMR.md`、`FRONTEND.md`
- `docs/architecture/frontend.md` -> `FRONTEND.md`、`HMR.md`、`RUNTIME.md`
- `docs/architecture/lint-toolchain.md` -> `TOOLCHAIN.md`、`GOVERNANCE.md`
- `docs/design/plugin-config/overview.md` -> `CONFIG.md`
- `docs/design/plugin-feature/overview.md` -> `CORE.md`
- `docs/design/plugin-lifecycle-hmr.md` -> `CORE.md`、`RUNTIME.md`、`HMR.md`
- `docs/design/plugin-contribution/overview.md` -> `FRONTEND.md`、`WORKBENCH.md`
- `docs/design/plugin-contribution/future-work.md` -> `proposals/README.md`
- `docs/design/plugin-workbench/design.md` -> `WORKBENCH.md`
- `docs/design/plugin-workbench/implementation.md` -> `WORKBENCH.md`
- `docs/design/plugin-workbench/extension-model.md` -> `proposals/README.md`
- `docs/design/ops-catalog/overview.md` -> `OPS.md`
- `docs/design/vite-architecture.md` -> `TOOLCHAIN.md`、`HMR.md`、`FRONTEND.md`
- `docs/design/core-di/overview.md` -> `proposals/README.md`
- `docs/design/core-di/plugin-biased-v2.md` -> `proposals/README.md`
- `docs/governance/packaging.md` -> `GOVERNANCE.md`、`TOOLCHAIN.md`
- `docs/governance/agent-rules.md` -> `GOVERNANCE.md`

迁移时保留的是设计结论、边界、不变量和实现入口。旧文档里的长篇推导、历史争论、临时 checklist 和已经过期的中间方案不再作为当前文档的一部分；需要考古时从 git history 读取旧原文。
