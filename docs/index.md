---
title: Pluxel 文档
description: 创建并运行第一个应用，再按任务查找插件、运行时、管理界面和交付指南。
icon: BookOpen
---

Pluxel 用 TypeScript 插件组织业务能力。插件声明依赖和配置，框架管理它们的启动、热更新与资源清理。

## 先运行一个项目

准备 Node.js 24+ 和 pnpm 11，然后执行：

```sh
pnpm create @pluxel my-app
cd my-app
pnpm dev
```

`@pluxel/create` 会生成并安装完整示例。打开终端打印的应用地址，即可操作 Todo 页面；页面背后已经连接插件提供的 HTTP API，也带有 Workbench 管理界面。

[快速开始](./getting-started/index.md)带你确认运行结果、修改第一处代码并构建应用。

## 接着学习什么

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

遇到宿主模式、内部资源拆分等具体需求时，再阅读[宿主配置](./getting-started/host-setup.md)和 [PluginPart](./getting-started/plugin-parts.md)。想了解适用场景和设计取舍，阅读[为什么是 Pluxel](./why-pluxel.md)。

## 与 coding agent 一起开发

给 agent 提供你要完成的任务、项目路径和运行结果，再选择对应文档：

- **开发 Pluxel 应用或插件**：先读[快速开始](./getting-started/index.md)，随后只读当前功能的指南。公开入口不确定时查 [Package 矩阵](./reference/package-matrix.md)。
- **检查正在运行的应用**：使用[开发控制台](./development/dev-console.md)，先发现实例，再固定项目和实例执行操作、读取结果。
- **同时修改框架和业务仓库**：按[源码联调](./development/source-workspaces.md)连接 Git checkout。
- **修改 Pluxel 框架本身**：从[工程文档入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)读取对应领域的约束。

生成项目已安装 CLI，可以在项目根目录用 `pnpm exec pluxel docs` 查找本文档，用 `pnpm exec pluxel docs development/testing.md` 打开某一页的链接。`docs/` 是当前用户 API 的文档来源；设计提案和 Git 历史用于理解背景。
