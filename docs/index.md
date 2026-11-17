---
title: 欢迎使用 Pluxel
description: 面向 TypeScript 应用的模块化插件运行时。
icon: BookOpen
---

Pluxel 是一个面向 TypeScript 场景的模块化插件运行时。它基于声明式依赖图组织应用能力，提供确定性的生命周期管理、统一的配置校验机制以及开发期热重载能力。

无论你是构建前后端一体化应用、自动化工具，还是需要在宿主中动态装卸第三方插件，都可以使用相同的插件模型进行开发。

## 快速导航

- **新手上手**：参考[快速开始](./getting-started/index.md)在几分钟内搭建一个具备 HTTP API 与 Workbench 的完整应用，或通过[编写第一个插件](./getting-started/first-plugin.md)学习独立插件的基础编写方法。
- **设计初衷**：阅读[为什么是 Pluxel](./why-pluxel.md)，了解从 Cordis 到 Pluxel 的架构演进与设计权衡。
- **插件开发**：查阅[插件开发指南](./plugin-development/index.md)，涵盖[依赖注入](./plugin-development/model.md)、[生命周期管理](./plugin-development/lifecycle.md)、[Valibot 配置](./plugin-development/configuration.md)、[结构化日志](./plugin-development/logging.md)与[插件单元测试](./plugin-development/testing.md)。
- **宿主装配**：查阅[宿主配置教程](./host/configuration.md)，学习如何通过 `defineHostApplication()` 组装应用入口、绑定环境变量、挂载文件持久化与构建生产产物。
- **管理界面**：查阅[Workbench 工作台](./workbench/index.md)，为插件开发可视化设置表单、自定义视图面板与交互页面。
- **开发与交付**：查阅[开发工具链](./development/workspace-toolchain.md)与[应用交付](./development/distribution.md)，掌握日常调试命令与静态打包流程。
- **官方插件**：查阅[官方插件目录](./plugins/index.md)，直接使用开箱即用的 HTTP 客户端、权限认证、缓存与渲染插件。
- **问题排查**：遇到疑问或异常时，可在[常见错误与排查](./reference/troubleshooting.md)中寻找对应解决方案。

## 终端文档查阅

除了通过网页查阅文档，在本地项目中也可以使用命令行工具直接查看指定文档：

```sh
vp exec pluxel docs plugin-development/model.md
```
