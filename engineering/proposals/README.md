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

- [`workbench-vnext/`](workbench-vnext/README.md)：Workbench 重构 implementation blueprint。固定不可拆分的
  MF2 + WS-only Cap’n Web Profile 1、direct View/Attachment API、Plugin generation atomic publication、
  FontManager/BotManager 调用面、实施切片与 cutover gates；仍未成为当前 API。
- [`WORKBENCH_PLUGIN_COMPOSITION.md`](WORKBENCH_PLUGIN_COMPOSITION.md)：用 chatbot 的共享 Bot 管理页面与 Wretch Port 验证
  plugin-owned Workbench 组合；作为 vNext 的 composition 输入研究，仍不代表当前 API。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含待验证的
  decoratorless Plugin declaration。

已实施的架构与用户行为仍分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md)
进入当前文档；上面的 accepted proposal 索引只用于跟踪未完成的迁移 gate。
