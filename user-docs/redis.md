# Redis

`@pluxel/redis` 提供独立 Redis capability。使用 Redis command、transaction、stream、pub/sub 或 Lua 的 consumer
在 constructor required-depend `Redis`：

```ts
import { Redis } from '@pluxel/redis'

@Plugin({ displayName: 'Queue' })
class QueuePlugin extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}

	push(value: string) {
		return this.redis.client.lPush('queue', value)
	}
}
```

默认 host 使用 `RedisPlugin`。它提供 credential-free standalone connection、initial connect failure propagation、
有界 command queue 和 lifecycle cleanup。认证、Sentinel、Cluster 或平台 binding 使用另一个
`@Plugin(Redis, ...)` provider；consumer 不改变。

Lua script 使用 `defineRedisScript()` 定义 typed keys、arguments 与 reply decoder，再通过 `redis.scripts.use()` 获得
runner。helper 自动计算 SHA1，优先 EVALSHA，并在 NOSCRIPT 时回退 EVAL；Redis restart 或 SCRIPT FLUSH 后不需要业务
代码重新加载 script。

只读脚本可设置 `readOnly: true` 使用 Redis 7+ 的 EVALSHA_RO/EVAL_RO。多个 Redis endpoint/database 使用
`RedisPlugin` fork 和 dependency override，每个连接保持独立 config 与 lifecycle。

```ts
const Claim = defineRedisScript<readonly [string], readonly [string], boolean>({
	name: 'jobs.claim',
	numberOfKeys: 1,
	source: `return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', 30000) ~= false`,
	decode: Boolean,
})

const claim = this.redis.scripts.use(Claim)
const acquired = await claim({ keys: [`job:${id}`], arguments: [ownerId] })
```

Redis 是 raw capability，不按 caller 自动添加 key prefix。业务 key/channel contract 属于 consumer。需要 caller-aware
缓存时安装：

```ts
import { CachePlugin } from '@pluxel/cache'
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, AccountsPlugin])
```

业务侧仍使用 `cache.scope() + getOrLoad()`；Redis adapter 只保存 caller-aware managed key/value 和剩余 TTL，不拥有数据库
freshness、外部 API 刷新或 distributed lock。Redis 只是可丢失加速层时，可在 Cache scope 上显式选择
`backendFailure: 'bypass'`。

Workbench 会从 `CachePlugin(CacheBackend)` 和 `RedisCacheBackendPlugin(Redis)` 两层 constructor dependency 自动生成
provider 选择。caller-aware admission control 使用 `RatesPlugin` 与本包的 `RedisRatesBackendPlugin`；四种算法都通过
server time + digest key + 单 key Lua 跨实例原子判定。cache/rates adapter 的 `keyPrefix` 必须是 well-formed Unicode。
Redis、cache 或 rates 都不需要专属管理 UI。详细配置和 adapter 见
[`../plugins/redis/README.md`](../plugins/redis/README.md)。
