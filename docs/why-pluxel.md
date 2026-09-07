---
title: 为什么是 Pluxel？
description: 了解 Pluxel 适合解决的问题、插件模型的来源，以及依赖检查与生命周期带来的取舍。
---

当应用由多个可组合的功能组成，而这些功能需要独立配置、相互依赖、热更新和资源清理时，可以把它们组织为 Pluxel 插件。例如：机器人接入、HTTP 服务、后台任务、管理界面和第三方集成。

想先体验运行效果，直接看[快速开始](./getting-started/index.md)。本页解释选择 Pluxel 时需要了解的能力和代价。

## 它替你管理什么

| 应用中的问题                           | Pluxel 的做法                                                           |
| -------------------------------------- | ----------------------------------------------------------------------- |
| 一个功能启动前必须有另一个功能         | 在构造函数中声明插件依赖，由运行时按依赖关系启动                        |
| 可选集成出现或消失时需要重新连接       | 声明可选插件引用，由运行时调整依赖并重启受影响的插件                    |
| 配置类型、默认值、校验和表单容易不同步 | 用同一份 Valibot schema 声明配置                                        |
| 热更新后遗留监听器、定时器或路由       | 把资源登记到插件的 Context，随本次运行实例一起释放                      |
| 开发与部署使用不同插件清单             | 宿主显式选择插件，static 构建固定发行内容，dynamic 允许额外发现插件文件 |

普通数据转换、计算和其他没有生命周期的代码可以继续写成函数或类。只有需要依赖关系、配置或资源管理的业务边界才需要成为插件；示例项目中的 `packages/domain` 就是普通 TypeScript。

## 依赖直接写在使用处

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { AccountsPlugin } from '@acme/accounts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}
}
```

`AccountsPlugin` 的导入和构造函数参数共同声明了这条必需依赖。构建工具在 TypeScript 擦除类型之前记录它，运行时据此注入依赖。修改依赖时，类型检查、包导出和构建检查可以沿同一条源码关系工作。

可选集成使用 `definePluginRef()` 和 `plugins.use()`；宿主提供的 HTTP、日志和资源管理则通过 `this.ctx` 使用。具体写法见[插件依赖与生命周期](./getting-started/plugin-model.md)。

## Context 与生命周期

Context 是当前插件使用宿主能力的入口，也记录资源属于谁。插件通过 `ctx.effects` 登记清理操作；插件停止、替换或启动回滚时，框架释放对应资源。

每次插件启动都会创建新的运行实例，文档中称为一个 **generation**。旧实例退出后，不能继续把其句柄当作当前可用的插件使用。依赖变化、可选集成和热更新都遵循这条生命周期规则。

HTTP 插件使用真实的 Elysia application：在 `init()` 中通过 `ctx.elysia` 注册接口，框架在插件初始化完成后发布路由，在插件退出时撤销。监听端口和服务进程由应用宿主管理。见[HTTP 接口](./runtime/http.md)。

需要拆分同一个插件内部的资源时，可以使用普通类、函数或 [PluginPart](./getting-started/plugin-parts.md)。只有需要独立配置、启停或被其他插件依赖的能力才值得拆成另一个插件。

## 从 Cordis 与 Koishi 学到的模型

Pluxel 的思考始于 2023 年以来的 [Koishi](https://github.com/koishijs/koishi) 插件实践，延续了 [Cordis](https://github.com/cordiverse/cordis) 的核心直觉：插件组织能力与副作用，Context 关联资源所有者，依赖是否可用决定功能的装载和卸载。

Cordis v3 的 service 模型通过 module augmentation 给 Context 增加类型，并用名称连接注册、依赖声明和访问。例如，provider 注册 `database`，consumer 声明 `inject: ['database']`，再调用 `ctx.database`。这些名称需要作者保持一致。可核对其 [service 生命周期约定](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/README.md#L368-L430)和 [Context 类型扩展示例](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/timer/src/index.ts#L1-L19)。

Pluxel 选择让业务依赖成为可追溯的源码关系：包根导出、值导入和构造函数参数共同确定依赖身份。业务插件通过依赖图组合，宿主公共设施通过 Context 提供。这样可以在构建阶段检查部分依赖错误，代价是插件写法与构建链路更受约束。

Cordis 模型也用于 Koishi 之外的项目。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L1-L9) 将其插件架构标记为 powered by Cordis，并维护 [Cordis 4.0.1](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/package.json#L1-L12)。这里的源码对照限定于前述 Cordis v3 写法，不代表对所有版本和项目的比较结论。

## 选择与代价

选择 Pluxel 时，需要接受以下工程要求：

- **使用对应工具链**：插件源码需要经过 Pluxel 的 Vite/Rolldown 处理，不能只擦除 TypeScript 后直接当作完整插件发行。
- **公开稳定入口**：可发布的插件从包根具名导出，依赖导入要能追溯到该入口。
- **遵循生命周期**：长期资源登记清理，已退出实例的资源和句柄不继续复用。
- **显式组合宿主**：应用选择插件清单和宿主能力；第三方业务能力通过插件依赖连接。

脚手架已经配置好工具链、示例插件、测试和宿主。先在生成项目中开发，出现新的交付需求时再选择 [static 或 dynamic 宿主](./getting-started/host-setup.md)。

Pluxel 与 Cordis v4 目前没有同场、同语义的性能比较。构建阶段的检查和运行时的生命周期管理是本页的选择依据，不能据此推导哪个框架更快。Context 的实现与独立宿主组合见 [Context 参考](./reference/context-hosts.md)；框架维护者可以继续阅读[工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)。
