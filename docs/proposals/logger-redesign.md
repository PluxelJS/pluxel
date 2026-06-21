# Logger Redesign

状态：提案。

本文描述一次允许破坏兼容的 logger 重构方向。目标不是重新实现 LogTape，而是把 Pluxel 的日志语义清晰、显式、高效地编译到 LogTape 原语。

## 目标

- 配置显式：看 host logging config 就能判断日志去哪、最低等级、caller 是否开启、插件策略如何生效。
- 行为可检查：运行时能 inspect resolved config 和当前插件日志策略。
- 热路径高效：disabled log 尽早退出；caller、error 深序列化、UI 存储只在真正需要的 sink 上发生。
- 网页可配置：workbench 继续能配置插件日志等级和禁用策略，且运行时立即生效。
- 边界清晰：LogTape 负责 logging 系统，Pluxel 只负责 Pluxel 上下文和 runtime state。

## 非目标

- 不新增一套 parallel logging pipeline。
- 不抽象替代 LogTape 的 category、sink、formatter、filter、level routing。
- 不让 formatter、sink、LoggerService 分散决定同一个语义。
- 不在插件代码里暴露 LogTape 以外的第二套日志事件模型。

## Ownership

LogTape owns:

- logger/category
- level routing
- sink
- formatter
- filter
- `logger.with(properties)`
- `configure()`

Pluxel owns:

- `Context` 到 `context/pluginId/name` 的绑定。
- runtime UI log store sink。
- plugin log policy runtime state。
- caller policy 默认值和 sink-level capture。
- Pluxel console/file formatting defaults。
- host config resolve 和 inspect。

一句话：不要包住 LogTape；要把 Pluxel 语义编译到 LogTape。

## Public API

新的 host 入口只接受显式配置。不要用 `enabled: "dev"` 这类运行时隐式值；是否在 dev 开启 caller 由 host 自己算成 boolean 后传入。

```ts
const logging = createRuntimeLogging({
	profile: 'plugins-host',
	preset: 'hmr',
	minLevel: 'info',
	sinks: {
		console: {
			enabled: true,
			format: 'pretty',
			caller: true,
			youch: true,
		},
		file: {
			enabled: true,
			path: './logs/hmr.log',
			format: 'jsonl',
			caller: false,
		},
		ui: {
			enabled: true,
			streamId: 'default',
			caller: true,
			windowLines: 200_000,
		},
	},
	pluginPolicy: {
		path: 'packages/plugins/host/.pluxel/{profile}/logging-policy.json',
		defaultLevel: 'info',
	},
	debugTopics: ['pluxel:runtime:*'],
})

await logging.configure()
```

runtime object：

```ts
type RuntimeLogging = {
	configure(): Promise<void>
	dispose(): Promise<void>
	describe(): LoggingDescription
	logtapeConfig(): Config<string, string>
	policy: RuntimePluginLogPolicy
}
```

`describe()` 输出 resolved config，而不是输入 config。它必须包含：

- preset 展开结果。
- enabled sinks。
- category 到 sink 的绑定。
- 每个 sink 是否启用 caller。
- base level。
- plugin policy file 和当前 policy snapshot。
- debug topic filter。

`logtapeConfig()` 返回生成后的 LogTape config，方便测试和调试。调用它不应读取文件、env 或修改全局状态。

## LoggerService

`LoggerService` 只做 Pluxel context 绑定，不懂 sink、formatter、caller、file、UI、持久化。

```ts
class LoggerService {
	private readonly logtape = getLogger(category).with({
		context: ctx.name,
		pluginId,
		name,
	})

	info = (...args) => callLogtape(this.logtape, 'info', args)
}
```

`callLogtape()` 只保留调用兼容层：

- `logger.info('message', props)`
- `logger.info(error)`
- `logger.error('failed', { error })`
- tagged template / lazy callback 透传给 LogTape。

它不能做系统级行为：

- 不 capture caller。
- 不读 env。
- 不判断 sink。
- 不序列化 error。
- 不访问 plugin policy。

## Plugin Log Policy

插件日志策略是独立 runtime state，不是 LogTape config 的一次性参数。

```ts
type PluginLogPolicySnapshot = {
	defaultLevel: LogLevel | 'off'
	overrides: Record<string, LogLevel | 'off'>
}
```

网页配置只操作 policy：

```ts
logging.policy.setDefaultLevel('info')
logging.policy.setPluginLevel('PluginA', 'debug')
logging.policy.setPluginLevel('PluginB', 'off')
logging.policy.clearPluginLevel('PluginA')
logging.policy.replace({
	defaultLevel: 'warning',
	overrides: { PluginA: 'debug' },
})
```

LogTape 只注册一次 filter：

```ts
filters: {
	pluginPolicy(record) {
		if (!isPluginLog(record)) return true
		return logging.policy.allows(record)
	},
}
```

policy 修改后不重新 `configure()`，也不重建 logger/sink。filter 读取同一个 policy 实例，运行时立即生效。

语义固定：

- `defaultLevel` 是所有没有 override 的插件等级。
- `overrides[pluginId]` 覆盖单个插件。
- `clearPluginLevel(pluginId)` 删除 override，恢复继承 `defaultLevel`。
- `'off'` 禁用对应范围。
- 缺失 `pluginId` 的 plugin category 记录使用 `defaultLevel`。

## Policy Runtime

policy 内部使用预编译结构，避免每条日志 parse 字符串。

```ts
class RuntimePluginLogPolicy {
	private defaultRank: number | null
	private pluginRanks = new Map<string, number | null>()

	allows(record: LogRecord): boolean {
		const pluginId = readPluginId(record)
		const rank = this.pluginRanks.get(pluginId) ?? this.defaultRank
		return rank !== null && levelRank(record.level) >= rank
	}
}
```

规则：

- `off` 编译为 `null`。
- level 编译为 numeric rank。
- `defaultLevel` 覆盖没有 per-plugin 规则的插件。
- policy state 负责持久化和订阅，不负责输出。
- mutation 后同步更新编译结构，再异步持久化。
- 如果持久化失败，内存策略仍然生效，并通过 host logger 报错。

持久化路径由 host 明确传入，支持 `{profile}` token：

```txt
.pluxel/{profile}/logging-policy.json
```

## Workbench API

网页继续能配置插件日志策略，但 API 只暴露 policy，不暴露 LogTape config。

RPC shape：

```ts
type LoggingRpc = {
	getPolicy(): Promise<PluginLogPolicySnapshot>
	replacePolicy(snapshot: PluginLogPolicySnapshot): Promise<PluginLogPolicySnapshot>
	setDefaultLevel(level: LogLevel | 'off'): Promise<PluginLogPolicySnapshot>
	setPluginLevel(pluginId: string, level: LogLevel | 'off'): Promise<PluginLogPolicySnapshot>
	clearPluginLevel(pluginId: string): Promise<PluginLogPolicySnapshot>
	resetPolicy(): Promise<PluginLogPolicySnapshot>
}
```

HTTP shape 继续保留，作为 workbench/runtime API 的兼容 transport：

```txt
GET  /api/logging/policy
PUT  /api/logging/policy
POST /api/logging/plugin-level
```

UI 不需要知道 sinks、formatters、LogTape filters。它只展示和修改 `PluginLogPolicySnapshot`。

## Caller Policy

caller 是 sink capability，不是 logger capability。

```ts
sinks: {
	console: { enabled: true, caller: true },
	file: { enabled: true, caller: false },
	ui: { enabled: true, caller: true },
}
```

实现上由 resolved config 展开为固定 sink 行为：

```txt
console -> core pretty formatter includeCaller
file    -> runtime file sink boundary caller wrapper
ui      -> runtime UI sink boundary caller capture
```

规则：

- caller 只在 record 到达 caller-enabled sink 后捕获。
- console 可以要 caller，UI 可以要 caller，file 可以不要。
- 如果调用方已经传入 `caller`，不覆盖。
- 默认值由 preset 展开成 boolean；resolved config 不允许出现 `dev`、`auto`、env-dependent 字符串。
- 不允许 sink 自行读取 env 决定 caller；只能消费 resolved config 的 boolean。

## Sinks

推荐 sink 组合：

- `console`: pretty text，面向人。
- `file`: stable text or JSONL，面向审计和采集。
- `ui`: runtime log store，面向 workbench/API/SSE。

所有 sink 由 resolved config 生成。顺序固定：

```txt
LogTape filter
-> sink-level caller capability
-> sink-specific serialization/formatting
-> output
```

UI sink 继续批量写入 runtime log store：

- bounded window。
- batched append。
- structured `RuntimeLogLine`。
- error/caller/messageParts 只按 UI sink 需求计算。

## Presets

preset 只是模板，不能成为隐藏行为。

```ts
const presets = {
	core: {
		categories: {
			base: ['pluxel', 'core'],
			plugins: ['pluxel', 'plugins'],
		},
		sinks: {
			console: { caller: true },
			file: { caller: false },
			ui: { caller: false },
		},
		name: false,
	},
	hmr: {
		categories: {
			base: ['pluxel', 'hmr'],
			plugins: ['pluxel', 'plugins'],
		},
		sinks: {
			console: { caller: true },
			file: { caller: false },
			ui: { caller: true },
		},
		name: true,
	},
}
```

系统内部只使用 `ResolvedLoggingConfig`。不要在多个模块里重复判断 `preset === 'hmr'`。

## Resolved Config

输入 config 合并 preset 后生成：

```ts
type ResolvedLoggingConfig = {
	profile: string
	minLevel: LogLevel | null
	categories: {
		base: string[]
		plugins: string[]
		debug: string[]
	}
	sinks: {
		console?: ResolvedConsoleSink
		file?: ResolvedFileSink
		ui?: ResolvedUiSink
	}
	policy: {
		file?: string
		initial: PluginLogPolicySnapshot
	}
	debug: {
		topics: string[]
	}
}
```

`createPluxelLogtapeConfig(resolved)` 只做 LogTape config 生成：

- `sinks`
- `filters`
- `loggers`

不读 env，不读文件，不创建 runtime policy。

resolved sink 必须包含 caller boolean：

```ts
type ResolvedConsoleSink = {
	enabled: true
	format: 'pretty' | 'text'
	caller: boolean
	youch: boolean
}

type ResolvedFileSink = {
	enabled: true
	path: string
	format: 'jsonl' | 'text'
	caller: boolean
}

type ResolvedUiSink = {
	enabled: true
	streamId: string
	caller: boolean
	windowLines: number
}
```

## Functionality Contract

破坏兼容不代表少功能。重构后必须覆盖现有能力：

- plugin logs 按 `pluginId` 过滤和调级。
- workbench 读取、修改、持久化插件日志策略。
- logs API / SSE / runtime log store 继续工作。
- console pretty 输出、file 输出、UI structured logs 继续存在。
- HMR preset 注入 `name` 展示字段。
- core preset 不强制注入 `name`。
- debug topic channel 继续支持精确匹配和前缀匹配。
- error structured field 继续可被 console/UI/file 识别。
- Youch error rendering 继续可配置。
- caller 可分别对 console/file/UI 开关。
- 外部显式传入 `caller` 时不覆盖。
- 日志策略修改不需要重新 `configure()`。

## Performance Rules

必须满足：

- disabled log 不 capture stack。
- disabled log 不深拷贝 props。
- disabled log 不序列化 error。
- plugin policy filter 用 numeric rank 查表。
- caller 只在需要 caller 的 sink 上捕获。
- `ctx.logger` 创建时预绑定 category 和 context props。
- runtime UI sink 批处理写入。
- error normalization 单点实现，sink 只选择展示方式。

需要 benchmark 覆盖：

- disabled debug。
- enabled info without props。
- enabled info with props。
- enabled error with `Error`。
- enabled info with caller to console。
- enabled info with caller to console + UI。
- plugin policy per-plugin lookup。

性能门禁：

- 每个 benchmark 必须先在重构前记录 baseline。
- 重构后 disabled debug、plugin policy lookup、enabled info without props 不得慢于 baseline。
- caller-enabled 场景允许有 stack capture 成本，但不得比当前 caller-enabled baseline 更慢。
- UI sink append throughput 不得低于 baseline。
- benchmark 结果必须随 PR 附上，不能只靠主观判断。
- 如果 benchmark 波动超过 5%，需要重复运行并记录中位数。

## Regression Tests

功能不得靠人工检查。重构 PR 必须包含以下测试：

- config resolve：`core` / `hmr` preset 展开后没有 `auto`、`dev`、env-dependent 字符串。
- config resolve：每个 enabled sink 都有明确 `caller` boolean。
- LogTape config：生成的 `sinks`、`filters`、`loggers` 和 `describe()` 一致。
- LoggerService：plugin context 注入 `context/pluginId/name`。
- LoggerService：core context 不误注入 pluginId。
- call normalization：string、tagged template、lazy callback、`Error`、`{ error }` 都保持语义。
- plugin policy：default level、per-plugin override、clear override、`off`。
- plugin policy：mutation 不重新 `configure()` 也立即影响 filter。
- plugin policy persistence：启动加载、修改保存、保存失败不回滚内存策略。
- workbench RPC：读取、替换、设置默认等级、设置插件等级、清除插件等级、重置。
- UI sink：runtime log store、range/latest/wait、SSE append 继续工作。
- caller：console/file/UI 分别开关。
- caller：显式传入 `caller` 不被覆盖。
- caller：disabled sink 不 capture stack。
- debug topics：精确匹配和前缀匹配。
- error handling：console pretty、file、UI structured error 都能识别 `error` 字段。
- Youch：可开启、可关闭，且只处理匹配等级/category 的 error。

## Performance Contract

性能不靠承诺，靠 baseline gate。重构 PR 必须包含：

- 重构前 benchmark baseline。
- 重构后 benchmark result。
- benchmark 脚本随代码提交。
- CI 或本地可重复运行命令。

阻断条件：

- disabled debug 慢于 baseline。
- plugin policy lookup 慢于 baseline。
- enabled info without props 慢于 baseline。
- caller-enabled 慢于当前 caller-enabled baseline。
- UI sink append throughput 低于 baseline。
- benchmark 缺失或不可复现。

允许例外：

- 只有在功能 contract 明确新增能力时，才允许对应场景变慢。
- 例外必须写出原因、影响面和后续优化计划。

## Package Layout

目标文件组织：

```txt
packages/core/src/logger/
  service.ts        // LoggerService: ctx -> LogTape logger
  call.ts           // Pluxel call signature normalization
  resolve.ts        // input + preset -> resolved config
  config.ts         // resolved config -> LogTape config
  caller.ts         // captureCaller
  filters.ts        // plugin policy/debug filters
  formatters.ts     // console/file formatters
  inspect.ts        // describe helpers

packages/runtime/src/logger/
  ensure.ts         // host helper, creates RuntimeLogging
  policy.ts         // RuntimePluginLogPolicy + persistence
  ui-sink.ts        // runtime store sink
  file-sink.ts      // runtime file sink
  store.ts          // RuntimeLogStore
```

## Migration

破坏兼容的迁移顺序：

1. 增加 `RuntimePluginLogPolicy`，让现有网页配置改写 policy state。
2. 增加 `ResolvedLoggingConfig` 和 `logging.describe()`。
3. 把 caller 从隐式 env/default 逻辑迁到 resolved sink config。
4. 收缩 `LoggerService`，只保留 context binding 和 call normalization。
5. 删除旧入口：
   - `createPluxelLogtapeConfig({ pluginLevels })`
   - `ensurePluxelLogging({ pluginLevels })`
   - 直接暴露的 `runtimePluginLevels.lookup`
6. 更新 workbench RPC 到 policy API。
7. 增加 benchmark 和 regression tests。

## Acceptance

重构完成后应满足：

- host logging config 可完整解释运行行为。
- `logging.describe()` 能还原实际 LogTape 绑定和 policy 状态。
- workbench 可以读取、修改、持久化插件日志策略。
- 修改插件日志等级不需要重新 `configure()`。
- console、file、UI 的 caller 行为由同一个 caller policy 决定。
- `ctx.logger` 不知道 sink、formatter、caller、policy。
- Pluxel 没有第二套 logging pipeline。
