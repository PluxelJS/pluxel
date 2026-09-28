<div align="center">

# Pluxel

### 面向 TypeScript 应用的模块化 Plugin Runtime

用依赖图组织能力，用一致的生命周期管理资源。<br>
一套 Plugin 模型，既能打包固定的插件清单，也能在运行时接入新的插件来源，并可按需启用管理界面。

[![CI](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml/badge.svg)](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-663399.svg)](./LICENSE)

[文档](https://www.pluxel.dev) · [设计初心](./docs/why-pluxel.md) · [参与贡献](./CONTRIBUTING.md) · [许可](./LICENSE)

</div>

## 🌱 从 Cordis v3 出发

Pluxel 从 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) 与 [Koishi](https://github.com/koishijs/koishi) 的 Plugin 实践出发，延续 Context、生命周期和副作用回收的核心直觉，并重新设计依赖身份、构建验证与运行时边界。

[了解这段技术传承与设计选择 →](./docs/why-pluxel.md)

## 从任务开始

| 任务               | 入口                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| 创建并运行应用     | [快速开始](./docs/getting-started/index.md)                           |
| 修改已有应用或插件 | [开发指南](./docs/development/index.md)：源码定位、在线操作与隔离回归 |
| 查公开包和 import  | [Package 矩阵](./docs/reference/package-matrix.md)                    |
| 修改框架内部       | [工程索引](./engineering/README.md)：职责、约束、实现与验证           |
| 提交变更           | [贡献指南](./CONTRIBUTING.md)：环境、检查、changelog 与 PR            |

Coding agent 从 [AGENTS.md](./AGENTS.md) 按任务选读。公开用法维护在 `docs/`，框架内部约束维护在 `engineering/`；package README 补充本包操作和源码入口。

## 应用如何组成

应用通过 `defineHostApplication(factory)` 声明 Plugin catalog、可选动态 sources 和服务。Vite 开发与生产构建消费同一声明；加入 catalog 不等于自动启动，运行策略由 Host 管理。

Plugin 通过 constructor 声明必需依赖，框架负责依赖图、启停与 generation 资源清理。配置由 schema 描述，HTTP、持久化等服务由 Host 明确选择。Workbench 可选，业务能力不依赖管理界面。

- [插件模型](./docs/getting-started/plugin-model.md)：依赖、失败与生命周期。
- [宿主配置](./docs/getting-started/host-setup.md)：应用声明与服务装配。
- [Workbench](./docs/workbench/index.md)：插件管理界面与可组合视图。
- [交付应用](./docs/development/distribution.md)：构建和验证生产制品。

> Pluxel 的公开版本线从 `1.0.0` 开始。安装版本和公开 API 请以所用版本的文档及 npm registry 为准。

## ⚖️ 许可

Pluxel 以 [GNU Affero General Public License v3.0](./LICENSE)（`AGPL-3.0-only`）开源。

闭源分发、专有修改、商业嵌入或其他与 AGPL 不兼容的使用方式，请参阅 [商业许可说明](./COMMERCIAL-LICENSE.md)。贡献代码前请阅读 [CLA](./CLA.md)。
