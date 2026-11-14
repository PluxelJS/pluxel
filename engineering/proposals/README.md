# 待讨论与待实施的设计

这里保存尚未采纳或尚未完成的设计。当前架构从 [工程索引](../README.md)进入，公开用法由 [docs](../../docs/index.md)维护。

## 剩余方向

以下状态于 2026-11-12 对照本仓 exports、实现、测试和正式文档核对；Agent 方向于 2026-11-13 完成首轮实现。插件控制 SDK 于 2026-11-14 进入正式生成、运行和同步链路，当前规则见 [Plugin Control](../PLUGIN_CONTROL.md)。表中的下一步按各提案的完成条件推进。

| 方向                                                    | 当前进展与缺口                                                                                                    | 下一步要回答的问题                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Schema Form 与内部表单 UI](schema-form/README.md)      | 2026-11-13 新增提案：独立字段契约、Valibot/JSON Schema 适配、Pluxel 内部 UI 迁移；尚未实施                        | typed metadata、配置校验桥、真实 UI 与独立包消费能否共同满足清晰可用的 API？     |
| [Agent 脚本执行后续方向](AGENT_WORKFLOW.md)             | SDK、Node/Vite 执行与共享控制已有实现；真实 workerd 最小桥已验证；正式 CF 后端与部署待交付                        | CF 首个部署的 run owner、取消传播、能力桥释放和查询寿命由谁持有？                |
| [插件控制的后续方向](plugin-control-sdk/README.md)      | 生成、实例调用与材料同步已有正式实现；跨 isolate、离线 validator 和自动快照清理分别待推进                         | 新后端的资源寿命和活动材料保留由谁持有？                                         |
| [严格契约的剩余缺口](STRICT_CONTRACT_REVIEW.md)         | 既有迁移已落地；显式修复工具、应用级 capnweb 所有权检查及部分解析失败分类仍有缺口                                 | doctor 的首批确定性修复是什么，应用版本与解析诊断各自有哪些可靠依据？            |
| [插件分发与市场](plugin-distribution/README.md)         | Worker/D1、市场网页、管理 API 和安装确认已有实现；自动 provenance 收录、新 manifest、消费者认证与恢复流程尚未完成 | 先解决 Worker 的 provenance 验证，还是先交付需要认证的市场消费闭环？             |
| [Typst 内容与私有排版](TYPST_AUTHORING_BOUNDARIES.md)   | 源码编辑、JSON 投影和 native 编译已有实现；独立 JSON 正文、私有排版输出与按单元提交待实施                         | 两章 JSON 能否经私有模板生成 PNG，保留跨章引用与导航，并满足资产保密和输出质量？ |
| [是否删除 Plugin fork](REMOVE_PLUGIN_FORKS.md)          | Redis/S3 已改为领域目录；Core/Host 删除 fork 尚未采纳                                                             | 是否仍有真实调用方必须使用独立 graph node，删除后的身份和数据怎样一次迁移？      |
| [Elysia 外部承载边界](NATIVE_ELYSIA_APPLICATION.md)     | Node/Vite HTTP、stream 和 WebSocket 已有实现；等价 matcher 冲突、包 peer 准入和外部 lifecycle 仍有缺口            | 哪些准入工作可由本仓完成，哪些必须等上游提供公开接口？                           |
| [Decoratorless 声明](FUTURE_ARCHITECTURE_DIRECTIONS.md) | 研究方向，未采纳                                                                                                  | 相比薄 `@Plugin`，是否真能减少整体复杂度，并保留发现、身份与诊断质量？           |
| [Identity Platform](IDENTITY_PLATFORM.md)               | 独立产品假设，未立项；现有 Auth 插件不等于该产品                                                                  | 首个真实 OIDC 调用方、Authority 的职责和持久事务边界是什么？                     |

Agent 与插件控制 SDK 提案沿用当前 node/fork 身份。若决定删除 fork，需要同步调整相关提案的寻址与验收；讨论控制接口本身不要求先改身份模型。Typst 的 Electron Studio 已移至 [Pluxel Lab](https://github.com/PluxelJS/lab)，其应用改造与验收由 Lab 维护。

## 已落地内容的入口

- Host 配置与执行策略：[Host 配置用法](../../docs/host/configuration.md)、[Config](../CONFIG.md)、[Host](../HOST.md)。
- 状态与文件系统：[TinyBase](../TINYBASE.md)、[迁移清单](../TINYBASE_MIGRATION.md)、[FS](../FS.md)。
- Agent 脚本 SDK 与执行：[使用指南](../../docs/development/scripts.md)、[架构与验证](../AGENT_WORKFLOW.md)。
- 插件控制类型与实例：[使用指南](../../docs/development/plugin-control.md)、[生成与运行边界](../PLUGIN_CONTROL.md)。
- Native/Vite 与开发控制台：[应用交付](../APPLICATION_BUILD.md)、[HMR](../HMR.md)、[Dev Console](../DEV_CONSOLE.md)。
- API 与第三方库互操作：[契约与资源](../../docs/plugin-development/contracts.md)、[Better Result](../../docs/plugin-development/better-result.md)、[Workbench](../WORKBENCH.md)、[依赖治理](../GOVERNANCE.md)。
- Typst 当前编辑器：[源码编辑](../../docs/plugins/rendering/typst-editor.md)、[Typst DESIGN](../../plugins/render/typst/DESIGN.md)。
- 市场与安装：[市场服务](../../projects/plugin-market/README.md)、[Package Manager](../../docs/plugins/package-manager.md)。

环境与发行验收的剩余边界保留在 [Host 部署验证](../HOST_DEPLOYMENT_VALIDATION.md)、[Workbench 验收](../WORKBENCH_FLEXLAYOUT_VALIDATION.md)及各领域验证记录中。

## 维护规则

- 提案写清问题、已有依据、未决判断与完成条件，拟议 API 始终标明尚未实施。
- 已实现规则进入所属 `engineering/` 或 `docs/` 页面；提案只保留影响下一步决策的依据与剩余工作。
- 已完成或已被替代的提案删除，实施过程由 Git 保存；必要的验收范围归相应验证记录。
- 实验结果只证明实验边界；实现存在、部署运行和环境验收分别按实际证据标注。
