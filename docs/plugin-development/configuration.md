---
title: 声明和更新插件配置
description: 使用 Valibot Schema 统一定义插件配置的类型推导、默认值填充、运行时校验与 Workbench 表单。
---

配置项用于管理随部署环境或用户意图动态调整的参数（例如服务地址、请求超时、并发上限等）。Pluxel 采用 [Valibot](https://valibot.dev/) 作为统一的配置定义工具：一份 Schema 同时搞定 TypeScript 静态类型推导、默认值填充、启动时严格校验以及 Workbench 可视化表单生成。

## 先添加一个有默认值的字段

在插件类中使用 `this.configs.use()` 传入 Valibot Schema：

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

// 1. 定义配置 Schema
export const WorkerConfig = v.object({
	concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 4),
})

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	// 2. 注入配置：得到经过校验与默认值填充的冻结对象
	private readonly config = this.configs.use(WorkerConfig)

	protected override init() {
		// 3. 读取配置项
		this.ctx.logger.info('Worker initialized', { concurrency: this.config.concurrency })
	}
}
```

首次运行且无外部配置时，`this.config.concurrency` 会自动采用默认值 `4`。如果传入了非法数值（例如 `0`），配置校验将失败并阻止插件进入运行状态，同时输出具体字段的校验报错。

## 声明规则

为了让编译器在构建阶段顺利提取配置结构，定义配置字段时请遵循以下规范：

1. **类顶层字段声明**：`this.configs.use()` 必须声明为插件类（或 `PluginPart` 类）的普通类属性。请勿将其放置在构造函数体内、类方法中或外部辅助函数中。
2. **使用 TypeScript 属性**：使用常规的 `private`、`protected` 或 `readonly` 关键字，不要使用 JavaScript 原生私有字段（`#config`）。
3. **顶层必须为 Object**：传入的 Schema 顶层必须解析为一个普通对象结构（`v.object(...)`）。
4. **深层冻结只读**：`this.configs.use()` 返回的是深度冻结的只读快照。如果业务需要对配置内的数据进行就地排序或增删，请先进行浅拷贝（例如 `[...this.config.items]`）。

## 增强表单展示（valibot-form）

如果需要在 Workbench 管理后台中呈现清晰的表单标题、输入提示或步长控制，可以配合使用 `@pluxel/valibot-form`：

```ts twoslash
// @filename: config.ts
import * as f from 'valibot-form'
import * as v from 'valibot'

export const WorkerConfig = v.object({
	enabled: v.optional(v.pipe(v.boolean(), f.formMeta({ title: '启用任务' })), true),
	endpoint: v.pipe(v.string(), v.url(), f.formMeta({ title: '上游服务地址' })),
	concurrency: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(32),
			f.formMeta({ title: '并发线程数' }),
			f.numberMeta({ step: 1 }),
		),
		4,
	),
})

// @filename: WorkerPlugin.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { WorkerConfig } from './config.ts'

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)
}
```

这些表单元数据只增强界面的编辑体验，不会增加运行时的额外开销。

## 让运行中的 Plugin 接收配置更新

通过 Workbench 或管理 API 保存新配置时，宿主首先完成新配置的持久化。如果当前插件处于运行中，有以下两种方式使新配置生效：

1. **重启插件**：默认情况下，插件将在下一次重启时加载最新配置。
2. **原地热应用（Live Update）**：在 `init()` 中注册 `this.configs.onUpdate()` 监听器，在不重启插件的前提下无缝应用新参数。

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

const GatewayConfig = v.object({
	timeoutMs: v.optional(v.number(), 5_000),
	concurrency: v.optional(v.number(), 4),
})

@Plugin()
export class GatewayPlugin extends BasePlugin {
	private readonly config = this.configs.use(GatewayConfig)
	private runtimeOptions = { timeoutMs: 5_000, concurrency: 4 }

	protected override init() {
		this.runtimeOptions = { ...this.config }

		// 注册配置更新回调
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.runtimeOptions = {
				timeoutMs: desired.timeoutMs,
				concurrency: desired.concurrency,
			}
		})
	}
}
```

在更新回调中，`desired` 代表已保存的新配置对象。更新回调执行完成后，框架即确认新配置已成功应用（`applied`）。如果底层连接必须完全断开重连才能改变配置，通常无需注册 `onUpdate`，由用户或宿主触发插件重启即可。

## 嵌套相关设置与 Part config

当配置项较多时，可以在单个 Schema 内使用嵌套对象清晰划分配置域：

```ts twoslash
import * as v from 'valibot'

export const ServerConfig = v.object({
	http: v.object({
		port: v.optional(v.number(), 3000),
		timeoutMs: v.optional(v.number(), 10_000),
	}),
	rateLimit: v.object({
		maxRequests: v.optional(v.number(), 100),
		windowSeconds: v.optional(v.number(), 60),
	}),
})
```

如果某个子模块已被拆分为 `PluginPart`，该 Part 可以直接拥有自己独立的配置 Schema：

```ts no-twoslash
const CacheConfig = v.object({ maxEntries: v.optional(v.number(), 1_000) })

class CachePart extends PluginPart<SearchPlugin> {
	private readonly config = this.configs.use(CacheConfig)
}

@Plugin()
class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(CachePart)
	private readonly config = this.configs.use(SearchConfig)
}
```

框架会自动将 `CachePart` 的配置映射到父级配置中的 `cache` 字段下，形成统一的配置存储与表单展示。

## 配置表单

在 Workbench 中，插件主配置会默认归入“常规”分区，各个 Part 的配置会按路径呈现为独立分区。支持使用快捷键保存修改：

- `Ctrl/⌘ + S`：保存当前分区所做的修改；
- `Ctrl/⌘ + Shift + S`：一次性保存当前插件所有分区的改动。

## 敏感信息说明

普通的配置项会被宿主配置系统和 Workbench 界面读取，因此请勿在常规配置中明文存储数据库密码、个人令牌或私钥。对于此类机密凭据，请配合使用 [Vault 凭证服务](./vault.md)。
