---
title: 声明和更新插件配置
description: 用一个 Valibot object schema 统一配置类型、默认值、归一化和校验。
---

配置适合会随部署或用户选择变化的值，例如服务地址、超时和开关。
在 Plugin 中声明一个 Valibot schema，Pluxel 会从中得到类型、默认值、校验规则和 Workbench 配置表单。

开始前，你应已有一个能启动的 Plugin。先给配置加默认值，在 `init()` 中读取，再从工作台修改它。
普通配置不保存密钥；密码、Token 等使用 [Vault](../runtime/vault.md)。

## 先添加一个有默认值的字段

```ts twoslash
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

@Plugin({ displayName: 'Worker' })
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(
		v.object({
			concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 4),
		}),
	)

	protected override init() {
		this.ctx.logger.info('worker configured', { concurrency: this.config.concurrency })
	}
}
```

首次没有保存配置时，启动日志应显示 `concurrency: 4`；工作台的标准配置页应出现此字段。
输入 `0` 会校验失败。保存为 `8` 后，若没有注册下文的在线更新处理，重启插件才会应用新值。
“保存成功”与“运行中已应用”需要分别检查。

## 添加标题、约束和更多字段

```ts twoslash
// @filename: config.ts
import { f, v } from '@pluxel/runtime'

export const WorkerConfig = v.object({
	enabled: v.optional(v.pipe(v.boolean(), f.formMeta({ title: '启用同步' })), true),
	endpoint: v.pipe(v.string(), v.url(), f.formMeta({ title: '上游地址' })),
	concurrency: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(32),
			f.formMeta({ title: '并发数' }),
			f.numberMeta({ step: 1 }),
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

	protected override init() {
		this.ctx.logger.info('worker configured', {
			endpoint: this.config.endpoint,
			concurrency: this.config.concurrency,
		})
	}
}
```

## 宿主如何设置配置

日常手动配置使用 Workbench；以下 `host` 指 [Runtime 测试宿主](../development/testing.md)，适合检查初始值和更新结果。
正在运行的开发应用应通过 [开发控制台](../development/dev-console.md)修改配置。
测试中，首次启动可以传入 `initialConfig`：

```ts no-twoslash
const worker = await host.start(WorkerPlugin, {
	initialConfig: {
		endpoint: 'https://api.example.com',
		concurrency: 8,
	},
})
```

node 已拥有 committed config 或进入过 lifecycle 后，使用 Runtime 的 production-like live mutation：

```ts no-twoslash
const result = await host.config.patch(WorkerPlugin, {
	endpoint: 'https://api.example.com',
	concurrency: 12,
})

// 已注册 configs.onUpdate() 且处理成功时，application 为 'applied'。
// 否则检查 'saved-not-applied'，再按业务需要显式重启。
expect(result.ok).toBe(true)
```

`initialConfig` 不会根据当前状态偷偷变成 live update；越过 bootstrap boundary 后继续传它会明确失败。static 与 dynamic host 的持久化和
reload 行为由宿主决定；Plugin 只读取校验后的配置。配置保存与显式 restart 是两个独立操作，`host.config.patch()` 不会隐式重启；
运行中的原地更新只通过 `configs.onUpdate()` 通知。

## 声明规则

工具链依赖这个稳定形状提取 metadata，因此：

- `configs.use()` 必须是 concrete `@Plugin` 或 direct `PluginPart` subclass 的普通 class field；
- 不能放进 constructor、method、嵌套 class 或 helper function；
- 不能使用 JavaScript `#private` field，因为 runtime 无法注入；
- 每个 Plugin/Part class 各自最多一次，并且 schema 必须产出 object；
- schema expression 要能由 semantic pass 追踪，不用动态 runtime 分支拼接。

使用 TypeScript `private` 或 `protected` 字段即可。配置值在构造完成后、`init()` 前才可读取，
构造器和其他字段初始化器中提前读取会被构建检查拒绝。
`configs` 只在 Plugin/Part 子类内部使用；测试和宿主通过配置 API 操作，不直接改实例字段。

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
		// 直接读取 schema 已补全的默认值。
		await request({ timeoutMs: this.config.timeoutMs })

		// 避免再次补默认值：这里会与 schema 的默认值重复。
		await request({ timeoutMs: this.config.timeoutMs ?? 5_000 })
	}
}
```

同样，trim、枚举映射、范围限制和 cross-field validation 应在 schema 中表达。这样 CLI、runtime、测试和配置 UI 看到的是同一个 contract。
字段标题、说明和展示偏好集中写入 `f.formMeta({ title, description, ... })`。它产生 Valibot 标准 metadata；requiredness、
格式和范围仍由 `v.optional()`、`v.url()`、`v.minValue()` 等 schema/validation action 表达。

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

	protected override init() {
		const client = createClient(this.config.endpoint)
		this.ctx.effects.defer(() => client.close())
	}
}
```

constructor 只声明 required Plugin dependency，不读取 config，也不创建依赖 config 的资源。

## 让运行中的 Plugin 接收配置更新

保存配置会先持久化用户希望采用的值，不会自动重启插件。若连接或服务可以原地更新，在 `init()` 中注册一次
`configs.onUpdate()`；处理完成后，框架才把配置标记为已应用：

```ts twoslash
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const GatewayConfig = v.object({
	timeoutMs: v.optional(v.number(), 5_000),
	concurrency: v.optional(v.number(), 4),
})

@Plugin()
export class GatewayPlugin extends BasePlugin {
	private readonly config = this.configs.use(GatewayConfig)
	private options = { timeoutMs: 0, concurrency: 0 }

	protected override init() {
		this.options = { ...this.config }
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.options = {
				timeoutMs: desired.timeoutMs,
				concurrency: desired.concurrency,
			}
		})
	}

	currentOptions() {
		return this.options
	}
}
```

更新函数收到两个只读快照和一个取消信号。这里的一次运行指插件从启动到停止或重启之前的这段生命周期：

- `applied` 是本次运行已确认应用的配置；
- `desired` 是本次已保存、等待应用的配置；
- `signal` 在插件停止、重启或热替换时取消。

listener resolve 表示 Plugin 确认自己已经处理更新。框架随后更新 config field 与 applied revision，但不会检查 Plugin 的普通字段、连接或
外部系统，也不会回滚 listener 已经产生的副作用。需要并发一致读取时，先构造完整 runtime object，再像示例一样一次替换引用。

注册只允许发生在声明该 field 的 Plugin/Part `init()` 中，每个 declaration、每个 generation 一次。Listener 应保持幂等，并能从当前
真实 runtime state 收敛到最新 `desired`。如果只能通过完整重建安全应用配置，就不要注册 listener；保存结果会是
`saved-not-applied`，由用户或宿主显式 restart。Listener 内不要等待另一个 config mutation、restart 或 graph operation，因为这些操作
与当前通知使用同一个 coordinator queue。

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

normalized output 必须是无环的 plain object/array tree，leaf 使用 JSON-compatible primitive。runtime 会复制并冻结这棵树；`Date`、
`Map`、`Set`、class instance、function、symbol、getter/setter 和 cycle 都会被拒绝。需要领域对象时，把它保存成稳定的 plain value，
再在 Plugin `init()` 中显式构造资源；不要让 schema transform 把带 identity 或 behavior 的对象塞进 config snapshot。

## 嵌套相关设置与 Part config

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

如果设置对应一个 owner-bound `PluginPart`，Part 可以声明自己的 schema，配置会自然进入 occurrence field path：

```ts no-twoslash
const CacheConfig = v.object({ maxEntries: v.optional(v.number(), 1_000) })
const SearchConfig = v.object({ endpoint: v.string() })

class CachePart extends PluginPart<SearchPlugin> {
	private readonly config = this.configs.use(CacheConfig)
}

@Plugin()
class SearchPlugin extends BasePlugin {
	private readonly cache = this.parts.use(CachePart)
	private readonly config = this.configs.use(SearchConfig)
}
```

对应 raw record：

```json
{
	"endpoint": "https://search.example.com",
	"cache": { "maxEntries": 2000 }
}
```

父 schema 仍占 root，Part schema 只接收 `cache` subtree；两边分别执行 default/transform，随后合成冻结 snapshot。父 schema
output 不能使用与 direct Part field 相同的 key。Part field rename 会改变公开配置 path，应按配置 contract 变更处理。
这个 path 是静态配置坐标，不会同时作为 Part Context 上可读的 runtime identity。
Part config 属于静态 owner schema：即使 optional provider absent、对应 Part 没有产生业务 effects，这个 subtree 仍会执行
default、transform 和 validation。需要“未启用时不要求凭据”等语义时，在 schema 中使用带 `enabled` discriminator 的 object
明确表达，不根据 runtime catalog 动态改变配置契约。

Workbench 把父 schema 显示为“常规”分区，把 Part schema 按 nested path 显示为独立分区。配置操作栏固定在内容区顶部，切换分区时会保留
各自的滚动位置和未保存草稿；分区名称后的圆点与“待保存”计数用于提示尚未提交的变化。使用 `Ctrl/⌘ + S` 保存当前分区，或使用
`Ctrl/⌘ + Shift + S` 一次保存当前 Plugin 的全部已修改分区。所有分区编辑同一个 Plugin config owner；保存当前分区或全部分区都会在
server 重新验证完整 composite record。只有所有变化的 Plugin/Part declaration 都注册 listener 时才通知当前 generation；否则只保存
desired config，不会单独更新 Part 或隐式 restart。

Part 的静态声明、依赖与生命周期边界见[使用 PluginPart 组织内部资源](./plugin-parts.md)。

## 敏感信息

普通 Plugin config 会被宿主配置系统和 Workbench 管理面读取，不应当默认承载 secret。token、私钥和长期 credential 优先由宿主 secret provider、部署环境或 [Vault](../runtime/vault.md) 管理，再在 server-side capability 中使用。

不要把 secret 放进：

- browser-safe Workbench DTO/API；
- config form metadata、description 或 option label；
- structured log properties；
- status snapshot、command output 或序列化错误。

## 用部署环境初始化 static config

Static application 可以把少量部署环境变量绑定到固定 Plugin 的 raw config path。这个能力只初始化新的 config store；它不是每次启动都覆盖管理员配置的 environment overlay。

Plugin 需要导出传给 `configs.use()` 的同一个 schema：

```ts no-twoslash
// WorkerPlugin.ts
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

export const WorkerConfig = v.object({
	endpoint: v.pipe(v.string(), v.url()),
	http: v.object({
		enabled: v.optional(v.boolean(), true),
		timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5_000),
	}),
})

@Plugin()
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)
}
```

Canonical static entry 直接声明部署名称；不要在 `configure()` 中重复解析类型或拼装 Plugin address：

```ts no-twoslash
import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
import { WorkerConfig, WorkerPlugin } from './WorkerPlugin.ts'

export default defineStaticRuntime({
	name: 'worker-app',
	plugins: [WorkerPlugin],
	configEnvironmentBootstrap: [
		bindConfigEnvironment(WorkerPlugin, WorkerConfig, {
			endpoint: 'WORKER_ENDPOINT',
			http: {
				enabled: 'WORKER_HTTP_ENABLED',
				timeoutMs: 'WORKER_HTTP_TIMEOUT_MS',
			},
		}),
	],
})
```

Mapping 从 schema raw input 递归推导：object 可以继续展开，也可以直接绑定一个 JSON environment；array、tuple、record 和 scalar 是 leaf。根 mapping 也可以直接写一个 environment name，用 JSON object 初始化完整 raw record。环境名称必须匹配 `[A-Z_][A-Z0-9_]*`；`PLUXEL_*` 保留给 framework。

Transport 只负责把 string 送入原 schema：raw string 保留原文，number 要求 finite JSON number，boolean 只接受 JSON `true`/`false`，compound/nullable/mixed union 使用 JSON。环境缺失不产生对应 raw path；空 string 对 string 是显式值，对 number、boolean、JSON 是 decode error；JSON `null` 也是显式值。默认值、URL/range/refinement、transform 和最终 validation 仍只由 `WorkerConfig` 决定。

新 store 的优先级固定为：

```text
configure() config snapshot
  < configEnvironmentBootstrap
  < PLUXEL_CONFIG complete snapshot
  < existing persisted config file
```

Writable file mode 会保存第一次合成的 seed；后续修改环境不会覆盖该文件。Memory mode 在每个新 host 上重新初始化；readonly mode 在无文件时只在本次 host 使用 seed。长期 credential 不要经过这条路径写入普通 config store，继续使用 Vault、secret provider 或部署平台的 secret capability。

Static production build 会从同一 declaration 和 schema facts 生成 root `.env.example`。文件只包含注释说明与注释状态的空 placeholder，不读取构建机环境、不生成或加载真实 `.env`，也不复制 schema default。为了让 Vite 与 production 都能确定地检查声明，`configEnvironmentBootstrap` 必须是 direct array literal；元素必须是 direct `bindConfigEnvironment()` call，mapping 只使用 direct object tree 和 string literal，不使用 identifier、spread、computed property 或 runtime branch。

直接消费 runtime control-plane `ConfigResult` 时按 discriminant 处理返回值：query 返回 `config` 和 `defaults`，并标记
`saved: false`；成功 mutation 返回已持久化的 `config`、`application` 与 apply report，不再重复返回 defaults。
`validation_failed` 只有在 defaults 可以独立计算时才带可选 `defaults`。持久化失败不会发布 staged revision，也不会把未确认的值注入
Plugin generation。

## 配置表单

`valibot-form` metadata 可以让同一 schema 生成字段、说明、布局和控件选择。它不改变 Valibot validation，也不建立第二份 config model。

使用 [配置 Playground](../workbench/configuration-playground.md) 可编辑 schema、操作生成的表单，并比较原始输入与 Valibot 输出。完整 metadata 与 React adapter 见 [Valibot 配置表单](../workbench/valibot-form.mdx)。浏览器表单只是编辑界面；提交到宿主后仍必须由 server runtime 使用同一个 schema 校验。

## 检查清单

- schema 产出一个 object，且每个 Plugin/Part class 只声明一次 `configs.use()`。
- 所有默认值和 normalization 都在 schema 中。
- normalized output 是无环、可持久化的 plain object/array tree。
- constructor 与 field initializer 不读取 config。
- secret 没有进入普通 UI/config/log contract。
- 测试覆盖默认值、边界值、非法值和 transform 后的 output。
- schema 变化后重新运行 build，确认提取 metadata 与 Workbench 表单一致。
