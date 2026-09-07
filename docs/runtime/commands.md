---
title: Commands 与 Agent 集成
description: 定义一次命令契约，再复用于统一注册表、可选 Agent Plugin、CLI、HTTP 和 Workbench。
---

`@pluxel/commands` 让可携带的业务命令只定义一次输入、输出、副作用等级和执行函数，再由调用方显式发布到 Agent、CLI、HTTP、Workbench 或 carrier。只属于某个 carrier 的命令也使用同一条校验和错误管线，但可以要求该 carrier 构造的扩展 Context，不必进入 root catalog。

在快速开始生成的工作区根目录运行下面命令，选择定义 command 的插件包，然后安装更新后的依赖：

```sh
pnpm catalog:add -- @pluxel/commands
pnpm install
```

已有、不使用 catalog 的项目可以在对应包目录运行 `npx nypm add @pluxel/commands`。

只在多个入口需要复用同一个业务操作时定义 command。普通插件方法可以继续直接调用；HTTP 路由见 [插件 HTTP](./http.md)，Agent 权限配置见 [Agent tools](../plugins/agent-tools.md)。

## 1. 定义一个 command

```ts twoslash
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

async function readJobStatus(_jobId: string): Promise<'running' | 'stopped' | 'failed'> {
	return 'running'
}

// ---cut---

export const jobStatus = defineCommand({
	name: 'job.status.get',
	title: 'Job status',
	description: 'Read the current status of one job.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({
		jobId: Type.String({
			description: 'Stable job identifier.',
			examples: ['cache-refresh'],
		}),
	}),
	output: obj({
		status: Type.Union([Type.Literal('running'), Type.Literal('stopped'), Type.Literal('failed')]),
	}),
	examples: [
		{
			title: 'Running job',
			input: { jobId: 'cache-refresh' },
			output: { status: 'running' },
		},
	],
	async execute({ jobId }, context) {
		context.signal?.throwIfAborted()
		return { status: await readJobStatus(jobId) }
	},
})
```

`behavior` 描述 discovery、confirmation 和 audit policy 使用的静态最坏情况，不授予权限：

- query 声明 `world: 'closed' | 'open'`；
- mutation 还必须声明 `destructive` 和 `idempotent`；
- carrier/host 仍负责 principal、permission、确认、rate limit、credential 和 audit。

如果成功没有业务数据，省略 `output` 并让 `execute()` 返回 `void`。若调用方需要 `changed`、状态或新 ID，就显式声明 output；未声明 output 却返回值会成为 `OUTPUT_VALIDATION` fault。

## 在插件中发布并验证

在插件 `init()` 中注册上面的 definition：

```ts no-twoslash
this.ctx.commands.register(jobStatus)
```

先直接执行一次，验证完整的输入校验与业务结果：

```ts no-twoslash
const result = await jobStatus.execute({ jobId: 'cache-refresh' })
// result.status === 'running'
```

然后在 [开发控制台](../development/dev-console.md) 读取宿主的 command catalog，确认存在 `job.status.get`。注册只让命令进入可发现清单；是否暴露给 Agent、HTTP 或消息平台是各入口独立的配置。

## 2. Schema 是唯一公开输入协议

command 的 `input` 必须是 object schema。可携带 command 的顶层字段是所有目标 carrier 共用的参数，不要再为 Agent、CLI 或 HTTP 维护另一套近似 schema；carrier route 只投影这些字段，不复制 schema。

```ts twoslash
import { Type, obj, openObj } from '@pluxel/commands/typebox'

const input = obj({
	retryCount: Type.Optional(Type.Integer({ minimum: 0, default: 3 })),
	labels: Type.Array(Type.String()),
	metadata: openObj({}),
})
```

`obj()` 以及嵌套的普通 `Type.Object()` 默认拒绝额外属性；只有额外 JSON key 本身就是协议时才使用 `openObj()`。公开 wire value 必须是严格 JSON，不能包含 function、`BigInt`、`Date` 实例、非有限数、cycle 或 class instance。

需要在实现中使用领域类型时，用 JSON-backed `Type.Transform()`：wire schema 仍是字符串/数字等 JSON，Decode 后的值才进入 `validate` 和 `execute`，output 则先 Encode 再校验。可复用引用应使用自包含的 `Type.Module().Import()`；裸 `Type.Ref()` 因 descriptor 没有外部 reference registry，会以 `COMMAND_CONFIG` 拒绝。

字段级 `description`/`examples` 用于解释单个值；command `examples` 表达完整、transport-neutral 的 input/output。不要把 argv 拼写或大段 JSON 塞进 command description。

## 3. 执行与错误契约

```ts no-twoslash
import { CommandError } from '@pluxel/commands'

try {
	const value = await jobStatus.execute(
		{ jobId: 'cache-refresh' },
		{ signal, deadlineMs: Date.now() + 5_000 },
	)
	console.log(value.status)
} catch (error) {
	if (error instanceof CommandError) console.error(error.code, error.publicMessage)
}
```

raw command 的 `execute()` 是唯一 validation/codec/business pipeline：它完整执行 wire JSON 检查、schema validation、Decode、自定义 validation、handler、Encode 和 output validation，失败统一抛 `CommandError`。Carrier 可以在这个 pipeline 得到已校验 output 后执行自己的 presenter，但不能复制或绕过它。`deadlineMs` 在 pipeline 阶段之间检查；IO 取消要求实现观察 `context.signal`。

需要向 carrier 暴露可预期失败时抛 `CommandError`：

```ts no-twoslash
import { CommandError, validation } from '@pluxel/commands'

throw new CommandError('INPUT_VALIDATION', 'Invalid command input', {
	details: {
		issues: [validation.constraint('jobId', 'Job does not exist', { code: 'not_found' })],
	},
})
```

稳定 code 包括 `COMMAND_CONFIG`、`COMMAND_NOT_FOUND`、`ARGUMENT_SYNTAX`、`INPUT_VALIDATION`、`OUTPUT_VALIDATION`、`FORBIDDEN`、`ABORTED`、`TIMEOUT`、`DEPENDENCY` 和 `INTERNAL`。carrier 按 `code` 分支、向用户展示 `publicMessage`；`message`、`cause` 和 diagnostics 只进入可信日志。`kind` 将配置、输出、依赖和内部错误归为 `fault`，其余归为 `expected`。

## 4. Root catalog 与 lifecycle-neutral registry

独立 host，或确实需要 name discovery 的 provider-private catalog，使用 factory 创建 registry：

```ts no-twoslash
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
const registration = commands.register(jobStatus)

commands.list() // 冻结、按名称排序的 descriptor
commands.snapshot() // { revision, descriptors }
await commands.execute('job.status.get', { jobId: 'cache-refresh' })
await registration.execute({ jobId: 'cache-refresh' }) // 保留精确 output 类型

registration.dispose() // 幂等撤销后续查找与发现
```

不要 `new CommandRegistry()` 或 subclass；需要注解时只 `import type`。`register()` 返回可执行的 typed installed command 与 `dispose()`；动态 name dispatch 无法推导具体 output，因此 `commands.execute()` 返回 `unknown`。`snapshot()` 在 catalog 未变时复用同一 immutable identity，`list()` 就是其 `descriptors`；`subscribe()` 只通知之后成功的 publication/withdrawal。Installed handle 是一个会按 name/schema 跟随 compatible replacement 的 catalog slot，不能作为 carrier route 的固定 registration identity。

Pluxel Plugin 应使用 `this.ctx.commands.register(jobStatus)`。Runtime 原样委托 registry 的 list/snapshot/subscribe/execute，只在 registration 上增加 Plugin owner gate 与 generation effects ownership。stop、replacement、rollback 和 shutdown 会撤销 publication；Core 在 owner 离开 running generation 时统一关闭新 invocation、abort call/owner 组合 signal，并等待已接纳调用退出。手动 dispose 只撤销未来 publication，不取消已经进入执行的调用，也不关闭同 owner 其他 command 的 admission。

## 5. Carrier publication mount

拥有 argv router、平台 SDK callback 或其他领域 publication surface 的 provider，可以创建一个 owner-bound mount。Mount 是 carrier 实现 primitive，不是普通 consumer 的注册 API。Carrier package 应先用自己的纯 definer 把 direct command、syntax、presenter 和静态 policy 包成领域 declaration，再只公开单参数 `registerCommand(declaration)`：

```ts no-twoslash
const echoOnMessage = defineMessageCommand({
	command: echo,
	syntax: { routes: ['echo'], positionals: ['text'] },
	present: (output, { reply }) => reply(output.text),
})

class ConsumerPlugin extends BasePlugin {
	constructor(private readonly messages: MessagePlugin) {
		super()
	}

	override init() {
		this.messages.registerCommand(echoOnMessage)
	}
}
```

Provider 内部才把 declaration 投影成包含 presenter/error rendering 的 direct command，并交给 mount；这些阶段必须在 mounted `execute()` 返回前完成：

```ts no-twoslash
import type { CommandContext, Registration } from '@pluxel/commands'
import { createArgvRouter } from '@pluxel/commands/argv'
import { BasePlugin, type CommandMount } from '@pluxel/runtime'

interface MessageCommandContext extends CommandContext {
	readonly reply: (text: string) => Promise<void>
}

class MessagePlugin extends BasePlugin {
	private readonly router = createArgvRouter<MessageCommandContext>()
	private mount!: CommandMount<MessageCommandContext>

	protected override init() {
		this.mount = this.ctx.commands.createMount<MessageCommandContext>()
	}

	registerCommand<I, O>(definition: MessageCommandDefinition<I, O>): Registration {
		const router = this.router
		const projected = projectMessageCommand(definition)
		return this.mount.bind(projected, (owned) => router.bind(owned, definition.syntax))
	}
}
```

`defineMessageCommand()`、`MessageCommandDefinition` 与 `projectMessageCommand()` 在这里代表 carrier 自己拥有的领域 API/实现，不是 Runtime export。普通 consumer 只调用 provider 定义的 definer 与 `registerCommand()`，不直接取得 mount，也不传裸 Context。dependency facade 读取 provider 的 mount field 时，Runtime 自动固定 publication owner。每次执行同时受 provider 与 publication owner generation gate 保护，任一方 stop/replacement 都拒绝新调用，并取消、drain 已接纳调用。手动 dispose 只撤销未来 publication，不取消已经开始的调用。

扩展 Context 是每次调用创建、只含 enumerable own data property 的结构化 capability record，不使用 class prototype 或 non-enumerable field。`reply` 等函数成员应使用闭包，不依赖 Context 对象作为 `this`；Runtime 会复制该 record，并在不修改调用方对象的前提下用 provider、publication owner 与 call signal 的组合结果替换 `signal`。

`bind()` 只接受 `DirectCommand`：普通 `defineCommand()` 结果可以直接挂载，registry `register()` 返回的 `InstalledCommand`/`CommandRegistration` 不可以。后者会按 name 和 schema 跟随 compatible replacement，不适合作为一条 route、presenter 和 owner generation 的固定 identity。这个限制在 TypeScript 中是 misuse guard；Runtime 仍做运行时校验。

Mount 在 bind 时复制、冻结 name/descriptor snapshot，并捕获当时的 `execute` 函数与原 command receiver。之后替换 `command.execute` 不会改变已挂载实现，但 hand-authored method 仍取得原 receiver；“direct”不代表 deep-freeze receiver 的其他可变状态。Direct definition 也不能带 `dispose` member，lifecycle cleanup 只属于 publication registration。

Mount 的 `install` 必须同步返回一个幂等、同步、no-throw 的 `Registration`。Mount 只管理 exact command、双 owner admission 与撤销事务，不提供 list/snapshot/subscribe/name lookup，也不建立 secondary registry。Carrier 的 route syntax、admission、invocation context、success presenter 和 error renderer 留在 carrier；会触碰 invocation capability 的阶段必须在 mounted command 返回前 settle。Root catalog publication 与 carrier publication 是两个独立决定：需要同时暴露时，分别调用 `ctx.commands.register(raw)` 与 carrier 的 `registerCommand(definition)`。

## 6. Agent tool 投影与 allowlist

普通 host 从同一 descriptor snapshot 生成 provider 自己的 tool 描述：

```ts no-twoslash
const visible = commands.list().filter((descriptor) => policy.allows(descriptor.name))
const tools = visible.map((descriptor) => provider.projectCommand(descriptor))
```

provider adapter 自己映射 name、title、description、input/output JSON Schema 和 `behavior`。MCP annotation、task support、provider 重命名与反向 name mapping 都是 carrier 契约，不是 command kernel 的公开概念。

需要持久化 Agent allowlist 时安装可选官方 Plugin `@pluxel/agent-tools`。Toolset 与 Agent assignment 是它的普通 Plugin config：ConfigService 负责校验、持久化和通用配置页面，Runtime 不安装 Agent capability，也不维护第二套 policy store 或 Management RPC。

```ts no-twoslash
import { AgentToolsPlugin } from '@pluxel/agent-tools'

const catalog = agentTools.catalog(agentId)
const tools = catalog.list().map((descriptor) => provider.projectCommand(descriptor))
const result = await catalog.execute(toolName, candidate, invocationContext)
```

Agent adapter 应是通过 constructor required dependency 取得 `AgentToolsPlugin` 的普通 Plugin。发布和执行必须使用同一个 bound catalog；它会在调用时再次检查 assignment，并提供包含 `catalogRevision`/`policyRevision` 的 snapshot 与订阅能力。Plugin stop/replacement 后旧 catalog 立即撤销。adapter 不应在收到 tool call 后绕过它调用裸 `ctx.commands.execute()`。

Toolset 只保存稳定 command name，不复制 descriptor 或 handler。暂时不存在的 name 会保留在 config，之后同名 command 发布时自动进入投影。MCP、OpenAI、Claude 等 provider schema、tool name 映射、principal、确认与审计仍由 adapter 自己负责。完整用法见 [Agent tools Plugin](../plugins/agent-tools.md)。

需要直接内置 Agent engine 时，workspace preview [`@pluxel/pi-agent`](../plugins/pi-agent.md) 会把同一个
bound catalog 投影给 Pi，并保持 Pluxel 作为唯一 Plugin runtime 与权限边界。

## 7. argv/message grammar

只有确实需要人类友好的 route、alias、positionals 或 tail 时才使用自定义 router。下面是 standalone/router primitive 用法；Runtime Plugin carrier 应在 provider 内把 `CommandMount` 给出的 `owned` command 绑定到 router，而不是让普通 consumer 直接绑定 raw/installed command：

```ts no-twoslash
import { createArgvRouter } from '@pluxel/commands/argv'

const argv = createArgvRouter()
argv.bind(jobStatus, {
	routes: ['job status', 'status'],
	positionals: ['jobId'],
})

const resolution = argv.resolve(process.argv.slice(2))
if (resolution) {
	await resolution.command.execute(resolution.candidate)
}
```

把 shell 已 tokenized 的 `string[]` 原样传入；不要先 `join(' ')`，否则会丢失 quoting 边界。raw chat/message 文本可以直接传 string，由 router tokenize 一次。

`createArgvRouter().bind()` 只把已有 object fields 映射为语法：

- `routes`：第一项是 canonical route，其余为 alias；最长前缀匹配；
- `positionals`：每项消费一个 token；
- `options`：可改 long name、aliases 和 help，未列出的标量仍生成 option；
- `tail.text(key)`：把余下文本交给 string-backed field；
- `tail.json(key)`：把余下文本解析成一个 JSON value。

string、number、integer、boolean、string enum 和 scalar array 可自动成为 option。object、union 等复杂字段不会被猜测，必须显式设置 `{ format: 'json' }`。positionals/tail/options 不能重复占用同一字段，冲突和 unsupported schema 会在 `bind()` 时以 `COMMAND_CONFIG` 失败。

```ts no-twoslash
argv.bind(patchConfig, {
	routes: ['settings patch'],
	positionals: ['scope'],
	options: { patch: { format: 'json' } },
	tail: tail.text('reason', '[reason]'),
})
```

`resolve()` 只负责 route match 与 candidate 构造；carrier 再完成授权、context 组装、mounted `command.execute()` 与结果呈现。`list()` 提供 frozen metadata 给 host 自己的 help/completion renderer。默认大小写不敏感、文本上限 16 KiB，unknown option 和 enum typo 会给出稳定 suggestions；unknown route 不会在 policy 过滤前泄漏其他 command。

## 公开入口

| 需求                               | 入口                                  |
| ---------------------------------- | ------------------------------------- |
| Plugin 发布到 root catalog         | `this.ctx.commands.register(command)` |
| Carrier provider 建 publication 面 | `this.ctx.commands.createMount()`     |
| 独立 host 建 catalog               | `createCommandRegistry()`             |
| Agent allowlist                    | `agentTools.catalog(agentId)`         |
| 自定义 route/positionals/tail      | `createArgvRouter().bind()`           |

carrier 负责授权、确认、principal 映射、输出格式和进程退出码；command definition 与 runtime registry 不承担这些宿主策略。
