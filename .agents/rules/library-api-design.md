# Library API Design Rules for Agents

本文档用于 agent 创建或修改 TypeScript/JavaScript 库、SDK、框架、工具包、插件系统和内部基础设施包的 public API。

目标不是让所有 API 长得一样，而是帮助 agent 在已知需求下做出最小、清晰、诚实且可验证的公共契约。

## Agent 如何执行本文档

本文档不使用“一切视情况而定”的弱建议。每项设计都应有一个明确默认，再由可观察的例外信号决定是否偏离。

1. 先遵守 **MUST**，它们保护正确性、兼容性、安全性和资源所有权。
2. 没有明确反证时，直接采用 **SHOULD** 给出的默认方案。
3. 只有当文档列出的例外信号、项目现有契约或真实调用点提供证据时，才偏离默认。
4. 偏离 SHOULD 时，在代码、测试、文档或交付说明中保留一句可验证理由，不要只写“更灵活”或“更简单”。

示例：

> 使用位置参数，因为该 API 遵循现有 `slice(start, end)` 契约，两个参数的顺序在所有调用点中都一致。

这是有证据的例外。“我觉得这样省代码”不是。

## 适用边界和优先级

在以下变更中使用本文档：

- 新增或修改 public export、函数签名、配置、返回值或公开类型。
- 新增或修改错误契约、扩展点、资源生命周期或跨运行时边界。
- 判断一个内部概念是否应该变成公共契约。

不要机械套用到业务流程、私有 helper 或一次性实现细节。

原则冲突时，按以下顺序决策：

1. 正确性、安全性和数据完整性。
2. 项目 `AGENTS.md`、架构不变量、已有 public contract 和生态互操作性。
3. 已知调用方的可读性、可用性和误用成本。
4. 经过验证的性能、可维护性和演进需求。
5. 尚未被真实需求证明的灵活性。

## 工作流程

设计前：

1. 读取项目约束、当前 exports、类型、文档、测试和真实调用点。
2. 确认变更对象是 public、experimental 还是 internal，不用文件位置臆测可见性。
3. 区分已知需求与假设需求。不为只有一个实现的假设场景新建 plugin、adapter、factory 或 config layer。
4. 优先延伸项目现有概念；只在旧概念无法诚实表达新语义时引入新抽象。

实现后：

1. 验证类型契约与运行时行为一致。
2. 针对变更的风险边界添加或更新测试。
3. 检查 public exports、已知调用方和用户文档。
4. 若替换旧契约，搜索旧符号和旧文档；除非存在明确迁移需求，不自动添加 alias 或平行 API。

## MUST：公共契约必须诚实

### Public API 必须是有意识的兼容性承诺

**规则**

- 不因“也许有用”导出 internal helper、可变内部状态、内部 key 或尚未稳定的实现类型。
- public、experimental 和 internal 边界必须能从 package exports、命名或文档中被识别。
- 修改或删除已有 public contract 前，必须检查已知调用方和兼容性影响。

**理由**

每个 export 都可能变成调用方依赖的名称、类型和行为。偶然导出会把内部重构变成破坏性变更。

**默认做法**

```ts
// 默认 public entry point：只包含已知调用方需要的契约
export {
	createEngine,
	type Engine,
	type EngineConfig,
}
```

**合理例外**

Low-level、debug 或 adapter API 有真实用例时可以暴露，但应通过独立 entry point、namespace 或 experimental 标记限定承诺：

```ts
import { inspectEngine } from '@scope/engine/debug'
```

“Public surface 应该小”是降低兼容成本的手段，不是拒绝合法能力的目标。

### 类型、运行时和文档必须描述同一个契约

**规则**

- 实际互斥的状态不得被一组无约束 optional 字段伪装成可任意组合的结构。
- TypeScript 类型不能代替信任边界的运行时校验。
- 不得声称一项能力可取消、可重试、可回滚或可持久化，除非实现真正提供该语义。

**理由**

公开类型会引导调用方构造数据。如果类型允许实现无法处理的状态，错误只是被从编译期推迟到了运行时。反过来，文件、网络和用户输入并不会因为声明了 TypeScript 类型就变得可信。

```ts
// 不诚实：允许 success=true 但没有 output，或同时有 output 和 error
type AmbiguousBuildResult = {
	success: boolean
	output?: string
	error?: Error
}

// 默认：类型直接表达真实状态
type BuildResult =
	| { ok: true; output: string }
	| { ok: false; error: BuildError }
```

从 JSON、环境变量、网络、存储或第三方插件进入的数据，必须在进入内部契约时验证。

```ts
// 外部数据先是 unknown，校验后才进入内部契约
const config = ConfigSchema.parse(JSON.parse(source) as unknown)
return createEngine(config)
```

### 可变性、资源和扩展点必须有明确所有权

**规则**

- 不隐式修改调用方传入的对象。原地更新是 API 本意时，必须从命名和文档中表达。
- 不暴露需要调用方理解或修改的内部可变状态。
- 扩展点必须说明可用能力、调用顺序、错误传播和清理所有权。
- 保留资源或注册外部副作用的对象必须提供与项目约定一致的清理机制，并定义重复清理的语义。

**理由**

如果调用方无法判断谁拥有对象、注册和资源，并发调用、错误回滚和测试 teardown 都会出现不确定行为。

```ts
const watcher = createWatcher({ paths: ['src'] })

try {
	watcher.on('change', callback)
} finally {
	await watcher.dispose()
}
```

`dispose` / `close` / `stop` / `Symbol.dispose` 没有绝对优劣；使用项目既有惯例，并明确它是否幂等。

### 可分支处理的公开失败必须有稳定信号

**默认**

当调用方需要恢复、降级、重试或分支处理时，使用 error class、稳定 `code` 或 discriminated result，不依赖 message。

**理由**

Message 需要改进、本地化和补充上下文，不是稳定程序协议。但如果所有 throw 都强制错误码，内部编程错误也会被不必要地固化为 public API。

Message 面向人，稳定类型或 `code` 面向程序，`cause` / `details` 面向诊断。只有当调用方需要依赖其结构时，才把 details 声明为稳定 public contract；诊断数据不得泄露密钥、凭据或不必要的用户数据。

```ts
type LoadResult =
	| { ok: true; value: Config }
	| { ok: false; code: 'NOT_FOUND' | 'INVALID_CONFIG'; cause?: unknown }

// 调用方可以稳定分支
if (!result.ok && result.code === 'NOT_FOUND') {
	return useDefaults()
}
```

**合理例外**

表示编程错误或不可恢复不变量的失败，可直接使用 `Error` / `TypeError`。

## SHOULD：有强默认的设计规则

### 参数超过 3 个时，默认对象化

**强默认**

- 超过 3 个位置参数时，优先改为已命名对象。
- 即使不超过 3 个，只要多个参数类型相同、顺序容易对调，或调用点出现含义不明的字面量，也优先对象化。

**理由**

位置参数把语义放在声明处，调用点只保留顺序。参数越多、类型越相似，调用方和 agent 越需要靠记忆还原含义。对象参数还允许在不改变旧顺序的情况下增加可选字段。

```ts
// 不推荐：调用点无法解释两个 format、boolean 和 number
createEngine(source, 'esm', 'cjs', true, false, 3_000)

// 默认
createEngine({
	input: source,
	inputFormat: 'esm',
	outputFormat: 'cjs',
	strict: true,
	cache: false,
	timeoutMs: 3_000,
})
```

**合理例外**

保留位置参数需要出现至少一个强信号：

- API 遵循广泛熟悉的领域惯例，例如 `slice(start, end)`、`clamp(value, min, max)`。
- 参数形成稳定原子结构，例如坐标、范围或底层协议。
- 该签名是必须遵循的现有标准或兼容契约。

```ts
// 合理：三个位置在数值领域中是熟悉原子操作
clamp(value, min, max)
```

只因为对象写起来更长，不足以偏离默认。

### 裸 boolean 位置参数默认禁止，已命名 boolean 不禁止

**强默认**

避免将 `true` / `false` 作为含义不明的位置参数。先使用已命名 boolean；只在状态空间或演进需求超过二元开关时改用语义枚举。

**理由**

`parse(input, true)` 不能从调用点看出 `true` 的意义。但 `{ strict: true }` 和 `setEnabled(true)` 已经表达了完整语义。强制把所有 boolean 变成枚举只会增加词汇，不一定增加信息。

```ts
// 不推荐
parse(input, true)

// 默认：真正的二元开关
parse(input, { strict: true })

// 当已知存在多个模式时
parse(input, { mode: 'strict' })
type ParseMode = 'strict' | 'loose' | 'recover'

// 合理例外：方法名已表达开关语义
engine.setEnabled(true)
```

### Options 只在真实语义域上分组

**强默认**

当两个或更多字段共享所有权、默认值、merge 策略或独立覆盖边界时，将它们分组。否则保持平铺。

**理由**

过度平铺会把输入、输出、执行策略和诊断依赖混成一个无边界的 options 垃圾桶。过度分组则会让调用方为单个字段穿过多层对象。

```ts
// 已经出现真实语义域：execution 和 diagnostics 可独立默认和覆盖
createEngine({
	input: { source, format: 'esm' },
	output: { format: 'cjs' },
	execution: { signal, timeoutMs: 3_000, retries: 3 },
	diagnostics: { logger, level: 'warn' },
})

// 不需要分组：为一个字段创建层级没有提供边界
createParser({ parser: { mode: 'strict' } })

// 更清楚
createParser({ mode: 'strict' })
```

### 默认值、`undefined` 和配置优先级必须可推导

**强默认**

- 每个 public optional 字段都要说明 `undefined` 是固定默认、继承、自动检测还是禁用。
- 固定值使用 `@default` / `@defaultValue`；上下文默认描述选择规则。
- 默认值和 merge 语义保持单一权威实现，不散落在多条路径的 `??` / `||` 中。
- 配置优先级必须写入 public 文档。

**理由**

可选字段将决策从调用方交给了库。如果库不说明如何决策，类型并不完整。重复实现默认值则容易让不同调用路径产生不同行为。

```ts
type EngineConfig = {
	/**
	 * Maximum execution time.
	 *
	 * @defaultValue 10_000
	 */
	timeoutMs?: number

	/**
	 * Output format. When omitted, inferred from the output filename.
	 */
	format?: 'esm' | 'cjs'
}
```

**配置优先级默认**

常见库可以从以下顺序开始：

```text
built-in default < project config < call-site override
```

但 runtime/host policy、安全上限或管理员策略可能必须覆盖 call-site。因此“优先级必须明确”是硬要求，具体顺序是领域决策。

### `defineConfig` 只在提供实际价值时引入

**强默认**

先使用 TypeScript `satisfies`。只当 `defineConfig` 提供更好的泛型推导、运行时验证、标准化、metadata 或 JavaScript 用户体验时，才把它加入 public API。

**理由**

每个 public helper 都是新的命名和兼容性承诺。一个只接收 `EngineConfig` 再返回 `EngineConfig` 的 identity function 可能不比 `satisfies` 多提供任何信息，甚至会抹平字面量推导。

```ts
// 默认：无额外运行时语义
const config = {
	mode: 'strict',
} satisfies EngineConfig

// 合理：helper 真正进行校验并保留具体推导
function defineEngineConfig<const T extends EngineConfig>(config: T): T {
	validateEngineConfig(config)
	return config
}
```

### 配置描述行为，实例承载状态和生命周期

**强默认**

声明性配置在创建后不被库隐式改写；运行时状态、缓存、连接和生命周期存放在实例中。

**理由**

配置通常需要被复用、比较、持久化或用于创建多个实例。如果运行时悄然改写它，后续调用会依赖隐藏历史。

```ts
function resolveConfig(config: EngineConfig): ResolvedEngineConfig {
	return {
		...config,
		mode: config.mode ?? 'production',
	}
}

const engine = await createEngine({ config })
try {
	await engine.run(input)
} finally {
	await engine.dispose()
}
```

**合理例外**

Mutable builder 或动态配置本身就是领域模型时，可以可变，但必须用明确类型、命名和更新方法表达，例如 `builder.addPlugin()` 或 `runtime.updatePolicy()`。

### 用类型精确表达封闭状态，但不关闭开放扩展点

**强默认**

- 互斥状态、模式和结果使用 discriminated union。
- 闭合的可枚举值使用 literal union，不使用无约束 `string`。
- 复杂返回值默认使用对象，小型原子结构才使用 tuple。

**理由**

Discriminated union 让分支缩小后的字段可用性与真实运行时状态一致。Literal union 能补全、检查拼写并列出库真正支持的闭合集合。对象返回值为字段命名，新增可选字段时也不改变解构顺序。

```ts
type ParseResult =
	| { ok: true; ast: Ast; warnings: Warning[] }
	| { ok: false; error: ParseError }

type ParseMode = 'strict' | 'loose' | 'recover'
```

**合理例外**

- 第三方可以注册新值时，使用开放 string、branded string 或注册表契约，不用闭合 literal union 伪装开放集合。
- 坐标、范围、语法惯例或被当作一个原子值的小型结果可以使用 tuple。

```ts
type PluginId = string & { readonly __brand: 'PluginId' }
type Point = readonly [x: number, y: number]
```

公共返回值还应说明它是 snapshot、live view 还是 mutable handle。不要要求调用方修改返回的内部对象来完成未明示配置；需要可变性时，提供有语义的方法或 builder。

```ts
// Snapshot：调用方读取，不通过修改它反向控制 engine
const state: Readonly<EngineState> = engine.getState()

// Mutable handle：可变能力由明确方法提供
const session = engine.openSession()
session.setMode('strict')
```

### Callback、plugin 和 adapter 按组合需求升级

**强默认**

- 一两个局部、简单、不需要独立生命周期的定制点，使用 callback 或 function option。
- 多个独立扩展需要组合、排序、命名、错误隔离或清理时，升级为 plugin 或 middleware。
- 已有多个运行时实现，或存在明确 IO / trust boundary 时，引入 adapter。
- Plugin 通过受控 context 或窄能力接口扩展行为，不直接读写 engine 内部状态。

**理由**

Callback 的优点是局部和直接；问题只在它们需要彼此组合时出现。Plugin 的价值是为独立扩展提供身份、顺序和生命周期，不是仅仅把 `onXXX` 搬到另一个对象。Adapter 的价值是稳定真实变化边界，不是为每个 helper 制造 interface。

```ts
// 合理 callback：单一、局部、无独立生命周期
download(url, { onProgress })

// 合理 plugin：扩展需要独立组合和排序
createEngine({
	plugins: [cachePlugin(), diagnosticsPlugin(), transformPlugin()],
})

interface PluginContext {
	hooks: HookRegistry
	diagnostics: Diagnostics
}
```

**引入 plugin 时的必要验收**

必须同时定义顺序、重入、失败传播、并发和 teardown 语义。如果这些问题没有答案，把 callbacks 包装成 plugin interface 并没有完成设计。

### Core 与 IO 保持自然边界，不为假设实现制造 adapter

**强默认**

将可确定计算与文件、网络、数据库等 IO 编排分开。只在已有多个实现、宿主必须注入能力、或边界需要独立验证与测试时，公开 adapter contract。

**理由**

分离确定性逻辑和 IO 使得测试、重试和运行时迁移更容易。但如果只有一个实现且调用方不需要替换它，公开 interface 只会扩大契约面。

```ts
// 保持内部边界：IO 编排与纯转换分开，但不急于导出 adapter
async function compileFile(path: string) {
	const source = await fs.readFile(path, 'utf8')
	return compileSource(source)
}

function compileSource(source: string): Output {
	return runCompiler(source)
}
```

当 Node、browser 或 memory 实现已是产品需求时，再将 `ConfigLoader` 之类的 adapter 变成稳定边界。

### 内部 key 由库生成，字符串和结构化协议按边界选择

**强默认**

- cache key、dedupe key、task key 和 plugin internal id 由库生成，调用方传递语义输入。
- 自定义的多字段协议默认使用结构化数据。
- 字符串协议若作为稳定边界，必须有 parser、validator 和明确 grammar。

**理由**

调用方一旦手工拼接内部 key，分隔符、字段顺序和编码方式都会变成公共契约。结构化输入能够被类型检查和独立演进，但它不会自动解决结构相等和序列化。

```ts
// 不推荐：调用方依赖内部编码
cache.get('compile:src/index.ts:esm:prod')

// 默认：调用方传语义，库负责稳定编码
compileCache.get({
	file: 'src/index.ts',
	format: 'esm',
	mode: 'production',
})

// 自定义多字段协议也默认结构化
transform({
	pipeline: [
		{ type: 'parse' },
		{ type: 'minify' },
		{ type: 'emit', format: 'cjs' },
	],
})
```

如果底层使用 `Map` 或持久化 key，库必须定义 canonicalization、字段顺序和 serialization，不得默认两个结构相同但引用不同的对象会自动命中。

**合理例外**

URL、glob、RegExp source、cron、CSS selector、GraphQL SDL、SQL 等成熟 DSL 应优先遵循生态形式。跨进程、跨语言、命令行或持久化边界也可能更适合有版本的稳定字符串协议。

### 命名显示领域与副作用，不使用禁词表

**强默认**

- 独立 public function 优先使用能表达领域动作的名称，避免失去上下文的 `run` / `handle` / `process` / `do`。
- `get` / `parse` / `resolve` / `normalize` 不产生与所在领域惯例不符的隐藏外部副作用。
- 会写入、注册、启动、订阅或释放资源的 API，从动词或所属对象中能看出成本和所有权。
- 同一领域的对称操作使用一致命名。

**理由**

调用方会从名称预测 IO、状态变化和资源成本。隐藏副作用会使缓存、并发和测试决策全部失效。但名称的信息量来自完整调用表达式，不是单个动词。

```ts
// 含义不足：独立 export 没有上下文
run()

// 清楚
compileProject()
startConfigWatcher()

// 合理例外：所属对象已提供领域上下文
runner.run()
middleware.handle(request)
childProcess.exec(command)
```

`httpClient.get()` 会产生 IO，但这符合 HTTP 领域惯例；`config.get()` 悄然启动 watcher 则通常不符合预期。

### 长耗时 Async API 默认接受 `AbortSignal`

**强默认**

网络、子进程、队列、watcher、大型编译和可能持续等待的操作，默认接受 `AbortSignal`。

**理由**

库无法预知调用方的请求边界、页面生命周期、测试超时和进程关闭时间。无法停止等待会导致泄漏、卡住和过期结果写入。

```ts
await compile({
	input,
	execution: {
		signal: abortController.signal,
		timeoutMs: 30_000,
	},
})
```

**必须说清的边界**

- Abort 是停止底层工作、撤销排队、只停止等待，还是仅丢弃结果？
- Timeout、retry 和 cancellation 是不同语义，不能互相假装。
- 底层无法取消时，文档必须诚实说明 abort 之后工作可能仍在继续。

**合理例外**

短小的纯计算、原子同步操作，或必须遵循无 cancellation 参数的既有标准签名，不需要为形式一致加入无效 `AbortSignal`。

### 性能边界默认在实现中有界，只在需要时公开

**强默认**

- 缓存、队列、并发、批处理和连接池在实现中必须有明确边界，或明确证明无界是预期语义。
- 检查热路径中的重复计算、重复 IO 和同步阻塞。
- 只在调用方有合理调优需求时，才将 `ttl`、`maxSize`、`concurrency` 等实现参数暴露为 public config。

**理由**

库会被放入未知规模的调用环境，无界结构会把输入规模直接放大为内存、延迟或连接风险。但把所有内部调优参数公开，又会把当前实现冻结成 API。

```ts
// 实现必须有界
const cache = createCache({
	maxSize: 1_000,
	ttlMs: 60_000,
})
```

示例数值不是通用推荐值。真实边界应来自内存预算、负载测量或明确产品限额。

**优化约束**

- 先测量，再为性能增加 public complexity。
- 不为微优化牺牲调用点可读性和契约清晰度。
- 不因为“复用 context 可能更快”就在并发调用间共享可变上下文。

### Public 文档解释契约，不复述代码

**强默认**

每个影响调用方决策的 public API 都应有简短文档，优先说明：

- `undefined` 和省略字段的语义。
- 默认值与配置优先级。
- 外部副作用、错误和可恢复方式。
- 并发、重入、取消和生命周期语义。
- 资源由谁创建，何时释放。

**理由**

类型只能表达结构，不能完整表达时序、所有权、成本和失败恢复策略。反过来，重复字段名会增加维护量，却不增加契约信息。

```ts
// 没有增加信息
/** Set timeoutMs. */
timeoutMs?: number

// 解释真正契约
/**
 * Maximum time allowed for one execution.
 *
 * @defaultValue 10_000
 * When exceeded, the operation fails with `TIMEOUT`.
 */
timeoutMs?: number
```

当前文档只描述已实现行为。未实现设计进入 proposal 或明确的 future work，不与当前 API 混写。

## CONSIDER：提交前的定向审查

这些问题用来发现偏离默认规则的地方，不用来重新开始无边界设计。

### 必要性

- 新 export、新类型和新抽象是否对应真实调用方？
- 是否可以延伸现有概念，而不是建立平行 contract？
- 是否正在为假设性的第二个实现引入 adapter、plugin 或 factory？

### 调用点

- 超过 3 个位置参数时，是否有明确领域惯例支持保留？
- 相同类型参数是否可能对调？字面量能否从调用点被理解？
- Options 是否已成为垃圾桶，或反过来被分成了只包含一个字段的层级？
- 类型是否精确表达已知状态，还是在建模未知未来？

### 运行时

- 外部输入在何处验证？
- 并发、重试、取消、部分失败和重复清理的结果是什么？
- 是否存在无界状态、隐式 IO、隐式可变性或无法回收的资源？
- 对象 cache key 是否错把引用相等当成结构相等？

### 演进和验证

- 这次变更增加了哪些兼容性承诺？
- 类型测试、运行时测试和文档是否验证了同一契约？
- Public exports、已知调用方和用户文档是否一致？
- 若偏离 SHOULD，是否能用现有惯例、真实调用点或测量结果简短解释？

## 最终原则

好的库设计不是拥有最多模式，而是让已知调用方使用一个小而诚实的契约完成任务。当两种方案都正确时，选择与当前项目概念更一致、调用点更清楚、引入公共承诺更少的方案。
