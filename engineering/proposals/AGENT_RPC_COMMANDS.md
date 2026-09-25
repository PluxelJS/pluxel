# Command、Agent 与 RPC：直接定义，显式发布

状态：分阶段实施中。日期：2026-09-25。Command 内核和现有消费者、可选 Pi 直接工具载体、MCP 显式发布、RPC 显式 Command 目录与精确契约会话已落地；隔离程序和 HTTP 网关仍为内部实现，尚无稳定公开安装入口。旧 AgentTools 包与执行入口已按破坏性重构删除；独立的 `local-projects/chatbot` 已迁移其 Command/CLI 调用方。
内部执行器现已在真实 Podman 路径验证宿主完成时封闭新调用、未完成请求判定、同机同一运行环境下的跨进程运行上限、绝对 deadline 和排空超时后的关闭等待；网关也限制同一 run 跨 HTTP batch 的并发。启动探针核查容器实际隔离约束和私有挂载访问，Podman 独立超时约束宿主崩溃后的容器运行时间。下次执行器创建可按进程身份、启动锁和容器标签回收异常退出后的运行中容器；跨运行环境恢复仍待验收。容器内的 Node VM 不能隔离同一进程的控制凭据；真实恶意脚本回归证明同一进程可取得控制凭据，但 Podman 阻止读取宿主文件和连接外网，宿主网关拒绝把伪造完成时仍在途的调用结算为成功。仓库已有固定 Node 摘要的执行器专用镜像定义，本机最小镜像已通过真实 Podman 回归。当前平台、预算与运维边界见[执行器文档](../RPC_EXECUTOR.md)；目标部署环境尚未验收，因此执行器仍未公开。
当前用法以 [Commands](../../docs/runtime/commands.md)、[Pi](../../docs/plugins/pi-agent.md)、[MCP](../../docs/runtime/mcp.md)、[RPC](../../docs/runtime/rpc.md)、[工程边界](../COMMANDS.md)和[开发控制台](../../docs/development/dev-console.md)为准。RPC 的前置实验分别位于[真实 Command 制品绑定](../experiments/agent-rpc-binding/README.md)、[隔离与 HTTP 探针](../experiments/agent-rpc-commands/README.md)和[隔离工作排空](../experiments/agent-rpc-sandbox/README.md)。实验不构成正式发布或完整验收。

## 1. 设计决定

作者只定义操作本身，需要哪个入口就发布到哪个载体。普通业务复用使用函数或 Plugin 方法；Command 负责可发现、可校验的操作边界。

```text
业务函数 / Plugin 方法
  → Command：输入 schema、说明、执行
      → 可选 registry / argv
      → Agent tool
      → MCP tool
      → RPC 方法 → 受限 TypeScript 程序
```

| 决定         | 目标契约                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Command 定义 | `name`、`description`、`input`、`execute` 四项；handler 显式返回 `Result.ok(value)` / `Result.err(failure)` |
| 本地执行     | `execute(wireInput, context?) → Promise<Result<T, CommandFailure>>`；校验、业务拒绝和执行故障都可显式分支   |
| 静态类型     | 已知 Command 的参数、结果和必需 context 可检查；动态名称与协议输入仍在运行时校验                            |
| 多入口       | Agent、MCP、RPC 并列适配；不经过彼此，不自动镜像 root catalog                                               |
| Plugin 发布  | 载体绑定真实调用者 owner；作者不填写 owner ID，不复制 handler                                               |
| RPC 首版     | 只发布显式 Command 方法表；普通 DTO 往返，不开放任意类、getter 或业务子能力                                 |
| 程序编写     | 普通 `async/await`、`Promise.all`；HTTP 批次由客户端内部调度                                                |
| 授权         | RPC access 绑定具体契约；session 固定 publication generation；发现接口不授予权限                            |
| 生命周期     | 发布句柄同步撤销；会话异步关闭并等待工作退出；Plugin 长期资源归 effects                                     |

Command 是明确的受校验执行边界，作者和调用方使用同一 Result 契约；普通业务函数、SDK、会话创建和清理保留各自契约。
Result 使用现有 Better Result，不另造 `CommandResult`、抛异常的 `fail` 或平行的 `executeOrThrow`。
RPC 将本地 Result 投影为普通 DTO，Agent/MCP 转换为原生协议结果；投影不再次执行、不增加一层成功包装。

首版优先交付 Command 和直接工具。RPC 用于应用内受限 Agent；维护当前开发应用继续使用 devconsole。
任意 `RpcTarget` 对象图、子能力传递、跨 provider 能力归属和通用接口反射不属于首版；现有 Workbench 继续使用自己的原生 RPC 契约。

落地顺序为：Command 内核与现有消费者 → 各载体显式适配 → RPC 发布与隔离程序。Pi 只是可选的直接工具载体，不是 Command 或 RPC 的前置依赖。
RPC 的制品生成与隔离后端须先通过第 13 节的小规模验证，再实现完整管理与发现入口。
四字段定义、显式 Result、固定发布句柄和 owner 归属作为本轮实现基线，不再并行保留另一套作者 API。

## 2. 定义与调用

```ts
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const echo = defineCommand({
	name: 'text.echo',
	description: '返回输入的文本。',
	input: obj({ text: Type.String() }),
	execute({ text }) {
		return Result.ok(text)
	},
})

const textInfo = defineCommand({
	name: 'text.info',
	description: '统计文本的 Unicode 码点数量。',
	input: obj({ text: Type.String() }),
	execute({ text }) {
		return Result.ok({ length: [...text].length })
	},
})

const echoed = await echo.execute({ text: 'hello' })
if (echoed.isErr()) {
	console.error(echoed.error.code, echoed.error.message)
} else {
	console.log(echoed.value) // string：'hello'
}

await textInfo.execute({ text: '你好' }) // Result<{ length: number }, CommandFailure>

// @ts-expect-error 已知 Command 的 wire 参数必须正确。
await echo.execute({ tetx: 42 })
```

`input` 推导 wire 类型和 decoded 类型；定义中的 execute 接收 decoded 值，返回 Result 或 Promise<Result>。
公开 execute 接收 wire 值，统一返回 `Promise<Result<T, CommandFailure>>`；T 从 handler 的成功分支推导，包含同步、异步和 `Result.ok()` 的 void。
省略 context 仅对没有额外必需字段的命令合法。成功分支可以携带字符串、对象、数组或其他本地值；是否能跨协议交付由出口检查。

拟议的 `@pluxel/commands` 直接依赖仓库统一版本的 `better-result`，并原样再导出 `Result`，不包装或修改上游实现。
Commands 与 Core 仍彼此独立；Commands 不导入 `@pluxel/core/better-result`。Plugin 领域 API 继续使用现有 Core 子入口，
两处共享同一上游契约与版本。实现时验证类型互操作、ESM/CJS 发布入口与依赖解析，避免独立打包产生不兼容的 Result 副本。

类型检查不替代运行时校验。即使调用来自 JavaScript、`any` 或协议载体，也经过同一个输入入口：

```text
检查取消 / deadline → 检查严格 JSON、克隆、填默认值、校验 → Decode 一次
  → 检查取消 / deadline → handler → 校验 Result 形状 → 返回 Result
```

执行边界检查 Result 的合法形状，不校验或编码 Ok 内的业务值；四字段定义无需为本地成功值补输出 schema。
定义固定名称、说明、规范化 input 和 handler；返回的定义对象与 descriptor 只读，修改原 config 不改变已定义契约。

不提供公开的 `unknown` overload、`unsafeExecute` 或第二个执行方法。registry、argv 和载体在内部擦除具体输入类型后调用同一受校验函数；
它们接收 unknown 不表示存在未校验 handler。argv resolve 的动态 command 视图也不承诺知道具体参数类型。

定义不包含 `title`、顶层 `examples`、`validate`、`behavior`、`output` 或 `validateOutput`。
用途只写在必填 description；完整参数示例写在 input 对象 schema 的 examples，字段示例写在对应字段上。
普通参数无需凑示例。跨字段与业务检查进入 execute 或领域服务，展示标题归 UI，协议专属 metadata 归载体。

沿用[现有输入内核](../../packages/commands/docs/DESIGN.md)：按作者 schema 身份缓存编译结果，不修改作者对象；
投影、validator、codec 共用规范化结果；嵌套对象默认封闭；refs、defaults 和 metadata 在定义时检查；示例只验证 wire 数据，不执行 codec。
需要在 typed 调用中省略的字段应在 schema 中声明 Optional，不能指望运行时 default 改变 TypeScript 的必填性。

## 3. 显式失败、组合与可信 context

Command 的执行失败使用一个固定判别 union。`REJECTED` 的 reason 是业务内稳定的分支信号，说明中写明含义；
`INPUT_VALIDATION` 必须携带 issues。message 是可公开的安全说明；可选 cause 只供本地诊断，不进入模型或传输数据。

```ts
type CommandFailure = {
	readonly message: string
	readonly cause?: unknown
} & (
	| {
			readonly code: 'INPUT_VALIDATION'
			readonly issues: readonly {
				readonly path?: readonly (string | number)[]
				readonly code?: string
				readonly message: string
			}[]
	  }
	| { readonly code: 'REJECTED'; readonly reason: string }
	| {
			readonly code:
				| 'FORBIDDEN'
				| 'COMMAND_NOT_FOUND'
				| 'PUBLICATION_GONE'
				| 'ABORTED'
				| 'TIMEOUT'
				| 'DEPENDENCY'
				| 'INTERNAL'
				| 'OUTPUT_ENCODING'
				| 'OUTPUT_LIMIT'
	  }
)
```

作者声明可恢复的业务失败；输入内核、目录、owner 和载体在自己拥有的边界产生其他失败。
这个 union 为执行边界提供统一处理方式，不承诺每个入口都会产生所有 code，也不要求领域函数放弃自己的窄错误类型。

```ts
import type { CommandContext } from '@pluxel/commands'

interface NoteContext extends CommandContext {
	readonly actorId: string
	readonly store: {
		read(id: string, actorId: string, signal?: AbortSignal): Promise<string | null>
	}
}

const readNote = defineCommand({
	name: 'notes.read',
	description: '读取当前用户的笔记；不存在或不属于该用户时拒绝，reason 为 not_found。',
	input: obj({ id: Type.String({ minLength: 1 }) }),
	async execute({ id }, context: NoteContext) {
		const text = await context.store.read(id, context.actorId, context.signal)
		if (text === null) {
			return Result.err({
				code: 'REJECTED',
				reason: 'not_found',
				message: '笔记不存在',
			})
		}
		return Result.ok({ id, text })
	},
})

const note = await readNote.execute(
	{ id: 'missing' },
	{ actorId: 'alice', store: { read: async () => null } },
)
if (note.isErr()) {
	if (note.error.code === 'REJECTED' && note.error.reason === 'not_found') {
		console.log('可以提示用户选择其他笔记')
	} else {
		console.error(note.error.code, note.error.message)
	}
} else {
	console.log(note.value.text)
}
```

`actorId` 和 store 由可信调用方提供，模型只填写 id。作者不需要错误类、异常终止 helper 或另写错误 schema。
类型拒绝漏写 reason/issues；运行时也检查 Result 与失败形状，不依赖调用方遵守 TypeScript。不合法的返回值属于 INTERNAL，不能假装业务拒绝。

### 每类失败在哪一层结算

| 发生的事                                                     | 执行契约                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| 输入校验或 Decode 失败                                       | `Err(INPUT_VALIDATION)`，不进入 handler                          |
| 业务拒绝或跨字段检查失败                                     | handler 显式返回 `Result.err(...)`                               |
| 目录缺失、权限拒绝、发布失效                                 | 拥有该边界的 registry/carrier 返回对应 Err，协议载体再投影       |
| handler 前已取消 / 超时，或 handler 确认响应本次取消         | `Err(ABORTED/TIMEOUT)`；已返回的有效 Result 按下面的结算规则保留 |
| 未适配的 SDK rejection、handler throw 或 Better Result Panic | Command 返回 `Err(INTERNAL)`，原异常保留为 cause；载体记录故障   |
| 定义无效、发布安装失败、会话创建或清理失败                   | 保留各自配置和 lifecycle 异常契约，不能伪装成一次命令执行的 Err  |

execute 的正常结算路径覆盖上述执行失败，调用方不靠 try/catch 区分业务结果。INTERNAL 仍是须报告的 defect，不能归为可恢复业务拒绝。
纯 Commands 内核不隐式安装 logger；载体负责关联故障日志，本地直接调用由调用方的宿主监督并报告 cause。
这项承诺来自 Command 的监督实现，不来自 `Promise<Result<...>>` 类型；框架实现自身的缺陷仍可能 reject，由宿主故障边界报告。
新 handler 使用 Result 声明失败，throw 不再是作者声明预期拒绝的第二条路径；旧 CommandError 的执行用法在迁移时转换，配置与 argv 的原有异常边界另行保留。

作者只在理解语义时将 SDK 的已知失败映射为 REJECTED 或 DEPENDENCY；未知异常留给上述监督边界，不能 catch 整个 handler 后统一伪装成可重试。
局部适配遵守 [Better Result](../../docs/api/better-result.md)，需要保留未知异常时使用窄 try/catch；不使用会改变原异常语义的 catch mapper 重抛。
INTERNAL 的 cause 和 stack 留在本地，载体投影只选择公开字段；取消须有当前执行 signal/deadline 的依据，不能只凭异常 name 猜测。

### 取消请求不能覆盖已经取得的结果

deadlineMs 是绝对 Unix 时间戳；省略表示本层不增加 deadline，载体仍施加宿主上限。非法的可信 context（如 NaN deadline）是 INTERNAL。
每次执行合成调用方、owner 和有效 deadline 的取消信号；有效 deadline 取各层最早值，timer 和 listener 随实际调用退出释放。
直接本地 execute 同样将 deadline 接入 handler 的 signal，不只在函数前后看时间。实际 IO 必须接收 signal；它仍是协作取消，不强制中断业务。

| 时点 / 结果                 | 唯一结算规则                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- |
| 进入 handler 前             | 先观察既有取消，再检查是否到达 deadline；拒绝启动并返回相应 Err                     |
| handler 执行期间            | signal 通知停止，继续等待 handler 与其清理退出，不用 Promise.race 提前释放 owner    |
| handler 返回合法 Ok 或 Err  | 原样保留，包括已提交回执；后来观察到取消或超时不改写它                              |
| handler 因本次取消而 reject | 原因为当前 signal.reason，或由 SDK 接入明确识别为本次取消时，映射为 ABORTED/TIMEOUT |
| handler 因其他原因 reject   | INTERNAL 保留原始 cause；不能因 signal 同时 aborted 就把独立故障掩盖成取消          |

运行中的取消链保留首先确定的分类：调用方/owner 撤回为 ABORTED，框架 deadline 为 TIMEOUT。
调用方传入 Error 的 name/code 不改变分类；继承框架已合成的取消信号时保留其分类。
写入已经提交时，handler 应返回领域回执；只看到取消并不知道提交结果时，不能自行构造“未执行”或“可重试”的结论。
远程连接或沙盒先失效时，交付结果仍可能是 unknown；这与本地 Command 已经取得的业务 Result 分开记录。

### Result 组合只有一种默认写法

```ts
const echoInfo = defineCommand({
	name: 'text.echoInfo',
	description: '回显文本后统计其 Unicode 码点数量。',
	input: obj({ text: Type.String() }),
	async execute(input, context) {
		const echoed = await echo.execute(input, context)
		if (echoed.isErr()) return echoed
		return textInfo.execute({ text: echoed.value }, context)
	},
})
```

handler 和公开 execute 使用同一种 Result；合法结果直接交付，不执行 `Result.ok(handlerResult)`，也不被执行后的取消检查覆盖。
直接返回另一个 Command 的 Result 不产生双层包装。需要组合器时使用上游 map/andThen 等契约，不新增框架组合 DSL。
共享业务优先调用领域函数；领域已有 `Result<T, E>` 时显式将 E 映射为 CommandFailure，成功值只包一次。

成功的业务数据放在 `Result.ok(value)` 内，包括 `{ ok: false }` 和部分成功回执。框架不扫描 value 的字段推断执行成败，
也不自动 flatten 业务数据里的 Result；命令的结果作为另一命令的控制结果时应直接返回，而不是放进 Ok。
协议出口不能直接序列化 Result/Error 实例，详见第 10 节。

Err 是 fulfilled value；Promise.all 会等待全部命令，调用方逐项检查结果，不会因一个 Err 自动停止后续工作。
真正的 Promise rejection 也不会取消兄弟任务。业务须等待自行启动的 IO 退出；Result、取消和异常都不构成回滚。
取消可能发生在写入之后；调用方不能仅凭 Err 或 ABORTED、TIMEOUT、INTERNAL 判断可以重试。

## 4. 名称目录与用户输入

仅在需要按名称发现和执行时注册：

```ts
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
using registration = commands.register(echo)

commands.list()
await registration.execute({ text: 'hello' }) // Result<string, CommandFailure>，固定本次注册
await commands.execute('text.echo', { text: 'hello' }) // Result<unknown, CommandFailure>，按名称查找
await commands.execute('text.echo', { text: 42 }) // Err：INPUT_VALIDATION
```

registration 保留 name、不可变 descriptor、typed execute、dispose 和 Symbol.dispose。撤销后永久失效，同名重新注册不会复活旧句柄。
只有动态名称调用跟随当前发布。没有输出 schema 后，不再用相同输入契约推断替换实现仍返回旧类型。
名称缺失或手动撤销使用 COMMAND_NOT_FOUND；owner 停止的接纳失败使用 ABORTED。手动撤销不改写已接纳工作的结果。

Plugin 的 root catalog 仍使用 `ctx.require(Commands).register(command)`，仅接受 common CommandContext 命令，注册归 generation effects。
它不自动发布 Agent/MCP/RPC，也不能接收需要 NoteContext 的 readNote。registry 的 revision、缓存快照身份、有序重入通知和订阅者错误隔离继续保留。

```ts
import { createArgvRouter } from '@pluxel/commands/argv'

const router = createArgvRouter()
using binding = router.bind(echo, { routes: ['text echo'], positionals: ['text'] })
const resolved = router.resolve('text echo hello')
if (!resolved) throw new Error('Unknown command')
const executed = await resolved.command.execute(resolved.candidate)
if (executed.isErr()) console.error(executed.error.code, executed.error.message)
else console.log(executed.value)
```

argv 只解析语法并构造 candidate；无匹配与 ARGUMENT_SYNTAX 由 CLI/聊天载体呈现，stdout、exit code 和消息回复也归载体。
插件路由绑定受 owner mount 保护的 command，回复与错误呈现在该次调用内完成。

### ParseBox 仍是输入 Transform

```ts
import { Runtime } from '@sinclair/parsebox'
import { tail } from '@pluxel/commands/argv'

const grammar = new Runtime.Module({
	Filter: Runtime.Tuple(
		[Runtime.Const('warnings'), Runtime.Const('>='), Runtime.Integer()],
		([field, operator, threshold]) => ({ field, operator, threshold: Number(threshold) }),
	),
})

const query = Type.Transform(
	Type.String({ description: 'warnings >= 整数', examples: ['warnings >= 3'] }),
)
	.Decode((source) => {
		const parsed = grammar.Parse('Filter', `${source}\n`)
		if (parsed.length !== 2 || parsed[1].trim()) throw new SyntaxError('Invalid filter expression')
		return { source, expression: parsed[0] }
	})
	.Encode((value) => value.source)

const explainFilter = defineCommand({
	name: 'filter.explain',
	description: '解析告警次数筛选表达式。',
	input: obj({ query }),
	execute({ query }) {
		return Result.ok(query.expression)
	},
})

await explainFilter.execute({ query: 'warnings >= 3' })
using filterBinding = router.bind(explainFilter, {
	routes: ['filter'],
	tail: tail.text('query', '<expression>'),
})
```

本地、argv、Agent、MCP 和 RPC 都传字符串；只有 Command Decode 执行解析，不能提前 Decode 后再传一次。
解析器异常转换为安全的 INPUT_VALIDATION issue，原异常留作诊断。输入 Encode 仍属于 Transform 往返契约。
保留现有 argv 引号/转义、位置参数、options/aliases、默认值、`--`、tail.text/tail.json、help、建议、冲突检测与原子绑定；ParseBox 保持应用可选依赖。

## 5. 直接 Agent tool

以下 agent 是已配置模型后端的引擎。标准入口仍是异步 createSession；创建失败先清理部分资源，再 reject。

```ts
await using conversation = await agent.createSession({ tools: [echo, textInfo] })
const result = await conversation.prompt('统计“你好”的字数。')
```

Command 直接提供名称、说明、wire schema 和执行。SDK 不支持的 schema 在建立会话时拒绝；名称稳定映射，冲突拒绝，不偷偷改名。
输入 examples 从同一 schema 投影到 SDK 支持的位置；不能静默丢失，也不另写一份 prompt。
prompt 保留 Pi 原有 outcome、事件流、goal、受限 subagent、取消与等待退出；内置文件/shell 工具不会因此开启。

跨 Plugin 发布时使用引擎的显式目录：

```ts
using exposure = agent.expose(readNote, {
	context: ({ principal }) => ({ actorId: requireActorId(principal), store }),
})

await using conversation = await agent.createSession({
	principal: authenticatedUser,
	tools: ['notes.read'],
	authorize: ({ name }) => policy.allows(authenticatedUser, name),
})
```

例中的 store、authenticatedUser、policy 与 requireActorId 均由应用提供；第 7 节给出完整 Plugin 绑定。
`agent.tools()` 向可信宿主返回此载体的不可变工具描述，供选择和管理；模型只看到会话获准的工具。

`tools` 的两种元素有固定含义：Command 定义属于本次会话的临时发布；字符串只选择 `agent.expose()` 的已有发布，不查 root Commands。
创建时解析所有名称并固定其 generation，缺失或重名就失败。已发布工具使用自己的 context，不被会话的 context 覆盖；
直接定义使用会话 context，类型检查要求它满足全部直接定义。安装前完整验证，失败不留下部分工具。
同时选择多个直接 Command 时，context 满足它们全部业务字段的交集；类型从 tools 推导，不能由 context 反过来放宽 Command 要求。
只选择已发布名称时不接受会话 context 覆盖。缺失 tools 表示空直接工具集合，不隐式暴露目录中的其他工具。

每个会话的 tools 是固定上限。每轮模型请求前重算可见列表，每次工具调用再检查当前策略；已经发给模型的描述不能撤回，缓存 callback 不因此获得旧权限。
新的 publication 或新工具须进入新会话，旧回调不跟随同名替换。直接工具在会话内默认串行；领域服务仍负责跨会话互斥，子会话权限不超过父会话。

## 6. MCP 与载体共同约定

mcp 是已安装传输与认证的 MCP 载体。Command 仍只定义一次：

```ts
using echoTool = mcp.expose(echo)
using infoTool = mcp.expose(textInfo, {
	annotations: { readOnlyHint: true },
	outputSchema: obj({ length: Type.Integer({ minimum: 0 }) }),
})
using noteTool = mcp.expose(readNote, {
	context: ({ principal }) => ({ actorId: requireActorId(principal), store }),
})
```

MCP 先判断 Result。outputSchema 仅约束 Ok 内的成功业务值，并产生 structured content；没有它时，普通对象按 JSON 文本返回。
它校验 wire 数据，不填输出默认值；包含 TypeBox Transform 的输出 schema 明确拒绝，避免出现隐式输出 codec。
合法 JSON 不符合 outputSchema 时是载体的 INTERNAL，并记录 schema 诊断；非 JSON 成功值是 OUTPUT_ENCODING，体积超限是 OUTPUT_LIMIT。
它们都表示业务可能已完成，不能重新执行 handler 来尝试取得另一个输出。
annotations 使用 MCP 原生语义，不参与授权、重试或框架并发决策。Err 映射为 isError 和安全错误内容，连接取消保持 MCP 取消流程。
不能将一个 fulfilled Err 当成成功工具输出，也不能对 Result 实例直接 JSON.stringify。

Agent 的 expose/createSession、MCP 的 expose 和 RPC 的 publish 都遵循以下规则；类型由各入口推导，不要求作者学习通用载体基类：

| 选项           | 语义                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| context        | 每次调用构造业务扩展字段，可同步或异步返回；输入包含 principal、合成 signal 与 deadlineMs；有必需扩展字段时必填 |
| authorize      | 可选的当前访问判定，接收 principal、Command name 与 signal；同步或异步返回 boolean；同时用于发现与实际调用      |
| 省略 authorize | 不增加该级限制；仍执行宿主认证、会话上限及其他已配置权限                                                        |

context 返回的对象只包含业务字段；signal、deadlineMs、meta 由载体填写，类型和运行时都拒绝扩展字段覆盖它们。
这些保留字段在 factory 返回类型中显式禁止；不能只依赖对象字面量的 excess-property 检查。
可选业务字段不使 factory 变成必填；需要必需字段时，直接 expose、RPC 方法表与会话工具集合均在发布时检查对应要求。
先逐项推导业务字段再求交集，随后限制 factory 的推导方向；不能把只满足方法表某一项的 context 当成满足整个发布。
必需业务字段是宿主的 TypeScript 契约，运行时不反射接口或补生成 context schema；JavaScript/any 宿主仍须保证其构造正确。
context 只构造数据、借用已有能力，不执行业务写入或创建需要额外释放的资源；临时资源由 handler 使用 using/try-finally 管理。
context 构造后再进行本次操作的 authorize，构造期间尚未取得操作许可；它不能借准备阶段读取业务数据或提前执行命令。
principal 使用应用的原有身份对象，进入通用载体时为 unknown；应用负责验证，不新建统一用户模型。
authorize 是操作级权限；输入中的资源 ID 仍由领域服务执行对象级授权。多个生效的权限限制取交集；发现时 false 隐藏该操作，调用时 false 结算为 FORBIDDEN。
authorize/context 意外抛出则报告 INTERNAL；发现失败不返回一份冒充完整的部分授权列表。它们与 Command 执行共同处于载体监督范围内。

普通成功值不要求 renderer：字符串成为文本，JSON 数据成为 JSON 文本，void 使用载体固定的成功回复。
Err 按同一 CommandFailure 分类投影到 SDK/MCP 原生失败形式；未知异常只交付安全信息，cause 不公开。
特殊媒体结果使用实际 SDK 的原生接口，不在首版建立通用 result/project/renderer 抽象。

## 7. 一个完整 Plugin 发布

以下 `Mcp` 和 `Rpc` 是拟议新增的 `@pluxel/services/mcp`、`@pluxel/services/rpc` token；宿主显式安装所需服务，默认 preset 不自动启用。
PiAgentPlugin 保留现有 package root，新增 expose 和工具选择契约。示例宿主已经安装三项能力；只需要一种载体时删除其他发布即可。
readNote 与 NoteContext 使用第 3 节定义。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { PiAgentPlugin } from '@pluxel/pi-agent'
import { Mcp } from '@pluxel/services/mcp'
import { Rpc } from '@pluxel/services/rpc'

function requireActorId(principal: unknown): string {
	if (
		typeof principal !== 'object' ||
		principal === null ||
		!('id' in principal) ||
		typeof principal.id !== 'string' ||
		!principal.id
	) {
		throw new TypeError('Authenticated principal must contain a non-empty id')
	}
	return principal.id
}

@Plugin()
export class NotesPlugin extends BasePlugin {
	private readonly notes = new Map([['note-1', { ownerId: 'alice', text: '你好' }]])

	constructor(private readonly agent: PiAgentPlugin) {
		super()
	}

	protected override init() {
		const context = ({ principal }: { principal: unknown }) => ({
			actorId: requireActorId(principal),
			store: this,
		})
		this.agent.expose(readNote, { context })
		this.ctx.require(Mcp).expose(readNote, { context })
		this.ctx.require(Rpc).publish({ id: 'notes', commands: { read: readNote }, context })
	}

	async read(id: string, actorId: string, signal?: AbortSignal): Promise<string | null> {
		signal?.throwIfAborted()
		const note = this.notes.get(id)
		return note?.ownerId === actorId ? note.text : null
	}
}
```

载体从调用者的真实 Context 固定 publication owner；`this.agent` 的 caller-bound 接入固定 Agent provider 与 NotesPlugin 双方 owner。
服务 view 同样绑定调用者。不能从 Command 对象猜 owner，也不允许应用填写 owner ID。
Plugin `init()` 中没有 using：这些发布应活到 generation 结束，载体立即登记 effects。普通局部发布才使用 using。

principal 已由宿主认证；requireActorId 只校验其应用形状，不接受模型提交的身份声明。
这里的 TypeError 表示宿主身份契约配置错误，载体记录为 INTERNAL；正常访问拒绝由认证入口或 authorize 的 false 表达，不靠此异常分支。
Handler、身份检查和 DTO 投影都只有一份。store 是可信本地能力，不会进入 schema、发现文档或远程返回；RPC 只暴露 `notes.read`，不会把 NotesPlugin 的原型方法当成远程接口。

## 8. RPC 发布与授权

RPC 只接收显式方法表，键决定远程方法名，值必须是直接 Command 定义；不接收 registry 句柄、任意 RpcTarget、函数属性或嵌套对象。
发布时复制方法表，固定 descriptor、execute 和 receiver；修改原对象不改变已发布入口，更新需撤销后重新发布。
Cap’n Web HTTP batch 留在内部，作者只传 Command。

```ts
using publication = rpcService.publish({
	id: 'text',
	commands: { echo, info: textInfo },
})

await using session = await rpcService.createSession({
	principal: authenticatedUser,
	access: [publication.contract],
})
```

publication.contract 是只读普通数据 `{ id, hash }`。hash 由框架对规范化调用契约生成，覆盖 publisher 的宿主规范身份、API id、
方法名到 Command name 的绑定、wire 输入约束与默认值、成功值类型和 wire 协议版本。使用有版本的结构表示和确定性序列化，不依赖绝对路径、行号或构建时间。
不追求任意 schema/TypeScript 类型的语义等价；规范化结构不同的改写允许产生新 hash。
description、title、examples、`$comment` 等纯展示信息不进入授权 hash；它们改变时仍重建制品与发布描述。
排除的是 schema 对应位置上的 annotation，不是按字段名递归删除 JSON；名为 description 的业务属性、默认值和 enum/const 数据仍参与 hash。
只改文案的新 publication 可由新会话复用既有批准；已有会话依然固定旧 generation，不因此复活。作者不填写 hash，也不维护第二份接口。
publication 的 dispose / Symbol.dispose 撤销未来调用，不取消已接纳工作。
同一 RPC 载体中的 API id 必须唯一；重复发布在开放调用前拒绝，替换先撤销再重新发布。

创建 session 是可信应用的授权动作：access 必须为精确契约引用，不接受 `['text']`、通配符或“永远使用最新版本”。
应用持久策略保存被批准的 `{ id, hash }`，不能每次按 id 查最新 hash 来继承旧批准。持有 contract 数据本身不授予访问权；只有可信入口可以创建 session。

session 创建时核对全部契约并固定各 publication generation；任意缺失或不匹配即创建失败，不交付部分会话。
新增方法、扩大输入或改变绑定都会改变 hash，需要可信应用更新授权。旧 session 不跟随同名重发，即使 hash 相同也不复活；
新 session 可以使用仍匹配的既有批准。业务实现、权限和实际副作用的变化仍由可信 publisher 负责，hash 不证明语义等价。

`session.revoke(['text'])` 只缩权，撤销后不可恢复；重新授权创建新会话。应用当前权限还在每次接纳时检查，撤销不回滚已接纳工作。
principal 绑定本次会话的已认证身份，不通过修改共享对象切换用户；权限变化从应用策略读取。
调用先检查 session 的允许范围；范围外统一拒绝，不通过错误内容透露其他 API 是否存在。
这几项职责分别固定：契约说明允许调用什么，generation 说明哪次发布有效，领域权限说明用户此刻能操作哪些数据。

## 9. 发现后编写普通 TypeScript

```ts
await session.search({ query: '文本', limit: 5 })
const contracts = await session.describe({ apis: ['text'] })

const run = await executor.run({
	session,
	contracts,
	code: `
		const text = rpc.open('text')
		const echoed = await text.echo({ text: '你好' })
		if (!echoed.ok) return echoed
		return await text.info({ text: echoed.value })
	`,
})
if (run.isErr()) console.error(run.error.code, run.error.message)
else console.log(run.value) // { ok: true, value: { length: 2 } }
```

executor 是宿主已配置真实隔离 backend 的执行器，run 支持额外的 signal。它也是明确的执行边界，返回本地 `Result<JsonValue, RunFailure>`。
code 固定为 TypeScript async 函数体，允许 return，
注入受限 rpc；无任意 import、宿主 filesystem、process 或直接网络能力。标准语言对象与 Promise 正常使用。
编译时使用本次 contracts 的完整客户端类型；语法/类型错误在业务调用前返回稳定 code 与原始代码行列。
类型检查不承担隔离或授权，使用 any、动态属性访问或构造代码也不能绕过运行时方法表。

`rpc.open('text')` 同步取得本次 run 的逻辑 API 引用；不执行 IO、不授予权限、不暴露原生 RpcStub。
方法返回普通 Promise。值依赖正常 await，独立调用正常并发：

```ts
const text = rpc.open('text')
const results = await Promise.all([text.echo({ text: '你好' }), text.info({ text: '你好' })])
return results
```

客户端把同一调度轮内的独立调用合并为有界 HTTP batch。await 后的新调用使用后续请求，逻辑 API 引用仍可复用；原生 stub 的创建与释放留在内部。
批次只包含同一次 run 的调用，不跨 principal、session 或 run 合并；排队中的调用在实际发出前重新检查该 run 是否仍开放。
批次不是事务，不承诺并行调用的副作用顺序；需要顺序就 await。RPC 可显式并行，不继承直接 Agent 工具的串行默认。

脚本必须等待自己的工作。返回时仍有未完成 RPC，run 结算为 Err(RUN_PENDING_CALLS)，拒绝新调用并取消、等待已发出的操作退出。
运行结束后所有逻辑引用失效；返回值只能是有界 JSON，顶层 void/undefined 规范化为 null，不能携带函数、API 引用或后台任务。

发现接口固定如下：

| 入口     | 返回与边界                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| search   | 当前获准的 API ID、契约 hash 与匹配操作摘要；同一可见目录和 query 下排序稳定，默认 10 项、最多 50 项；结果标明是否还有匹配项 |
| describe | 所选 API 的不可变快照：id/hash、generation、方法说明、wire 输入、返回值、错误协议及完整客户端类型；未获准 API 不返回内容     |
| run      | 校验快照属于该 session 且仍匹配，再编译执行；Ok 携带程序的 JSON 值，控制失败返回 Err(RunFailure)；从不自动重放程序           |

describe 包含 rpc.open、方法和共享 RpcResult 的类型，Agent 不用猜 import 或自己补公共类型。
run 使用 session 内保存的发现记录复核快照，再提取方法允许表与声明；调用者提供的 hash 或声明文本本身不能作为授权依据。
省略未选 API，不静默截断所选接口；超预算明确拒绝并提示缩小选择。运行前已过期则拒绝；运行中发生撤销或 owner 停止时，逐次调用仍重新检查接纳。
每个 run 只开放此次快照中的 API 和方法；生效范围是快照、session access 与当前权限的交集，手写未选择的路径也不会获得访问。

需要模型载体时，应用可把同一 search、describe、run 流程包装为模型工具。载体应为每个 conversation 独立保存 describe 快照，并在每次 run 时捕获它；这属于可选集成，不是 Command 或 RPC 内核的依赖与当前交付 API。
若 conversation 借用 RPC session，关闭 conversation 只取消自己的 run，关闭 session 则取消所有借用者的工作。与直接工具并用时须共享该 session 的 principal，避免同一次对话混用两个用户。

## 10. 数据出口与不确定结果

RPC 方法把本地 Result 转换为一个普通 DTO；转换只消除运行时对象、投影安全失败字段并添加调用事实，沿用 CommandFailure 分类。
本地使用 isErr()，受限脚本使用 DTO 的 ok 判别；describe 给出完整声明，不要求远端安装 Better Result 或恢复 Error/Result 原型。

```ts
type RpcResult<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcFailure }
```

RpcFailure 的完整判别类型由同一失败定义生成：所有分支都有 `code`、`message`、`callId: string` 和
`outcome: 'not_started' | 'unknown'`；INPUT_VALIDATION 额外具有 issues，REJECTED 额外具有 reason。
仅这些字段进入 wire，cause、stack 和任意附加属性不参与投影。错误字段同样经过结构与预算校验，不能用对象展开或 toJSON 替代公开字段选择。
RPC 方法的 T 是 Command Result 内的成功值；不会生成 `RpcResult<Result<T, CommandFailure>>`。

outcome 描述能否确认 handler 尚未执行。首版采用可实现的保守规则：在网关尚未调用 Command.execute 时拒绝，才标记 not_started；
调用 execute 后的失败与交付故障一律为 unknown。INPUT_VALIDATION 也可能来自 handler 内跨字段检查，不能仅凭 code 推断未执行。
由当前调用状态生成 outcome，不继承嵌套命令的分类，不为追求更细状态新增公开执行方法或重复输入校验。
业务是否提交仍由领域回执说明。`Result.ok({ ok: false, succeeded, failed })` 中的回执位于 RPC 成功分支 value 内，不被框架拆解或冒充执行异常。

callId 在发送前生成，用于关联安全诊断；它不是幂等键。断线、隔离预算、会话取消等控制失败由 executor 结算为 Err(RunFailure)，
同时停止该 run 的新调用；脚本 catch 不能恢复已经关闭的执行范围。RunFailure 使用以下稳定分类：

| code                           | 含义与必要字段                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| CONTRACT_CHANGED / FORBIDDEN   | 快照失效或访问被拒绝；未发出的调用不执行                                  |
| CODE_SYNTAX / CODE_TYPECHECK   | 编译失败；diagnostics 包含安全 message 与原始代码从 1 开始的 line、column |
| RUN_PENDING_CALLS / RUN_SCRIPT | 未等待 RPC 或脚本未处理的异常；停止新调用并等待已接纳工作                 |
| RUN_TRANSPORT / RUN_LIMIT      | 传输失效或隔离预算耗尽；不能猜测远端未执行                                |
| ABORTED / TIMEOUT / INTERNAL   | 取消、超时或执行器故障；INTERNAL 在本地报告原始 cause                     |
| OUTPUT_ENCODING / OUTPUT_LIMIT | 程序输出不能交付；不重跑程序                                              |

每项 RunFailure 都有安全 message、`phase: 'prepare' | 'compile' | 'execute' | 'drain' | 'encode'` 和
`calls: readonly { callId: string; outcome: 'not_started' | 'unknown' }[]`；calls 覆盖本次 run 创建的调用，未发起 RPC 时为空。
outcome 只声明能否证明该 handler 未开始，不是提交回执；无法取得确认的已发送调用保守为 unknown。diagnostics 仅在两个编译分支必填。
类型由 executor 导出，框架自身未结算的缺陷仍交宿主故障边界；创建与关闭 executor/session 的异常不混入某次 run 的 Result。
run 的 Ok 仅表示程序完成并交付其 JSON 值，不表示返回值中的所有 RpcResult 都成功；此处的程序结果与方法结果拥有不同范围。

Agent/MCP 消费本地 Result 后保留各自原生成功与失败形式，同样区分输入错误、业务拒绝、未知故障、取消及输出失败；公开错误投影共用经过校验的安全字段。
协议失败和预算超限不重跑 handler，不截断 JSON 冒充成功。模型再次请求写入时仍需遵守业务幂等与确认规则，不能只依赖框架没有自动 retry。

默认 JSON 出口只接受有限数值、字符串、boolean、null、数组和普通数据对象；拒绝嵌套 undefined、BigInt、class、accessor、toJSON、循环和能力引用。
RPC 顶层 void/undefined 唯一规范化为 null，生成类型同步反映；除此之外不做隐式转换。输入和输出都有深度、节点数与字节预算。
有图片或 SDK 对象时由实际协议出口显式处理；敏感字段由业务选择，编码器不自动删字段。
通用工具出口不转移 native 资源的所有权；临时资源在 handler 内释放，长期资源归 owner，结果只返回 DTO 或业务 ID。
需要向本地调用者交付原生资源时使用已有领域 API 并说明清理责任，不能指望编码失败后载体替作者释放任意返回对象。

写入操作优先返回小型、稳定的领域回执。已存在 operation ID、查询接口或幂等键时直接复用；结果未交付时据此确认。
没有确认能力就报告状态不确定，不增加通用任务存储，也不承诺 exactly-once。

## 11. 接纳、清理与隔离

沿用 Services 的 [mount](../../packages/services/src/commands/mount.ts) 与 Core effects。每次调用的完整范围是：

```text
核对发布 / 会话 / access 上限 → 持有 provider 与 publication owner 调用占用
  → 构造独立业务 context → 检查当前权限 → 最终接纳检查 → Command 校验 / Decode / handler
  → 协议编码、异步呈现和发送或失败结算 → 释放调用占用
```

安装先验证并同步登记 carrier registration 与 effects，再开放调用；失败回滚，不让 SDK 提前调用 preparing 状态的入口。
owner 占用先保护可能访问 Plugin 资源的异步 authorize/context，它本身不等于业务已经接纳。
所有准备步骤完成后，同步复核 publication、session access、owner 与取消状态，再调用 Command.execute；复核与分派之间不插入 await。
异步 authorize 是本次外部策略判定的权威结果；策略自身负责判定一致性，强撤回同时关闭宿主 admission 或取消 owner。
准备期间发生的 dispose、session.revoke 或 owner stop 必须挡住 handler；通过最终接纳点之后，手动撤销与缩权不取消本次工作。
generation 停止则关闭 admission、abort 并等待真实工作退出，再释放业务资源。发现时执行的 authorize 也要持有相同的资源保护。
载体不得只 mount 裸 handler，把 context 构造、编码或回复放到保护范围外。每次调用只校验/Decode 一次。

| 资源                                                             | 释放与所有权                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Command 定义、借用的 store/executor                              | 引用不转移所有权                                                                    |
| registry 注册、argv binding、Agent/MCP exposure、RPC publication | dispose 与 Symbol.dispose 共用幂等同步撤销；Plugin 发布同时登记 owner effects       |
| Agent conversation、RPC session                                  | dispose 与 Symbol.asyncDispose 共用一次异步关闭；拒绝新工作、取消并等待所属任务退出 |
| RPC 请求与隔离程序                                               | executor 跟踪其发出的全部请求，关闭不只等待脚本的返回 Promise                       |

同步撤销路径 no-throw；后台清理失败进入所属载体诊断。异步清理失败正常传播，并发/重复关闭等待同一次过程。
Symbol.dispose 必须接在最外层 owner 句柄上，不能绕过 Services 的 guard 清理。await using 按逆序关闭，先 conversation 后 RPC session。

沙盒的停止不等于服务端工作退出。session/executor 通过受认证的执行标识请求取消、等待服务端已接纳调用结算；
无法确认远端退出时，关闭不能报告成功，服务端 owner 仍保留真实调用占用。忽略 signal 的业务不具备强制中断保证。

隔离后端必须实际约束宿主访问、网络、内存、时间与 RPC 数量；Node vm、普通 worker 和 TypeScript 检查都不充当安全沙盒。
宿主安装时提供有限的执行预算，缺项或后端不能强制关键上限就拒绝启用；作者的 Command 不暴露这些调度参数。
协议另有描述、输入、输出、队列和并发上限。上限在首个后端验证中定值并文档化，不提供无界默认。
未安装 RPC/Agent/MCP 时不创建网关、模型客户端或沙盒。RPC 网关只读取接口制品；仅启用代码执行时，由显式 executor 提供受预算约束的类型检查器与隔离运行器。
构建工具不进入 Core 或常规 Services 求值路径。

## 12. RPC 制品与首版范围

RPC 方法表与描述制品由同一份发布声明产生。Pluxel 构建/开发工具在类型擦除前读取静态 commands 方法表、Command 输入和 Result 成功分支类型，
生成 runtime 方法允许表与完整客户端声明；运行时只加载制品并绑定真实发布。RPC 源码开发使用既有 Vite/Rolldown 通道，发行包随包携带制品。
普通 Command、registry、argv 和直接工具不因此需要 RPC 编译步骤。

构建工具按真实 import/type 来源识别 publish 与 Command，给实际发布点注入内部制品关联；不扫描运行中对象，也不执行应用工厂来猜类型。
发布时将实际固定的方法表、Command 名称和规范化输入与制品绑定并核对；不能仅用 API id 或授权 hash 查到某份 .d.ts 就放行。
制品的内部完整性校验包含实现绑定与说明等生成内容，和前述稳定授权 hash 各司其职，不再暴露第二个作者填写的版本字段。
运行时只保证 Result/协议 envelope 和严格 JSON；TypeScript 的成功值声明不是自动生成的业务 output validator，领域实现继续拥有这些不变量。

首版支持静态方法表、可解析的 Command 引用以及 JSON DTO 返回类型；字段级输入 Transform 使用 wire 类型。
跨包 DTO 必须有可解析的声明；不支持的动态方法表、任意类对象图、函数/能力返回和无法闭合的类型在构建或发布时拒绝，不猜成 any。
有意返回 unknown 的数据可以保留 unknown，调用方自行缩小；出口仍做 JSON 校验。已知不支持的 Date/BigInt 等类型在适配时拒绝。

方法名冲突和原型/then 等保留名称在发布前拒绝。制品必须匹配实际 id、方法表、Command 定义与协议；缺失或过期不能仅凭同名对象绑定。
底层生成的 RpcTarget 只承载允许表中的方法，业务对象不进入原生 RPC 分派；不能把 TypeScript private 或“没有写进文档”当成访问限制。

首版不提供任意接口反射、toCapnweb、业务 RpcTarget 工厂、嵌套能力或公开 rpc.batch。
业务资源通过普通 ID 参数选择并在领域服务授权。只有真实任务证明这些方式不足时，才另行设计资源对象协议；不会提前保留一个尚未解决生命周期的高级入口。

## 13. 实施与验收

### 开工边界与第一条完整路径

先迁移现有 Commands、Services mount 和真实调用方：一个带必需 context 的查询、一个返回提交回执的写入、一次可恢复拒绝和一次 SDK 故障。
连同 argv、管理命令及旧输出消费者在第一阶段闭合迁移；新 API 不以“旧执行器外面套 Result.tryPromise”实现，取消、返回值和接纳结算必须一起调整。
第 7 节的三载体 Plugin 是最终组合示例；第一条路径只安装当前交付的载体，不等待 MCP/RPC 完成。

RPC 开工前在临时验证中证明以下三件事，验证失败时保持后续 RPC 入口未开放，继续交付直接工具：

1. 一个跨包 Command 的 wire 输入与 Result 成功类型可生成精确客户端声明；变更绑定能拒绝旧制品，纯文案改动不改变授权 hash。
2. 一个选定且有实际支持版本的隔离后端能阻止宿主/网络访问、终止超时与超内存脚本；停止脚本后仍能跟踪并等待已发出的服务端工作。
3. 实际 Cap’n Web HTTP 通道支持顺序 await 与并行调用；run 结束不遗留原生 stub，断线不重放，有界批次不串会话。

隔离后端、支持平台和具体预算在第二项验证产物中定值，进入正式配置与运维文档后才实现第 4 阶段。
本文不把一个尚未选定和验证的 sandbox 记为已经解决；RPC 的成本不能阻塞 Command 作者面的简化。

### 必须保留的回归断言

| 场景                                                | 必须观察到                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| 已取消输入 / deadline 到期                          | handler 未进入；得到明确 Err                                       |
| 写入返回回执时 signal 已 aborted                    | 本地仍交付原 Result；不丢失 operation ID 或提交事实                |
| SDK 故障与取消同时发生                              | 独立故障仍是 INTERNAL，原 cause 可追踪                             |
| authorize/context 等待期间撤销发布或 session access | 准备步骤退出后拒绝分派，handler 不执行，owner 占用最终释放         |
| factory 缺少任一 Command 的必需字段                 | 发布处类型报错；不能因数组、变量或返回对象多字段而绕过保留字段约束 |
| handler 返回 INPUT_VALIDATION / 外层转发子命令 Err  | RPC 不凭错误 code 或子命令状态声称本次 handler 未执行              |
| 修改描述 / 新增 RPC 方法                            | 前者保持授权 hash、更新制品；后者改变 hash，旧批准不能扩大权限     |
| 业务字段或默认值也叫 description / examples         | 它们仍参与授权 hash，不能被当作 annotation 删除                    |

### 分阶段交付

| 阶段                | 交付内容                                                                                                  | 必须通过                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1. Command 与调用方 | 四字段定义、typed execute 与 Better Result、CommandFailure、固定注册句柄、using；同时迁移执行与输出消费者 | 成功值推导、失败缩小、必需 context、错误参数/裸返回值拒绝、无双层包装、取消保留回执与 cause、ParseBox 与 argv 回归 |
| 2. 载体适配         | 可选的真实 SDK 直接工具、MCP expose、完整 Plugin 发布与当前权限检查                                       | owner 归属、SDK schema/示例、名字冲突、输出失败、缓存回调缩权、呈现期间停止、异步创建失败清理                      |
| 3. RPC 发布与发现   | 静态方法表、制品、精确契约授权、session generation 固定、远端结果协议                                     | 编译声明与允许表一致、未批准方法拒绝、新方法不扩权、旧 session 不复活、JSON 出口与回执                             |
| 4. 受限程序         | 一个真实隔离后端、普通 Promise 客户端、内部 HTTP batching、run 的 Result 契约                             | 类型诊断、预算强制、未等待调用、远程取消/退出及断线不重放                                                          |

删除 output/validateOutput/OUTPUT_VALIDATION 时，同一交付完成[管理命令](../../packages/services/src/management/commands.ts)、
[Package Manager](../../plugins/package-manager/src/index.ts)、[ReportStudio](../../projects/plugin-host/src/showcase/ReportStudio.ts)及 SDK 消费者迁移。
保留状态快照、生命周期报告、部分成功回执和显式 DTO 投影；业务输出不变量归领域实现，协议转换归出口。
同一阶段将 handler 的成功返回改为 Result.ok，将预期 CommandError 拒绝改为 Result.err；消费方先处理 Err，再使用 value。
宿主取消、owner 接纳与输入内核的既有异常在各自边界转换，保留原始 cause。清理仍在 finally/effects 中，不能因为 Err 不再 reject 而跳过。
检查所有 catch、Promise.all、缓存和 SDK callbacks 的旧假设；Err 不触发 catch、不会 fail-fast，也不能默认按成功值缓存或呈现。
Commands 的 Better Result 依赖与 Core 共享版本并验证已发布包互操作；正式 Better Result 指南的 Command 边界说明与示例随实现一起迁移。
删除 behavior 的同时迁移 Pi 并发默认与所有 descriptor 消费者，不留下无法运行的中间版本。

旧 AgentTools 的 Toolset/assignment 和执行入口已按破坏性重构删除，不保留平行 Command API。独立的 `local-projects/chatbot` 原来把 Command 当 CLI 使用，现已将 Command 定义、调用、carrier 与管理 UI 迁移到新的 Result/descriptor 契约；若需要命令行参数解析，使用 Commands argv 入口。应用需要的授权由实际载体显式表达，不迁入旧 Toolset/assignment 存储。
ConfigService 继续拥有配置持久化；不新增统一策略存储。每个阶段同步正式 docs 与公共包 changelog。

任务验收至少包含：编写普通命令、接一个会 reject 的 SDK、注入用户 context、读取后修改、处理部分成功、缩权和 HMR 后再调用。Command、RPC 和隔离程序使用确定性调用方直接验证契约；接入具体 LLM 及比较任务成本属于载体验证，不作为内核完成条件。
权限绕过、重复写入和清理遗漏不能由平均性能收益抵消。RPC 阶段未通过时不开放该能力，已完成的直接工具独立交付。

本版的临时声明级探针使用 TypeScript 7.0.2、现有 TypeBox 与 Better Result 3.0.1 验证 Result 成功值推导、失败分支缩小、
参数错拼/类型错误拒绝、wire/decoded 区分、必需 context、裸返回值与不完整错误拒绝、固定句柄类型及无双层包装的组合。
上游运行时探针另验证了直接转发、Promise.all 对 Err 的结算、部分成功回执保留、Panic 的 cause 与显式安全 DTO 投影。
本轮补充的载体声明探针覆盖必需/可选 context、异构工具数组和方法表、预声明变量、异步 factory、保留字段及 root catalog 约束。
独立调用现有内核复现了“写入回执被后置取消检查覆盖”和“独立 SDK 故障被取消分类掩盖”；第 3 节结算规则是对此的明确设计变更，实施时须迁移相关旧断言。
这些探针验证拟议签名与所用库的行为，不证明 Command 监督实现、已发布包互操作或载体集成完成。
既有源码与测试是输入内核、argv 和 owner 行为的保留基线；RPC 制品、内部批处理和隔离仍按上述阶段验收。
