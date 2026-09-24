---
icon: Lightbulb
title: 为什么是 Pluxel？
description: 从 Koishi 与 Cordis 的实践出发，理解 Pluxel 对依赖身份、Context、生命周期和构建语义的选择。
---

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) 插件思想的一次再诠释。我们延续 Context、依赖注入和资源随插件回收的模型，希望把业务依赖的声明、类型和运行时身份进一步连接起来：开发者写下导入和构造函数参数，构建工具记录依赖关系，运行时据此管理启动、替换与清理。

需要判断是否采用 Pluxel 时读本页；开始开发直接进入[快速开始](./getting-started/index.md)。

## 从 Koishi Plugin 实践出发

我们从 2023 年开始编写 [Koishi](https://github.com/koishijs/koishi) 插件。Koishi 的插件运行时建立在 Cordis 之上；本文引用的 `@koishijs/core` 提交明确依赖 [Cordis 3.18.1](https://github.com/koishijs/koishi/blob/fb6e2c092242c0387f07f36e21082d5715c48449/packages/core/package.json#L36-L42)。Pluxel 对依赖模型的思考，来自持续编写、组合、替换插件和处理其资源生命周期的经验。

Cordis 的应用也已超出 Koishi 生态。DeepSeek 官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) 将其 “everything is a plugin” 架构标记为 [powered by Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md#L1-L9)，并在仓库中维护和发布 [Cordis 4.0.1](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vendor/cordis/package.json#L1-L12)。这些实践说明了插件模型可以服务于不同类型的应用。

下面的代码与类型对比以链接中固定提交的 **Cordis v3** 为依据。DeepSeek Harness 的采用是模型背景，不作为推断 Cordis v4 实现细节的依据。

## 从 Cordis 学到的 Plugin 模型

Cordis 把功能组织成具有 Context 和生命周期的插件，这给应用组合提供了几个重要基础：

- **插件是能力与副作用的边界。** 一个功能可以连同它的监听器、定时器和其他资源一起装载、卸载。
- **Context 关联调用者与资源所有者。** 共享服务处理调用时，需要知道注册和清理属于哪个插件。
- **依赖可用性参与生命周期。** 必需服务尚未出现时等待，服务变化时卸载并按条件重新加载插件。
- **scope 和 effect 管理清理。** 资源跟随所属作用域释放，动态替换不必重启整个应用。

Pluxel 保留了这些判断。我们进一步关注的问题是：同一条业务依赖，如何在编辑器、构建产物和运行时中保持可追溯的关联？

## Cordis 如何连接类型与运行时

理解差异，需要分清 Cordis 中两个配合工作的部分：TypeScript 为 Context 提供类型，运行时根据服务名称和依赖声明决定插件何时可用。

### Declaration merging 提供 Context 类型

Cordis v3 的 service package 通过 module augmentation 扩展 `Context`。以 timer package 为例，下面保留类型扩展与服务注册，省略具体计时器实现：

```ts
import { Context, Service } from '@cordisjs/core'

declare module '@cordisjs/core' {
	interface Context {
		timer: TimerService
		setTimeout(callback: () => void, delay: number): () => void
	}
}

export class TimerService extends Service {
	constructor(ctx: Context) {
		super(ctx, 'timer')
		ctx.mixin('timer', ['setTimeout'])
	}

	// setTimeout 的具体实现见下方源码链接。
}
```

当包含这些声明的 package 进入 TypeScript program 后，`timer` 和 `setTimeout` 会合并进 `Context` interface，编辑器因而能检查 `ctx.timer` 和 `ctx.setTimeout()` 的使用。完整实现见 [timer package 源码](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/timer/src/index.ts#L1-L35)。

`declare module` 建立静态类型表面；服务是否已经注册、当前是否可用、何时释放，则由 Cordis runtime 处理。类型中存在某个属性，与当前插件可以使用该服务，是需要分别表达的两件事。

### 一个名称连接注册、依赖和访问

以 `database` 服务为例，下面三个片段分别位于 provider 和 consumer 中：

```ts
// provider：以 database 名称注册服务
super(ctx, 'database')

// consumer：声明自己依赖 database 服务
export const inject = ['database']

// consumer：通过 Context 使用服务
ctx.database.get(table, id)
```

`database` 同时连接服务注册、依赖 metadata 和 Context 属性。Cordis 的 [Service 文档](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/README.md#L380-L407) 明确约定：必需服务为真值时插件才加载；服务变化时插件卸载；新值仍可用时插件重新加载。依赖可用性和动态生命周期已经是这套模型的一部分。

类型扩展可以检查 `ctx.database` 的属性访问，却不会自动生成或同步 `inject: ['database']`。对应源码中的 [`Inject`](https://github.com/cordiverse/cordis/blob/f8f10ec6734ebb4558addeba0f6a25294684d494/packages/core/src/registry.ts#L10-L43) 类型为 `string[] | Dict<Inject.Meta>`。如果 consumer 改用另一个已声明的 Context 属性，还需要同时维护依赖 metadata。

这种按名称连接的模型保留了运行时绑定的灵活性：consumer 可以声明所需的服务名称，而不必通过值导入绑定提供该服务的具体插件。常量、lint 或封装可以帮助维护名称的一致性；在上面的基础写法中，这几个位置仍是分别声明的。

## Pluxel 为什么选择另一种依赖表达

在长期维护多个插件包时，我们希望构建工具能够沿源码回答：这个参数依赖哪个包的哪个插件导出？声明的依赖是否就是代码正在使用的依赖？这个身份能否继续用于配置、日志、替换和发行检查？

这对应三个具体问题：

1. **声明与使用需要一起维护。** 独立的依赖名称列表和属性访问容易在修改时不同步，尤其是两边各自仍满足 TypeScript 类型检查时。
2. **服务名称没有直接表达来源。** 名称能够参与运行时查找，但它本身不包含包根入口、具名导出或构建时记录的来源关系。
3. **一部分错误希望提前发现。** 服务是否存在仍需运行时判断；可追溯的导入、参数与包边界错误，则可以交给构建阶段检查。

Pluxel 因此把必需插件依赖写在构造函数中：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { AccountsPlugin } from '@acme/accounts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}
}
```

构建工具在 TypeScript 擦除类型之前，记录 `AccountsPlugin` 的值导入来源及构造函数参数位置。包根入口与具名导出确定插件定义，参数声明确定依赖边；运行时根据这些 metadata 注入当前的 provider 实例。

业务插件不再另写一份 `inject` 列表，也不通过扩展 Context 属性注册自己。构造函数依赖的具体规则见[插件依赖与生命周期](./getting-started/plugin-model.md)。

### 两种选择的区别

| 比较点                 | Cordis v3 的上述 service 写法    | Pluxel 的必需插件依赖                        |
| ---------------------- | -------------------------------- | -------------------------------------------- |
| consumer 如何声明依赖  | `inject` 中的服务名称            | 构造函数中的插件参数与值导入                 |
| consumer 如何访问能力  | 对应的 Context 属性              | 注入的插件实例                               |
| 类型从哪里来           | Context 的类型扩展和服务类型     | 导入的插件类型与构造函数签名                 |
| 依赖关系如何进入运行时 | 运行时读取名称与依赖 metadata    | 构建工具从源码生成依赖 metadata              |
| provider 变化时怎么办  | 依赖服务变化驱动卸载和重新加载   | 依赖图与插件实例生命周期驱动替换、重启和清理 |
| 主要取舍               | 保留按名称进行运行时绑定的灵活性 | 以源码和构建约束换取可追溯的依赖身份         |

两者都提供类型支持，也都处理动态生命周期。Pluxel 增加的约束服务于源码、构建与运行时身份的一致性；这些检查也不能替代实际启动、业务校验或运行时的依赖可用性判断。

## 能力与所有权

| 需求         | 标准表达                              | 生命周期                                     |
| ------------ | ------------------------------------- | -------------------------------------------- |
| 必需业务能力 | constructor + 值导入                  | provider 变化驱动依赖图更新                  |
| 可选业务集成 | `definePluginRef()` + `plugins.use()` | 不安装 provider；其运行代变化时重启 consumer |
| 宿主设施     | root 创建前安装 Context services      | 宿主准备与关闭，访问绑定 caller/owner        |
| 内部组成     | 函数、effects scope 或 PluginPart     | 跟随所属 Plugin generation                   |
| 管理界面     | 可选 Workbench publication            | 每次打开创建 API；关闭或 owner 退出后释放    |

一次启动产生一个 generation。旧实例和缓存 handle 在停止或 replacement 后如何失效，是公开契约的一部分；不能仅按 class name 判断可用性。

Context 与本地依赖视图使用固定 owner 的对象或预编译成员，避免在并发异步调用间改写全局“当前调用者”。远程 Workbench 使用 Cap’n Web 的 RPC 对象模型；网络引用与本地资源仍各有明确 owner。
这些实现选择服务于可追溯、可撤回的调用，不构成比其他框架更快的承诺；目前没有与 Cordis 同场、同语义的性能对照。

## 源码也是契约

构造器 import 提供依赖，包根 named export 提供身份，Valibot schema 提供配置类型、默认值和校验。
Vite/Rolldown 在类型擦除前提取这些事实，runtime 依此启动、替换与清理；[inspect](./development/inspection.md) 复用同一语义来定位修改位置。
普通 TypeScript 擦除无法代替这条工具链。

同一份应用声明可冻结为发行物，也可通过显式动态来源扩展 catalog。业务 Plugin 的依赖、配置与生命周期模型保持一致；开发期的真实状态通过[devconsole](./development/dev-console.md)读取。

## 选择与代价

这些能力建立在明确的约束之上：

- 插件源码必须经过 Pluxel 的 Vite/Rolldown 处理，保留构建所需的依赖与资源信息。
- 可发布插件必须来自可追溯的包根具名导出；无法确定稳定来源的动态写法会被构建工具拒绝。
- 插件作者需要遵循依赖图和 generation 生命周期：长期资源登记清理，旧实例退出后不继续复用其句柄。
- 应用显式选择插件清单和宿主能力，并承担它们的组合与交付配置。

这些限制适合需要长期维护插件组合、配置、热更新、可审计发行和资源回收的应用。它们也减少了一部分开放字符串注册和任意动态装配的自由度。是否值得采用，取决于应用是否需要这套可追溯的依赖与生命周期模型。

要实际体验，可以用[快速开始](./getting-started/index.md)创建已配置好工具链的项目；要继续理解作者模型，阅读[插件依赖与生命周期](./getting-started/plugin-model.md)。框架实现和约束的索引在[工程文档](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)。
