# Proposals

这里保存尚未采纳的研究，以及已部分实施、仍需跟踪后续设计的迁移决策。proposal 不是当前 API 权威，
也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、相关领域工程文档与 `docs/` 的已发布事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现过程中把已稳定结论同步写入对应领域文档，proposal 只保留决策理由、未完成设计和验收边界；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

已接受并随实现保留的决策记录：

- [`NATIVE_ELYSIA_APPLICATION.md`](NATIVE_ELYSIA_APPLICATION.md)：`ctx.elysia` 已是当前单一 Plugin Web application
  authoring contract，generation finalization/immutable publication 和 srvx Node HTTP/WS carrier 已落地。提案继续记录
  beta.7 `setup()`/`cleanup()` fail-fast、exact-only collision、第二 carrier/portable WS 与 peer-range admission 等剩余 gate；
  当前用法仍以领域工程文档和 `docs/runtime/http.md` 为准。
  尚在研究、未采纳的提案：

- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含待验证的
  decoratorless Plugin declaration。
- [`REMOVE_PLUGIN_FORKS.md`](REMOVE_PLUGIN_FORKS.md)：评估删除通用 Plugin fork；Redis/S3 的 producer-owned bounded catalog
  验证迁移已完成，Core/Runtime 身份与控制面的完整删除仍待决策。

已实施的架构与用户行为仍分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md)
进入当前文档；上面的 accepted proposal 索引只用于跟踪尚未落地的扩展设计与实施边界。
