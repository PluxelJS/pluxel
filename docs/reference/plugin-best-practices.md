---
title: 插件提交检查
description: 按改动影响选择验证，确认当前实例与可交付产物。
---

提交前按本次变化核对以下结果；具体契约留在对应指南，不需要每次重读全部文档。

| 改动                     | 应有的证据                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 依赖或生命周期           | 真实 Consumer 的成功/缺失路径，失败初始化与 stop/replacement 后资源回收；见[插件模型](../getting-started/plugin-model.md)和[测试](../development/testing.md) |
| 配置或 Part              | 默认值、非法值、公开路径与保存后应用状态；见[配置](../getting-started/configuration.md)和[Part](../getting-started/plugin-parts.md)                          |
| HTTP、command 或数据操作 | 从公开入口验证结果、输入错误及 owner 失效；外部网络行为使用真实 listener                                                                                     |
| Workbench                | 真实页面读取/操作/关闭，关闭 Workbench 后业务仍运行；见[页面资源](../workbench/renderer-resources.md)                                                        |
| 交付契约                 | exports、peers 与生成制品一致，`pnpm pack --dry-run` 包含所需文件；见[插件包](../development/plugin-package.md)                                              |

运行 package 实际声明的相关 scripts；发布前运行完整 `verify` 与构建。
[inspect](../development/inspection.md) 可定位声明和验证脚本；[devconsole](../development/dev-console.md) 确认当前实例的状态、应用报告和日志。隔离测试使用 `@pluxel/test`，不替代在线实例证据。
