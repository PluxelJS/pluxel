---
title: 使用 PluginPart 组织内部资源
description: 用静态 Part composition 隔离配置、注册和清理，同时保持一个 Plugin 治理边界。
---

`PluginPart` 用来拆分一个 Plugin generation 内部的资源所有权。它适合需要独立 config slice、effects、日志、注册或 nested composition，
但仍应跟随同一个 Plugin 一起启动、失败、重启和停止的组成。

Part 不是迷你 Plugin，也不是 service locator：它没有 catalog identity、独立启停、provider selection、RuntimeState 或 HMR lifecycle。

## 先判断是否应该使用 Part

| 需求                                                 | 选择                       |
| ---------------------------------------------------- | -------------------------- |
| 少量纯逻辑或显式传参已经足够                         | 普通函数或 class           |
| 只需要把一组 cleanup 从 owner effects 中分组         | `this.ctx.effects.scope()` |
| 需要自动派生 config、Context、effects 或 nested 组成 | `PluginPart`               |
| 需要独立启停、自动启动策略、失败状态或依赖选择       | 独立 `Plugin`              |
| 需要被其他 Plugin 注入或被多个 owner 共享            | 独立 `Plugin`              |

判断的关键不是代码量，而是治理边界。Part 可以拥有很多内部代码，但它的运行状态始终属于 owning Plugin。

## 标准写法

把 Part 声明为 direct `PluginPart` subclass，并在 owner 的普通 private field 中静态使用：

```ts no-twoslash
import { CacheBackendPlugin } from '@acme/cache-backend'
import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'

type CacheHandle = {
	get(key: string): string | undefined
	dispose(): void
}

const CacheConfig = v.object({
	maxEntries: v.optional(v.number(), 1_000),
})

class SearchCachePart extends PluginPart<SearchPlugin> {
	private readonly config = this.configs.use(CacheConfig)
	private cache: CacheHandle | undefined

	constructor(private readonly backend: CacheBackendPlugin) {
		super()
	}

	get(key: string): string | undefined {
		return this.cache?.get(key)
	}

	protected override init() {
		const cache = this.backend.createCache({ maxEntries: this.config.maxEntries })
		this.cache = cache
		return () => {
			this.cache = undefined
			cache.dispose()
		}
	}
}

@Plugin({ displayName: 'Search' })
export class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(SearchCachePart)

	readCachedResult(key: string): string | undefined {
		return this.cache.get(key)
	}
}
```

这个例子保留了几个重要边界：

- owner 不传入 Context、config、effects 或 dependency；Core 负责构造 Part；
- 真正消费 `CacheBackendPlugin` 的 Part 自己声明 constructor dependency，owner 不重复声明；
- `parts.use()` 和 `configs.use()` 只声明静态结构，不在 field initializer 创建资源；
- Part field 默认 private，owner 对外暴露自己的业务 API；
- Part 只公开 owner 真正需要调用的窄业务方法，composition internals 保持 protected。

## 静态声明规则

工具链必须在构建时完整确定 containment tree，因此 Part declaration 遵循固定形状：

1. Part 是 concrete direct `PluginPart` subclass，不加 `@Plugin()`。
2. `this.parts.use(PartClass)` 必须完整占据一个普通 class field initializer。
3. Part field 默认使用 TypeScript `private readonly`；不要用 ECMAScript `#private` field 承载 `parts.use()` 或 `configs.use()`。
4. 不在 constructor、method、条件表达式、循环或 helper 中动态调用 `parts.use()`。
5. constructor 只声明 required Plugin dependency 并调用 `super()`；不读取 config，也不创建外部资源。
6. 每个具体 Plugin 或 Part class 最多声明一次 object `configs.use()`。
7. 长期资源、registration 和 cleanup 放在 protected `init()` 或 `plugins.use()` callback。

下面这些写法都不是静态 Part composition：

```ts no-twoslash
// 错误：Part class 由运行时条件决定。
private readonly cache = this.parts.use(enabled ? FastCachePart : SafeCachePart)

// 错误：在 method 中动态创建 occurrence。
createCache() {
	return this.parts.use(CachePart)
}

// 错误：把 Part 当成普通对象自行构造。
private readonly cache = new CachePart()
```

## 依赖写在实际 consumer

Part 可以像 Plugin 一样在 constructor 声明 required Plugin。provider 必须从其 package root value-import；同一个 constructor 不能重复
同一 Plugin definition。

工具链会把所有 reachable Part requirements 提升并去重到 owning Plugin graph。因此不要在 owner constructor 或额外的 Part
dependency allowlist 中再复制一份 requirement；provider package 仍是实际 consumer 的直接 import，必须正常声明在 `package.json`
依赖中。provider 缺失或启动失败时，整个 owner blocked；Part 不会被跳过，也没有单独的 dependency override。

optional integration 仍使用 module-level `definePluginRef<T>()`，并在 Part `init()` 中直接调用 `plugins.use()`：

```ts no-twoslash
import type { MetricsPlugin } from '@acme/metrics'
import { definePluginRef, PluginPart } from '@pluxel/runtime'

const Metrics = definePluginRef<MetricsPlugin>()

class MetricsPart extends PluginPart<AppPlugin> {
	protected override init() {
		this.plugins.use(Metrics, (metrics) => {
			const subscription = metrics.subscribe((sample) => this.record(sample))
			return () => subscription.dispose()
		})
	}

	private record(sample: unknown): void {
		// 更新当前 Part 的普通业务状态。
	}
}
```

Part containment 始终存在。optional provider absent、当前未运行或 start-failed 时，只是不执行 setup callback；Part 仍会构造、校验 config
并运行自己的 `init()`。provider 出现、消失或 replacement 时，整个 owner generation 重启。

## 嵌套 Part 与 immediate host

Part 可以用自己的 private field 静态拥有 child Part。nested Part 的 protected `host` 永远是 immediate parent，不是 root Plugin locator：

```ts no-twoslash
class ShardPart extends PluginPart<IndexPart> {
	indexName(): string {
		return this.host.currentIndexName()
	}
}

class IndexPart extends PluginPart<SearchPlugin> {
	private readonly shard = this.parts.use(ShardPart)

	currentIndexName(): string {
		return 'products'
	}
}
```

如果 child 需要更上层的业务信息，让 immediate host 暴露一个窄方法并显式转发。不要增加 root-owner getter、Context locator 或
按 `partPath` 查找任意 sibling 的机制。

## 生命周期和所有权

每个 `parts.use()` field occurrence 都得到独立 Part instance、child Context 和 child effects scope；同一个 Part class 可以在不同 field
重复使用。它们共享 owning Plugin generation 和 runtime backend，但 registration、cleanup、日志与 dependency caller attribution
保持 occurrence 隔离。

生命周期顺序固定为：

```text
required providers running
  -> construct owner and reachable Parts
  -> inject and validate composite config
  -> init nested children
  -> init direct Parts
  -> init owning Plugin
```

停止和 rollback 通过 effects tree 反向清理。任一 Part constructor、config 或 `init()` 失败都会让整个 Plugin start 失败；provider
replacement 与 optional availability 会重启整个 owner。Config patch 只通知显式注册 `configs.onUpdate()` 的当前 Part/Plugin generation，
不会隐式 restart。Part 不提供单独 restart、running 或 failure 状态。

Part Context 是资源归属边界，不是安全 sandbox，也不会复制完整 service graph。部分 capability 仍以 owning Plugin 为最终治理单位；
Workbench definition 只能由 owning Plugin 统一发布，Part 需要参与时向 owner 暴露窄领域能力，由 owner 绑定 Direct View 或
Attachment target。

## Config path 属于 owner contract

Part 的 schema 位于 occurrence field path。假设 owner field 为 `cache`，raw config 就包含同名 subtree：

```json
{
	"cache": { "maxEntries": 2000 }
}
```

所有 Part config 都属于同一个 Plugin config record、持久化 owner 和 revision。修改任意 Part config 会重新校验完整 composite record，并在
所有变化 declaration 都注册 listener 时按 nested children-before-owner 顺序通知；缺少任一 listener 就只保存 desired config。重命名 Part
field 会改变公开配置 path，应按配置 contract 变更处理。

完整 schema、default 和 Workbench form 规则见[配置模型](./configuration.md#嵌套相关设置与-part-config)。

## 只暴露业务 API

`PluginPart.ctx/host/parts/plugins/configs` 和 `BasePlugin.parts/plugins/configs` 都是 subclass 内的 protected author DSL；只有
`BasePlugin.ctx` 保持 public。Part 的调用方只应看到 subclass 主动声明的业务方法或数据。

不要为了宿主、测试或调试增加这些 escape hatch：

- `context()` / `getCtx()`；
- root Plugin getter；
- `partPath`、Part id 或任意 sibling locator；
- 转发 `parts`、`plugins`、`configs` 的 public getter；
- 返回 provider facade 供外部长期缓存。

诊断不需要破坏这个边界。结构化日志自动带 Part attribution；宿主从 `PluginLifecycleErrorInfo.partPath` 定位 construction、init 或 cleanup
失败。`partPath` 是 definition-local diagnostic/config coordinate，不是业务 identity。

## 测试正确边界

不要直接 `new PartClass()`，也不要通过类型断言读取 protected DSL。使用真实 Pluxel test host 启动 owner，并验证：

- owner 暴露的业务结果；
- Part 注册的 HTTP、command、event 或其他 capability 是否出现并在 stop 后撤销；
- required provider failure 是否阻塞整个 owner；
- replacement、rollback 和 partial init 是否完整 cleanup；
- lifecycle failure 是否携带预期 `partPath`。

只有业务确实需要的 projection 才值得成为 public Part method。完整测试入口见[测试 Pluxel 插件](../development/testing.md#pluginpart-business-surface)。

## 提交前检查

- Part 只服务一个 owner，并且不需要独立治理。
- owner 和 nested Part field 默认为 `private readonly`。
- required dependency 只写在真正消费它的 Part constructor。
- field initializer 没有 IO、registration 或其他副作用。
- config、资源和 optional setup 都由 Part 自己声明并随 owner cleanup。
- public surface 只包含领域方法，不泄露 Context、host、path 或 composition DSL。
- 需要独立选择、启停、共享或 HMR identity 的组成已经升级为 Plugin。
