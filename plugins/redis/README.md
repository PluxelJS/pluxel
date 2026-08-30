# `@pluxel/redis`

Pluxel 官方 Redis capability，同时自带 `RedisCacheBackendPlugin`、`RedisRatesBackendPlugin` 与 typed Lua script helper。Redis 原生 consumer
依赖抽象 `Redis`；host 选择默认 standalone provider、Vault-aware provider、Sentinel、Cluster 或平台 binding 实现。

```ts
import { Redis, RedisPlugin } from '@pluxel/redis'

@Plugin()
class QueuePlugin extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}

	push(value: string) {
		return this.redis.client.lPush('queue', value)
	}
}

host.add([RedisPlugin, QueuePlugin])
```

`Redis` 是 raw server capability，不自动添加 caller namespace。使用普通 Redis command、transaction、stream 或
pub/sub 的插件需要定义自己的 key/channel contract。需要 caller-aware cache/rates 时使用本包导出的对应 backend。

## 默认 standalone provider

```ts
host.cfg(RedisPlugin).set({
	url: 'redis://127.0.0.1:6379',
	database: 0,
	connectTimeoutMs: 10_000,
	commandQueueMaxLength: 10_000,
	disableOfflineQueue: true,
	pingIntervalMs: 0,
})
```

- `commandQueueMaxLength` 防止断线或高压期间积累无界 client queue；
- `disableOfflineQueue: true` 默认让断线期间 command 快速失败，而不是等待不确定时长；
- `pingIntervalMs: 0` 默认不创建额外 keepalive command，正数时交给 node-redis 周期 PING；
- client name 自动使用 `pluxel:<runtime-plugin-id>`，便于 Redis 侧诊断；
- initial connect 失败会让 plugin lifecycle 失败，required consumers 被正常阻塞；
- stop、replacement、rollback 与 shutdown 都通过 owner effects 关闭连接。

## Secret 与部署形态

默认 `RedisPlugin` 只接受无 username/password、无 database path 的 `redis://` 或 `rediss://` endpoint。
credential 不进入普通 plugin config、Workbench、日志或 persistence。

认证、Sentinel、Cluster、云平台 binding 或自定义 TLS 的应用提供另一个实现：

```ts
@Plugin(Redis)
class PlatformRedisPlugin extends Redis {
	get client(): RedisClient {
		return this.platformClient
	}
}
```

该 provider 自己通过 Vault 或平台 secret binding 创建 client，并遵守同样的 lifecycle cleanup。consumer 与
`RedisCacheBackendPlugin`、`RedisRatesBackendPlugin` 都不需要修改。

## Lua script helper

普通 command 继续直接调用原生 client；需要 Lua 时用 `defineRedisScript()` 声明一次，再通过
`redis.scripts.use()` 获得稳定 typed runner：

```ts
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

const increment = redis.scripts.use(Increment)
const value = await increment({ keys: ['counter'], arguments: ['2'] })
```

definition 自动计算 SHA1、可校验 key 数量并集中 decode reply。runner 优先发送 EVALSHA，遇到 NOSCRIPT 自动回退
EVAL，所以 Redis restart、failover 或 SCRIPT FLUSH 后不要求 consumer 重新注册。`use()` 对同一 definition 返回同一
runner；偶发调用也可以直接使用 `redis.scripts.run(definition, call)`。

只读脚本可以设置 `readOnly: true`，helper 会使用 Redis 7+ 的 EVALSHA_RO/EVAL_RO，便于 Cluster/replica routing；
需要兼容旧 Redis server 时保持默认 `false`。

## 多连接

`RedisPlugin` 通过 `@Plugin(Redis, { forkable: true })` 显式允许多实例，因此同一 host 可以创建 cache、queue、session
等多个 Redis connection fork，并为每个 fork 配置不同 endpoint/database。consumer 或内置 backend 通过正常 dependency override 选择具体 fork，
不需要在 Redis API 中增加 connection name 参数。

## 内置 cache backend

```ts
import { CachePlugin } from '@pluxel/cache'
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, AccountsPlugin])

host.cfg(RedisCacheBackendPlugin).set({
	keyPrefix: 'pluxel:cache:',
	scanCount: 200,
	deleteBatchSize: 200,
})
```

adapter 使用上述 script helper 原子读取 GET + PTTL，处理 TTL、structured value codec、SCAN 与有界 UNLINK。
`@pluxel/redis` 通过 peer dependency 复用 `@pluxel/cache` 与 `@pluxel/rates` 的 provider contract，
因此 adapter 与宿主使用同一份 Plugin identity，也不需要第三个集成包。`@pluxel/cache` 反向不依赖 Redis，
memory-only host 仍不会安装 node-redis。

- cache caller/scope prefix 继续由 `CachePlugin` 生成，`keyPrefix` 只隔离 Redis cache keyspace；
- cache opaque value 保留 `CachePlugin` 写入的完整结构化 owner envelope，Redis adapter 不解释或删除它；
- rates state metadata 保存完整 owner address 并由 Lua 校验，Redis 物理 key 只保留 canonical request digest；
- cache/rates `keyPrefix` 必须是 well-formed Unicode，不接受未配对 surrogate；
- Cache canonical key 直接追加到 managed prefix，不再 URI 二次转义，保持 byte bound 与 Redis key 紧凑；
- `ttlMs: 0` 表示无 expiry，正 TTL 使用 millisecond PX；
- value codec 使用版本头与 Node `v8.serialize()`，支持 BigInt、Date、Buffer、Map/Set；
- clear 转义 Redis glob metacharacter，使用 cursor SCAN 和 `deleteBatchSize` 限制 UNLINK；
- same-key request/load single-flight 仍由 `CachePlugin` 负责，adapter 不维护第二套队列。

adapter 遵循通用 `CacheBackend` contract：`undefined` 只表示 miss，`null` 是合法 hit，读取返回剩余 TTL，delete/clear
幂等且 backend error 原样 reject。数据库 freshness、loader failure policy 与主动失效顺序仍由 `CachePlugin`/consumer
负责。

## 内置 rates backend

```ts
import { RatesPlugin } from '@pluxel/rates'
import { RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisRatesBackendPlugin, RatesPlugin, MessagingPlugin])

host.cfg(RedisRatesBackendPlugin).set({ keyPrefix: 'pluxel:rates:' })
```

adapter 为 token bucket、fixed window、sliding window counter 和 sliding window log 各使用一个静态单 key Lua script。
脚本读取 Redis `TIME`，校验完整 resolved policy、原子完成状态转移并设置行为影响期 TTL；storage key 是 canonical
identity 的 SHA-256 digest，不暴露 raw identity，policy 也不参与 key。多个进程不会因 `GET` + `SET` 竞态超发；
SCRIPT FLUSH 后由 Lua helper 自动回退 EVAL。单 key 操作不产生 Cluster cross-slot 问题，需要固定 hash tag 时可在
`keyPrefix` 中配置。

sliding window log 的正常 allow 只读取固定大小的 metadata/边界信息；过期清理只读取到期事件，deny 使用一次最多
10,000 条的 bounded read 计算 `retryAfterMs` 并核对 live cost 总和。rates storage key 必须由 adapter 独占，不能由
其他 Redis writer 修改。

## Workbench 多态选择

Workbench 的 host-owned“依赖注入”卡片会根据 constructor 中的抽象 `Redis` 自动列出全部
`@Plugin(Redis, ...)` providers。选择结果属于 RuntimeState，commit 会重启被修改 plugin 及其 dependent closure。
`@pluxel/redis` 不发布专属 Workbench Definition，headless host 使用同一 graph contract。

同一个卡片也会根据 `CachePlugin(CacheBackend)`、`RatesPlugin(RatesBackend)` 列出 memory 与本包 Redis provider，
因此 host 可以独立选择 cache backend、rates backend 和底层 Redis provider。

完整约束见 [`DESIGN.md`](DESIGN.md)。
