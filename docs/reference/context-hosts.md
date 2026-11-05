---
title: 组合 Context host
description: 使用 @pluxel/context 为 standalone host 组合固定、严格惰性的能力投影。
---

`@pluxel/context` 是一个纯同步、宿主中立的 Context 状态管理内核。它适用于需要共享根级服务、按作用域隔离状态并精确追踪持有者身份（Owner Identity）的应用与框架底层。

对于编写常规 Pluxel 业务插件的开发者，无需直接接触此包，因为宿主已经将标准的 `ctx` 上下文组合就绪。

## 安装与引入

```sh package-install
npx nypm add @pluxel/context
```

## 作用域（Scope）类型

| 作用域模式 | 实例化与生命周期 | 适用场景 |
| :--- | :--- | :--- |
| **root** | 每个 Root 实例仅构建一次，属性仅挂载在根 Context 上 | 进程级连接池、全局时钟、注册表 |
| **scope** | 每次调用 `createScope()` 时构建一次，并在所有子 Context 间共享 | 请求上下文、会话 Session、生命周期代际 |
| **owner-view** | 根级共享单个 Backing 存储，但每个子 Context 各自持有专属视图 | 需要自动绑定调用方身份的日志、事件发射器或注册句柄 |

## 组合与创建 Context Host

通过声明能力描述符（Capability Descriptor）并安装到宿主中：

```ts
import {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	type Context,
	type ContextOf,
	type RootContextOf,
} from '@pluxel/context'

type Clock = { now(): number }
type ApplicationResources = { prepare(): Promise<void>; close(): Promise<void> }
type OwnerActions = { readonly owner: Context; publish(name: string): void }

class ActionCatalog {
	forOwner(owner: Context): OwnerActions {
		return {
			owner,
			publish: (name) => console.log(owner.name, name),
		}
	}
}

// 1. 声明能力 Token
const clockCapability = defineContextCapability<Clock>('example.clock')
const resourcesCapability = defineContextCapability<ApplicationResources>('example.resources')
const cacheCapability = defineContextCapability<Map<string, unknown>>('example.cache')
const actionsCapability = defineContextCapability<OwnerActions>('example.actions')

// 2. 安装能力实现
const capabilities = [
	installRootCapability(clockCapability, {
		property: 'clock',
		create: () => ({ now: () => Date.now() }),
	}),
	installRootCapability(resourcesCapability, {
		property: 'resources',
		create: () => ({ prepare: async () => {}, close: async () => {} }),
	}),
	installScopeCapability(cacheCapability, {
		property: 'cache',
		create: () => new Map(),
	}),
	installOwnerViewCapability(actionsCapability, {
		property: 'actions',
		createRoot: () => new ActionCatalog(),
		createView: (catalog, owner) => catalog.forOwner(owner),
	}),
] as const

// 3. 构建宿主工厂
const appContextHost = createContextHost({
	name: 'example',
	capabilities,
})

type AppContext = ContextOf<typeof appContextHost>
type AppRootContext = RootContextOf<typeof appContextHost>

// 4. 派生上下文
const root: AppRootContext = appContextHost.createRoot('app')
const request: AppContext = appContextHost.createScope(root, 'request:42')
const handler = appContextHost.createChild(request, 'handler')

console.log(root.clock.now())
console.assert(request.cache === handler.cache)
console.assert(handler.actions.owner === handler)
```

## 严格惰性初始化（Strict Lazy）

- `createContextHost()` 仅编译类型拓扑，`createRoot()` 与 `createScope()` 仅分配上下文句柄，不会提前触发能力的工厂函数。
- 只有在第一次访问 Context 上的具体属性或显式调用 `require(capability)` 时，对应的初始化工厂才会被执行，初始化结果会在所属作用域内自动缓存。
- 涉及建立外部数据库连接或异步初始化的场景，应在根上下文上显式定义并调用相应的生命周期方法（如 `root.resources.prepare()`）。

## 测试中的实现覆盖（Overrides）

在编写测试宿主时，可在创建时传入 `overrides` 替换特定能力的实现（如使用固定时间的 Mock 时钟）：

```ts
const testContextHost = createContextHost({
	name: 'example-test',
	capabilities,
	overrides: [
		installRootCapability(clockCapability, {
			property: 'clock',
			create: () => ({ now: () => 1700000000000 }),
		}),
	],
})
```

所有的重写必须匹配已有能力的 Descriptor 标识与作用域规则。
