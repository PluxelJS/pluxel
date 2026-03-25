# Pluxel Docs

这里是 **Pluxel 仓库的“规范/设计目标/维护约束”的唯一权威来源**（给人和 agent/LLM 都看）。

先记一个分层规则，后面读文档会快很多：

- `docs/*.md`
  回答“为什么这样设计、边界在哪里、哪些规则不能破”
- `packages/*/README.md`
  回答“这个包对外提供什么、应该怎么用”
- `packages/*/IMPLEMENTATION_INDEX.md`
  回答“具体代码入口在哪、从哪里开始追实现”

如果同一个主题在多个层级同时出现，优先级按上面顺序理解。

阅读顺序（推荐）：

1) `docs/ARCHITECTURE.md`：整体架构与依赖方向（core/runtime/hmr/cli）
2) `docs/FRONTEND_ARCHITECTURE.md`：插件前端链路（`ctx.ext` / HMR / MF2 / runtime）
3) `docs/PACKAGING.md`：发布/内联/依赖约束（只发布 5 个包）
4) `docs/AGENT_RULES.md`：后续维护规则（避免引入新的遗留/噪音）

包内文档（次级入口）：

- `packages/core/README.md`、`packages/core/IMPLEMENTATION_INDEX.md`
- `packages/runtime/README.md`、`packages/runtime/IMPLEMENTATION_INDEX.md`
- `packages/hmr/README.md`、`packages/hmr/IMPLEMENTATION_INDEX.md`
- `packages/cli/README.md`、`packages/cli/IMPLEMENTATION_INDEX.md`
- `packages/test/README.md`

仓库级补充文档：

- `docs/SERVICES.md`
  runtime / hmr service 边界补充说明

非权威/历史文档说明：

- `packages/*/src/**.md`、`packages/*/docs/**` 这类文件可能是历史笔记或第三方包自带文档；
  如果它们与 `docs/*` 或上述 5 个发布包的 README 冲突，以 **`docs/*` 为准**。

典型例子：

- `packages/diod/**`：第三方依赖（仓库内 vendored），其文档不代表 Pluxel 的架构/约束。

补充：

- 一些 internal/private 包（例如 `@pluxel/context`）会配置 `exports` 供仓库内 import，但仍不属于发布集合；发布/依赖约束以 `docs/PACKAGING.md` 为准。
- `packages/plugins/host/**`、`packages/plugins/host/src/demo/**`
  是样例与 smoke host，不是权威架构文档；它们用于展示“当前推荐写法”，不替代 `docs/*`。
