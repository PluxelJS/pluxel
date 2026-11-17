---
title: Redis 客户端与数据服务
description: 访问多连接 Redis 连接池、执行类型安全的 Lua 脚本，并为缓存与限流提供分布式后端支撑。
---

`@pluxel/plugin-redis` 提供了对 Redis 的全面支持。它不仅支持多连接池管理和流式操作，还为 `@pluxel/plugin-cache` 与 `@pluxel/plugin-rates` 提供了生产级分布式后端。

## 直接使用 Redis 客户端

在业务插件中注入 `Redis` 服务：

```ts twoslash
import { Redis } from '@pluxel/plugin-redis'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Queue' })
export class QueuePlugin extends BasePlugin {
	constructor(private readonly redis: Redis) {
		super()
	}

	async pushJob(jobData: string): Promise<number> {
		// 获取指定连接并调用原生 node-redis 方法
		const client = this.redis.connection('queue').client
		return client.lPush('jobs:pending', jobData)
	}

	async popJob(): Promise<string | null> {
		const client = this.redis.connection('queue').client
		return client.rPop('jobs:pending')
	}
}
```

## 执行强类型 Lua 脚本

通过 `defineScript()` 封装原子操作的 Lua 脚本：

```ts
const acquireLockScript = defineScript({
	numberOfKeys: 1,
	lua: `
		if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
			return 1
		else
			return 0
		end
	`,
})
```

脚本会自动被编译、缓存并在服务端原子执行，避免网络往返导致的并发竞争。
