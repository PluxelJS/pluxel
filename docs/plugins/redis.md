---
title: Redis
description: 直接使用 Redis、定义类型安全的 Lua 脚本，或为 Cache 与 Rates 提供后端。
---

> `@pluxel/redis` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/redis` 提供三层能力：

1. 原始 Redis 能力 `Redis` 和默认的单机实现 `RedisPlugin`；
2. 用于定义类型安全 Lua 脚本的 `defineRedisScript()` 与 `redis.scripts`；
3. 面向 Cache 和 Rates 的两个适配器 `RedisCacheBackendPlugin`、`RedisRatesBackendPlugin`。

三层能力面向不同需求。业务确实需要 Redis 命令、事务、Stream 或 Pub/Sub 时依赖 `Redis`；只需要缓存或请求准入控制时，应依赖对应的抽象能力，不要让 Redis 进入业务 API。

## 直接使用 Redis

```ts twoslash
import { Redis } from '@pluxel/redis'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Queue' })
export class QueuePlugin extends BasePlugin {
	constructor(private readonly redis: Redis) {
		super()
	}

	push(value: string): Promise<number> {
		return this.redis.client.lPush('queue:jobs', value)
	}
}
```

host 安装默认 provider：

```ts no-twoslash
import { RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, QueuePlugin])
host.cfg(RedisPlugin).set({
	url: 'redis://127.0.0.1:6379',
	database: 0,
	connectTimeoutMs: 10_000,
	commandQueueMaxLength: 10_000,
	disableOfflineQueue: true,
	pingIntervalMs: 0,
})
```

`Redis.client` 的公开类型是 node-redis 的 standalone、Cluster 或 Sentinel client union。这个 capability 是 raw server access，不自动添加 caller prefix；key、channel、consumer group 和 stream 的 namespace 都是 consumer 自己定义的业务 contract。

## 默认 provider 的边界

默认 `RedisPlugin` 只创建 credential-free standalone 连接：

- `url` 只能是没有 username、password、database path、query 或 hash 的 `redis://` / `rediss://` URL；
- database 通过独立的非负整数 `database` 配置；
- client name 自动使用 `pluxel:<Plugin node reference>`，例如 `pluxel:package:@acme/orders::OrdersPlugin`；
- initial connect 超时或失败会让 lifecycle 失败，并抛 `RedisConnectionError`；
- provider 未运行或已停止时读取 `client` 抛 `RedisNotRunningError`；
- stop、replacement、rollback 和 shutdown 会关闭或销毁连接。

`disableOfflineQueue` 默认为 `true`，让断线期间的 command 快速失败；`commandQueueMaxLength` 为 node-redis command queue 设置上限；`pingIntervalMs: 0` 表示不启用周期 PING。

认证、Sentinel、Cluster、自定义 TLS 或云平台 binding 不应把 secret 塞进普通 config。host 可以提供另一个 `Redis` implementation，并通过 Vault 或平台 secret binding 管理 client：

```ts no-twoslash
import { Redis, type RedisClient } from '@pluxel/redis'
import { Plugin } from '@pluxel/runtime'

@Plugin(Redis)
export class PlatformRedisPlugin extends Redis {
	get client(): RedisClient {
		return this.platformClient
	}

	private get platformClient(): RedisClient {
		throw new Error('Provided by the platform integration')
	}
}
```

custom provider 必须自己把连接清理注册到 lifecycle。consumer 和下面两个 backend adapter 不需要因此改变。

## Typed Lua scripts

需要原子组合多个 Redis command 时，用 `defineRedisScript()` 把 keys、arguments 和返回值绑定成一个 definition：

```ts no-twoslash
import { defineRedisScript } from '@pluxel/redis'

const Increment = defineRedisScript<readonly [string], readonly [string], number>({
	name: 'counter.increment',
	numberOfKeys: 1,
	source: `return redis.call('INCRBY', KEYS[1], ARGV[1])`,
	decode(reply) {
		const value = Number(reply)
		if (!Number.isSafeInteger(value)) throw new TypeError('Expected an integer')
		return value
	},
})

const increment = this.redis.scripts.use(Increment)
const next = await increment({ keys: ['counter'], arguments: ['2'] })
```

definition 在声明时被 trim/校验、计算 source SHA-1 并冻结。`numberOfKeys` 可选；设置后 runner 会在发请求前校验 key 数量。`arguments` 可省略，等价于空数组。

runner 先调用 `EVALSHA`，只在收到 `NOSCRIPT` 时自动回退 `EVAL`。因此 Redis restart、failover 或 `SCRIPT FLUSH` 后不需要重新注册。`redis.scripts.use(definition)` 对同一 owner 和同一 definition 返回稳定 runner；一次性调用也可使用：

```ts no-twoslash
const value = await this.redis.scripts.run(Increment, {
	keys: ['counter'],
	arguments: ['1'],
})
```

`readOnly: true` 会切换为 Redis 7+ 的 `EVALSHA_RO` / `EVAL_RO`。decode 失败会被包装为 `RedisScriptDecodeError`，原始异常保留在 `cause`；Redis command 自身的异常则原样 reject。

## 多连接与 fork

`Redis` 继承 `ForkablePlugin`。同一 host 需要 cache、queue、session 等独立连接时，创建 Redis provider fork，为每个 fork 配置 endpoint/database，再用 dependency override 选择依赖。不要在 `Redis` API 上增加一个可变的 connection name，也不要让 consumer 自己维护全局 client registry。

## 作为 Cache backend

```ts no-twoslash
import { CachePlugin } from '@pluxel/cache'
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, AccountsPlugin])
host.cfg(RedisCacheBackendPlugin).set({
	keyPrefix: 'pluxel:cache:',
	scanCount: 200,
	deleteBatchSize: 200,
})
```

业务插件依赖 `Cache`，而不是 `Redis`。adapter 的关键行为是：

- 用 Lua 原子读取 value 与 PTTL；`undefined` 只表示 miss，`null` 是合法 value；
- `ttlMs: 0` 表示无 expiry，正值使用 Redis `PX`；
- 以版本头和 Node `v8.serialize()` 编码 structured value，支持 BigInt、Date、Buffer、Map/Set；
- `clear(prefix)` 使用 cursor `SCAN` 和有界 `UNLINK`，并正确转义 glob 元字符；
- Cluster 会逐个 master 扫描，并逐 key unlink 以避免 CROSSSLOT；
- single-flight、scope 与 caller owner envelope 仍由 `CachePlugin` 负责。

`keyPrefix` 只是 Redis keyspace 隔离，不是 cache scope。它必须是 well-formed Unicode。

## 作为 Rates backend

```ts no-twoslash
import { RatesPlugin } from '@pluxel/rates'
import { RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisRatesBackendPlugin, RatesPlugin, MessagingPlugin])
host.cfg(RedisRatesBackendPlugin).set({ keyPrefix: 'pluxel:rates:' })
```

adapter 为四种 Rates algorithm 分别使用静态、单 key Lua script。它读取 Redis `TIME`，在一次调用内校验完整 resolved policy、owner address、状态格式并更新 TTL。物理 key 使用 canonical request 的 SHA-256 digest，不暴露 raw identity；policy 不参与 key，因此同一 identity 的 policy 冲突可被检测。

Rates keyspace 必须由 adapter 独占，不能由其他 writer 修改。多个实例共享 Redis 后会得到同一个原子判定；这正是它与进程内 memory backend 的主要区别。

## 运行时失败原则

连接建立失败属于 lifecycle failure，required dependents 会被阻塞。调用期间的 node-redis command error、script error 或 adapter error 属于调用事实，应保留 error/cause，让 consumer 或上层 transport 明确选择重试、降级或失败；不要吞掉 Redis error 后报告成功。
