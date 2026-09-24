---
title: 理解与修改已有项目
description: 人和 coding agent 共用的开发入口：用 inspect 定位源码，用 devconsole 操作当前应用，用测试验证行为。
---

接手一个 Pluxel 项目，先确定要修改的功能、项目根目录和应用入口，再选择下表中的工具。已有项目不必从创建教程重读；本页适用于开发者和 coding agent。

## 按要确认的事实选工具

| 你要确认什么                             | 工具与入口                                                                                               | 得到什么                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Plugin、Part、依赖或配置在哪里声明       | [inspect 源码查询](./inspection.md)：`@pluxel/rolldown/inspect`                                          | definition、源码位置、分析缺口与包内验证脚本          |
| 某个应用如何给 Plugin 提供配置输入       | [inspect 应用查询](./inspection.md#定位应用的配置输入)：`plugin()` 的 `application` 与 `inputs`          | configRecords 表达式、env/file binding 和 schema 位置 |
| 当前应用的配置、插件状态、方法调用或日志 | [devconsole 开发控制台](./dev-console.md)：`pluxel dev`                                                  | 所选 Vite 实例上的执行结果、应用报告与日志            |
| 修改后行为是否满足可重复断言             | [插件测试](./testing.md)：`@pluxel/test`                                                                 | 隔离宿主中的行为回归结果                              |
| import 从哪个包来，服务怎样安装          | [Package 与入口矩阵](../reference/package-matrix.md)、[组合 Host 服务](../reference/runtime-services.md) | 公开入口与显式服务组合方式                            |
| 如何构建、联调或交付                     | [CLI 与工具链](./tooling.md)、[源码联调](./source-workspaces.md)、[应用交付](./distribution.md)          | 对应任务的命令、产物与验证方式                        |

inspect 是可在普通 Node 脚本中调用的 TypeScript API；devconsole 是向现有 Vite 提交 TypeScript 操作的 CLI。前者描述源码声明，后者观察或修改运行实例。测试宿主提供隔离环境，不能证明已经运行的应用处于相同状态。

## 先建立当前应用的模型

读代码时按下面的职责找入口，不必从底层实现开始：

| 概念                | 在项目中负责什么                                                   | 需要深入时读                                                                                    |
| ------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Plugin / PluginPart | 业务能力、依赖、配置声明及随生命周期释放的资源                     | [插件模型](../getting-started/plugin-model.md)、[Part 组合](../getting-started/plugin-parts.md) |
| 应用声明 / Host     | 选择固定插件、可变来源、服务与启动策略；开发和生产消费同一应用声明 | [宿主配置](../getting-started/host-setup.md)                                                    |
| Host services       | 为应用显式安装 HTTP、日志、持久化等能力；安装包本身不等于启用服务  | [组合 Host 服务](../reference/runtime-services.md)                                              |
| Vite / 构建工具链   | 转换 Plugin 声明并加载开发代码，或生成可部署产物                   | [CLI 与工具链](./tooling.md)                                                                    |
| Workbench           | 可选的管理与交互界面；业务功能应可独立运行                         | [Workbench](../workbench/index.md)                                                              |

## 完成一次修改

1. **确定上下文。** 读取项目自己的 AGENTS.md、package scripts、Vite 配置与应用入口。生成项目的应用声明位于 `host/src/app.ts`；其他项目以实际配置为准。应用声明中的 catalog、sources 和 services 决定接入哪些插件及服务，详见[宿主配置](../getting-started/host-setup.md)。
2. **定位源码。** 已知 Plugin 时直接调用 `project.plugin()`；已知文件时使用 `file()`；需要发现目标时再用 `overview()` / `plugins()`。涉及应用输入时显式选择 application。按返回位置读取源码；遇到 partial/unavailable 先看诊断，空结果不自动等于没有功能。
3. **按功能读取契约并修改。** 依赖、清理和 Part 组合看[插件模型](../getting-started/plugin-model.md)与 [PluginPart](../getting-started/plugin-parts.md)；配置看[配置模型](../getting-started/configuration.md)；对外调用看 [API 设计与使用](../api/index.md)。不需要预先阅读全部框架内部文档。
4. **验证修改。** 运行项目实际声明的相关测试、类型检查和构建；inspect 的 `checks` 只列出脚本，不代替执行，也不保证脚本覆盖当前行为。源码编辑后重新查询即可，无需刷新索引。
5. **需要在线结果时确认同一实例。** 按 devconsole 指南先发现实例，再固定 `--root` 和 `--instance`。检查执行状态、领域结果、配置应用报告和相关日志；保存的数据不会在脚本结束时自动还原。

例如修改一个 Plugin 的环境变量输入：用 inspect 同时请求 `config`、`inputs`、`checks`，沿 schema 和 binding 位置修改声明，运行相关检查；若任务还要求确认当前应用效果，再通过 devconsole 读取实际应用结果。

## 当前文档在哪里

项目内用 `pnpm exec pluxel docs development/index.md` 获取本页链接，其他页面同样按路径查找。CLI 返回文档链接；具体用法需继续阅读对应页面。源码 checkout 中可以直接读取 `docs/`。

- `docs/` 描述当前公开用法；功能页负责最小示例、关键边界和验证方法。
- package README 负责本包安装和入口；准确导出以所用版本的 `package.json#exports` 为准。
- 修改 Pluxel 框架本身时，先读[工程文档入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)，按改动领域加载约束。
- 提案、实验和 Git 历史解释背景，不作为当前 API 的依据。使用已发布版本时，同时核对安装版本与发布记录。

新建项目从[快速开始](../getting-started/index.md)开始；生成项目的目录与日常命令见[示例项目结构](./starter-monorepo.md)。
