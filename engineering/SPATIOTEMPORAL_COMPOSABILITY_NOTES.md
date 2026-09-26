# 时空可组合性：设计背景

本页记录与 [Cordis 论文](https://github.com/cordiverse/paper)的对照，不定义 API 或 roadmap。已落地的 lifecycle 词汇/矩阵由 [CORE_LIFECYCLE_SEMANTICS](CORE_LIFECYCLE_SEMANTICS.md)拥有，capability 撤回由 [PROVIDER_WITHDRAWAL_AUDIT](PROVIDER_WITHDRAWAL_AUDIT.md)拥有，不在此复制。

## 保留的判断

Pluxel 的三个所有权边界各自回答不同问题：business dependency 进入 Plugin graph，generation resource 进入 effects，runtime capability 定义自己的 publication/admission/in-flight/root resource 语义。

Graph ordering 只保证 provider/consumer 顺序，不能证明任意 effect 可交换。Cleanup 是进程内 ownership 与 at-most-once 机制，不是外部 emission 的数学逆。Root durable resource 与 generation handle 不能为统一 API 而合并。

| 副作用                               | 恢复/所有权边界                               |
| ------------------------------------ | --------------------------------------------- |
| route/listener/timer/registration    | generation effects、cleanup at-most-once      |
| worker/watcher/queue consumer        | 停止接纳、abort、等待真实退出                 |
| 数据库 rows/outbox                   | 同一 transaction commit/rollback              |
| S3 PUT、邮件、第三方 API、已投递消息 | 领域幂等、withholding、outbox 或 compensation |

没有足够证据抽取统一 `GenerationLease`：Database drain 不强制 abort transaction，Workers 要等物理退出，Workbench 还拥有 socket epoch/roots/Bridge。只有真实重复状态机且抽取能删除代码、统一错误与增加覆盖时，才考虑 internal primitive，不增加 ambient current-owner。

## 证据与后续判断

`packages/core/tests/PluginService.lifecycle-model.test.ts` 使用抽象 ownership/graph oracle 覆盖 batching、queued commit、late init、reentrant cleanup、optional availability 与 required failure locality。扩展 action alphabet 应复用 trace runner，不复制 production scheduler；各真实 carrier 仍需要领域证据。

Canonical entry/export/provenance 能防 identity collision，不能证明跨版本行为兼容。诊断先复用 package version/range、lineage、manifest/facts 与 wire revision；不引入 structural duck typing、多版本自动选择或静默 fallback。只有真实跨版本需求才能支持额外 fingerprint 契约。

进一步工作由实际无法解释的 transition、撤回交错或下游兼容失败驱动。新增 API、配置、错误或包边界需单独设计；仅改进可反驳的不变量、测试和诊断也可完成任务，不必产生统一抽象。
