# @pluxel/context

`@pluxel/context` 是同步、immutable、strict-lazy 的 Context host kernel。它让 standalone application 或 framework host 在
创建 root 前组合固定能力，并用 root、scope 与 owner-view 表达共享和所有权；本包不依赖 `@pluxel/core` 或
`@pluxel/runtime`。

```ts
import {
	createContextHost,
	defineContextCapability,
	installRootCapability,
	installScopeCapability,
} from '@pluxel/context'

const clockCapability = defineContextCapability<{ now(): number }>('app.clock')
const cacheCapability = defineContextCapability<Map<string, unknown>>('app.cache')

const host = createContextHost({
	name: 'app',
	capabilities: [
		installRootCapability(clockCapability, {
			property: 'clock',
			create: () => ({ now: () => Date.now() }),
		}),
		installScopeCapability(cacheCapability, {
			property: 'cache',
			create: () => new Map(),
		}),
	],
})

const root = host.createRoot()
const request = host.createScope(root, 'request')
const handler = host.createChild(request, 'handler')

void root.clock.now()
void handler.cache
```

关键边界：

- 创建 host/root/scope/child 不运行 factory；第一次属性读取或 `resolveContextCapability()` 才构造并按 scope 缓存；
- root 每个 root 一份，scope 与其 children 共享一份，owner-view 使用 root backing 并为每个 Context 缓存独立 view；
- `overrides` 只在 host 编译前替换基础集合中的同一 descriptor，且必须保持 scope/property；
- host 编译后没有 install/mutate API；
- `ContextHost` 没有 `prepare()`、`dispose()` 或资源协议，启动和清理由上层 host 明确拥有；
- Pluxel Plugin 不能借助本包修改已经创建的 Runtime Context，Plugin 业务依赖仍进入 Plugin graph。

公开入口：

- `@pluxel/context`：descriptor、scoped installation、Context host、projection types 与显式 resolve；
- `@pluxel/context/internal`：供 Pluxel framework packages 使用的 raw plan/context construction，不是稳定第三方 API。

完整用法与作用域选择见[组合 Context host](../../docs/reference/context-hosts.md)。
