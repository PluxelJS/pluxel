---
title: 插件依赖与组成
description: 掌握 Pluxel 中的必需依赖、可选集成、拓扑关系与生命周期行为。
---

在复杂的应用中，一个功能模块往往需要与其他模块协作。Pluxel 提供了声明式的依赖管理机制：框架根据构造函数参数与显式引用构建依赖拓扑图，自动安排启动顺序、注入实例，并在依赖项更新或卸载时协调下游状态。

## 三种组成关系

根据模块是否需要独立分发、启停或注入，可分为以下三种组成方式：

| 组成方式                 | 适用场景                                                   | 声明方式                                      |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| **必需依赖（Required）** | 缺少提供方功能便无法运行                                   | 构造函数参数 + 强类型值导入                   |
| **可选依赖（Optional）** | 提供方缺席时仍可工作；提供方就绪或重启时自动接入           | `definePluginRef<T>()` + `this.plugins.use()` |
| **子部件（PluginPart）** | 属于当前插件的内部实现，需要独立配置或资源，但随父插件启停 | `this.parts.use(MyPart)`                      |

<span id="required-dependency"></span>

## 必需依赖（Required Dependency）

如果一个插件离开另一个插件就无法完成自身核心业务，请通过构造函数声明必需依赖。提供能力的插件称为**提供方（Provider）**，发起调用的插件称为**消费方（Consumer）**。

在消费方中直接值导入提供方插件的类，并作为构造函数参数声明：

```ts twoslash
// @filename: accounts.ts
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Accounts' })
export class AccountsPlugin extends BasePlugin {
	listInvoices(): readonly string[] {
		return ['inv_001', 'inv_002']
	}
}

// @filename: billing.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { AccountsPlugin } from './accounts.ts'

@Plugin({ displayName: 'Billing' })
export class BillingPlugin extends BasePlugin {
	// 在构造函数参数中声明依赖，框架自动注入对应实例
	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	listInvoices() {
		return this.accounts.listInvoices()
	}
}
```

在实际多包工程中，通常从提供方包的公共入口导入：

```ts
import { AccountsPlugin } from '@acme/accounts'
```

### 启动顺序与故障传播

当宿主启动 `BillingPlugin` 时，框架会解析依赖图，确保 `AccountsPlugin` 先完成初始化并就绪。如果 `AccountsPlugin` 启动失败，`BillingPlugin` 将处于被阻塞（Blocked）状态，等待上游修复；但与它们无关的其他独立插件仍会正常启动。

### 代理视图机制与写法限制

框架注入到消费方构造函数中的不是裸实例，而是绑定了调用方上下文与生命周期版本的**代理视图（Facade）**。当提供方被热重载或重启时，旧的代理视图会自动失效，防止下游消费方继续向已卸载的旧实例发起调用。

为了保证代理视图能够稳定转发调用并保持上下文感知，请遵守以下写法规范：

> [!NOTE]
> **语法限制**
>
> 1. **使用 TypeScript `private` 代替 JS `#private`**：代理视图无法穿透原生 JavaScript 私有字段（`#field`），构建工具会拦截并报错 `plugin_caller_view_private_brand_unsupported`。请使用常规的 `private` 关键字修饰内部状态。
> 2. **对外暴露的方法请声明为原型方法**：对外提供调用的方法请直接写为标准的类方法（`method() {}`）。不要使用箭头函数字段（如 `handler = () => {}`）或在属性上使用 `.bind(this)`，这类属性会直接捕获原始实例导致调用方上下文丢失，构建工具会提示 `plugin_caller_view_callable_field_unsupported`。
> 3. **显式声明公开字段**：公开属性请在类定义中声明并赋初值，不要只使用 `declare field` 占位或在运行时动态挂载字段。

## 可选依赖（Optional Integration）

当某项依赖只是作为增强能力（例如：有审计插件时记录日志，没有时正常处理业务），可使用可选依赖。此时即使提供方未安装或未启动，消费方也能独立运行。

### 声明可选依赖

声明可选依赖时，使用 `import type` 导入提供方的类型，并通过 `definePluginRef<T>()` 定义一个模块级引用：

```ts twoslash
// @filename: audit.ts
import { BasePlugin } from '@pluxel/core'

export declare class AuditPlugin extends BasePlugin {
	registerSource(source: BasePlugin): () => void
}

// @filename: orders.ts
import type { AuditPlugin } from './audit.ts'
import { BasePlugin, definePluginRef, Plugin } from '@pluxel/core'

// 1. 声明模块级引用（不产生对提供方运行时的硬导入）
const Audit = definePluginRef<AuditPlugin>()

@Plugin({ displayName: 'Orders' })
export class OrdersPlugin extends BasePlugin {
	protected override init() {
		// 2. 在 init 中消费可选插件：仅在 Audit 存在且已启动时执行回调
		this.plugins.use(Audit, (audit) => {
			const unregister = audit.registerSource(this)
			// 返回释放函数，当 Audit 卸载或 Orders 自身重载时自动注销
			return unregister
		})
	}
}
```

### 可选依赖对生命周期的影响

1. **按需激活**：若 `AuditPlugin` 不存在、未加入启动列表或启动失败，`this.plugins.use()` 的回调函数将不会执行，但 `OrdersPlugin` 仍会正常初始化并提供服务。
2. **动态重启**：当 `AuditPlugin` 后来被动态启动、热替换或停止时，Core 会自动重新初始化 `OrdersPlugin` 及其下游依赖，让可选接入始终绑定最新实例，避免持有过期引用。
3. **独立错误处理**：`plugins.use()` 的同步回调函数在 `init()` 内部执行；如果在回调中主动抛出异常，`OrdersPlugin` 自身会被判定为初始化失败。

## 架构选型与组合模式

针对不同的模块协作场景，可以灵活选择依赖方向：

- **基础调用**：消费方直接必需依赖提供方（例如订单依赖账户服务）。
- **聚合多个数据源**：聚合插件可选依赖各个具体数据源（例如指标监控插件可选依赖 CPU、内存与磁盘采样插件），在 `init()` 中通过多次 `plugins.use()` 收集可用源。
- **解耦桥接**：当系统已存在 `OrdersPlugin` 与 `AuditPlugin` 且双方互不知晓时，可编写一个独立的桥接插件 `OrdersAuditBridgePlugin`，在它的构造函数中同时必需依赖双方，负责将订单事件接入审计服务中。这样双方的基础功能都不需要增加对方的代码。

## 使用 PluginPart 组织内部结构

如果插件内部逻辑较多（如包含独立的缓存管理、心跳探活与配置解析），但不适合拆分成全局独立的插件，可以使用 `PluginPart`。

`PluginPart` 拥有自己的生命周期 `init()` 和独立的局部配置，并由所属插件通过 `this.parts.use(CachePart)` 声明所有权。它随所属插件一同启停，不会在全局依赖图中生成多余的插件节点。详细用法请参阅 [PluginPart 指南](./parts.md)。

## 插件身份与地址

在日志、配置持久化与跨进程通信中，插件拥有确定的身份定位：

- **定义地址（Definition Address）**：由包名（或源码路径）与导出的类名唯一确定（如 `@acme/billing::BillingPlugin`）。
- **节点地址（Node Address）**：区分默认实例与多实例分叉（Fork）。如果一个插件支持多实例并配置了 `@Plugin({ forkable: true })`，它的不同分叉拥有独立的节点地址（例如 `...#fork=east`），各自管理独立的配置与运行生命周期。
