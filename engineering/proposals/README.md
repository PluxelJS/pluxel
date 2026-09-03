# Proposals

这里仅保存尚未采纳或尚未实现的研究。Proposal 不是当前 API 权威，也不能覆盖
[`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、相关领域工程文档或 `docs/` 的用户契约。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把 proposal 示例复制进用户文档；
- 实现后的当前事实进入对应 `engineering/` 与 `docs/` 文档；
- 已实现 proposal 应删除，或缩为仍未实现边界、必要决策摘要与可核对的实施证据；
- 已被替代或没有继续价值的内容直接删除，历史由 Git 保存。

仍有未实现边界的文件：

- [`testing/`](testing/)：面向 Plugin 作者与 coding agent 的 composable test API 重新设计；当前研究 Plugin host lifecycle/config、
  Workbench RPC、纯 `RpcTarget` contract、Elysia-mounted endpoint 与真实 dynamic dev server smoke 的分层入口。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍，包含待验证的
  decoratorless Plugin declaration。
- [`REMOVE_PLUGIN_FORKS.md`](REMOVE_PLUGIN_FORKS.md)：评估删除通用 Plugin fork；Redis/S3 的 producer-owned bounded catalog
  验证迁移已完成，Core/Runtime 身份与控制面的完整删除仍待决策。
- [`NATIVE_ELYSIA_APPLICATION.md`](NATIVE_ELYSIA_APPLICATION.md)：核心 HTTP application contract 已进入当前架构；本文只应
  跟踪 beta.7 fail-fast、第二 carrier、portable WS 与 peer-range admission 等尚未完成的 gate。

已实施架构与用户行为分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md) 进入。
