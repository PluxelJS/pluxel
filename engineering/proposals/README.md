# Proposals

这里保存尚未采纳的研究，以及已接受但仍需跟踪实施 gate 的迁移决策。proposal 不是当前 API 权威，
也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、相关领域工程文档与 `docs/` 的已发布事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现过程中把已稳定结论同步写入对应领域文档，proposal 只保留决策理由、未完成 gate 和验收边界；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

已接受、实施中的提案：

- [`NATIVE_ELYSIA_APPLICATION.md`](NATIVE_ELYSIA_APPLICATION.md)：`ctx.elysia` 已是当前单一 Plugin Web application
  authoring contract，generation finalization/immutable publication 和 srvx Node HTTP/WS carrier 已落地。提案继续记录
  beta.7 `setup()`/`cleanup()` fail-fast、exact-only collision、第二 carrier/portable WS 与 peer-range admission 等剩余 gate；
  当前用法仍以领域工程文档和 `docs/runtime/http.md` 为准。

尚在研究、未采纳的提案：

- [`PORTABLE_COMMAND_REGISTRIES.md`](PORTABLE_COMMAND_REGISTRIES.md)：研究 owner-bound secondary command registry、
  cross-owner publication 与 carrier output 二阶段呈现，使 KOOK/Discord 等 provider 不必维护 per-caller registry，
  同时保持 root catalog exposure 为显式独立决策。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含待验证的
  decoratorless Plugin declaration。
- [`WORKBENCH_STANDARD_PAGES.md`](WORKBENCH_STANDARD_PAGES.md)：研究host-rendered Markdown document + typed snapshot/action slots 的
  Standard Page；Workbench是第一版adapter，resource/runtime protocol保持宿主中性，在Config resource与完整React View之间提供受限、
  零Plugin producer的管理界面。

已实施的架构与用户行为仍分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md)
进入当前文档；上面的 accepted proposal 索引只用于跟踪未完成的迁移 gate。
