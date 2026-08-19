# Proposals

这里仅保存尚未实现的研究。proposal 不是当前 API，也不能覆盖 [`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md) 的事实。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把提案示例复制进用户文档；
- 实现后把稳定结论写入对应领域文档，并删除已完成提案内容；
- 已被替代或没有继续价值的提案直接删除，历史由 Git 保存。

当前进行中的提案：

- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍记录，包含已否决的
  decoratorless Plugin 与 catalog exact-only 简化，以及仍可升级为 proposal 的 browser config artifact、
  multi-instance internals、Context kernel、Workbench transport 与 binding 稳定性研究。

CLI 分发、local-first delegation 与官方能力按需加载的已实施约束见 [`../TOOLCHAIN.md`](../TOOLCHAIN.md) 和
[`../../docs/development/tooling.md`](../../docs/development/tooling.md)。

OpenTelemetry 的当前设计、非目标与上游阻塞见 [`../../plugins/otel/DESIGN.md`](../../plugins/otel/DESIGN.md) 和
[`../../docs/runtime/otel.md`](../../docs/runtime/otel.md)。

Command 默认 CLI projection 与 owner-bound invocation 的已实施约束见 [`../COMMANDS.md`](../COMMANDS.md) 与
[`../RUNTIME.md`](../RUNTIME.md)。

数据库与 Workbench 的已实施结论见 [`../DATABASE.md`](../DATABASE.md) 与
[`../WORKBENCH.md`](../WORKBENCH.md)。

时空可组合性研究中已经落地的维护者思考见
[`../SPATIOTEMPORAL_COMPOSABILITY_NOTES.md`](../SPATIOTEMPORAL_COMPOSABILITY_NOTES.md)。

Static distribution 的已实施结论见 [`../DISTRIBUTION.md`](../DISTRIBUTION.md)。
