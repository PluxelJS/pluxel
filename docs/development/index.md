---
title: 开发与验证
description: 按任务选择源码查询、检查、隔离测试和在线操作。
---

Coding agent 从 [pluxel-development skill](https://github.com/PluxelJS/pluxel/blob/main/.agents/skills/pluxel-development/SKILL.md)进入；本目录提供按需查阅的用法。已知修改点直接读对应页，无需顺序阅读。

## 按任务选择

| 任务                                   | 入口                                                         | 结果能证明什么                              |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| 定位 Plugin/Part、配置声明或应用绑定   | [源码 inspect](./inspection.md)                              | 静态声明关系；partial/空结果不证明不存在    |
| 检查类型、lint、构建与工作区契约       | 项目 scripts、[工作区工具链](./workspace-toolchain.md)       | 实际执行的检查；inspect 列出脚本不等于执行  |
| 验证插件行为、失败与清理               | [插件测试](../plugin-development/testing.md)                 | 隔离 host 的回归；不代表运行实例            |
| 控制 HMR 批次、操作配置、方法或日志    | [开发控制台](./dev-console.md)                               | 选定 profile/实例的在线结果；保留原 receipt |
| Git 源码联调、catalog、文档/skill 接入 | [源码工作区](./source-workspaces.md)                         | 安装与来源状态；doctor 不证明产物最新       |
| 理解生成项目的目录与任务               | [示例项目](./starter-monorepo.md)                            | 模板的职责划分与操作入口                    |
| CLI、构建转换与 HMR                    | [CLI 与工具链](./tooling.md)                                 | 命令职责、源码转换与更新边界                |
| 发布插件或交付应用                     | [插件包](./plugin-package.md)、[应用交付](./distribution.md) | 包公开契约与最终发行物                      |

业务实现查[插件开发](../plugin-development/index.md)，装配与部署查[Host 配置](../host/configuration.md)，框架内部维护查[工程入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)。

## 选择验证边界

普通函数用普通测试；依赖注入、配置和生命周期用真实 lowering 的 test host；运行中应用的变化用现有 dev console。已知符号直接用 `rg`、exports 和源码，不必先做 inspect 或启动应用。

确认输入、资源所有者、调用方与生效条件后修改；按风险执行检查，交付实际结果和未覆盖边界。各类证据不能相互替代。

`pluxel docs <path>` 输出当前开发来源的正文；下游优先读 `docs/pluxel/`，接入方式见[源码工作区](./source-workspaces.md#文档skill-与接入状态)。文档与版本不一致时核对实际 exports 和实现。
