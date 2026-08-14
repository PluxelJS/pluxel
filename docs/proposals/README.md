# Proposals

这里仅保存尚未实现的研究。proposal 不是当前 API，也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 的事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现后把稳定结论写入对应领域文档，并删除已完成提案内容；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

当前进行中的提案：

- [`OFFICIAL_TELEMETRY_PLUGIN.md`](OFFICIAL_TELEMETRY_PLUGIN.md)：服务器 metrics/traces/events 的信号与所有权边界，
  以及不建立通用 Telemetry umbrella API 的约束。
- [`WORKBENCH_INSIGHTFLARE_ANALYTICS.md`](WORKBENCH_INSIGHTFLARE_ANALYTICS.md)：Workbench 使用 InsightFlare 分析页面性能、
  插件运行覆盖、失败状态与发行观测时的 host policy、脱敏和关闭边界。

Command 默认 CLI projection 与 owner-bound invocation 的已实施约束见 [`../COMMANDS.md`](../COMMANDS.md) 与
[`../RUNTIME.md`](../RUNTIME.md)。

数据库与 Workbench 的已实施结论见 [`../DATABASE.md`](../DATABASE.md) 与
[`../WORKBENCH.md`](../WORKBENCH.md)。

Static distribution 的已实施结论见 [`../DISTRIBUTION.md`](../DISTRIBUTION.md)。
