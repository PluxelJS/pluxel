# Pluxel 文档入口

这组文档面向人和 LLM：先给设计边界，再给实现入口，避免每次都扫完整仓库。当前实现和未来设想必须分开；`proposals/README.md` 里的内容不能反推为已实现 API。

## 阅读顺序

1. 先读包边界：
   - `CORE.md`
   - `RUNTIME.md`
   - `RUNTIME_DYNAMIC_SPLIT.md`
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
- `RUNTIME.md`：宿主 runtime common、配置持久化、HTTP/web 协议、route-neutral 状态投影。
- `RUNTIME_DYNAMIC_SPLIT.md`：当前 runtime common 与 runtime-dynamic route 的拆分结果和迁移边界。
- `HMR.md`：开发期 Vite runner、watch、moduleGraph、模块替换。
- `FRONTEND.md`：插件 UI、authoring bridge、MF2 remote、SignalDB/RPC/SSE。
- `CONFIG.md`：配置声明、校验、默认值、持久化、网页配置。
- `WORKBENCH.md`：插件工作台、builtin/custom contribution、UI ownership。
- `TOOLCHAIN.md`：build、Vite 分层、lint、test 和发布工具链。
- `GOVERNANCE.md`：依赖方向、公开包、导出、维护规则。
- `proposals/README.md`：未实现或未来设计入口，例如 WorkbenchView、Plugin UI cleanup、Core DI V2。

## 当前与未来

- 当前实现：写在 `CORE.md`、`RUNTIME.md`、`RUNTIME_DYNAMIC_SPLIT.md`、`HMR.md`、`FRONTEND.md`、`CONFIG.md`、`WORKBENCH.md`、`TOOLCHAIN.md`、`GOVERNANCE.md`。
- 未来或未实现：写在 `proposals/README.md`，大型提案放在 `docs/proposals/*.md`，并由 `proposals/README.md` 索引。
- runtime 当前有 runtime-dynamic route 和 runtime-static route。dynamic/static 的当前行为分别写在 `RUNTIME.md`、`RUNTIME_DYNAMIC_SPLIT.md` 和 `HMR.md`。
- 如果提案实现，先把已实现行为迁入当前领域文档，再缩短 `proposals/README.md` 或对应提案文档。

## 维护规则

- 不再新增深层文档目录，除非某个领域已经大到单文件无法维护。
- 新文档优先放在 `docs/*.md` 顶层，按包或领域命名。
- 每个当前设计文档都应该同时回答两个问题：为什么这样分层、代码从哪里看起。
- 已实现行为写入对应领域文档；未实现计划只写入 `docs/proposals/`。
- 包内 README 只保留本包入口和本包特有说明，仓库级设计链接到这些顶层文档。
