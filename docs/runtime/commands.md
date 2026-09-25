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

已知 Command 的 `execute()` 检查 wire 参数类型；来自 JavaScript、`any`、argv 或模型的输入仍在运行时校验。它统一返回 `Promise<Result<T, CommandFailure>>`，T 从 handler 的成功分支推导。省略 context 只适用于没有额外必需 context 字段的 Command。

成功值可以是字符串、对象、数组或 `void`。本地执行不要求 output schema，也不编码成功值。载体负责将它投影到自己的协议，并验证该出口能否交付。

`input` 必须是 object schema。`obj()` 与嵌套的普通 `Type.Object()` 默认拒绝多余属性；协议确需开放对象时使用 `openObj()`。字段的 description/examples 写在 schema 字段上，完整输入示例写在 input 对象 schema 的 examples。需要在 TypeScript 调用中省略的字段应声明 `Type.Optional()`，不能只依赖运行时 default。

`Type.Transform()` 以 JSON wire 值进入 Command，经过一次 Decode 后交给 handler。定义时检查 refs、defaults 和 schema metadata；输入无效或 Decode 失败得到带 `issues` 的 `INPUT_VALIDATION`。跨字段或领域检查进入 handler，作为显式的业务拒绝。

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

`REJECTED.reason` 是稳定业务分支信号，`message` 面向人。`CommandFailure` 还区分输入错误、权限、发布撤销、取消、超时、依赖或内部故障。SDK 的已知领域拒绝可以在 handler 内映射；未知 rejection 由 Command 监督为 `INTERNAL`，原异常保留在本地 cause。配置错误和发布安装失败仍按各自生命周期契约抛出。

handler 和公开 `execute()` 使用同一种 Result。组合另一个 Command 时，检查它的 Err 后可以直接返回该 Result；不要包装为 `Result.ok(result)`。`Err` 是 fulfilled value，`Promise.all()` 不会因其中一个 Err 提前失败。Command 不扫描成功值里的 `ok` 字段，也不替业务处理部分成功回执。

`signal` 与 `deadlineMs` 是可信 context 的控制字段；`deadlineMs` 是绝对 Unix 毫秒时间戳，较远的截止时间也会在实际到期时触发。进入 handler 前已取消或超时会阻止执行；执行中的取消通知 handler 并等待其退出。框架 deadline 的 `TIMEOUT` 分类经信号组合和嵌套 Command 调用仍保留；普通调用方取消归为 `ABORTED`。handler 已返回的合法 Result 保留，即使写入后 signal 才变为 aborted，也不会覆盖提交回执。实际 IO 应接收 context.signal。

可信 context 无法读取或展开时，执行返回 `INTERNAL` 并在本地 cause 保留原异常；owner 停止或取消信号触发时返回 `ABORTED`。

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

`@pluxel/services/management/commands` 的 `managementCommands()` 显式安装管理命令；`servicesPreset()` 选择它，通用 Commands 服务本身不会启动管理面。注册到 root 不会自动向 Agent、MCP、HTTP 或其他载体暴露。

## argv 与载体

```ts no-twoslash
import { createArgvRouter } from '@pluxel/commands/argv'

const router = createArgvRouter()
using binding = router.bind(echo, { routes: ['text echo'], positionals: ['text'] })
const resolved = router.resolve('text echo hello')
if (resolved) {
	const result = await resolved.command.execute(resolved.candidate)
	if (result.isErr()) console.error(result.error.message)
	else console.log(result.value)
}
```

argv 只解析 grammar 并构造 candidate，Command 才执行输入校验和 Decode。router 支持 routes、aliases、位置参数、options、默认值、`--`、tail、help 和建议；语法错误由调用它的 CLI 或消息载体呈现。Host carrier 可通过 `createMount()` 固定 provider 与发布者 owner，并在整个处理、回复和清理期间保留接纳。

Pi Agent 用 `createSession({ tools: [...] })` 明确选择直接 Command 或已发布名称，详见 [Pi Agent](../plugins/pi-agent.md)。MCP 与 RPC 分别通过[显式 MCP 服务](./mcp.md)和[显式 RPC 目录](./rpc.md)发布指定 Command；受限程序执行仍在内部验收。在线检查现有 Host 请使用[开发控制台](../development/dev-console.md)。

## 公开入口

- `@pluxel/commands`：`defineCommand`、`Result`、`CommandFailure`、registry 与类型。
- `@pluxel/commands/typebox`：`Type`、`obj`、`openObj`。
- `@pluxel/commands/argv`：argv router、tail 与相关类型。
- `@pluxel/services/commands`：Host 的 Commands token、服务与 carrier mount。
