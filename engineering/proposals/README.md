# Proposals

这里仅保存尚未实现的研究。proposal 不是当前 API，也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 的事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现后把稳定结论写入对应领域文档，并删除已完成提案内容；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

当前进行中的提案：

- [`WORKBENCH_PLUGIN_COMPOSITION.md`](WORKBENCH_PLUGIN_COMPOSITION.md)：用 chatbot 的共享 Bot 管理页面与 Wretch Port 验证
  plugin-owned Workbench 组合；优先使用 application builder，不预先增加 Feature runtime 或多页面 Port。
- [`PORTABLE_WORKBENCH_PROTOCOL.md`](PORTABLE_WORKBENCH_PROTOCOL.md)：Level 1 management 落地后，仅研究可替代 Remote View host
  所需的 browser runtime、React renderer/delivery ABI、最小 singleton 和 CSS asset ownership。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含待验证的
  decoratorless Plugin declaration。

已实施的架构与用户行为不在本目录建立索引；分别从 [`../README.md`](../README.md) 与
[`../../docs/index.md`](../../docs/index.md) 进入当前文档。
