---
title: Pluxel 文档
description: 按任务直接找到插件开发范式、Host 配置与验证入口。
icon: BookOpen
---

Pluxel 用 TypeScript 插件组织业务能力，管理依赖、配置、启动、热更新与资源清理。

插件基础从[依赖](./plugin-development/model.md)、[事件](./plugin-development/events.md)、[日志](./plugin-development/logging.md)和[资源清理](./plugin-development/lifecycle.md)开始。这些能力由 Core 提供，不要求先接 HTTP 或管理页面。

## 先选你正在改的东西

| 当前任务                         | 入口                                                                                  | 读到哪里就可以开始做                                       |
| -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 第一次创建应用                   | [快速开始](./getting-started/index.md)                                                | 跑通示例，再改一个业务功能                                 |
| 编写或修改业务插件               | [插件开发范式](./plugin-development/index.md)                                         | 优先定位依赖、事件、日志、生命周期或配置；额外服务按需选择 |
| 装配应用、配置部署或日志输出     | [Host 配置教程](./host/configuration.md)                                              | 选择服务、输入、输出、Vite 或生产构建章节                  |
| 定位已有代码、验证修改或在线排障 | [开发与验证](./development/index.md)                                                  | 明确源码事实、隔离测试或在线证据                           |
| 开发管理页面                     | [Workbench](./workbench/index.md)                                                     | 选择 Content、View 或组合方式                              |
| 使用现成插件                     | [官方插件](./plugins/index.md)                                                        | 确认是否公开可安装，再读对应能力                           |
| 发布或交付                       | [插件包](./development/plugin-package.md)、[应用交付](./development/distribution.md)  | 检查实际发行入口与搬离工作区的产物                         |
| 确认 import 或故障原因           | [Package 矩阵](./reference/package-matrix.md)、[排错](./reference/troubleshooting.md) | 核对实际版本、exports 和报告                               |

## 文档使用方式

`pnpm exec pluxel docs <path>` 输出正文及来源；例如 `pluxel docs plugin-development/logging.md`。已 setup 的下游工作区可直接读 `docs/pluxel/`，源码仓库读 `docs/`。不要把另一版本的在线页面当成本地契约。

已知任务直接读目标页，无需先通读索引。明确输入、所有者、修改点和验证方式后开始实现；遇到版本冲突、未知行为或跨领域影响再展开链接。文档与代码不一致时核对 exports、实现和调用方，修正差异。

`docs/` 维护公开开发用法；[工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)维护框架约束和实现入口。设计动机见[为什么是 Pluxel](./why-pluxel.md)。
