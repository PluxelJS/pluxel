# `@pluxel/cache`

Pluxel 官方 caller-aware 缓存插件。它提供同步 local cache、异步 backend、`getOrLoad()` single-flight、显式 global
共享和轻量 method decorator。consumer 只依赖抽象 `Cache`，host 可以选择 memory 或 Redis backend。

## 先选择写法

| 场景                                          | 推荐入口                        |
| --------------------------------------------- | ------------------------------- |
| 一个简单同步计算                              | `cache.local.getOrCompute()`    |
| 一个简单异步只读方法，不需要主动失效          | `@Cached`                       |
| 多层缓存、主动失效、独立策略或需要读取统计    | `cache.scope()` + `getOrLoad()` |
| 明确由多个插件共享同一个 value contract       | `cache.global`                  |
| 数据库长期 freshness、外部 API 刷新、跨实例锁 | 放在 repository，不放进 Cache   |

`getOrLoad()` 是主要的异步 cache-aside primitive；decorator 只是简单方法的便利入口。不要为了隐藏几行代码把数据库
freshness、transaction 或外部 API 协调塞进 decorator。

## 标准显式 scope

需要稳定策略或主动失效时，在 plugin `init()` 中绑定一次 handle：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { Cache, type CacheNamespace } from '@pluxel/cache'

@Plugin()
class AccountsPlugin extends BasePlugin {
	private users!: CacheNamespace

	constructor(
		readonly cache: Cache,
		private readonly userRepository: UserRepository,
	) {
		super()
	}

	protected override init(): void {
		this.users = this.cache.scope('users', {
			ttlMs: 60_000,
			maxEntries: 5_000,
			backendFailure: 'bypass',
		})
	}

	getUser(tenantId: string, userId: string): Promise<User | null> {
		return this.users.getOrLoad([tenantId, userId], () =>
			this.userRepository.find(tenantId, userId),
		)
	}

	invalidateUser(tenantId: string, userId: string): Promise<boolean> {
		return this.users.delete([tenantId, userId])
	}
}
```

启动时绑定避免首次请求顺序影响策略；读取、失效和 `stats()` 也始终使用同一个 handle。caller stop、replacement 或
backend 切换后，旧 handle 会稳定抛出 `CacheStoppedError`。

## 默认 namespace 与 global

直接使用注入的 `cache` 时，key 自动带 caller Plugin node namespace：

```ts
await accountsCache.set('user:1', user) // AccountsPlugin 私有
await billingCache.set('user:1', user) // BillingPlugin 私有
```

隔离依据是 caller 的 opaque node slot；持久 backend 使用结构化 node address 的 SHA-256 作为物理前缀，并在 value
envelope 中保存、校验完整 address。`displayName` 相同的不同 plugin/fork 不会共享 namespace。

只有多个插件确实消费相同 value contract 时才使用 `global`：

```ts
await accountsCache.global.set(['accounts', '1'], user)
await billingCache.global.get<User>(['accounts', '1'])
```

global 共享 value namespace 和同进程 single-flight，但 handle cleanup 仍属于各自 caller；最后一个 owner 停止时才释放
进程内 registration。backend value 继续按 TTL 存续。`global` 不是 raw backend client。

## Key 与 value

优先使用有类型的 composite key，不要手工拼接可能产生歧义的字符串：

```ts
await cache.getOrLoad([tenantId, provider, recordId], load)
await cache.getOrLoad({ tenantId, provider, recordId }, load)
```

key 支持：

- `string | number | bigint | boolean`；
- 最多 16 项的 primitive tuple；
- 最多 16 个字段的 primitive-value plain record。

canonical encoding 保留 primitive 类型、tuple 位置和 `-0`；record 字段按 code-unit order 排序。拒绝 nested object、
accessor、symbol、非 plain object、非 finite number 和包含未配对 surrogate 的 string。canonical key 最多 1,024 UTF-8 bytes，并直接作为 managed backend
key 的主体，避免二次转义膨胀。cache key 不是 secret protection contract，不要放 credential 或 token。

`undefined` 始终表示 miss，不能缓存。负缓存使用 `null` 或明确的 domain value：

```ts
const user = await users.getOrLoad(userId, async (): Promise<User | null> => {
	return (await repository.find(userId)) ?? null
})
```

## 同步 local 与异步路径

`local` 全程同步，不访问 backend：

```ts
cache.local.set('feature:new-editor', true, { ttlMs: 5_000 })
const enabled = cache.local.get<boolean>('feature:new-editor')
const parsed = cache.local.getOrCompute('schema', () => parseSchema(source))
```

顶层和 scope 的异步路径使用 local + backend：

```ts
const value = await cache.getOrLoad(key, load, { ttlMs: 60_000 })
await cache.set(key, value)
await cache.delete(key)
await cache.clear()
```

同 scope、encoded key 在一个进程内最多执行一个 backend read/loader。subscriber 的 `AbortSignal` 只停止自己的等待，
不会取消其他 subscriber 的共享工作。达到 `maxInFlight` 时抛出 `CacheBusyError`，不会创建无界等待队列。

## Read policy

- `cache-first`（默认）：`local -> backend -> loader`；
- `cache-and-refresh`：local hit 立即返回，同时通过 single-flight 刷新 backend，`getOrLoad()` 在 backend miss 时再执行 loader；
- `remote-first`：跳过 local read，先访问 backend，结果仍写回 local。

稳定策略放在 provider 或 scope；`get()` / `getOrLoad()` 的单次 `readPolicy` override 只用于明确的个别请求。

## Backend failure

`backendFailure` 是 scope policy，只影响 `getOrLoad()`：

- `required`（默认）：backend read/write failure 直接 reject；
- `bypass`：backend read failure 继续 loader，loader 成功后的 backend write failure 仍返回结果并发布 local。

数据库是权威来源、Redis 只是加速层且数据库可以承受降级流量时，才选择 `bypass`。它不会吞掉 loader、数据库或
外部 API 错误。显式 `get/set/delete/clear` 始终严格传播 backend failure。

## 数据库长期保存与外部 API 刷新

推荐分层：

```text
Cache local / Redis：分钟级 TTL
        ↓ miss
Repository / Database：长期保存，记录 refreshedAt
        ↓ 超过业务 freshness
External API：带 claim/CAS/fencing 的受控刷新
```

Cache plugin 只负责第一层。repository 负责：

1. 读取数据库；
2. `refreshedAt` 未超过业务 freshness 时直接返回；
3. stale 时用短 transaction 获取 refresh claim；
4. transaction 外请求外部 API；
5. 带 token/fencing 提交结果；
6. 外部失败且已有旧值时按业务规则返回 stale；首次加载失败则抛错。

404/missing 可以作为带 `refreshedAt` 的 tombstone 存入数据库，并向 Cache 返回 `null`。Cache 的 single-flight 只覆盖
一个进程；多实例重复刷新必须由 repository/database 协调。

## Decorator

简单方法可以使用 decorator：

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

一个 primitive 参数直接作为 key；零参数使用固定 tuple key；多个 primitive 参数使用 bounded tuple encoding。object、
function 或超过 16 个参数时必须提供 `key()`。

`@Cached` 只接受 Promise method，`@Memoized` 只接受同步 method，constructor 中仍需声明 `Cache` required dependency。
需要在首次 method 调用前主动失效、集中复用策略或读取统计时，改用显式 scope，不要围绕 decorator 再造 definition API。

## Provider 配置与 backend

```ts
await host.commit((change) => {
	change.start(MemoryCacheBackendPlugin)
	change.start(CachePlugin, {
		initialConfig: {
			ttlMs: 300_000,
			maxEntries: 1_000,
			maxInFlight: 256,
			readPolicy: 'cache-first',
			backendFailure: 'required',
		},
	})
	change.start(AccountsPlugin)
})
```

Redis host：

```ts
import { RedisCacheBackendPlugin, RedisPlugin } from '@pluxel/redis'

await host.start([RedisPlugin, RedisCacheBackendPlugin, CachePlugin, AccountsPlugin])
```

这里的 `host` 是 `createRuntimeTestHost()` 作者 fixture。`start()` 立即提交并等待 lifecycle 稳定；需要同一边界内原子设置多个
Plugin 时使用同步 `commit()` callback，首次配置放在 `initialConfig`。production static/dynamic host 通过自己的
ConfigService 和 RuntimeState 管理相同 topology 与 config。

Workbench 通过 `CachePlugin(CacheBackend)` constructor dependency 使用标准 provider 选择，不需要 cache 专属 UI。

第三方 `CacheBackend` adapter 必须遵守：`get()` 仅以 `undefined` 表示 miss、hit value 不得为 `undefined`、泛型 value
必须原样 round-trip、TTL 返回剩余毫秒且 `0` 表示不失效、required `delete/clear` 幂等、`clear(prefix)` 不得越过
managed prefix、backend failure 必须 reject。结构化 owner envelope 由 `CachePlugin` 生成和验证，adapter 不解释它。

## Memory backend 重启预热

默认 memory backend 是纯内存且不会创建 persistence 成本。需要 warm start 时配置：

```ts
await host.start(MemoryCacheBackendPlugin, {
	initialConfig: {
		persistence: { mode: 'durable' },
	},
})
```

- `off`：默认，不打开 persistence namespace；
- `best-effort`：恢复或保存失败只告警；
- `durable`：要求 host persistence durable 且 writable，否则 provider 启动失败。

快照使用绝对过期时间、合并写入和 atomic put，停机时间计入 TTL。只恢复异步 memory backend，不恢复同步 local。
启用可写快照后，value 必须能由 Node structured-clone codec 序列化。这是 cache warm start，不是业务数据库 durability。

完整工程约束见 [`DESIGN.md`](DESIGN.md)。
