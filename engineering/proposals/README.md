# Proposals

这里仅保存尚未采纳或尚未实现的研究。Proposal 不是当前 API 权威，也不能覆盖
[`../PLUGIN_SYSTEM.md`](../PLUGIN_SYSTEM.md)、相关领域工程文档或 `docs/` 的用户契约。

规则：

- 明确标注问题、假设、未决问题和验收条件；
- 不把 proposal 示例复制进用户文档；
- 实现后的当前事实进入对应 `engineering/` 与 `docs/` 文档；
- 已实现 proposal 应删除，或缩为仍未实现边界、必要决策摘要与可核对的实施证据；
- 已被替代或没有继续价值的内容直接删除，历史由 Git 保存。

研究与必要决策记录：

- [Host 配置重构：决策与验收](HOST_CONFIGURATION_LAYERS.md)：已实施，根仓库及三个 local-projects 的完整门禁通过；保留身份/mode、原始输入事务和执行绑定决策，以及六条验收路径、线上检查和数据迁移证据。当前 API 见正式 Host/Config 文档。

- [Typst 内容创作与私有排版边界](TYPST_AUTHORING_BOUNDARIES.md)：待实施的整体重构提案；分离源码创作与 JSON 正文权威，明确私有模板/数据/资产边界、agent 协作提交和无兼容迁移。

- [插件分发与市场基础](plugin-distribution/README.md)：以 Drizzle ORM + SQLite 和 Cloudflare Workers/D1 为目标，设计在线运营配置、增量目录与按需 API，再细化发布标准、消费端市场插件和两类安装；独立于 legacy 分发实现，尚未实施。

- [`TINYBASE_PLUGIN_STATE.md`](TINYBASE_PLUGIN_STATE.md)：已实施状态重构的必要决策与剩余验收边界；当前契约见 [TinyBase](../TINYBASE.md) 与 [Database](../DATABASE.md)，逐包结论及实际验证见[迁移记录](../TINYBASE_MIGRATION.md)。

- Worksplit 的旧 API 精进提案已由新版会话契约替代；当前所有权见 [Frontend](../FRONTEND.md)，采用版本与实际宿主结果见 [Worksplit 迁移记录](../WORKSPLIT_MIGRATION.md)。

- [`ZENFS_FS_REFACTOR.md`](ZENFS_FS_REFACTOR.md)：ZenFS FS 重构的实施决策与验收记录；当前用法和资源契约见正式 FS 文档。

- [`TYPST_EDITOR_REFACTOR.md`](TYPST_EDITOR_REFACTOR.md)：旧 JSON 正文方案的 Typst 编辑器重构、独立验收及后续修正历史；当前 API 见正式用法与 Typst DESIGN。

- [`TYPST_EDITOR.md`](TYPST_EDITOR.md)：Typst 预览/定位下沉、区域 JSON 编辑器与 Studio 迁移的历史记录；当前 API 见正式用法与 Typst DESIGN。

- [`../WORKBENCH_FLEXLAYOUT_VALIDATION.md`](../WORKBENCH_FLEXLAYOUT_VALIDATION.md)：当前工作区的定向回归与浏览器验收入口；迁移记录保留在 Git 历史，设计理由见 [交互设计决策](../WORKBENCH_DESIGN.md)。

- [`VITE_DYNAMIC_RUNTIME.md`](VITE_DYNAMIC_RUNTIME.md)：已完成 native/modules/Vite 重构的必要决策、实际证据修正与验证入口；当前用法进入正式文档。

- [`STRICT_CONTRACT_REVIEW.md`](STRICT_CONTRACT_REVIEW.md)：严格契约迁移的实施证据、审查修正与剩余验收边界。

- [`PUBLIC_API_DESIGN_REVIEW.md`](PUBLIC_API_DESIGN_REVIEW.md)：13 项已实施修复的必要决策和验证索引。

- [`DEV_CONSOLE.md`](DEV_CONSOLE.md)：在线开发控制台尚未实现的编辑器、scratch bindings、SQL admin 与 Windows 通道方向；已实现契约已移入正式工程文档。
- [`FUTURE_ARCHITECTURE_DIRECTIONS.md`](FUTURE_ARCHITECTURE_DIRECTIONS.md)：未来架构方向的取舍，包含待验证的
  decoratorless Plugin declaration。
- [`REMOVE_PLUGIN_FORKS.md`](REMOVE_PLUGIN_FORKS.md)：评估删除通用 Plugin fork；Redis/S3 的 producer-owned bounded catalog
  验证迁移已完成，Core/Host 身份与控制面的完整删除仍待决策。
- [`NATIVE_ELYSIA_APPLICATION.md`](NATIVE_ELYSIA_APPLICATION.md)：核心 HTTP application contract 已进入当前架构；本文只应
  跟踪 beta.7 lifecycle、WebSocket 能力与 peer-range admission 等尚未完成的 gate。
- [`PLUGIN_THIRD_PARTY_VERSION_BOUNDARIES.md`](PLUGIN_THIRD_PARTY_VERSION_BOUNDARIES.md)：区分宿主 Elysia/Workbench Cap’n Web
  互操作版本、插件私有实现，以及可选的公共 Result 导入入口。
- [`IDENTITY_PLATFORM.md`](IDENTITY_PLATFORM.md)：尚未实现的自托管身份产品架构，研究 protocol-neutral Authority、认证方式、
  OIDC/OAuth、实验性 GNAP 与独立管理面的所有权和信任边界。

已实施架构与用户行为分别从 [`../README.md`](../README.md) 与 [`../../docs/index.md`](../../docs/index.md) 进入。
