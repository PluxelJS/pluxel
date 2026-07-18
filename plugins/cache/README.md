# `@pluxel/cache`

Pluxel 官方 caller-aware 缓存插件。所有插件共享一个 provider/backend，默认 key 自动带 caller plugin 前缀。

## 同步 local cache

```ts
cache.local.set('feature:new-editor', true, { ttlMs: 5_000 })

const enabled = cache.local.get<boolean>('feature:new-editor')
// boolean | undefined，全程同步
```

local 不会访问 backend，也不会返回 Promise。

## 异步分层缓存

```ts
const user = await cache.getOrLoad<User>(`user:${id}`, () => database.loadUser(id), {
	ttlMs: 60_000,
})

await cache.set(`user:${id}`, user, { ttlMs: 60_000 })
await cache.delete(`user:${id}`)
```

顶层路径始终返回 Promise；backend 可以是默认内存实现，也可以由 Redis/数据库 plugin 多态替换。

## 默认隔离与 global

```ts
await accountsCache.set('user:1', user) // plugin:AccountsPlugin:...
await billingCache.set('user:1', user) // plugin:BillingPlugin:...

await accountsCache.global.set('accounts:user:1', user)
await billingCache.global.get<User>('accounts:user:1') // 同一个 value
```

`global` 是受管理的跨插件共享，不是 raw backend client。

## Provider 默认配置

```ts
host.cfg(CachePlugin).set({
	config: {
		ttlMs: 300_000,
		maxEntries: 1_000,
		maxInFlight: 256,
		readPolicy: 'cache-first',
	},
})
```

普通 caller namespace 与 global namespace 都继承这组默认值。

## Scope 覆盖

只在需要独立策略或批量失效时使用：

```ts
const responses = cache.scope('responses', {
	ttlMs: 30_000,
	maxEntries: 5_000,
	readPolicy: 'cache-and-refresh',
})

const response = await responses.getOrLoad(url, () => fetchResponse(url))
await responses.clear()
```

淘汰算法固定为 SIEVE，没有 LRU 选择。

## Async read policy

```ts
// local -> backend -> loader
await cache.getOrLoad(key, load, { readPolicy: 'cache-first' })

// 有 local value 时立即返回，并在后台刷新 backend/loader
await cache.getOrLoad(key, load, { readPolicy: 'cache-and-refresh' })

// 跳过 local 读取，始终先访问 backend
await cache.getOrLoad(key, load, { readPolicy: 'remote-first' })
```

稳定策略优先配置在 provider 或 scope；单次 override 用于少数明确场景。

## Decorator

```ts
@Plugin({ name: 'AccountsPlugin' })
class AccountsPlugin extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}

	@Cached({ ttlMs: 60_000 })
	async getUser(id: string): Promise<User> {
		return this.database.loadUser(id)
	}

	@Memoized({ ttlMs: 5_000 })
	featureEnabled(name: string): boolean {
		return this.readFeatureFlag(name)
	}

	@Cached({ name: 'permissions', key: (tenant: string, user: string) => `${tenant}/${user}` })
	async permissionsFor(tenant: string, user: string): Promise<PermissionSet> {
		return this.database.loadPermissions(tenant, user)
	}

	invalidatePermissions(tenant: string, user: string) {
		return this.cache.scope('permissions').delete(`${tenant}/${user}`)
	}
}
```

`@Cached` 只接受 Promise method；`@Memoized` 只接受同步 method。constructor 中的 `Cache` 仍是 required
dependency。

## Backend 多态

纯内存 host：

```ts
host.add([MemoryCacheBackendPlugin, CachePlugin])
```

外部 backend 通过独立 adapter package 提供。例如 Redis：

```ts
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin])
```

`@pluxel/cache` 本身不依赖 Redis client、数据库 driver 或其他远端 SDK。memory-only consumer 只安装 cache；
Redis package 自带 adapter，codec、TTL、Lua 与 clear 规则见 [`@pluxel/redis`](../redis/README.md)。

## Memory backend 重启预热

默认 memory backend 是纯内存且不产生持久化成本。需要在 plugin replacement 或进程重启后预热异步 backend 时，
配置它使用 runtime `PersistenceService`：

```ts
host.cfg(MemoryCacheBackendPlugin).set({
	config: {
		persistence: { mode: 'durable' },
	},
})
```

- `off`：默认值，不打开 persistence namespace，不序列化 value；
- `best-effort`：恢复/保存失败只告警；ephemeral storage 不保证跨进程恢复；
- `durable`：要求 host persistence durable 且 writable，否则 memory backend 启动失败。

`flushIntervalMs` 默认 `1_000`，只有需要改变连续 mutation 的合并窗口时才配置。

快照保存绝对过期时间，因此停机时间计入 TTL。连续 mutation 会按 `flushIntervalMs` 合并，provider 停止或替换前
会 flush 最新 revision。恢复后仍按当前 `maxEntries` 使用 SIEVE，缩小容量不会把旧快照完整塞回内存。

持久化只覆盖异步 `MemoryCacheBackendPlugin`，不覆盖同步 `cache.local`。开启可写快照后，value 必须能由 Node
structured-clone codec 序列化；Date、BigInt、Buffer、Map、Set 等可以恢复，函数和 Promise 不可以。这是 cache
warm start，而不是业务数据库或 write-through durability。

## Workbench 选择注入实现

`CachePlugin` constructor required-depend 抽象 `CacheBackend`。只要 catalog 同时知道
`MemoryCacheBackendPlugin` 与 `RedisCacheBackendPlugin`，Workbench 现有“依赖注入”卡片就会自动列出两个实现，
无需 cache plugin 注册专属 UI。选择 Redis 后，host 持久化 dependency override、启用目标 provider、commit graph，
并重启 `CachePlugin` 及其 dependent closure；consumer API 始终还是 `Cache`。

同理，`RedisCacheBackendPlugin` required-depend 抽象 `Redis`，所以默认连接 provider 与应用自定义的 Vault-aware
Redis provider 也可以使用同一套多态选择。

完整设计见 [`DESIGN.md`](DESIGN.md)。
