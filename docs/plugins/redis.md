---
title: Redis 客户端与数据服务
description: 访问多连接 Redis 连接池、执行类型安全的 Lua 脚本，并为缓存与限流提供分布式后端支撑。
---

`@pluxel/plugin-redis` 提供具名 Redis 连接目录和原生 node-redis client，并为 `@pluxel/plugin-cache` 与 `@pluxel/plugin-rates` 提供 Redis 后端。

## 连接目录与生命周期

`RedisPlugin` 的 `connections` 配置包含 1–64 个唯一 ID。初始化并行连接各项，任一连接失败会使整个 provider 初始化失败，并清理已取得资源。`connectionIds()` 返回当前目录；业务通过 `connection('queue')` 显式选择，省略参数等同于选择 `default`，没有对应项时抛出 `RedisConnectionNotFoundError`。

连接由 provider 创建和关闭，consumer 借用连接 handle。consumer 或 provider 停止后，旧 handle 的 `client` 访问和 `scripts` 调用抛出 `RedisNotRunningError`；consumer 不应调用共享 client 的 `close()` 或 `destroy()`。已取出的原生 client 保留 SDK 自身行为，调用方应让使用它的工作随自身生命周期结束。

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

通过 `defineRedisScript()` 声明 Lua 源码、keys、arguments 和返回值类型，再由连接的 `scripts` 执行：

```ts
import { defineRedisScript, type Redis } from '@pluxel/plugin-redis'

const increment = defineRedisScript<readonly [string], readonly [string], number>({
	name: 'increment',
	numberOfKeys: 1,
	source: "return redis.call('INCRBY', KEYS[1], ARGV[1])",
	decode: Number,
})

export function incrementCounter(redis: Redis, key: string, amount: number): Promise<number> {
	return redis.connection().scripts.run(increment, {
		keys: [key],
		arguments: [String(amount)],
	})
}
```

必需的 arguments tuple 必须在调用时提供；允许空数组的参数类型可以省略 `arguments`。`scripts.use(definition)` 返回保留相同类型的缓存 runner。执行先调用 `EVALSHA`，仅在 Redis 返回 `NOSCRIPT` 时回退 `EVAL`；其他 Redis 错误原样抛出，`decode` 失败则抛出带 cause 的 `RedisScriptDecodeError`。调用方按业务处理这些失败，连接的生命周期仍由 Redis provider 管理。
