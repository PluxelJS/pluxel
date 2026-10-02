---
title: 开发与验证
description: 区分源码事实、静态检查、隔离行为和在线状态，按改动选择证据。
---

本目录回答“如何定位和验证修改”。业务写法从[插件开发范式](../plugin-development/index.md)选择；服务安装和部署输入从[Host 配置](../host/configuration.md)选择。

## 先确认任务需要什么证据

| 问题                                      | 首选工具                                     | 证据边界                                      |
| ----------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| Plugin、Part、schema 或应用输入在哪里声明 | [inspect](./inspection.md)                   | 静态声明与绑定关系；不能证明在线实例已应用    |
| 类型、lint、包边界或构建是否正确          | 项目实际 scripts / `pluxel workspace doctor` | 静态检查；inspect 列出脚本不等于执行检查      |
| 插件行为、错误与停止清理是否正确          | [插件测试](../plugin-development/testing.md) | 真实 lowering 的隔离 host；不代表运行实例     |
| 当前应用的配置、方法、报告和日志          | [dev console](./dev-console.md)              | 现有 Vite 实例；固定绝对 root 和准确 instance |
| Git overlay、文档或 skill 来源是否正确    | [源码工作区](./source-workspaces.md)         | setup、链接、所选 checkout 与产物来源         |

已知文件和符号时直接用 `rg`、exports 和源码。inspect 用于确认声明关系，不代替任意 import 分析；空结果或 partial 报告不能证明不存在。

## 完成一次修改

1. 确认项目根、包版本、目标文件及实际 scripts。
2. 读取本次契约：谁提供输入、谁拥有资源、谁消费结果、何时算生效。
3. 修改实现和已知调用方；按风险运行静态检查、隔离测试或在线验证。
4. 报告实际执行的检查、观察到的行为和未覆盖边界。用户用法变化同步所属指南。

纯函数使用普通测试；插件依赖与生命周期使用 `@pluxel/test`；在线变更使用现有 dev console。不要为满足形式启动无关应用，或用另一宿主推断线上结果。

## 工程任务入口

| 任务                        | 入口                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| 理解生成项目                | [示例项目](./starter-monorepo.md)                                              |
| CLI、源码 lowering 与构建   | [工具链](./tooling.md)                                                         |
| Git/npm setup 与 skill 安装 | [源码工作区](./source-workspaces.md)                                           |
| 发布插件或交付应用          | [插件包](./plugin-package.md)、[应用交付](./distribution.md)                   |
| 修改框架内部                | [工程入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md) |

Coding agent 的工具选择与执行要求由 [pluxel-development skill](https://github.com/PluxelJS/pluxel/blob/main/.agents/skills/pluxel-development/SKILL.md)引导。CLI 负责物化 skill 和文档；正文只有上游一份，项目 AGENTS 保留本地约束。`pluxel docs` 输出当前来源正文；版本有差异时先核对 exports 与实现。
