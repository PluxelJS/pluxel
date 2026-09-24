---
title: 理解与修改已有项目
description: 按任务选择 inspect 源码查询、devconsole 在线操作和隔离测试。
---

先确认项目根目录、package scripts 和 Vite 的应用入口，再按需要确认的事实选择工具。

| 任务                                             | 入口                                                                       | 结果边界                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 定位 Plugin、Part、依赖、schema 或应用配置输入   | [inspect](./inspection.md)：`@pluxel/rolldown/inspect`，在 Node 脚本中调用 | 源码声明与位置，不执行应用；应用输入需显式选择 `application`            |
| 读取或修改当前应用的配置、插件、Workbench 和日志 | [devconsole](./dev-console.md)：`pluxel dev`                               | 所选 Vite 实例的真实状态；先发现实例，后续固定 `--root` 与 `--instance` |
| 验证依赖、配置、请求与资源清理                   | [插件测试](./testing.md)：`@pluxel/test`                                   | 隔离回归，不代表当前运行实例                                            |

已知目标就直接查询 Plugin 或文件，不必先扫描项目。沿返回位置读取源码，处理分析缺口，修改后运行相关 scripts；需要在线结果时再检查对应实例的应用报告与日志。

## 按改动范围继续读

- 业务代码：[插件模型](../getting-started/plugin-model.md)、[Part](../getting-started/plugin-parts.md)、[配置](../getting-started/configuration.md)、[API 设计](../api/index.md)。
- 应用装配：[宿主配置](../getting-started/host-setup.md)、[服务组合](../reference/runtime-services.md)；生成项目入口为 `host/src/app.ts`，目录说明见[示例项目](./starter-monorepo.md)。
- 工具与交付：[CLI](./tooling.md)、[源码联调](./source-workspaces.md)、[插件发布](./plugin-package.md)、[应用交付](./distribution.md)。

公开导入查 [Package 矩阵](../reference/package-matrix.md)。修改框架时才进入[工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)；提案和实验不作为当前 API 依据。
