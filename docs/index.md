---
title: Pluxel 文档
description: 按任务进入新项目入门、已有项目开发、源码查询、在线控制台和功能指南。
icon: BookOpen
---

Pluxel 用 TypeScript 插件组织业务能力。插件声明依赖和配置，框架管理它们的启动、热更新与资源清理。

想先了解设计动机、Cordis 对比和具体取舍，可以阅读[为什么是 Pluxel](./why-pluxel.md)；想先体验应用，继续下面的创建步骤。

## 从当前任务开始

| 当前任务                          | 阅读入口                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 接手项目、定位源码并完成修改      | [理解与修改已有项目](./development/index.md)：inspect、devconsole 与测试的选择和工作流程 |
| 查询 Plugin、Part、配置与应用输入 | [inspect 源码查询](./development/inspection.md)                                          |
| 检查或操作正在运行的应用          | [devconsole 开发控制台](./development/dev-console.md)                                    |
| 创建第一个应用                    | 下方创建步骤与[快速开始](./getting-started/index.md)                                     |
| 修改框架本身                      | [工程文档入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)       |

开发者与 coding agent 使用同一套任务入口。提供任务、项目路径和需要验证的结果后，按需读取对应指南即可。

## 创建新项目

准备 Node.js 24+ 和 pnpm 11，然后执行：

```sh
pnpm create @pluxel my-app
cd my-app
pnpm dev
```

`@pluxel/create` 会生成并安装完整示例。打开终端打印的应用地址，即可操作 Todo 页面；页面背后已经连接插件提供的 HTTP API，也带有 Workbench 管理界面。

[快速开始](./getting-started/index.md)带你确认运行结果、修改第一处代码并构建应用。

## 接着学习什么

为其他插件或客户端设计接口时，从 [API 设计与使用](./api/index.md)选择本地调用、RPC 或 HTTP 边界。

| 你现在要做的事                     | 阅读入口                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 理解生成项目的目录、开发和构建命令 | [示例项目结构与开发流程](./development/starter-monorepo.md)                                                             |
| 编写一个自己的插件                 | [编写第一个插件](./getting-started/first-plugin.md)                                                                     |
| 让插件使用其他插件，并正确释放资源 | [插件依赖与生命周期](./getting-started/plugin-model.md)                                                                 |
| 给插件添加配置、默认值和表单       | [配置模型](./getting-started/configuration.md)                                                                          |
| 添加 API、日志、数据库或命令       | [HTTP](./runtime/http.md)、[日志](./runtime/logging.md)、[数据库](./runtime/database.md)、[命令](./runtime/commands.md) |
| 接入现成的插件能力                 | [官方插件](./plugins/index.md)                                                                                          |
| 给插件添加管理界面                 | [Workbench](./workbench/index.md)                                                                                       |
| 测试、发布插件或部署应用           | [测试](./development/testing.md)、[插件包](./development/plugin-package.md)、[应用交付](./development/distribution.md)  |
| 定位一个错误或查找准确的 import    | [排错](./reference/troubleshooting.md)、[Package 矩阵](./reference/package-matrix.md)                                   |

遇到宿主模式、内部资源拆分等具体需求时，再阅读[宿主配置](./getting-started/host-setup.md)和 [PluginPart](./getting-started/plugin-parts.md)。

## 查找文档与公开入口

生成项目已安装 CLI，用 `pnpm exec pluxel docs development/index.md` 获取开发入口链接，其他页面也可按路径查找。
不确定 import 时查 [Package 矩阵](./reference/package-matrix.md)；同时修改框架与业务仓库时查[源码联调](./development/source-workspaces.md)。
`docs/` 描述当前用户 API，工程文档约束框架实现，提案与 Git 历史用于理解背景。
