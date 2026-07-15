# Proposals

这里仅保存尚未实现的研究。proposal 不是当前 API，也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 的事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现后把稳定结论写入对应领域文档，并删除已完成提案内容；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

当前 proposals：

- [`PLUGIN_PACKAGE_DEPENDENCY_METADATA.md`](PLUGIN_PACKAGE_DEPENDENCY_METADATA.md)：修正独立插件包 required dependency metadata 的采集、写入和 dynamic loader 消费。
- [`PACKAGE_OPTIONAL_PLUGIN_INTEGRATION.md`](PACKAGE_OPTIONAL_PLUGIN_INTEGRATION.md)：已收敛、等待实现的 system-owned lazy import package-optional integration 设计。
