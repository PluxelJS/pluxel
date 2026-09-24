---
title: Pluxel 文档
description: 按任务查找入门、开发工具、功能指南和公开 API。
icon: BookOpen
---

Pluxel 用 TypeScript 插件组织业务能力，管理依赖、配置、启动、热更新与资源清理。

| 任务                   | 入口                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建并运行应用         | [快速开始](./getting-started/index.md)                                                                                                                  |
| 修改已有项目           | [开发工具选择](./development/index.md)：inspect、devconsole、测试                                                                                       |
| 编写插件与组合资源     | [第一个插件](./getting-started/first-plugin.md)、[依赖与生命周期](./getting-started/plugin-model.md)、[PluginPart](./getting-started/plugin-parts.md)   |
| 配置插件或装配应用     | [配置模型](./getting-started/configuration.md)、[宿主配置](./getting-started/host-setup.md)                                                             |
| 添加业务能力           | [HTTP](./runtime/http.md)、[日志](./runtime/logging.md)、[数据库](./runtime/database.md)、[命令](./runtime/commands.md)、[官方插件](./plugins/index.md) |
| 设计调用接口或管理界面 | [API 设计](./api/index.md)、[Workbench](./workbench/index.md)                                                                                           |
| 发布插件或部署应用     | [插件包](./development/plugin-package.md)、[应用交付](./development/distribution.md)                                                                    |
| 排错或确认 import      | [排错](./reference/troubleshooting.md)、[Package 矩阵](./reference/package-matrix.md)                                                                   |
| 修改框架               | [工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)                                                                          |

项目内运行 `pnpm exec pluxel docs [path]` 获取页面链接；源码 checkout 可直接读 `docs/`。
设计动机见[为什么是 Pluxel](./why-pluxel.md)。
