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

- [`workbench-vnext/`](workbench-vnext/README.md)：基于当前 Wretch/Fonts/PackageManager 调用面与 BotManager proposal fixture，从零研究
  不可拆分的 MF 2.0 + WS-required Cap’n Web closed Profile 1，以及 direct Cap’n Web ViewApi、View/Attachment authoring、Plugin generation
  atomic publication 与 direct opened View；Workbench 只增加 View/Attachment 两个 UI 声明，Collection/Feature/Model/Query/Channel
  不成为 platform protocol，Shell framework 保持
  platform-neutral，但必须复用同一 concrete host packages，Workbench/Management SSE 完全不存在，不发布 replaceable
  transport/artifact/auth SPI。
- [`WORKBENCH_PLUGIN_COMPOSITION.md`](WORKBENCH_PLUGIN_COMPOSITION.md)：用 chatbot 的共享 Bot 管理页面与 Wretch Port 验证
  plugin-owned Workbench 组合；作为 vNext 的 composition 输入研究，仍不代表当前 API。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含待验证的
  decoratorless Plugin declaration。

已实施的架构与用户行为仍分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md)
进入当前文档；上面的 accepted proposal 索引只用于跟踪未完成的迁移 gate。
