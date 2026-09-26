---
title: 理解与修改已有项目
description: 先区分源码声明、在线状态和隔离回归，再定位改动与验证入口。
---

先确认项目根目录、所用包版本、相关 scripts，以及要修改的插件或应用入口。已知目标时直接定位，不必扫描整个项目。

源码 checkout 的文档随该 revision 演进；`pluxel docs` 链接当前上游文档，不自动匹配已安装版本。出现符号或行为差异时先核对版本与 exports，再判断是用法错误还是需要修改契约。

## 选择需要的事实

| 要回答的问题                                         | 工具                                                   | 结果能证明什么                                                        |
| ---------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Plugin、Part、schema、依赖或应用配置输入在哪里声明？ | [inspect](./inspection.md)：`@pluxel/rolldown/inspect` | 源码声明与位置；应用输入需要显式 `application`                        |
| 当前实例用了什么配置，调用是否生效，日志是什么？     | [devconsole](./dev-console.md)：`pluxel dev`           | 所选现有 Vite 实例的真实状态；先发现，再固定 `--root` 与 `--instance` |
| 修改是否满足依赖、配置、请求与清理契约？             | [插件测试](./testing.md)：`@pluxel/test`               | 隔离回归结果，不代表当前在线实例                                      |

普通函数、任意 import 或框架内部实现可直接搜索源码。inspect 的空结果只描述其查询范围；`partial` 或 `unavailable` 必须继续处理缺口，不能据此断言不存在。

## 完成一次修改

1. **定位。** 已知文件直接读源码；需要声明关系时查询 Plugin，沿 declaration、schema、binding 位置阅读。修改应用输入时明确选择应用。
2. **确认契约。** 检查当前导出、类型、文档和真实调用方，确定谁拥有状态、失败和清理。
3. **实现与验证。** 运行相关 package 实际声明的检查。脚本存在不代表覆盖本次风险；根据行为选择类型、运行时或生命周期验证。
4. **确认需要的结果。** 若修改涉及之前查询的声明，编辑后重查；需要在线效果时检查对应实例的运行结果、应用报告与日志。源码 revision 和隔离测试不能替代在线证据。

## 按任务继续阅读

| 改动                 | 入口                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| 插件依赖与生命周期   | [插件模型](../getting-started/plugin-model.md)                                             |
| 拆分插件内部组成     | [PluginPart](../getting-started/plugin-parts.md)                                           |
| 配置声明和输入       | [配置](../getting-started/configuration.md)                                                |
| 业务 API、可恢复失败 | [API 设计](../api/index.md)、[Better Result](../api/better-result.md)                      |
| 应用装配与服务选择   | [宿主配置](../getting-started/host-setup.md)、[服务组合](../reference/runtime-services.md) |
| 生成项目目录和命令   | [示例项目](./starter-monorepo.md)、[CLI](./tooling.md)                                     |
| 跨仓库源码联调       | [源码工作区](./source-workspaces.md)                                                       |
| 插件发布或应用部署   | [插件包](./plugin-package.md)、[应用交付](./distribution.md)                               |
| 查公开 import 或排错 | [Package 矩阵](../reference/package-matrix.md)、[排错](../reference/troubleshooting.md)    |

修改 Pluxel 框架内部时，转到[工程索引](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)。提案与实验不作为当前 API 依据。
