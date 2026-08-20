---
title: 配置模型
description: 用一个 Valibot object schema 统一配置类型、默认值、归一化和校验。
---

每个 Plugin 只维护一份配置定义：传给 `this.configs.use()` 的 Valibot object schema。TypeScript 类型、默认值、归一化、运行时校验和 Workbench 表单都从这份 schema 派生，不需要再写一套平行的配置接口。

## 从一个完整 schema 开始

```ts twoslash
// @filename: config.ts
import { f, v } from '@pluxel/runtime'

export const WorkerConfig = v.object({
	enabled: v.optional(
		v.pipe(v.boolean(), f.formMeta({ label: '启用同步' }), f.booleanMeta({})),
		true,
	),
	endpoint: v.pipe(v.string(), v.url(), f.formMeta({ label: '上游地址' })),
	concurrency: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(32),
			f.formMeta({ label: '并发数' }),
			f.numberMeta({ min: 1, max: 32, step: 1 }),
		),
		4,
	),
})
// @filename: WorkerPlugin.ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { WorkerConfig } from './config.ts'

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)

	override init() {
		this.ctx.logger.info('worker configured', {
			endpoint: this.config.endpoint,
			concurrency: this.config.concurrency,
		})
	}
}
```

## 声明规则

工具链依赖这个稳定形状提取 metadata，因此：

- `configs.use()` 必须是 concrete `@Plugin` class 的普通 class field；
- 不能放进 constructor、method、嵌套 class 或 helper function；
- 不能使用 JavaScript `#private` field，因为 runtime 无法注入；
- 每个具体 Plugin 最多一次，并且 schema 必须产出 object；
- schema expression 要能由 semantic pass 追踪，不用动态 runtime 分支拼接。

TypeScript 的 `private`/`protected` 可以使用；限制针对真正的 `#private` runtime slot。

## 默认值只写一次

默认值只由 schema 提供。下面是正确写法与重复 fallback 的对照：

```ts twoslash
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

declare function request(options: { timeoutMs: number }): Promise<void>

const Config = v.object({
	timeoutMs: v.optional(v.number(), 5_000),
})

@Plugin({ displayName: 'Worker' })
class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(Config)

	async run() {
		// ✅ 正确：schema 的 normalized output 是唯一默认值 authority。
		await request({ timeoutMs: this.config.timeoutMs })

		// ❌ 错误：业务代码再次 fallback，形成第二份默认值 authority。
		await request({ timeoutMs: this.config.timeoutMs ?? 5_000 })
	}
}
```

同样，trim、枚举映射、范围限制和 cross-field validation 应在 schema 中表达。这样 CLI、runtime、测试和配置 UI 看到的是同一个 contract。

## 何时可以读取配置

runtime 在实例构造完成后、`init()` 开始前注入并校验 config，所以只在 `init()` 或更晚的方法中读取：

```ts twoslash
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const ReportsConfig = v.object({ endpoint: v.string() })
declare function createClient(endpoint: string): { close(): void }

@Plugin()
export class ReportsPlugin extends BasePlugin {
	private readonly config = this.configs.use(ReportsConfig)

	// 错误：field initializer 运行时尚未完成 config injection。
	// private readonly client = createClient(this.config.endpoint)

	override init() {
		const client = createClient(this.config.endpoint)
		this.ctx.effects.defer(() => client.close())
	}
}
```

constructor 只声明 required Plugin dependency，不读取 config，也不创建依赖 config 的资源。

## 缺失值、显式值和归一化

host 提供的是 raw config record，schema 负责把它变成冻结的 normalized snapshot：

```text
host config patch
  -> raw object
  -> Valibot parse/default/transform
  -> frozen config snapshot
  -> Plugin init
```

`undefined`/缺失是否允许、空字符串是否有效、数字是否转换，都由 schema 明确决定。不要依赖表单控件或环境变量碰巧给出正确类型。

如果校验失败，Plugin 不进入 running，错误以字段 path 形式反馈给宿主。不要在 Plugin 内捕获 `ConfigValidationError` 后继续启动。

## 嵌套相关设置

每个 Plugin 声明一个 object schema；不同配置域使用嵌套 object 组织，不要多次调用 `configs.use()`：

```ts twoslash
import { v } from '@pluxel/runtime'

const Config = v.object({
	http: v.object({
		baseUrl: v.string(),
		timeoutMs: v.optional(v.number(), 5_000),
	}),
	retry: v.object({
		attempts: v.optional(v.number(), 3),
		backoffMs: v.optional(v.number(), 250),
	}),
})
```

是否拆成另一个 Plugin 的判断标准不是“字段很多”，而是这部分是否拥有独立依赖、失败、启停或治理意义。

## 敏感信息

普通 Plugin config 会被宿主配置系统和 Workbench 管理面读取，不应当默认承载 secret。token、私钥和长期 credential 优先由宿主 secret provider、部署环境或 [Vault](../runtime/vault.md) 管理，再在 server-side capability 中使用。

不要把 secret 放进：

- browser-safe Workbench Contract；
- config form metadata、description 或 option label；
- structured log properties；
- status snapshot、command output 或序列化错误。

## 宿主如何设置配置

测试和宿主通过 Plugin identity 设置 raw record，不直接修改实例字段。测试中使用 host config handle：

```ts no-twoslash
host.add([WorkerPlugin])
host.cfg(WorkerPlugin).set({
	endpoint: 'https://api.example.com',
	concurrency: 8,
})
host.cfg(WorkerPlugin).enable()
await host.commit()
```

static 与 dynamic host 的持久化和 reload 行为由宿主决定；Plugin 只读取校验后的配置。配置变化会重启 Plugin，具体清理顺序见 [Plugin 模型与生命周期](./plugin-model.md)。

## 配置表单

`valibot-form` metadata 可以让同一 schema 生成字段、说明、布局和控件选择。它不改变 Valibot validation，也不建立第二份 config model。

使用 [配置 Playground](../workbench/configuration-playground.md) 可编辑 schema、操作生成的表单，并比较原始输入与 Valibot 输出。完整 metadata 与 React adapter 见 [Valibot 配置表单](../workbench/valibot-form.mdx)。浏览器表单只是编辑界面；提交到宿主后仍必须由 server runtime 使用同一个 schema 校验。

## 检查清单

- schema 产出一个 object，且 Plugin 只声明一次 `configs.use()`。
- 所有默认值和 normalization 都在 schema 中。
- constructor 与 field initializer 不读取 config。
- secret 没有进入普通 UI/config/log contract。
- 测试覆盖默认值、边界值、非法值和 transform 后的 output。
- schema 变化后重新运行 build，确认提取 metadata 与 Workbench 表单一致。
