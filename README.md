<div align="center">

# Pluxel

### 面向 TypeScript 应用的模块化插件运行时

用依赖图组织能力，用确定性生命周期管理资源。<br>
一套插件模型，既能打包为预编译好的独立应用，也能在开发与运行时动态接入新插件，并按需启用可视化管理界面。

[![CI](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml/badge.svg)](https://github.com/PluxelJS/pluxel/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-663399.svg)](./LICENSE)

[文档](https://www.pluxel.dev) · [快速开始](./docs/getting-started/index.md) · [设计背景](./docs/why-pluxel.md) · [参与贡献](./CONTRIBUTING.md) · [开源许可](./LICENSE)

</div>

## 核心设计

Pluxel 借鉴了 [Cordis v3](https://github.com/cordiverse/cordis) 与 [Koishi](https://github.com/koishijs/koishi) 的插件实践，并进一步把 TypeScript 的类型导入与构建阶段的依赖元数据连接起来：

- **构造函数依赖注入**：通过 TypeScript 构造函数参数声明所需依赖，编译器在构建时记录类型来源并自动连接运行时依赖图。
- **确定性资源生命周期**：网络连接、定时器和事件监听器通过上下文统一注册到生命周期钩子中，在插件停止、重启或热更新时由框架自动清理。
- **统一的配置模型**：使用 Valibot 定义单份配置 Schema，同时推导类型、默认值、运行时校验与 Workbench 可视化表单。
- **动静皆宜的应用形态**：既支持在开发时热重载本地插件，也可以静态编译为无额外运行开销的生产独立制品。

## 快速浏览

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { AccountsPlugin } from '@acme/accounts'
import * as v from 'valibot'

const BillingConfig = v.object({
	currency: v.optional(v.string(), 'USD'),
})

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	private readonly config = this.configs.use(BillingConfig)

	// 1. 在构造函数中声明强类型依赖
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	protected override init() {
		// 2. 创建长期运行的资源，随插件生命周期自动回收
		const timer = setInterval(() => this.sync(), 60_000)
		this.ctx.effects.defer(() => clearInterval(timer))
	}

	private sync() {
		const list = this.accounts.listInvoices()
		this.ctx.logger.info('Synced invoices', { count: list.length, currency: this.config.currency })
	}
}
```

## 文档导航

- [快速开始](./docs/getting-started/index.md)：几分钟内创建并运行一个完整的示例应用。
- [Pluxel Lab](https://github.com/PluxelJS/lab)：独立维护 QuickJS 原生嵌入、Electron 等运行环境实验，包含源码、运行说明与验证记录。
- [为什么是 Pluxel](./docs/why-pluxel.md)：了解 Pluxel 的架构选型与 Cordis 的设计传承。
- [插件开发指南](./docs/plugin-development/index.md)：依赖模型、事件系统、日志输出、配置与隔离测试。
- [宿主配置](./docs/host/configuration.md)：应用入口定义、环境变量绑定、存储挂载与生产打包。
- [Workbench 工作台](./docs/workbench/index.md)：为插件配置可视化管理界面与业务视图。
- [开发工具链](./docs/development/workspace-toolchain.md)：本地开发环境、mise 工具链与 Pitchfork 服务管理。
- [包索引矩阵](./docs/reference/package-matrix.md)：查看所有官方包的导入入口与公开状态。

## 开源许可

Pluxel 基于 [GNU Affero General Public License v3.0](./LICENSE)（`AGPL-3.0-only`）开源。

如需闭源分发、专有修改、商业嵌入或在其他与 AGPL 不兼容的场景下使用，请查阅[商业许可说明](./COMMERCIAL-LICENSE.md)。贡献代码请参阅 [CLA](./CLA.md) 与 [参与贡献指南](./CONTRIBUTING.md)。
