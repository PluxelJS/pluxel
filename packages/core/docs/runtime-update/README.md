# Runtime Update Refactor Docs

本目录收拢 runtime update / HMR core 重构相关文档。

阅读顺序：

1. `DESIGN.md`
   - 稳定设计、边界、性能预算、迁移阶段、明确拒绝的方向。
2. `RATIONALE.md`
   - 为什么这些改动值得做，dynamic/static 分别如何受益，性能损益和停止规则。
3. `STATUS.md`
   - 当前已完成、未完成、下一步接手顺序和验证命令。

如果你当前是在 review / 整理 Phase 2 阶段提交，建议直接看：

1. `STATUS.md`
   - `Phase 2 收益总结`
   - `Phase 2 提交建议`
   - `推荐下一步`
2. `RATIONALE.md`
   - `截至当前停点的实际收益`
   - `Phase 3：PluginKey graph`

边界：

- runtime core 只接收 runtime declaration update 的事实，不接 Vite module graph。
- ops/MCP runtime 接入已经剥离；未来若重新接 MCP，应作为 adapter 复用 runtime usecases。
- `RuntimeKernel + SourceDriver + ArtifactProvider` 不属于当前接受的设计。
