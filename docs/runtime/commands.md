---
title: Commands 与 Agent tools
description: 定义一次命令契约，再复用于注册表、Agent tools、CLI、HTTP 和 Workbench。
---

`@pluxel/commands` 让一条命令只定义一次输入、输出、副作用等级和执行函数，再安全地暴露给 Agent、CLI、HTTP 或 Workbench。不同入口共享同一份校验和错误契约，不需要各自重写参数解析。

```sh package-install
npx nypm add @pluxel/commands
```

```text
untrusted JSON / argv
  -> Command input schema
  -> defaults + Decode + validate
  -> execute(decoded input, context)
  -> Encode + output validation
  -> structured result or CommandError
```

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

## 2. Schema 是唯一公开输入协议

command 的 `input` 必须是 object schema。顶层字段是所有 carrier 共用的参数，不要再为 Agent、CLI 或 HTTP 维护另一套近似 schema。

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

## 3. 直接执行与错误契约

```ts no-twoslash
const result = await jobStatus.execute(
	{ jobId: 'cache-refresh' },
	{
		signal,
		deadlineMs: Date.now() + 5_000,
		meta: { principalId: 'operator-42' },
	},
)

if (result.ok) {
	console.log(result.value.status)
} else {
	console.error(result.error.code, result.error.publicMessage)
}

const value = await jobStatus.executeOrThrow({ jobId: 'cache-refresh' })
```

两种调用都会经过完整验证。`executeOrThrow()` 将相同的失败结果转换为 throw。`deadlineMs` 在 pipeline 阶段之间检查；IO 取消要求实现观察 `context.signal`。

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

## 4. Registry：唯一 catalog

独立 host 或 carrier 使用 factory 创建 registry：

```ts no-twoslash
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
const registration = commands.register(jobStatus)

commands.get('job.status.get')
commands.list() // 冻结、按名称排序的 descriptor
await commands.execute('job.status.get', { jobId: 'cache-refresh' })
await commands.executeOrThrow('job.status.get', { jobId: 'cache-refresh' })

registration.dispose() // 幂等撤销后续查找与发现
```

不要 `new CommandRegistry()` 或 subclass；需要注解时只 `import type`。动态 name 查找无法推导具体 output，因此 registry dispatch 返回 `unknown`；应用内需要静态 output 类型时直接调用原 command object。

Pluxel Plugin 应使用 `this.ctx.commands.register(jobStatus)`。Runtime 把 registration 绑定到 Plugin generation effects：stop、replacement、rollback 和 shutdown 会撤销 publication，并在 owner 离开 running generation 时关闭新 invocation、组合 call/owner signal、等待已接纳调用退出。手动 dispose 会撤销未来发现，并让此前缓存到的 runtime command wrapper 在后续新调用中返回 `COMMAND_NOT_FOUND`；它不会取消已经进入执行的调用，也不会关闭同 owner 其他 command 的 admission。

## 5. Agent tool 投影与 allowlist

普通 host 可从同一 descriptor snapshot 生成 provider-neutral tool 描述：

```ts no-twoslash
import { toToolDescriptors } from '@pluxel/commands/tool'

const visible = commands.list().filter((descriptor) => policy.allows(descriptor.name))
const tools = toToolDescriptors(visible)
```

投影保留 name、title、description、input/output JSON Schema，并从 `behavior` 生成 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。单次 awaited execution 声明 `taskSupport: 'forbidden'`。provider 重命名 tool 时必须保留反向 name mapping，并把执行派回原 catalog。

Runtime host 需要持久化 Agent policy 时使用 `ctx.root.agentTools`：Toolset 保存稳定 command names，Agent assignment 保存 Toolset IDs。没有 assignment 的 Agent 默认看不到任何命令；暂时不存在的 name 会保留在 policy，之后同名 command 发布时重新生效。

```ts no-twoslash
const catalog = await ctx.root.agentTools.catalog(agentId)
const tools = toToolDescriptors(catalog.list())
const result = await catalog.execute(toolName, candidate, invocationContext)
```

发布和执行必须使用同一个 bound catalog。它会在调用时再次检查 assignment，并提供包含 `catalogRevision`/`policyRevision` 的 snapshot 与订阅能力。Agent carrier 不应在收到 tool call 后绕过它调用 `ctx.root.commands.execute()`。

## 6. 默认 argv projection

已安装的 CLI carrier 可直接投影 live catalog：

```ts no-twoslash
import { createCommandArgv } from '@pluxel/commands/argv'

const argv = createCommandArgv(commands)
await argv.dispatchOrThrow(['job.status.get', '--job-id', 'cache-refresh'])
```

`createCommandArgv()` 使用精确 command name 作为首 token，标量字段生成 named options，复杂字段使用 field-level JSON。它每次从 live catalog 解析当前 command，按 command handle 惰性缓存单命令 router，不复制第二份 registry。

这个 adapter 不创建 executable、不授权、不确认 destructive action，也不决定 stdout 或 exit code。仓库中的 `pluxel` CLI 是构建/开发工具，并不会自动连接某个运行中 host。

## 7. 自定义 argv/message grammar

只有确实需要人类友好的 route、alias、positionals 或 tail 时才使用自定义 router：

```ts no-twoslash
import { createArgvRouter, tail } from '@pluxel/commands/argv'

const argv = createArgvRouter()
argv.bind(jobStatus, {
	routes: ['job status', 'status'],
	positionals: ['jobId'],
})

await argv.dispatchOrThrow(process.argv.slice(2))
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

`resolve()` 只返回 route、candidate 和 raw args；`dispatch()` 返回 `CommandResult`；`dispatchOrThrow()` 抛 `CommandError`；`list()`/`help()` 提供 frozen metadata 给 host 自己的 help renderer。默认大小写不敏感、文本上限 16 KiB，unknown route/option 和 enum typo 会给出稳定 suggestions。

## 公开入口

| 需求                          | 入口                                   |
| ----------------------------- | -------------------------------------- |
| Plugin 发布能力               | `this.ctx.commands.register(command)`  |
| 独立 host 建 catalog          | `createCommandRegistry()`              |
| Agent/MCP descriptor          | `toToolDescriptors(catalog.list())`    |
| Runtime Agent allowlist       | `ctx.root.agentTools.catalog(agentId)` |
| catalog 的保守 CLI 投影       | `createCommandArgv(catalog)`           |
| 自定义 route/positionals/tail | `createArgvRouter().bind()`            |

carrier 负责授权、确认、principal 映射、输出格式和进程退出码；command definition 与 runtime registry 不承担这些宿主策略。
