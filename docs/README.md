# Pluxel Docs

这里是 **Pluxel 仓库的权威设计与治理文档入口**。

先看分层：

- `docs/architecture/**`
  回答“系统怎么分层、依赖方向与服务边界是什么”
- `docs/governance/**`
  回答“发布、维护、重构时有哪些硬约束”
- `docs/design/**`
  回答“某个具体子系统为什么收敛成当前设计”
- `packages/*/README.md`
  回答“这个包对外提供什么、应该怎么用”
- `packages/*/docs/**`
  回答“这个包内部某个子系统的实现 contract / host contract 是什么”
- `packages/*/IMPLEMENTATION_INDEX.md`
  回答“具体代码入口在哪、从哪里开始追实现”

如果同一个主题在多个层级同时出现，优先级按上面顺序理解。

阅读顺序（推荐）：

1. `docs/architecture/system.md`
   整体架构与依赖方向（core/runtime/hmr/cli）
2. `docs/architecture/frontend.md`
   插件前端链路（`ctx.ext` / HMR / MF2 / runtime）
3. `docs/governance/packaging.md`
   发布/内联/依赖约束（只发布 5 个包）
4. `docs/governance/agent-rules.md`
   后续维护规则（避免引入新的遗留/噪音）
5. `docs/architecture/lint-toolchain.md`
   lint / build-correctness / toolchain transform 的分层与约束

包内文档（次级入口）：

- `packages/core/README.md`、`packages/core/IMPLEMENTATION_INDEX.md`
- `packages/runtime/README.md`、`packages/runtime/IMPLEMENTATION_INDEX.md`
- `packages/hmr/README.md`、`packages/hmr/IMPLEMENTATION_INDEX.md`
- `packages/cli/README.md`、`packages/cli/IMPLEMENTATION_INDEX.md`
- `packages/test/README.md`

仓库级补充文档：

- `docs/architecture/services.md`
  runtime / hmr service 边界补充说明
- `docs/architecture/lint-toolchain.md`
  repo lint、build lint、toolchain 接入点与 autofix 边界
- `docs/design/plugin-config/overview.md`
  插件配置声明与宿主 doc 编排的收敛设计
  （实现侧 contract：`packages/runtime/docs/config/contract.md`）
- `docs/design/plugin-feature/overview.md`
  Plugin/Feature 分层、`use(required)` / `tryUse(optional)`、以及真正 optional feature 的模块加载边界
- `docs/design/plugin-contribution/overview.md`
  插件间 contribution / slot / provider-owned custom widget / resource reference 设计
  （包含当前 capability matrix、常见交互形式与稳定/非稳定边界）
- `docs/design/ops-catalog/overview.md`
  ops live registry 的 host-side catalog 设计
  （包含 runtime read model、生命周期边界与 workbench Ops 视图）

非权威/历史文档说明：

- `packages/*/src/**.md`、`packages/*/docs/**` 这类文件可能是历史笔记或第三方包自带文档；
  如果它们与 `docs/*` 或上述 5 个发布包的 README 冲突，以 **`docs/*` 为准**。

典型例子：

- `packages/diod/**`：第三方依赖（仓库内 vendored），其文档不代表 Pluxel 的架构/约束。

补充：

- 一些 internal/private 包（例如 `@pluxel/context`）会配置 `exports` 供仓库内 import，但仍不属于发布集合；发布/依赖约束以 `docs/governance/packaging.md` 为准。
- `packages/plugins/host/**`、`packages/plugins/host/src/demo/**`
  是样例与 smoke host，不是权威架构文档；它们用于展示“当前推荐写法”，不替代 `docs/*`。
