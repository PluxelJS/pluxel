---
title: Commands
description: 定义受校验的操作，并按需发布到命令目录或载体。
---

`@pluxel/commands` 定义可发现、可校验的操作。普通业务复用仍可使用函数或 Plugin 方法；需要命令目录、argv 或工具入口时再定义 Command。Command 只有 `name`、`description`、`input`、`execute` 四项。输入 schema 是公共 wire 契约，handler 接收解码后的值并显式返回 Better Result。

在插件包安装 `@pluxel/commands`：

```sh
pnpm catalog:add -- @pluxel/commands
pnpm install
```

## 定义和调用

```ts twoslash
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

const result = await echo.execute({ text: 'hello' })
if (result.isErr()) console.error(result.error.code, result.error.message)
else console.log(result.value)
```

已知 Command 的 `execute()` 检查 wire 参数类型；来自 JavaScript、`any`、argv 或远程调用的输入仍在运行时校验。它统一返回 `Promise<Result<T, CommandFailure>>`，T 从 handler 的成功分支推导。省略 context 只适用于没有额外必需 context 字段的 Command。

`@pluxel/commands` 再导出的 `Result` 与 `@pluxel/core/better-result` 的 `Result` 来自同一个上游包。需要组合函数等完整 API 时，从 [Better Result 共享入口](../api/better-result.md) 导入；Command 的 Result 无需另行转换。

成功值可以是字符串、对象、数组或 `void`。本地执行不要求 output schema，也不编码成功值。载体负责将它投影到自己的协议，并验证该出口能否交付。

`input` 必须是 object schema。`obj()` 与嵌套的普通 `Type.Object()` 默认拒绝多余属性；协议确需开放对象时使用 `openObj()`。字段的 description/examples 写在 schema 字段上，完整输入示例写在 input 对象 schema 的 examples。需要在 TypeScript 调用中省略的字段应声明 `Type.Optional()`，不能只依赖运行时 default。

`Type.Transform()` 以 JSON wire 值进入 Command，经过一次 Decode 后交给 handler。定义时检查 refs、defaults 和 schema metadata；输入无效或 Decode 失败得到带 `issues` 的 `INPUT_VALIDATION`。跨字段或领域检查进入 handler，作为显式的业务拒绝。

### 用 Parsebox 解析文本语法

Command 不绑定特定语法解析器。需要自定义文本语法时，在输入字段的 `Type.Transform()` 中调用 Parsebox；argv、Cap’n Web 和直接调用仍提交同一个字符串。应用需自行安装 `@sinclair/parsebox`。

```ts no-twoslash
import { Runtime } from '@sinclair/parsebox'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const filterGrammar = new Runtime.Module({
	Filter: Runtime.Tuple(
		[Runtime.Const('level'), Runtime.Const('>='), Runtime.Integer()],
		([, , threshold]) => Number(threshold),
	),
})

const filter = Type.Transform(Type.String())
	.Decode((source) => {
		const parsed = filterGrammar.Parse('Filter', source.endsWith('\n') ? source : `${source}\n`)
		if (parsed.length !== 2 || parsed[1].trim()) throw new Error('Invalid level filter')
		return { source, threshold: parsed[0] }
	})
	.Encode((value) => value.source)

const search = defineCommand({
	name: 'players.search',
	description: '按等级筛选玩家。',
	input: obj({ filter }),
	execute({ filter }) {
		return Result.ok({ minimumLevel: filter.threshold })
	},
})

const result = await search.execute({ filter: 'level >= 3' })
if (result.isErr()) {
	if (result.error.code === 'INPUT_VALIDATION') console.error(result.error.issues)
} else console.log(result.value.minimumLevel) // 3
```

解析失败由 Decode 抛出，Command 返回 `INPUT_VALIDATION`；语法通过后，handler 收到已解析的 `filter`。argv router 只构造输入候选，不另行调用 Parsebox。

## 失败与组合

```ts twoslash
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

interface NoteContext extends CommandContext {
	readonly actorId: string
	readonly read: (id: string, actorId: string, signal?: AbortSignal) => Promise<string | null>
}

const readNote = defineCommand({
	name: 'notes.read',
	description: '读取笔记；不存在时 reason 为 not_found。',
	input: obj({ id: Type.String() }),
	async execute({ id }, context: NoteContext) {
		const text = await context.read(id, context.actorId, context.signal)
		return text === null
			? Result.err({ code: 'REJECTED', reason: 'not_found', message: '笔记不存在' })
			: Result.ok({ id, text })
	},
})

const result = await readNote.execute({ id: 'one' }, { actorId: 'alice', read: async () => null })
if (result.isErr() && result.error.code === 'REJECTED') console.log(result.error.reason)
```

## 发布为 Cap'n Web 方法

`@pluxel/commands/capnweb` 的 `toCapnweb()` 从明确选择的 Command 生成原生 `RpcTarget` class。构造时传入服务端可信 context；远端只传每个方法的输入。生成的方法位于 prototype，可嵌入原生 Cap'n Web 对象树。

```ts no-twoslash
import { toCapnweb } from '@pluxel/commands/capnweb'

const Notes = toCapnweb({ read: readNote })
const notes = new Notes({ actorId: 'alice', read: async () => 'note text' })
```

方法返回 `{ ok: true, value }` 或 `{ ok: false, error }`，保留 Command 的失败 `code`、公开 `message`、输入问题和业务 `reason`，不传递本地 `cause`。`void` 成功值成为 `null`；其他成功值必须是普通 JSON 数据，无法按 Cap’n Web 编码格式表示时返回 `OUTPUT_ENCODING`。适配器拒绝以 `Object.prototype` 的属性名或 `toJSON` 命名的输入字段和输出数据键；Cap’n Web 传输会丢弃它们，动态键输入也不得依赖这些名字。会话可以施加额外的消息预算；授权、会话和传输由创建 `RpcTarget` 的应用负责。Cap’n Web HTTP batch 会话仅承载一次请求；后续调用应建立新会话，持续交互可选用宿主已有的 WebSocket 接入。

`REJECTED.reason` 是稳定业务分支信号，`message` 面向人。`CommandFailure` 还区分输入错误、权限、发布撤销、取消、超时、依赖或内部故障。SDK 的已知领域拒绝可以在 handler 内映射；未知 rejection 由 Command 监督为 `INTERNAL`，原异常保留在本地 cause。配置错误和发布安装失败仍按各自生命周期契约抛出。

handler 和公开 `execute()` 使用同一种 Result。组合另一个 Command 时，检查它的 Err 后可以直接返回该 Result；不要包装为 `Result.ok(result)`。`Err` 是 fulfilled value，`Promise.all()` 不会因其中一个 Err 提前失败。Command 不扫描成功值里的 `ok` 字段，也不替业务处理部分成功回执。

`signal` 与 `deadlineMs` 是可信 context 的控制字段；`deadlineMs` 是绝对 Unix 毫秒时间戳，较远的截止时间也会在实际到期时触发。进入 handler 前已取消或超时会阻止执行；执行中的取消通知 handler 并等待其退出。框架 deadline 的 `TIMEOUT` 分类经信号组合和嵌套 Command 调用仍保留；普通调用方取消归为 `ABORTED`。handler 已返回的合法 Result 保留，即使写入后 signal 才变为 aborted，也不会覆盖提交回执。实际 IO 应接收 context.signal。

可信 context 无法读取或展开时，执行返回 `INTERNAL` 并在本地 cause 保留原异常；owner 停止或取消信号触发时返回 `ABORTED`。

## 投影为 MCP Tool

`@pluxel/commands/mcp` 的 `toMcp()` 返回原生 MCP `Tool` 描述和 `call()` 函数，不创建 server 或发布工具。应用把 `tool` 放入自己的工具列表，并在 SDK 的 `tools/call` handler 中按名称选择它；每次调用由应用传入可信 context。

```ts no-twoslash
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { toMcp } from '@pluxel/commands/mcp'

const noteTool = toMcp(readNote)
const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [noteTool.tool] }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
	if (params.name !== noteTool.tool.name) throw new Error('Unknown tool')
	return noteTool.call(params.arguments ?? {}, {
		actorId: 'alice',
		read: async () => 'note text',
		signal: extra.signal,
	})
})
```

上例由应用创建并连接 `Server`，实际 context 应从已认证的请求构造。`noteTool.call()` 返回 `CallToolResult`：成功值编码为 JSON 文本块；失败设置 `isError: true`，文本只包含公开的 `code`、`message`、输入问题或业务 `reason`，不传递本地 `cause`。无法无损编码的成功值返回 `OUTPUT_ENCODING`。应用负责工具选择、认证、权限、会话、传输及清理；如需绑定 Plugin generation，使用下文 carrier mount 的 `handle` 把调用与协议呈现放入同一次 owner 保护。单独对 mounted endpoint 调用 `toMcp()` 只保护 endpoint 的 execute，后续编码仍由外层 carrier 负责。

## 名称目录和 Plugin owner

只有需要按名称发现或调用时才注册：

```ts no-twoslash
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
using registration = commands.register(echo)
const known = await registration.execute({ text: 'hello' })
const dynamic = await commands.execute('text.echo', { text: 'hello' })
```

`registration` 有不可变 descriptor、typed execute、`dispose()` 和 `Symbol.dispose`。撤销后旧句柄永久失效；同名重新注册不会让它复活。动态名称执行跟随当前目录，并返回 `Result<unknown, CommandFailure>`。目录保留 revision、快照和订阅能力。

Host 用 `@pluxel/services/commands` 的 `commands()` 安装空 root 目录，Plugin 通过 `this.ctx.require(Commands).register(command)` 发布。注册归当前 owner generation 的 effects，停止 Plugin 会撤销发布并等待已接纳的调用退出。root 目录只接受 common `CommandContext`；需要业务扩展 context 的 Command 由对应载体构造 context 并显式发布。

`@pluxel/services/management/commands` 的 `managementCommands()` 显式安装管理命令；`servicesPreset()` 选择它，通用 Commands 服务本身不会启动管理面。注册到 root 不会自动向 HTTP 或其他载体暴露。

## argv 与载体

```ts no-twoslash
import { createArgvRouter, toCli } from '@pluxel/commands/argv'

const cli = toCli(echo, { routes: ['text echo'], positionals: ['text'] })
const router = createArgvRouter()
using binding = router.bind(cli)
const resolved = router.resolve('text echo hello')
if (resolved) {
	const result = await resolved.command.execute(resolved.candidate)
	if (result.isErr()) console.error(result.error.message)
	else console.log(result.value)
}
```

`toCli()` 在定义端校验 Command 的 argv 语法并生成不可变投影；`router.bind()` 只发布投影并检查路由冲突。argv 只解析 grammar 并构造 candidate，Command 才执行输入校验和 Decode。router 支持 routes、aliases、位置参数、options、默认值、`--`、tail、help 和建议；语法错误由调用它的 CLI 或消息载体呈现。Host carrier 可通过 `createMount()` 固定 provider 与发布者 owner；下面的 `handle` 在处理与回复期间保留接纳。

需要把选定 Command 作为 Cap’n Web 方法时，使用显式适配入口；在线检查现有 Host 请使用[开发控制台](../development/dev-console.md)。

## Carrier 的处理与生命周期

Carrier 实现者用 `mount.bind(command, { install, handle? })` 发布一个确定的 Command。`install` 同步安装路由并返回 `{ name, dispose }`；调用方 generation 拥有撤销。省略 `handle` 时直接执行 Command，carrier context 必须满足其必需字段。

需要授权、构造业务身份或异步回复时，在 `handle` 中完成。它接收已快照的 Command、未经校验的 `unknown` candidate 和本次 carrier context；可以构造不同的业务 context，并返回不同的成功类型。整个 callback 都处于 provider 与发布者的 invocation 内：停止会拒绝新调用、发出取消并等待 callback 退出，然后清理资源。

```ts no-twoslash
import { Result, type CommandContext } from '@pluxel/commands'
import { createArgvRouter, toCli } from '@pluxel/commands/argv'
import { Commands } from '@pluxel/services/commands'

interface ReplyContext extends CommandContext {
	readonly reply: (text: string) => Promise<void>
}

// 在 carrier provider 的 init 中创建；通过 provider 方法发布时保留 caller binding。
const mount = this.ctx.require(Commands).createMount<ReplyContext>()
const router = createArgvRouter<ReplyContext>()
const registration = mount.bind(echo, {
	async handle(command, candidate, context) {
		// 类型断言不跳过 Command 内部的运行时校验与 Decode。
		const result = await command.execute(candidate as { text: string }, context)
		if (result.isErr()) {
			await context.reply(result.error.message)
			return Result.err(result.error)
		}
		await context.reply(result.value)
		return Result.ok()
	},
	install(endpoint) {
		return router.bind(toCli(endpoint, { routes: ['echo'], positionals: ['text'] }))
	},
})
```

`handle` 必须返回 Result；未知异常和非法 Result 变为 `INTERNAL`，匹配 owner/caller 取消原因的 rejection 变为 `ABORTED`。合法回执保持原样。将 `context.signal` 与 `deadlineMs` 继续传给 Command 和实际 IO；mount 的 owner 保护不替代 Command 的 deadline 监督，也不保证客户端已经收到网络响应。

`install` 得到 `MountedCommand`，它具有固定 descriptor、typed execute 和 `mounted: true` 标记。它可以交给 router 或协议投影，但不能作为新的 direct definition 再次 mount。`bind()` 返回的 registration 只负责撤销发布。手动 dispose 不取消已接纳的 callback；旧 endpoint 不会因同名重新发布而复活。

需要在自定义载体定义时固定 descriptor 和 execute，可用 `snapshotCommand(command)`，不必创建临时 registry。快照验证描述结构、冻结分离的 descriptor、固定 execute 并保留原 receiver；它不重新编译 schema、不添加执行监督，也不赋予独立生命周期。已发布句柄的快照仍跟随原发布撤销，并保留禁止重新 mount 的标记。

业务方法继续拥有自己的 `Result<T, E>` 与领域回执。在 Command handler 中把需要公开的拒绝映射为 `CommandFailure`，不要为了统一工具错误改写 SDK 回执或业务模型。普通领域组合直接调用业务方法。

## 公开入口

- `@pluxel/commands`：`defineCommand`、`snapshotCommand`、`Result`、`CommandFailure`、registry 与类型。
- `@pluxel/commands/typebox`：`Type`、`obj`、`openObj`。
- `@pluxel/commands/argv`：`toCli()`、argv router、tail 与相关类型。
- `@pluxel/commands/capnweb`：选定 Command 到原生 Cap’n Web 方法；需要可选 `capnweb` peer。
- `@pluxel/commands/mcp`：选定 Command 到 MCP Tool；SDK 仅用于类型，不加载 Cap’n Web。
- `@pluxel/services/commands`：Host 的 Commands token、服务与 carrier mount。
