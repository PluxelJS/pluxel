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

## ✨ 为什么选择 Pluxel？

Pluxel 将应用拆分为具有依赖、配置和生命周期的 Plugin。框架负责图调度、故障隔离、资源回收与宿主集成，让 Plugin 专注于业务能力，并能在不同运行方式之间复用。

- **可推导的 Plugin 图** — required/optional dependency、确定性的启停顺序与依赖失败传播。
- **可靠的资源生命周期** — replacement、rollback、restart 和 shutdown 共享 generation 级清理语义。
- **静态与动态宿主** — 固定可用的 Plugin 清单，或在运行时增删文件来源；开发期两者都支持 HMR。
- **Context 能力模型** — 配置、HTTP、日志、effects、commands、数据库等能力保持 Plugin-scoped。
- **Schema 驱动配置** — 类型、默认值、校验和 Workbench 表单来自同一份 Valibot schema。
- **可选 Workbench** — 提供配置和运行状态管理；关闭时不产生对应 compiler、watcher 与 transport 成本。
- **完整工具链** — CLI、Vite/Rolldown 集成、Plugin metadata、测试 harness 与 static artifact。

## 🧭 一个应用声明

应用在 `defineHostApplication(factory)` 中选择固定 Plugin catalog、可选动态 sources 和服务。Vite 开发与生产构建消费同一声明；加入 catalog 不等于自动启动，运行策略由 Host 管理。装配方式见[宿主配置](./docs/getting-started/host-setup.md)。

## 📚 了解更多

- [用户文档](https://www.pluxel.dev) — 入门、Plugin 开发、宿主装配与能力指南
- [Package 与公开入口](https://www.pluxel.dev/docs/reference/package-matrix) — package 职责和可用入口
- [开发与验证](./docs/development/index.md) — 开发者与 coding agent 共用的 inspect、devconsole 和测试工作流程
- [工程文档](./engineering/README.md) — 修改框架时的设计原则、内部边界和发布流程
- [贡献指南](./CONTRIBUTING.md) — 开发环境、测试、Tegami changelog 与 Pull Request

> Pluxel 的公开版本线从 `1.0.0` 开始。安装版本和公开 API 请以文档站及 npm registry 为准。

## ⚖️ 许可

Pluxel 以 [GNU Affero General Public License v3.0](./LICENSE)（`AGPL-3.0-only`）开源。

闭源分发、专有修改、商业嵌入或其他与 AGPL 不兼容的使用方式，请参阅 [商业许可说明](./COMMERCIAL-LICENSE.md)。贡献代码前请阅读 [CLA](./CLA.md)。
