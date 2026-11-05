---
icon: Lightbulb
title: 为什么是 Pluxel？
description: 从 Koishi 与 Cordis 的实践出发，理解 Pluxel 对依赖身份、Context、生命周期和构建语义的选择。
---

Pluxel 是对 [Cordis v3](https://github.com/cordiverse/cordis/tree/f8f10ec6734ebb4558addeba0f6a25294684d494) 插件模型的一次重新诠释。我们继承了上下文（Context）、依赖注入和资源随插件生命周期自动回收的设计，进一步探索如何将业务依赖的类型导入、构建期分析与运行时身份无缝衔接起来。

开发者只需按照 TypeScript 的直觉编写常规的 `import` 语句与构造函数参数，构建工具便能在编译阶段提取依赖关系，并由运行时统一驱动插件的启动、热替换与资源清理。

## 从插件化实践出发

编写复杂插件生态的经验表明，一个清晰的插件模型需要妥善处理以下核心问题：

- **以插件为能力与副作用的边界**：每个功能模块连同其注册的监听器、定时器、网络连接等资源，都应当具备完整的装载与卸载能力。
- **让上下文追踪资源所属方**：当共享服务接收调用时，需要清楚知晓本次操作由哪个插件发起，以便在插件卸载时及时回收相关资源。
- **依赖关系驱动生命周期**：当下游插件所依赖的上游服务发生变更或重新加载时，框架应当能自动感知并协调依赖树的平滑演进。
- **局部作用域管理资源释放**：随插件卸载自动释放关联资源，无需频繁重启整个应用进程。

Cordis v3 通过优秀的架构设计奠定了这些基石。在此基础上，Pluxel 关注的核心痛点是：**一条业务依赖关系，如何在编辑器类型提示、构建产物与运行时调用中，始终保持连贯且可追踪的一致性？**

## 类型与运行时的连接方式

为了理解设计选型上的差异，我们可以回顾 Cordis 中两个相互配合的机制：TypeScript 通过类型合并为 Context 提供提示，而运行时则根据服务名称来决定插件的可用性。

### 模块声明合并扩展 Context

在 Cordis v3 中，服务包通常通过 `declare module` 为 `Context` 接口增加属性。以计时器服务为例：

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
}
```

当包含这段声明的代码被 TypeScript 编译时，`timer` 与 `setTimeout` 就会合并进入 `Context` 接口中，开发者在编辑器中便能享受到 `ctx.timer` 的补全。这种机制在静态阶段提供了良好的开发体验，而服务何时就绪并可以使用，则由运行时根据字符串标识独立调度。

### 基于名称的运行时绑定

在消费方和服务提供方之间，通常通过字符串名称建立连接：

```ts
// 提供方：以 'database' 为标识注册服务
super(ctx, 'database')

// 消费方：声明自己需要 'database' 服务
export const inject = ['database']

// 消费方：通过 Context 访问服务
ctx.database.get(table, id)
```

这种机制保持了极高的灵活性：消费方只需知道所需服务的名称，无需直接依赖提供方的具体实现类。

在大型长期项目中，多处分散维护的字符串标识与类型定义可能会面临同步成本：消费方需要同时维护 `inject` 数组与属性调用，当消费方改用另一项服务时，也需要手动确保依赖元数据与代码保持一致。

## Pluxel 的解法：构造函数依赖注入

为了让构建工具能够在静态编译阶段直接追踪“这个参数依赖哪个包的哪个插件”，Pluxel 选择直接将必需依赖声明在构造函数中：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { AccountsPlugin } from '@acme/accounts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	checkout(orderId: string) {
		return this.accounts.processInvoice(orderId)
	}
}
```

构建流水线在 TypeScript 擦除类型之前，记录 `AccountsPlugin` 的值导入来源与其在构造函数中的参数位置。包的具名导出确定了插件的身份，参数列表则定义了依赖拓扑。应用运行时依据这些元数据，自动将就绪的提供方实例注入到构造函数中。

### 两种方式的对比

| 比较维度         | 基于服务名称的绑定            | Pluxel 构造函数依赖注入                |
| ---------------- | ----------------------------- | -------------------------------------- |
| 依赖声明方式     | `inject` 字符串数组           | 构造函数参数与普通值导入               |
| 能力访问方式     | `ctx.<serviceName>` 属性      | 构造函数注入的强类型实例               |
| 依赖类型来源     | `declare module` 扩展 Context | 导入的插件类本身及其导出类型           |
| 运行时元数据生成 | 手工编写服务名称列表          | 构建工具自动从源码提取依赖拓扑         |
| 适用倾向         | 追求弱耦合与松散组装          | 追求构建期可追溯、跨包检查与重构安全性 |

## 确定性生命周期与资源边界

在 Pluxel 中，插件的每一次实例化运行称为一个生命周期周期（Generation）。每次启动、热重载或依赖实例替换，都会创建新实例并终结旧周期。

```ts
@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	protected override init() {
		const timer = setInterval(() => this.heartbeat(), 5_000)

		// 注册清理回调，插件停止或重载时由框架自动执行
		this.ctx.effects.defer(() => clearInterval(timer))
	}
}
```

每个插件实例持有的 Context 与依赖视图均绑定了所属插件的身份。即使在复杂的异步流程中，也能清楚辨识调用来源，并且在提供方插件停止或重启后，旧的代理调用会自动失效，避免调用到已经卸载的僵尸实例。

## 适用场景与权衡

Pluxel 的设计专注于以下场景：

1. **依赖关系复杂的企业级应用**：通过强类型导入和构建期依赖图，能够在开发和 CI 阶段捕获依赖缺失与循环依赖。
2. **需要完善热重载与资源回收的应用**：长时间运行的宿主进程（如后台守护进程、开发者工作台）需要精确控制定时器、连接和事件监听的释放，避免内存泄漏。
3. **重视配置可读性与可视化管理**：单份 Valibot Schema 同时解决类型、校验、默认值与 Workbench 管理表单。

如果你需要一个完全动态、任意字符串插拔、不经过专门编译步骤即可运行的微型脚本环境，传统的服务定位器模式会更加轻巧。Pluxel 适合追求架构清晰度、构建期可验证性与长期可维护性的 TypeScript 工程。
