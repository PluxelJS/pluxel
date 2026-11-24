# 待讨论与待实施的设计

本目录保存尚未决定、尚未完成或待复核的设计。当前机制由[工程索引](../README.md)下的领域页维护，公开用法见 [docs](../../docs/index.md)。

## 剩余方向

| 方向                                                    | 已有基础与待解决问题                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [跨平台 Host 的后续能力](PLATFORM_NEUTRAL_RUNTIME.md)   | 跨 isolate 可写状态、平台服务及远程 Workbench 会话的所有权与验收                                                 |
| [Agent 执行与控制](AGENT_WORKFLOW.md)                   | Node/Vite、共享控制与材料同步已有实现；待交付正式 Cloudflare 后端、远程 Vite、离线 validator、持久任务与材料清理 |
| [Agent 工作流对照研究](AGENT_WORKFLOW_EVALUATION.md)    | 固定模型与相同任务下，验证文件查阅、错误恢复、任务结果及 token 消耗的变化；尚未开展                              |
| [表单适配器与远程校验](schema-form/README.md)           | 自有控件消费者、独立的源码投影入口和通用失焦校验的采用条件                                                       |
| [严格契约的剩余缺口](STRICT_CONTRACT_REVIEW.md)         | 显式修复工具、应用级 capnweb 所有权检查和部分解析失败分类                                                        |
| [插件分发与市场](plugin-distribution/README.md)         | Worker/D1、网页、管理与安装确认已有实现；待完成 provenance 自动收录、新 manifest、消费者认证与恢复闭环           |
| [是否删除 Plugin fork](REMOVE_PLUGIN_FORKS.md)          | Redis/S3 已改为领域目录；Core/Host 删除 fork 尚未采纳，需确认独立 graph node 调用方及数据迁移                    |
| [Elysia 外部承载](NATIVE_ELYSIA_APPLICATION.md)         | Node/Vite HTTP、stream、WebSocket 已有实现；matcher 冲突、peer 准入与外部 lifecycle 仍有缺口                     |
| [Decoratorless 声明](FUTURE_ARCHITECTURE_DIRECTIONS.md) | 尚未采纳；需比较薄 decorator 与新设计的发现、身份、诊断和整体复杂度                                              |
| [Identity Platform](IDENTITY_PLATFORM.md)               | 独立产品假设，未立项；需先确定真实 OIDC 调用方、Authority 职责与事务边界                                         |

Agent 方向沿用当前 node/fork 身份，控制接口演进与删除 fork 的决策分别推进。Typst Electron Studio 已移至 [Pluxel Lab](https://github.com/PluxelJS/lab)，应用改造与验收由 Lab 维护。

## 设计与证据

提案写明问题、已有依据、未决判断与完成条件，拟议 API 标注实施状态。已落地部分并入所属领域页；只剩研究问题时，以研究问题命名，完成过程由 Git 保存。

已有功能的环境与发行验证按 [Records](../records/README.md)和[Workbench 验收](../WORKBENCH_FLEXLAYOUT_VALIDATION.md)中的具体范围判断。实验能力、正式实现与部署验收分别标注。
