---
title: 缓存
description: 为每个 Plugin 隔离缓存，并组合本地缓存、后端、加载器、失效和请求合并。
---

> `@pluxel/cache` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/cache` 会识别当前调用它的 Plugin，并自动隔离普通 key。业务 Plugin 依赖抽象的 `Cache`，宿主选择内存或 Redis 后端；只有多个 Plugin 明确共享同一份值协议时，才应使用 `cache.global`。

## 先选择用法

| 需求                                    | 写法                            |
| --------------------------------------- | ------------------------------- |
| 同步计算、进程内热点                    | `cache.local`                   |
| 简单异步 cache-aside method             | `@Cached`                       |
| 主动失效、独立策略、多层缓存或统计      | `cache.scope()` + `getOrLoad()` |
| 跨 Plugin 共享完全相同的数据 contract   | `cache.global`                  |
| 长期 freshness、跨实例 claim/lock、事务 | repository/database             |

`getOrLoad()` 的主流程是 `local -> backend -> loader -> backend/local write`。decorator 只是便利写法，不负责 repository orchestration。

## 显式绑定稳定 scope

复杂缓存应在 Plugin generation 启动时创建一次：

```ts twoslash
import { Cache, type CacheNamespace } from '@pluxel/cache'
import { BasePlugin, Plugin } from '@pluxel/runtime'

type CatalogItem = { id: string }

async function fetchCatalogItem(_tenantId: string, itemId: string): Promise<CatalogItem> {
	return { id: itemId }
}

// ---cut---

@Plugin({ displayName: 'Catalog' })
export class CatalogPlugin extends BasePlugin {
	private catalog!: CacheNamespace

	constructor(private readonly cache: Cache) {
		super()
	}

	override init() {
		this.catalog = this.cache.scope('catalog', {
			ttlMs: 10 * 60_000,
			maxEntries: 5_000,
			maxInFlight: 32,
			backendFailure: 'bypass',
		})
	}

	getItem(tenantId: string, itemId: string) {
		return this.catalog.getOrLoad([tenantId, itemId], () => this.loadItem(tenantId, itemId))
	}

	invalidateItem(tenantId: string, itemId: string) {
		return this.catalog.delete([tenantId, itemId])
	}

	private loadItem(tenantId: string, itemId: string) {
		return fetchCatalogItem(tenantId, itemId)
	}
}
```

同 caller、scope name 和 normalized policy 会复用同一个 bucket；同名 scope 请求不同 policy 会抛出 `CachePolicyConflictError`。不要让“第一次收到的业务请求”决定长期 scope policy。

handle 绑定 caller 和 provider generation。任一 stop/replacement 后继续调用旧 handle 会抛出 `CacheStoppedError`。

## Key 设计

key 可以是 primitive、primitive tuple 或 primitive-value plain record：

```ts no-twoslash
catalog.getOrLoad(itemId, load)
catalog.getOrLoad([tenantId, provider, itemId], load)
catalog.getOrLoad({ tenantId, provider, itemId }, load)
```

类型、tuple 位置、record 字段和 `-0` 都参与 canonical encoding。不要手工拼接可能歧义的复合 key，也不要把 credential/token 放进 key。

key 应包含所有会改变结果的 caller-visible input：tenant、locale、permission view、schema version 等。遗漏隔离维度会比 cache miss 更危险，因为它可能返回另一个安全域的数据。

## Miss、负缓存和 single-flight

`undefined` 始终表示 miss，不能缓存。需要表示“查无结果”时返回 `null` 或明确的 domain value：

```ts no-twoslash
const user = await users.getOrLoad(userId, async () => {
	return (await repository.find(userId)) ?? null
})
```

同一进程、同 scope、同 canonical key 的 backend read 和 loader 自动合并。后到调用者订阅已有 Promise，不重复消耗 `maxInFlight`。

这是进程内 single-flight，不是跨进程 distributed lock。多个实例可能同时执行 loader；写入和外部 side effect 必须本身幂等或由 repository/database 协调。

达到 `maxInFlight` 时新 key 会抛出 `CacheBusyError`。调用方决定返回 503、绕过缓存或排队；不要在 cache 内建立无界等待队列。

## Backend failure policy

默认 `required` 适合把 backend 可用性视为业务前提。数据库是权威来源且能承受 Redis 故障后的降级流量时，在 scope 设置：

```ts no-twoslash
backendFailure: 'bypass'
```

`getOrLoad()` 的 backend read failure 会继续 loader；loader 成功后的 backend write failure 仍返回结果并发布 local。loader、数据库和外部 API error 不会被吞掉。

显式 `get()`、`set()`、`delete()` 和 `clear()` 始终严格传播 backend failure，因为调用方明确要求 backend operation。

## Local cache

同步、纯计算热点使用 `cache.local`：

```ts no-twoslash
const parsed = this.cache.local.getOrCompute(['policy', policyVersion], () => parsePolicy(source), {
	ttlMs: 60_000,
})
```

local 数据只存在当前进程，不参与 Redis，也不提供跨 instance coherence。值应该是当前 caller 可安全复用的 immutable snapshot；不要缓存可被调用方继续 mutation 的共享对象。

## Decorator

简单 method cache-aside 可以使用 decorator：

```ts no-twoslash
import { Cached, Memoized } from '@pluxel/cache'

@Cached({ ttlMs: 60_000 })
async findUser(id: string): Promise<User | null> {
	return (await this.users.find(id)) ?? null
}

@Memoized({ ttlMs: 5_000 })
featureEnabled(name: string): boolean {
	return this.flags.read(name)
}
```

`@Cached` 要求 Promise-returning method；同步方法使用 `@Memoized`。参数必须能形成稳定 primitive tuple，复杂参数通过 `key` 显式映射。

需要主动失效、查看 stats、按操作覆盖 read policy 或组合 repository 时，使用显式 scope，避免把 lifecycle 和 policy 藏在 decorator 中。

## Database + 外部 API freshness

缓存不应承担长期 freshness。典型职责链：

```text
Cache local / Redis（分钟）
        ↓ miss
Repository / Database（长期保存 + refreshedAt）
        ↓ stale
External API（受控刷新）
```

repository 负责：

1. 读取数据库 authoritative snapshot；
2. 未过期时直接返回；
3. stale 时通过 claim/CAS 获取刷新权；
4. 在 transaction 外调用外部 API；
5. 用 fencing token 提交新值；
6. 外部失败时按领域规则返回旧值或抛错。

Cache 只包住 `repository.loadFresh()`：

```ts no-twoslash
return this.catalog.getOrLoad([tenantId, itemId], () =>
	this.repository.loadFresh({ tenantId, itemId, maxAgeMs: 30 * 24 * 60 * 60_000 }),
)
```

404 可以在数据库保存带 `refreshedAt` 的 tombstone，再向 Cache 返回 `null`。不要向 Cache API 添加 database transaction、distributed lock 或 stale ownership 语义。

## 安装 provider

consumer 只依赖 `Cache` 抽象；host catalog 选择：

- `MemoryCacheBackendPlugin`：单进程或本地开发；
- Redis cache backend adapter：多实例共享加速层，见 [Redis](./redis.md)。

业务 Plugin 不同时维护独立 Redis client、第二套 namespace 和 cleanup。backend 选择属于 host composition。

## 检查清单

- key 包含 tenant/permission/schema 等所有隔离维度。
- `undefined` 没有被当成可缓存结果。
- scope 在稳定 generation 阶段创建，policy 不由首个请求决定。
- loader 能接受多实例重复执行，或由 repository 提供 claim/fencing。
- backend bypass 只在权威来源能承受降级流量时启用。
- cache 没有替代 database durability、transaction 或 object storage。
