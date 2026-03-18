# Pluxel Docs

这里是 **Pluxel 仓库的“规范/设计目标/维护约束”的唯一权威来源**（给人和 agent/LLM 都看）。

阅读顺序（推荐）：

1) `docs/ARCHITECTURE.md`：整体架构与依赖方向（core/runtime/hmr/cli）
2) `docs/PACKAGING.md`：发布/内联/依赖约束（只发布 5 个包）
3) `docs/AGENT_RULES.md`：后续维护规则（避免引入新的遗留/噪音）

包内文档（次级入口）：

- `packages/core/README.md`、`packages/core/IMPLEMENTATION_INDEX.md`
- `packages/runtime/README.md`、`packages/runtime/IMPLEMENTATION_INDEX.md`
- `packages/hmr/README.md`、`packages/hmr/IMPLEMENTATION_INDEX.md`
- `packages/cli/README.md`、`packages/cli/IMPLEMENTATION_INDEX.md`
- `packages/test/README.md`

非权威/历史文档说明：

- `packages/*/src/**.md`、`packages/*/docs/**` 这类文件可能是历史笔记或第三方包自带文档；
  如果它们与 `docs/*` 或上述 4 个发布包的 README 冲突，以 **`docs/*` 为准**。

典型例子：

- `packages/diod/**`：第三方依赖（仓库内 vendored），其文档不代表 Pluxel 的架构/约束。

补充：

- 一些 internal/private 包（例如 `@pluxel/context`）会配置 `exports` 供仓库内 import，但仍不属于发布集合；发布/依赖约束以 `docs/PACKAGING.md` 为准。
