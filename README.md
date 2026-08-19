<div align="center">

# Pluxel

### 面向 TypeScript 应用的模块化 Plugin Runtime

用依赖图组织能力，用一致的生命周期管理资源。<br>
一套 Plugin 模型，同时覆盖静态交付、动态开发与可选管理界面。

[![CI](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml/badge.svg)](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-663399.svg)](./LICENSE)

[文档](https://docs.pluxel.dev) · [设计初心](./docs/why-pluxel.md) · [参与贡献](./CONTRIBUTING.md) · [许可](./LICENSE)

</div>

## 🌱 从 Cordis v3 出发

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) Plugin 思想的一次再诠释与重构。我们从 2023 年开始在 [Koishi](https://github.com/koishijs/koishi) Plugin 开发中实践这套模型；Cordis 与 Koishi 是 Pluxel 重要的思想和实践基础，Cordis 也在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 等项目中继续展现其生命力。

在长期实践中，我们逐步探索出不同的依赖表达方式：Pluxel 的 required dependency 直接来自 constructor value import，构建期语义将类型、package provenance 和 graph identity 连在一起，运行时再由 DI graph 注入真实 Plugin generation。Context service 则通过预安装 getter 访问，而不是交给 Context-wide Proxy 统一解释。我们的目标，是让 TypeScript 不只提供补全，而是参与定义一套可以构建、验证和治理的 **typed meta-framework**。

[阅读完整的项目背景与设计选择 →](./docs/why-pluxel.md)

## ✨ 为什么选择 Pluxel？

Pluxel 将应用拆分为具有依赖、配置和生命周期的 Plugin。框架负责图调度、故障隔离、资源回收与宿主集成，让 Plugin 专注于业务能力，并能在不同运行方式之间复用。

- **可推导的 Plugin 图** — required/optional dependency、确定性的启停顺序与依赖失败传播。
- **可靠的资源生命周期** — replacement、rollback、restart 和 shutdown 共享 generation 级清理语义。
- **Static / Dynamic 双路线** — 固定 catalog 的可审计交付，或支持 source discovery、watch 与 HMR 的开发体验。
- **Context 能力模型** — 配置、HTTP、日志、effects、commands、数据库等能力保持 Plugin-scoped。
- **Schema 驱动配置** — 类型、默认值、校验和 Workbench 表单来自同一份 Valibot schema。
- **可选 Workbench** — 提供配置和运行状态管理；关闭时不产生对应 compiler、watcher 与 transport 成本。
- **完整工具链** — CLI、Vite/Rolldown 集成、Plugin metadata、测试 harness 与 static artifact。

## 🧭 两种运行方式，同一种 Plugin

| Static Runtime                | Dynamic Runtime                |
| ----------------------------- | ------------------------------ |
| 固定、可审计的 Plugin catalog | 可变 source 与运行时 entry     |
| 适合生产构建、离线与冻结交付  | 适合开发、workspace 联调与 HMR |
| 构建时确定代码闭包            | 运行时管理 source lifecycle    |

两条路线共享依赖图、配置、Context 和生命周期语义。Plugin 不需要感知自己运行在哪一种宿主中。

## 📚 了解更多

- [用户文档](https://docs.pluxel.dev) — 入门、Plugin 开发、宿主装配与能力指南
- [Package 与公开入口](https://docs.pluxel.dev/docs/reference/package-matrix) — package 职责和可用入口
- [工程文档](./engineering/README.md) — Agent 与维护者使用的设计原则、内部边界和发布流程
- [贡献指南](./CONTRIBUTING.md) — 开发环境、测试、Changeset 与 Pull Request

> Pluxel 目前处于积极开发的 `0.x` 阶段。安装版本和公开 API 请以文档站及 npm registry 为准。

## ⚖️ 许可

Pluxel 以 [GNU Affero General Public License v3.0](./LICENSE)（`AGPL-3.0-only`）开源。

闭源分发、专有修改、商业嵌入或其他与 AGPL 不兼容的使用方式，请参阅 [商业许可说明](./COMMERCIAL-LICENSE.md)。贡献代码前请阅读 [CLA](./CLA.md)。
