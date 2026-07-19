# 缓存

`@pluxel/cache` 提供 caller-aware 缓存能力。consumer 在 constructor 中 required-depend 抽象 `Cache`；host 选择
`MemoryCacheBackendPlugin` 或 Redis adapter。普通 key 自动按 caller plugin 隔离，只有明确共享同一个 value contract
时才使用 `cache.global`。

## 最短选择规则

| 需求                                     | 写法                                 |
| ---------------------------------------- | ------------------------------------ |
| 同步计算或进程内热点                     | `cache.local`                        |
| 简单异步只读方法                         | `@Cached`                            |
| 主动失效、独立策略、多层缓存或需要统计   | 显式 `cache.scope()` + `getOrLoad()` |
| 跨插件共享完全相同的数据                 | `cache.global`                       |
| 数据库长期 freshness、外部刷新、跨实例锁 | repository/database                  |

`getOrLoad()` 是主要异步 primitive，执行 `local -> backend -> loader -> backend/local write`。decorator 只是简单
cache-aside 的便利写法，不负责 repository orchestration。

## 推荐：显式绑定稳定 scope

复杂缓存应在 plugin `init()` 中绑定一次：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { Cache, type CacheNamespace } from '@pluxel/cache'

@Plugin({ name: 'ProfilesPlugin' })
class ProfilesPlugin extends BasePlugin {
	private profiles!: CacheNamespace

	constructor(
		readonly cache: Cache,
		private readonly repository: ProfileRepository,
	) {
		super()
	}

	protected override init(): void {
		this.profiles = this.cache.scope('profiles', {
			ttlMs: 10 * 60_000,
			maxEntries: 5_000,
			backendFailure: 'bypass',
		})
	}

	getProfile(tenantId: string, profileId: string): Promise<Profile | null> {
		return this.profiles.getOrLoad([tenantId, profileId], () =>
			this.repository.find(tenantId, profileId),
		)
	}

	invalidateProfile(tenantId: string, profileId: string): Promise<boolean> {
		return this.profiles.delete([tenantId, profileId])
	}
}
```

这种写法让策略、读取、失效和统计共用一个 lifecycle-bound handle，也不会让首次请求顺序决定 scope policy。

## Key、负缓存和 single-flight

key 可以是 primitive、primitive tuple 或 primitive-value plain record：

```ts
profiles.getOrLoad([tenantId, provider, profileId], load)
profiles.getOrLoad({ tenantId, provider, profileId }, load)
```

tuple/record 最多 16 parts，canonical key 最多 1,024 UTF-8 bytes。类型、tuple 位置、record 字段和 `-0` 都参与编码；
不要手工拼接有歧义的复合 key，也不要把 credential/token 当 key。

`undefined` 始终表示 miss，不能缓存。需要缓存“不存在”时返回 `null` 或明确 domain value。同 scope、encoded key 的
backend read 和 loader 在一个进程内自动合并；它不提供跨进程锁。

## Redis 只是加速层时

数据库是权威来源且能承受 Redis 故障后的降级流量时，在稳定 scope 上设置：

```ts
backendFailure: 'bypass'
```

此时 `getOrLoad()` 的 backend read failure 会继续 loader；loader 成功后的 backend write failure 仍返回结果并发布
local。loader、数据库和外部 API 错误不会被吞掉。显式 `get/set/delete/clear` 始终严格传播 backend failure。

默认 `required` 适合把 backend 可用性视为业务前提的场景。

## 数据库长期保存、按月刷新外部 API

推荐职责链：

```text
Cache local / Redis（分钟级）
        ↓ miss
Repository / Database（长期保存 + refreshedAt）
        ↓ 超过一个月
External API（受控刷新）
```

repository 应负责：

1. 先读数据库；
2. `refreshedAt` 未过期时直接返回；
3. stale 时通过数据库 claim/CAS 获取刷新权；
4. 在 transaction 外请求外部 API；
5. 使用 fencing token 提交新结果；
6. 外部失败时按业务规则返回数据库旧值；没有旧值则抛错。

repository 的核心形状可以保持很小：

```ts
async loadFresh(input: LoadRecordInput): Promise<RecordDto | null> {
	const existing = await this.find(input)
	if (existing && Date.now() - existing.refreshedAt.getTime() < input.maxAgeMs) {
		return existing.value
	}

	const claim = await this.tryClaimRefresh(input)
	if (!claim) {
		if (existing) return existing.value
		return this.waitForCurrentValue(input)
	}

	try {
		// 外部请求不占用数据库 transaction。
		const next = await this.external.fetch(input)
		return await this.completeRefresh(input, claim.token, next)
	} catch (error) {
		await this.releaseRefresh(input, claim.token)
		if (existing) return existing.value
		throw error
	}
}
```

`tryClaimRefresh()` 和 `completeRefresh()` 使用短 transaction；`claim.token` 防止过期请求覆盖较新结果。单实例应用可以先
省略 claim/fencing，其他 Cache 调用方式不变。

404 可以保存为带 `refreshedAt` 的 tombstone，并向 Cache 返回 `null`。Cache 不增加 database-specific decorator、
stale window、distributed lock 或 transaction API；这些语义只有 repository 才能正确决定。

## 简单方法使用 decorator

```ts
@Cached({ ttlMs: 60_000 })
async findUser(id: string): Promise<User | null> {
	return this.users.find(id)
}

@Memoized({ ttlMs: 5_000 })
featureEnabled(name: string): boolean {
	return this.flags.read(name)
}
```

`@Cached` 只用于 Promise method，`@Memoized` 只用于同步 method。多个 primitive 参数自动使用 bounded tuple key；object
或 function 参数必须配置 `key()`。需要在首次调用前失效、复用同一策略或读取 stats 时，使用显式 scope。

## 安装 backend

纯内存：

```ts
host.add([MemoryCacheBackendPlugin, CachePlugin, ProfilesPlugin])
```

Redis：

```ts
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

host.add([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, ProfilesPlugin])
```

需要 Redis command、transaction、stream 或 pub/sub 时，单独依赖 `@pluxel/redis` 的 `Redis` capability，不通过
`Cache` 获取 raw client。Workbench 使用标准 dependency override 选择 backend，headless host 使用同一 graph contract。

caller/provider stop 或 replacement 后旧 scope/decorator handle 会撤销。global 只共享 value namespace，不转移 cleanup
ownership。同名 active scope 的 normalized policy 必须完全一致。

Memory backend 的可选 persistence warm start、完整 read policy、配置字段、统计与 adapter contract 见
[`../plugins/cache/README.md`](../plugins/cache/README.md)。
