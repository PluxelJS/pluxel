---
title: 组合 Context host
description: 使用 @pluxel/context 为 standalone host 组合固定、严格惰性的能力投影。
---

`@pluxel/context` 适合需要共享 root 服务、隔离 scope 状态并保留 owner identity 的应用或框架宿主。它是一套同步、
host-neutral 的 Context kernel，不要求使用 Pluxel Plugin Runtime。

写普通 Pluxel Plugin 时不需要直接使用它：Runtime 已经组合好 `ctx`，Plugin 间的业务依赖应写进 constructor，而不是尝试
安装 Context capability。

先安装独立包：

```sh package-install
npx nypm add @pluxel/context
```

## 选择作用域

| 作用域     | 构造与共享方式                                                  | 适合                         |
| ---------- | --------------------------------------------------------------- | ---------------------------- |
| root       | 每个 root 构造一次；projected property 只出现在 root            | 进程级 registry、pool、clock |
| scope      | 每个 `createScope()` 结果构造一次，并与其 children 共享         | generation、request、session |
| owner-view | 每个 root 一个 backing；每个 root/scope/child 各自缓存一个 view | owner-bound 注册和 facade    |

`createChild(parent, name)` 建立 containment parent，并共享 parent 的 scope backing；它不会创建新 scope。owner-view 的
`createView()` 收到当前 Context，因此共享 backend 可以把注册、日志或 cleanup 归属到正确 owner。
`createView()` 应返回带 immutable owner reference 的普通 object/class；不要用 `Proxy` 动态替换共享 backend 的 `ctx`。
共享状态留在 root backing，view 只保留 owner 和调用 backing 所需的最小引用。

## 创建一个 host

下面组合进程时钟、应用资源、请求缓存和带调用者归属的操作接口。descriptor 是能力的唯一标识对象，`property` 决定 Context 上可读取的属性名：

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

const clockCapability = defineContextCapability<Clock>('example.clock')
const resourcesCapability = defineContextCapability<ApplicationResources>('example.resources')
const cacheCapability = defineContextCapability<Map<string, unknown>>('example.cache')
const actionsCapability = defineContextCapability<OwnerActions>('example.actions')

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

const appContextHost = createContextHost({
	name: 'example',
	capabilities,
})

type AppContext = ContextOf<typeof appContextHost>
type AppRootContext = RootContextOf<typeof appContextHost>

const root: AppRootContext = appContextHost.createRoot('app')
const request: AppContext = appContextHost.createScope(root, 'request:42')
const handler = appContextHost.createChild(request, 'handler')

console.log(root.clock.now())
console.assert(request.cache === handler.cache)
console.assert(handler.actions.owner === handler)
```

有 `property` 的 capability 会出现在推导出的 Context 类型上。若能力不适合成为属性，可以省略 `property`，再通过
`resolveContextCapability(ctx, descriptor)` 显式读取。

### 让应用配置保留类型提示

Context 属性类型从 `capabilities` 数组推导。应用创建参数则显式定义为自己的配置类型，解析后由 factory 使用：

```ts
interface AppHostConfig {
	clock?: { fixedNow?: number }
}

function createAppContext(config: AppHostConfig = {}) {
	const clock = Object.freeze({ fixedNow: config.clock?.fixedNow })
	return createContextHost({
		name: 'app',
		capabilities: [
			installRootCapability(clockCapability, {
				property: 'clock',
				create: () => ({ now: () => clock.fixedNow ?? Date.now() }),
			}),
		] as const,
	}).createRoot()
}
```

IDE 会分别检查 `createAppContext({ ... })` 的配置和返回 Context 的属性。不要把完整宿主配置交给每个插件；各能力只读取自己需要的配置。

## Strict lazy

`createContextHost()` 只编译 shape，`createRoot()`、`createScope()` 和 `createChild()` 只创建 Context。以上操作都不会调用
capability factory。第一次读取 projected property 或显式 resolve 时才构造值，成功结果按作用域缓存。

因此不要把“host 已创建”误认为资源已准备好。需要连接数据库、校验凭据或预热 backend 时，由拥有该资源的应用显式调用
领域方法：

```ts
const root = appContextHost.createRoot()

await root.resources.prepare()
try {
	// Start the application with the prepared root.
} finally {
	await root.resources.close()
}
```

`ContextHost` 本身没有 `prepare()`、`dispose()` 或通用异步 hook；资源启动、失败重试和关闭顺序属于上层 host，而不是
Context kernel。Pluxel Runtime 也遵循这一点：launcher 显式 prepare Runtime-owned service，root/generation effects 和
launcher `stop()` 负责清理。

## 在创建前替换实现

需要复用同一能力集合但替换 host 实现时，可以传入 `overrides`：

```ts
const testContextHost = createContextHost({
	name: 'example-test',
	capabilities,
	overrides: [
		installRootCapability(clockCapability, {
			property: 'clock',
			create: () => ({ now: () => 0 }),
		}),
	],
})
```

每个 override 必须匹配基础集合中同一个 descriptor，并保持原来的 scope 和 `property`；未知 descriptor、重复替换或 shape
变化都会在 host 编译时失败。override 不是运行时 mutator：host 创建后，其 Context shape 永久固定。

## 与 Pluxel Runtime 的边界

- standalone application/framework 可以直接安装 `@pluxel/context` 并组合自己的 host；
- `@pluxel/core` 源码复用这个 kernel，但发布的 Core JS 与 declarations 已完整内联，Core 消费者不需要额外安装它；
- static、dynamic 和 test Runtime 都由 Runtime launcher 组合固定能力；
- Plugin 不能向现有 Runtime Context 安装、替换或删除 capability；
- Plugin 间业务依赖使用 constructor 或 optional Plugin ref，不使用 Context descriptor 模拟第二张依赖图。

## 保持同一 kernel identity

`ContextCapability`、installation 和 Context 都是基于对象身份的 opaque value。组合一个 host 时，
这些值必须来自同一个 evaluated `@pluxel/context` kernel instance；不要在 ESM/CJS、两份 workspace
resolution 或 HMR host/runner 副本之间混用。

`@pluxel/core` 中内联的 kernel 与 standalone `@pluxel/context` 是有意隔离的两个 instance：它们可以在
同一进程中分别创建 host，但不能把一边创建的 descriptor、installation 或 Context 交给另一边。
跨 kernel 传值会立即失败并指向 package dedupe/HMR resolution，而不会把一份 host 的私有状态当作另一份
host 的状态。
