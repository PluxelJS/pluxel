---
title: 组合 Context host
description: 使用 @pluxel/context 组合固定、严格惰性的服务与作用域。
---

`@pluxel/context` 是同步、宿主中立的 Context 内核，负责固定服务集合、访问权限与作用域缓存。普通 Pluxel 插件直接使用宿主提供的 Context；应用安装服务见 [Host 服务](../host/services.md)。

## 安装与引入

```sh
vp add @pluxel/context
```

## 声明与组合

服务使用普通 class 或 abstract class 作为声明。声明本身表达类型，安装器决定实现及缓存范围；不需要继承框架基类，也不需要手写字符串标识。

```ts
import {
	createContextHost,
	installOwnerViewService,
	installRootService,
	installScopeService,
	type Context,
} from '@pluxel/context'

class Clock {
	now() {
		return Date.now()
	}
}

abstract class Cache {}
interface Cache extends Map<string, unknown> {}

abstract class OwnerActions {
	abstract readonly owner: Context
	abstract publish(name: string): void
}

const services = [
	installRootService(Clock, { create: () => new Clock() }),
	installScopeService(Cache, { create: () => new Map<string, unknown>() }),
	installOwnerViewService(OwnerActions, {
		createRoot: () => new Set<string>(),
		createView: (catalog, owner) => ({
			owner,
			publish(name) {
				catalog.add(`${owner.name}:${name}`)
			},
		}),
	}),
] as const

const appContextHost = createContextHost({ name: 'example', services })
const root = appContextHost.createRoot('app')
const request = appContextHost.createScope(root, 'request:42')
const handler = appContextHost.createChild(request, 'handler')

console.log(root.service(Clock).now())
console.assert(request.service(Cache) === handler.service(Cache))
console.assert(handler.service(OwnerActions).owner === handler)
```

`ctx.service(Declaration)` 返回服务本身。服务缺失、访问被拒绝或工厂构造失败都会抛出错误。Context 不增加服务属性，服务集合在创建 host 时固定。

## 缓存范围与访问权限

| 安装器                    | 缓存与归属                                         |
| ------------------------- | -------------------------------------------------- |
| `installRootService`      | 每个 root 一份，只能由真实 root 直接读取           |
| `installScopeService`     | 每个 scope 一份，同 scope 的 child 共享            |
| `installOwnerViewService` | 每个 root 一份 backing，每个 Context 各自缓存 view |

`root` 安装始终要求真实根 Context；子 Context 可显式使用 `ctx.root.service(...)`。需要让所有持有者直接读取同一 backing 时，使用 `owner-view` 并返回共享值。其他安装的访问权限通过声明与安装器约束。声明可设置 `static readonly access = 'root' as const` 或 `'owner' as const`；省略时为 `'all'`。安装器的 `access` 校验实际访问权限。`owner` 适用于非根 Context，在 Core 中对应 Plugin 与 Part；`root` 只允许真实根 Context。

在 Pluxel 中，Plugin generation 对应 scope，PluginPart 对应 child，caller facade 保留 provider generation 的 backing 并绑定独立的调用方。服务不会因此生成插件节点，也没有 fork、独立启停或依赖图状态。

## 严格惰性初始化

创建 host、root、scope 或 child 都不会调用服务工厂。首次调用 `ctx.service()` 时才同步构造，成功值按安装范围缓存；工厂不得返回 `undefined`，构造失败不会伪装成缺失。内核不接管 IO prepare/dispose，上层宿主负责资源获取与释放。

测试可在创建 host 时用 `overrides` 替换已经声明的服务实现：

```ts
const testContextHost = createContextHost({
	name: 'example-test',
	services,
	overrides: [installRootService(Clock, { create: () => ({ now: () => 1700000000000 }) })],
})
```

override 必须匹配已有服务的声明、安装范围与访问权限。编译后的集合不可扩展。

## Pluxel 中的可选引用

Pluxel 源码工具链提供 `defineServiceRef<T>()`，从导入的服务声明生成可选引用：

```ts
import { defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'

const WorkbenchRef = defineServiceRef<Workbench>()
```

`ctx.service(WorkbenchRef)` 返回 `Workbench | undefined`，只有未安装时返回 `undefined`。访问拒绝、工厂失败及声明契约错误仍然抛出。可选引用与直接导入的声明使用同一服务身份，不创建另一份定义。编译与远端脚本的生成材料见 [Agent SDK](../development/agent-sdk.md)。
