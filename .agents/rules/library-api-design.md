# Library API Design

为 TypeScript/JavaScript 库、SDK、框架和内部基础设施设计公共契约。目标是让调用方从名称、类型、短示例和错误反馈推导下一步，减少猜测，而不是统一所有 API 的外形或追求字段最少。

本页适用于 public export、签名、配置、公开类型、错误、扩展点、资源生命周期和跨运行时边界；不要求把私有 helper 或一次性业务实现都变成公共设计。

## 阅读与决策

每次先读本节和[公共契约的硬约束](#公共契约的硬约束)，再按本次变更选择规则与验收，不必依次重读全部示例。

| 本次任务                              | 阅读                              |
| ------------------------------------- | --------------------------------- |
| 新增入口、重命名、引入抽象            | [入口与命名](#入口与命名)         |
| 修改参数或配置                        | [参数与配置](#参数与配置)         |
| 修改类型、输入校验或返回值            | [类型与输入边界](#类型与输入边界) |
| 修改失败、批处理或重试                | [失败与组合](#失败与组合)         |
| 增加 callback、plugin、adapter 或协议 | [扩展与协议](#扩展与协议)         |
| 创建资源、取消操作、调整并发或缓存    | [生命周期与成本](#生命周期与成本) |
| 更新教程、评审设计收益                | [文档与验收](#文档与验收)         |

决策优先级：正确性、安全性与数据完整性 → 项目约束、已有公共契约与生态互操作性 → 已知调用方的可读性和误用成本 → 已验证的性能与演进需求 → 假设性的灵活性。项目专属约束优先于本页通用默认。

- **MUST** 是硬约束，保护契约真实性、正确性和所有权。
- **SHOULD** 是强默认；只有项目契约、真实调用点或列出的例外信号支持时才偏离。在代码、测试、文档或交付说明中保留一句可验证的理由。
- “更灵活”“更简单”“模型喜欢”不是证据。`slice(start, end)` 遵循熟悉领域惯例，则是保留位置参数的理由。

设计前检查当前 exports、类型、实现、用户文档、测试和真实调用点；确认 public / experimental / internal 身份，不从文件位置猜可见性。先延伸已有概念，只有它无法诚实表达需求时才引入新概念。

## 公共契约的硬约束

### MUST：公开面是有意识的承诺

只导出已知调用方需要的能力，不因“也许有用”暴露内部 helper、key、可变状态或未稳定类型。通过 package exports、命名或文档区分 public、experimental 与 internal；修改现有契约前检查已知调用方与兼容影响。

```ts
export { createEngine, type Engine, type EngineConfig }
```

真实的 low-level、debug 或 adapter 用例可以使用独立入口，例如 `@scope/engine/debug`。小的 public surface 是降低维护成本的手段，不能成为拒绝合法能力的理由。

替换旧契约时同步处理已知调用方、exports 与文档，搜索旧符号；只有明确迁移需求才保留过渡入口，不自动增加同义 alias。

### MUST：类型、运行时与文档表达同一事实

- 互斥状态不能用任意组合的 optional 字段伪装。
- JSON、环境变量、网络、存储和第三方插件等信任边界必须验证输入；TypeScript 不提供运行时验证。
- 只有真正实现时，才能承诺取消、重试、回滚、持久化、drain 或 exactly-once。
- 类型可见不代表获得权限；静态隐藏也不构成运行时授权。直接调用、动态访问、缓存句柄和子引用必须服从同一访问边界。

```ts
// 类型表达真实状态，而非 success + optional output + optional error
type BuildResult = { ok: true; output: string } | { ok: false; error: BuildError }

// 外部输入先校验，再进入内部契约
const config = ConfigSchema.parse(JSON.parse(source) as unknown)
```

### MUST：可变性、资源和扩展点有明确所有者

不隐式改写调用方对象，也不要求调用方修改内部状态完成未明示的配置。原地更新若是 API 本意，要由名称和文档明确表达。

保留资源或注册副作用的对象必须提供项目约定的清理机制，定义重复、并发清理及失败语义。扩展点必须说明可用能力、调用顺序、错误传播与清理归属。`dispose`、`close`、`stop`、`Symbol.dispose` 采用现有惯例，不再创建同义机制。

### MUST：需要程序分支的失败有稳定信号

调用方需要恢复、降级、重试或分支时，使用稳定 error class、`code` 或 discriminated result，不能解析 message。

Message 解释问题，稳定类型或 `code` 供程序分支，`cause` / `details` 保留诊断链路。仅在调用方确实依赖时把 details 结构纳入公共承诺；诊断不得泄露密钥、凭据或不必要的用户数据。编程错误和不可恢复的不变量失败可直接使用 `Error` / `TypeError`，不必给每个 throw 建公开错误码。

## 入口与命名

### SHOULD：同一语义提供一个默认入口

一个动作提供一种标准写法，不让调用方在同义的 `run`、`execute`、`invoke` 或无选择条件的 facade 间猜测。原生 SDK 已有清晰契约时直接复用，不为统一外观再包装。

不同边界应保留区别：同步计算与异步 IO、定义与发布、名称查找与固定句柄、本地对象与远程数据、撤销与等待退出可能需要不同入口。用真实任务说明选择条件，并给出普通用法的默认。

引入新概念前说明它拥有的状态、不变量、寿命或独立策略。没有这些职责时，先用函数、字段或内部实现；有这些职责时，也不要把授权、发布和资源管理挤进万能执行器。

### SHOULD：完整调用表达式说明领域动作和副作用

独立函数优先表达领域动作；所在对象已有领域上下文时，无需重复。对称操作保持命名一致，不用禁词表判断名称。

```ts
compileProject()
startConfigWatcher()
runner.run()
middleware.handle(request)
engine.setEnabled(true)
```

`get`、`parse`、`resolve`、`normalize` 不应隐藏违反领域惯例的外部副作用。`httpClient.get()` 的 IO 符合惯例，`config.get()` 悄然启动 watcher 则通常不符合。写入、注册、订阅和释放资源的成本与所有权应能从动词或所属对象判断。

返回值表达完成事实：涉及异步启动的 `createSession()` 应返回 Promise，并在启动失败时报告，不能为缩短示例把失败拖到后续调用。

### SHOULD：每个事实有一个权威来源

分别确定输入约束、实现、说明、权限、输出和生命周期由谁维护。能可靠推导的内容由库生成；协议独有的信息留在协议边界；不能推导的内容明确保留。

TypeScript 返回类型不会自动成为运行时 output validator，JSDoc 不会自然存在于运行中的 class 上。若依赖生成制品，应验证它与实际发布的对应关系，并明确诊断不支持的声明形态。

删除字段或层级后追踪原职责：从 schema 可靠生成是减少重复；移到真正需要它的边界是收窄耦合；让每个调用方补同一转换只是转移成本；让不变量无人负责则不是简化。

## 参数与配置

### SHOULD：参数较多或字面量难懂时对象化

超过 3 个位置参数，或参数同型易对调、字面量无法从调用点理解时，默认使用命名对象。对象既说明语义，也避免以后靠新增位置维护顺序。

```ts
createEngine({
	input: source,
	inputFormat: 'esm',
	outputFormat: 'cjs',
	strict: true,
	cache: false,
	timeoutMs: 3_000,
})
```

例外是熟悉的领域惯例（`slice(start, end)`、`clamp(value, min, max)`）、稳定原子结构（坐标、范围、底层协议）或必须遵守的标准签名。对象写起来更长本身不是例外依据。

避免含义不明的裸 boolean 位置参数。真正的二元开关使用 `{ strict: true }`；`setEnabled(true)` 已经表意。只有已知状态超过二元或存在演进需求时才改成 `mode: 'strict' | 'loose' | 'recover'`，不要机械枚举化所有 boolean。

### SHOULD：Options 按真实语义域分组

两个或更多字段共享所有权、默认值、merge 策略或独立覆盖边界时才分组；否则保持平铺。层级应解决边界问题，不应仅为一个字段增加包装。

```ts
createEngine({
	input: { source, format: 'esm' },
	output: { format: 'cjs' },
	execution: { signal, timeoutMs: 3_000, retries: 3 },
	diagnostics: { logger, level: 'warn' },
})

createParser({ mode: 'strict' })
```

### SHOULD：默认值、省略语义与优先级可推导

每个 public optional 字段说明省略 / `undefined` 表示固定默认、继承、自动检测还是禁用。固定值使用 `@default` / `@defaultValue`；上下文默认说明选择规则。

```ts
type EngineConfig = {
	/** Maximum execution time. @defaultValue 10_000 */
	timeoutMs?: number
	/** When omitted, inferred from the output filename. */
	format?: 'esm' | 'cjs'
}
```

默认值和 merge 语义由一处权威实现维护，避免多条路径分别用 `??` / `||` 决策。公共文档必须写明配置优先级；常见起点为 `built-in default < project config < call-site override`，但 host policy、安全上限和管理员策略可能优先于调用方，具体顺序由领域决定。

### SHOULD：配置描述行为，实例承载状态与寿命

声明性配置可复用、比较或持久化，不由库隐式改写；运行状态、缓存、连接属于实例。需要补齐默认值时生成 resolved config，不修改输入。

Mutable builder 或动态配置本身就是领域模型时可以可变，但通过明确类型与方法表达，例如 `builder.addPlugin()`、`runtime.updatePolicy()`。

### SHOULD：先用 `satisfies`，再判断是否需要 `defineConfig`

无额外语义时使用 `satisfies EngineConfig`。只有 helper 确实改善泛型推导、运行时验证、标准化、metadata 或 JavaScript 使用体验时才公开；identity helper 可能仅增加命名承诺，甚至抹平字面量推导。

```ts
const config = { mode: 'strict' } satisfies EngineConfig

// 有实际校验价值，并保留具体类型
function defineEngineConfig<const T extends EngineConfig>(config: T): T {
	validateEngineConfig(config)
	return config
}
```

## 类型与输入边界

### SHOULD：封闭状态精确，开放扩展诚实

互斥状态使用 discriminated union，封闭可枚举值使用 literal union，以支持补全、拼写检查和分支缩小。第三方可注册新值时使用开放 string、branded string 或注册表契约，不把开放集合伪装成封闭 union。

复杂返回值默认使用对象。坐标、范围、熟悉语法惯例等小型原子结构可使用 tuple，例如 `readonly [x: number, y: number]`。

公共返回对象必须说明它是 snapshot、live view 还是 mutable handle。需要控制状态时提供有语义的方法或 builder，不要求调用方通过修改返回的内部对象反向控制库。

### SHOULD：已知数据有准确类型，外部 candidate 有校验边界

本地已知数据使用准确参数类型；外部输入在进入时校验，handler 使用解码后的类型。类型检查与运行时校验不互相替代。

入口有意接受 `unknown` 时，要说明它接收待校验 candidate，不能同时声称编译器会检查字段拼写。typed overload 后仍留有 `unknown` overload，错误输入依然可编译。不要先加 `unsafeExecute` 绕过问题，应确认调用方需要的是输入边界还是普通业务方法。

默认路径应支持自然推导，不要求 `as any`、逐个显式泛型或重复手写接口才能使用。用真实编写任务检查推导，见[验收矩阵](#按风险验证真实任务)。

## 失败与组合

### SHOULD：先确定恢复动作，再选择失败形态

沿用领域 Result、原生 SDK 异常、决策和回执契约。同一边界提供一种标准处理方式，不为外观一致把所有失败包成相同 envelope，也不先用 `tryX`、`xOrThrow`、`unwrap` 掩盖未确定的主契约。

采用 Result 时，明确成功、预期失败及未知异常的责任：哪些异常被监督并转换，哪些仍会 reject。返回 Result 不自动意味着永不抛出，也不会自动阻止调用方启动下一步。已有结果直接转发；必要的协议投影在边界显式完成，不猜测对象中的 `ok`、`error` 字段来决定控制语义。

诊断应有安全的分类、位置和必要上下文，使调用方知道应改输入、重新发现、取得权限还是终止。内部使用 throw 的终止 helper 要说明普通 catch 仍会捕获它。

### SHOULD：用串联、批量与不确定结果检验契约

正常返回之外，检查预期失败可分支、未知依赖 reject 保留原因、第一步失败不误启动第二步、批量部分成功仍能识别完成结果。

执行失败、业务拒绝、部分成功、编码失败和取消可能要求不同恢复动作。写入已发生但结果未送达时，提供领域确认路径或诚实的不确定结果；不能把它描述成可安全重试。幂等性来自业务协议，不来自命名、annotation 或包装。

## 扩展与协议

### SHOULD：按组合需求从 callback 升级

| 已有需求                                   | 默认形式与原因                          |
| ------------------------------------------ | --------------------------------------- |
| 一两个局部定制点，无独立寿命               | callback / function option，直接且局部  |
| 多个扩展要组合、排序、命名、隔离失败或清理 | plugin / middleware，为独立扩展提供治理 |
| 多个运行时实现，或明确 IO / trust boundary | adapter，稳定真实变化边界               |

Plugin 使用受控 context 或窄能力接口，不直接读写 engine 内部状态。设计必须回答顺序、重入、失败传播、并发和 teardown；仅把 `onXXX` 搬进 plugin interface 不算完成设计。

将确定性计算与文件、网络、数据库 IO 编排分开，但不要因此自动导出 adapter。只有已有多个实现、宿主必须注入能力，或边界需独立验证时才公开替换契约。

```ts
async function compileFile(path: string) {
	const source = await fs.readFile(path, 'utf8')
	return compileSource(source)
}
```

只有一个实现且调用方无需替换时，内部边界已经足够；Node、browser、memory 实现成为实际需求后再公开相应 contract。

### SHOULD：库生成内部 key，自定义多字段协议使用结构

cache、dedupe、task key 和内部 plugin id 由库生成，调用方传语义输入。否则分隔符、顺序和编码都会意外成为公共契约。

```ts
compileCache.get({ file: 'src/index.ts', format: 'esm', mode: 'production' })
transform({
	pipeline: [{ type: 'parse' }, { type: 'minify' }, { type: 'emit', format: 'cjs' }],
})
```

结构化输入不自动解决相等与持久化。使用 `Map` 或存储 key 时定义 canonicalization、字段顺序和 serialization，不能假设同结构的不同对象引用会命中。

成熟 DSL（URL、glob、RegExp source、cron、CSS selector、GraphQL SDL、SQL）优先遵循生态形式。跨进程、跨语言、CLI 或持久化也可能需要有版本的字符串协议；字符串成为稳定边界时必须有 parser、validator 和明确 grammar。

## 生命周期与成本

### SHOULD：创建、接纳、撤销与关闭有可观察的含义

普通定义通常不持有运行资源；发布句柄说明撤销范围；session 等资源说明关闭过程。沿用项目 effects、`using`、`await using` 或原生清理协议。

一份契约应回答：

- 创建何时产生副作用，失败是否遗留资源？
- 撤销是否只拒绝新调用，已接纳工作如何处理？
- 清理是否等待工作退出，重复或并发清理如何完成？
- 失效、权限变化或关闭后，缓存句柄和子对象还能做什么？

准备 context 或异步检查权限期间占用资源，不代表业务工作已经接纳；若状态可能变化，在最终分派前检查相关 owner / session / publication 状态。库跟踪自己接纳的工作，业务等待自己启动的 IO，不把责任藏在另一方。

### SHOULD：长耗时异步操作接受 `AbortSignal`

网络、子进程、队列、watcher、大型编译和持续等待默认接受 signal，方便调用方对齐请求、页面、测试和进程寿命。短小纯计算、原子同步操作或必须遵循的标准签名不必加入无效参数。

说明 abort 是撤销排队、请求协作停止、终止底层工作、只停止等待还是丢弃结果。Timeout、retry、cancellation 是不同语义；底层无法取消时，说明工作可能继续。

`Promise.all` 提前失败不表示其他任务停止，关闭客户端不表示服务端工作退出。取消不能覆盖已取得的领域回执；取消与未知故障并发发生时保留真实故障原因。

### SHOULD：实现中的成本有界，只公开必要调优项

缓存、队列、并发、批处理和连接池必须有边界，或证明无界就是预期语义。检查热路径的重复计算、IO 与同步阻塞；实际限制来自内存预算、负载测量或产品限额，不照抄示例数值。

只有调用方确需调优时才公开 `ttl`、`maxSize`、`concurrency` 等参数，避免把当前实现冻结成契约。先测量，再增加公共复杂度；不为微优化牺牲可读性，也不因为“更快”就跨并发调用共享可变 context。

## 文档与验收

### SHOULD：文档补充类型无法表达的契约

文档优先说明省略值、默认与优先级、副作用、错误与恢复、并发、重入、取消和资源寿命，不复述字段名。每个事实只维护一份当前权威说明，其他指南链接它；未实现内容进入 proposal / future work，不混入现行用法。

最短示例完整呈现任务、成功值和必要清理；第二个示例覆盖最常见失败或可信 context，之后才介绍组合、发布或嵌套资源。不要求入门读者先理解内部 owner、lease、codec 或 transport。

若 handler 与公开入口的返回值不同，最短教程就说明转换。调用方无需处理的细节封装在实现中；影响重试、权限、失效与关闭的事实必须可见。

### 按风险验证真实任务

验证受本次变更影响的行，不为简单改名建立完整实验平台，也不靠只会 echo 的示例证明复杂边界。

| 变更风险             | 应验证的真实动作                                                             |
| -------------------- | ---------------------------------------------------------------------------- |
| 参数、泛型、输入边界 | 参数补全、错拼字段、省略必需 context、同步/异步推导、wire/decoded 差异       |
| 结果与组合           | 失败分支缩小、异构数组、方法表、预声明变量；满足一个成员不能代替整个集合约束 |
| 失败契约             | 正常、预期失败、未知 reject、串联停止、批量部分成功、必要时不确定结果        |
| 资源与时序           | 创建失败、并发、撤销、取消、已接纳工作、重复清理和失效句柄                   |
| 新抽象或跨边界机制   | 从定义到调用、执行、失败、清理的一条完整路径，包含真实副作用或权限           |
| 公开契约替换         | exports、已知调用方、类型、运行时与文档一致，旧符号和链接已处理              |

类型探针不能靠 `as any` 或重复接口绕过问题。RPC、生成器、沙盒分别证明自己的边界；上游支持某能力不代表项目已组合正确。

宣称“提升 agent 效率”时，固定模型、工具权限与任务条件，保留失败案例，比较正确完成率、修复次数、查阅量、token、请求数和端到端时间。单次成功或 token 变少不能证明整体改善；失败恢复变难也要计入成本。

### 评审只记录必要证据

新增公开契约应能简短回答以下问题；简单变更可在代码、测试或交付说明中回答，不另建长篇设计文档。

1. 哪个真实调用方被现有 API 阻塞？默认完整写法是什么？
2. 新概念承担哪项状态、不变量、寿命或策略？事实分别由谁维护？
3. 类型能阻止哪些错误，哪些必须运行时校验？
4. 失败后下一步是什么？并发、取消与关闭的结果是什么？
5. 哪些验证支持结论？偏离默认的可观察依据是什么？

没有具体消费者、明确职责和最小端到端证据时，机制先保持内部或 experimental。两种方案都正确时，选择更符合现有概念、调用点更清楚、公共承诺更少的一种。
