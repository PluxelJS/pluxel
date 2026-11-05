---
title: 多级缓存服务（Cache）
description: 插件级自动隔离的多级缓存，支持进程内热点缓存、后端持久存储、自动请求合并与单飞防击穿。
---

`@pluxel/plugin-cache` 提供了开箱即用的多级缓存抽象。在插件中注入 `Cache` 服务后，系统会自动根据插件身份隔离缓存 Key，防止不同业务插件之间的缓存冲突，并内置了并发合并（Singleflight）防止缓存击穿。

## 核心特性

- **插件级自动命名空间**：默认将 Key 限制在当前插件的命名空间内，无需手动添加前缀；
- **多级存储架构**：本地极速内存缓存（Local L1）+ 集中式共享存储（Redis L2）；
- **请求并发合并**：高并发下对同一 Key 的未命中读取，只触发一次真实的 Loader 查询；
- **装饰器支持**：提供 `@Cached` 装饰器，一键为异步方法添加透明缓存。

## 基础用法：getOrLoad

```ts
import { Cache } from '@pluxel/plugin-cache'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ProductPlugin extends BasePlugin {
	constructor(private readonly cache: Cache) {
		super()
	}

	async getProduct(productId: string) {
		// 先查缓存，未命中时执行 loader 并自动回填缓存
		return this.cache.getOrLoad(`product:${productId}`, async () => {
			return this.fetchFromDatabase(productId)
		}, { ttlMs: 60_000 })
	}

	async evictProduct(productId: string) {
		// 主动失效指定缓存
		await this.cache.delete(`product:${productId}`)
	}
}
```

## 使用 `@Cached` 装饰器

对于简单的只读方法，可以直接使用方法装饰器：

```ts
import { Cached } from '@pluxel/plugin-cache'

export class UserService extends BasePlugin {
	@Cached({ ttlMs: 300_000 })
	async getUserProfile(userId: string) {
		return fetchRemoteUserProfile(userId)
	}
}
```
