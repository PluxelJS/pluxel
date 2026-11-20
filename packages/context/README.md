# @pluxel/context

`@pluxel/context` 是同步、固定服务集合、严格惰性的 Context 内核。Host 在创建 root 前安装服务，所有读取统一使用 `ctx.service()`。

```ts
import { createContextHost, installRootService, installScopeService } from '@pluxel/context'

abstract class Clock {
	static readonly access = 'root'
	abstract now(): number
}
abstract class Cache {
	abstract readonly entries: Map<string, unknown>
}
const host = createContextHost({
	name: 'app',
	services: [
		installRootService(Clock, { create: () => ({ now: () => Date.now() }) }),
		installScopeService(Cache, { create: () => ({ entries: new Map() }) }),
	],
})
const root = host.createRoot()
const request = host.createScope(root, 'request')
console.log(root.service(Clock).now())
request.service(Cache).entries.set('answer', 42)
```

服务 class 是声明，读取不会执行其 constructor。实例完全由已安装工厂提供；缺少必需声明时明确抛错。Pluxel 的 `defineServiceRef<T>()` 经语义编译生成可选引用，`ctx.service(ref)` 仅在未安装时返回 `undefined`，访问与构造错误仍抛出。

- root 安装每个 root 缓存一个值，普通 owner 不能直接读取；
- scope 安装与其 children 共享一个值；
- owner-view 安装共享 root backing，每个 Context 缓存自己的视图；
- 创建 Host/root/scope/child 不运行工厂，首次读取才创建；
- 服务集合与访问范围在编译安装计划时固定，Host 创建前可显式替换实现；
- Context 内核不拥有 IO 或资源生命周期，Host 与 Plugin 的 effects 负责释放。

包不依赖 Core、Host 或编译器。独立 Context 使用 class 的对象身份；Pluxel 编译器与 Host 在同一解析链上绑定规范服务身份。完整用法见[组合 Context host](../../docs/reference/context-hosts.md)，实现取舍见 [DESIGN.md](./DESIGN.md)。
