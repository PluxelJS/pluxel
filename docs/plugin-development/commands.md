---
title: Commands 指令系统
description: 定义具备类型校验、错误契约与自省元数据的操作，并发布到命令行、MCP 或 RPC 载体。
---

`@pluxel/commands` 提供了一套结构化的指令抽象。如果你正在构建可被控制台命令行、AI Agent（MCP 协议）或图形界面调用的统一业务动作，使用 Command 可以将参数校验、类型解码与执行逻辑规范化地组织在一起。

每个 Command 包含四个核心部分：
- `name`：全局唯一的命名空间标识（例如 `notes.read`）；
- `description`：可被人或 AI 理解的功能描述；
- `input`：基于 TypeBox 的强类型输入 Schema；
- `execute`：执行业务逻辑并返回强类型的 `Result`。

## 定义与执行指令

```ts twoslash
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

// 1. 定义指令
export const echoCommand = defineCommand({
	name: 'text.echo',
	description: '回显传入的文本内容。',
	input: obj({
		text: Type.String({ description: '待回显的文本' }),
	}),
	execute({ text }) {
		return Result.ok(`Echo: ${text}`)
	},
})

// 2. 直接调用指令
const result = await echoCommand.execute({ text: 'Hello Pluxel' })

if (result.isErr()) {
	console.error('Execution failed:', result.error.message)
} else {
	console.log(result.value)
}
```

`execute` 方法会自动在运行时校验传入的入参是否符合 Schema。如果输入不合法，将返回包含具体错误细节的 `INPUT_VALIDATION` 失败结果。

### 用 Parsebox 解析文本语法

在控制台或自然语言交互中，有时需要支持自定义文本语法过滤（例如 `level >= 3`）。可以在输入 Schema 中配合 `Type.Transform()` 与 `@sinclair/parsebox`：

```ts no-twoslash
import { Runtime } from '@sinclair/parsebox'
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

// 1. 定义语法规则
const filterGrammar = new Runtime.Module({
	Filter: Runtime.Tuple(
		[Runtime.Const('level'), Runtime.Const('>='), Runtime.Integer()],
		([, , threshold]) => Number(threshold),
	),
})

// 2. 将字符串自动解码为结构化对象
const filter = Type.Transform(Type.String())
	.Decode((source) => {
		const parsed = filterGrammar.Parse('Filter', source.endsWith('\n') ? source : `${source}\n`)
		if (parsed.length !== 2 || parsed[1].trim()) throw new Error('Invalid filter syntax')
		return { threshold: parsed[0] }
	})
	.Encode((value) => `level >= ${value.threshold}`)

export const searchPlayers = defineCommand({
	name: 'players.search',
	description: '根据等级过滤玩家。',
	input: obj({ filter }),
	execute({ filter }) {
		return Result.ok({ minLevel: filter.threshold })
	},
})
```

如果外部传入了不合法的文本语法，解码失败会自动转化为标准的校验错误（`INPUT_VALIDATION`），避免进入业务逻辑。

## 上下文感知（Context）

对于需要访问当前用户身份、数据源连接或取消信号的指令，可以定义对应的上下文类型：

```ts twoslash
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

interface NoteContext extends CommandContext {
	readonly userId: string
	readonly getNote: (id: string) => Promise<string | null>
}

export const readNote = defineCommand<NoteContext>()({
	name: 'notes.read',
	description: '读取用户笔记内容。',
	input: obj({ id: Type.String() }),
	async execute({ id }, ctx) {
		const note = await ctx.getNote(id)
		if (!note) {
			return Result.err({
				code: 'REJECTED',
				reason: 'not_found',
				message: `Note ${id} not found`,
			})
		}
		return Result.ok(note)
	},
})
```

## 载体集成：CLI、MCP 与 RPC

定义好的 Command 可以无缝映射到多种外部载体，无需重写业务逻辑：

1. **命令行载体（CLI Argv）**：指令的 `input` Schema 会自动转换为 CLI 选项（`--text`）与位置参数；
2. **Model Context Protocol（MCP）**：通过 `@pluxel/commands/mcp`，将指令目录一键暴露给 Claude、Cursor 等 AI 客户端作为 Tools；
3. **RPC 服务**：通过 `@pluxel/commands/capnweb`，将指令发布为网络 RPC 接口。
