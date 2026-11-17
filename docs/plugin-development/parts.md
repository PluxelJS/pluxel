---
title: 使用 PluginPart 组织内部结构
description: 使用静态 Part 组合拆分大型插件的局部配置、注册逻辑与资源清理，同时维持单一插件的治理边界。
---

当一个插件的业务逻辑越来越庞大（例如同时包含缓存调度、后台同步和复杂的数据映射），但这些子功能始终随主插件一起启停时，可以使用 `PluginPart` 进行模块化拆分。

每个 `PluginPart` 都可以拥有自己独立的局部配置 Schema、生命周期 `init()` 和依赖声明。如果某个 Part 初始化失败，整个插件将安全回滚，保证系统状态的一致性。

## 场景选型：何时使用 Part

- **纯辅助函数**：仅包含纯数据计算或简单工具方法时，使用普通 TypeScript 函数或辅助类即可。
- **拆分清理作用域**：仅需要把某组清理函数聚合在一起，使用 `this.ctx.effects.scope()` 即可。
- **PluginPart**：子模块需要自己的 Valibot 配置、生命周期 `init()` 或独立的构造函数依赖，且生命周期依附于所属插件。
- **独立 Plugin**：模块需要被其他插件复用、需要独立配置自动启动策略，或需要独立发布与管理。

## 标准写法

在下面的例子中，`SearchPlugin` 将本地缓存的管理职责拆分给了 `SearchCachePart`：

```ts no-twoslash
import { CacheBackendPlugin } from '@acme/cache-backend'
import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
import * as v from 'valibot'

type CacheHandle = {
	get(key: string): string | undefined
	dispose(): void
}

const CacheConfig = v.object({
	maxEntries: v.optional(v.number(), 1_000),
})

// 1. 定义 Part 类：指定宿主插件类型作为泛型参数
class SearchCachePart extends PluginPart<SearchPlugin> {
	// Part 拥有独立的局部配置
	private readonly config = this.configs.use(CacheConfig)
	private cache: CacheHandle | undefined

	// Part 可以通过构造函数直接声明自己需要的依赖
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
	// 2. 主插件通过 this.parts.use 静态挂载 Part
	private readonly cache = this.parts.use(SearchCachePart)

	// 3. 对外暴露高层业务接口
	readCachedResult(key: string): string | undefined {
		return this.cache.get(key)
	}
}
```

## 静态声明规则

为了让编译器在静态分析阶段识别插件包含的所有部件，请遵守以下要求：

1. **直接继承 `PluginPart`**：Part 类必须直接继承 `PluginPart<Parent>`，类上方无需添加 `@Plugin()` 装饰器。
2. **顶层属性初始化**：`this.parts.use(PartClass)` 必须作为类的普通属性初值声明。不要在构造函数体、普通方法或循环中动态挂载。
3. **使用 TypeScript 属性**：属性使用常规的 `private`、`protected` 或 `readonly`，不要使用 JavaScript 原生 `#private` 私有字段。

## 依赖写在实际 consumer

Part 类与常规插件一样，可以直接在构造函数中声明所需上游依赖。

工具链会自动收集并提升 Part 所需的依赖到主插件的依赖图中。这意味着：

- **按需声明**：哪个 Part 真正使用上游服务，就在该 Part 的构造函数中注入它，主插件不需要重复列出该参数。
- **拓扑统一**：若 Part 所需的上游服务不可用或启动失败，主插件也会整体处于阻塞状态，确保不会产生半就绪的异常状态。
- **可选依赖**：Part 也支持在 `init()` 中通过 `this.plugins.use(Ref, callback)` 接入可选依赖。

## 嵌套 Part 与层级关系

Part 内部还可以继续嵌套挂载子 Part。在嵌套结构中，Part 内的 `this.host` 属性始终指向直接挂载它的父级组件：

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

## 启动生命周期顺序

挂载了 Part 的插件在启动时，框架按照严格自底向上的顺序推进生命周期：

```text
1. 校验并运行主插件及所有 Part 的必需依赖
2. 构造主插件与所有静态挂载的 Part 实例
3. 合并校验主配置与各 Part 局部配置
4. 执行最深层嵌套 Part 的 init()
5. 执行直接子 Part 的 init()
6. 执行主插件自身的 init()
```

插件停止或初始化遇到错误时，清理流程则严格按照相反顺序逆向执行。

## Part 字段名对应配置路径

Part 在父类中声明的属性名，将直接作为其局部配置在主配置 JSON 中的字段名。例如：

```ts no-twoslash
class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(SearchCachePart)
}
```

在保存配置时，`SearchCachePart` 的配置项会自动归入 `cache` 键下：

```json
{
	"cache": {
		"maxEntries": 2000
	}
}
```

在 Workbench 的配置界面中，主插件的配置会展示在“常规”分区，而每个 Part 的配置则会自动呈现为对应的独立子分区。

## 只暴露业务 API

`PluginPart` 内部的 `ctx`、`host`、`parts` 等辅助属性受 `protected` 保护。Part 应当面向父插件只暴露清晰的业务方法（如上面的 `get(key)`），避免将内部实现细节暴露到外部。测试时也建议通过测试宿主启动主插件，直接测试主插件对外的业务行为与资源清理。
