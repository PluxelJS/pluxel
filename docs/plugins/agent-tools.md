---
title: Agent tools
description: 用可选官方 Plugin 把统一 command catalog 安全投影给外部 Agent adapter。
---

`@pluxel/agent-tools` 用于需要把一部分 Pluxel commands 暴露给外部 Agent 的应用。它是普通、可停用的
官方 Plugin，不是宿主服务：只有把它加入 host catalog 并启动后，才会存在 Toolset、assignment 和受限 catalog。

以下命令在快速开始生成的工作区根目录执行；按 [添加插件](./index.md#把一个插件加入应用) 选择直接使用依赖的包，再运行 `pnpm install`。

```sh
pnpm catalog:add -- @pluxel/agent-tools @pluxel/commands @pluxel/core
```

## 配置 Toolset 与 Agent

Toolset 保存稳定 command name，Agent 得到所分配 Toolset 的并集。没有 assignment 的 Agent 默认没有任何命令：

在 [应用入口](./index.md#把一个插件加入应用) 的 配置工厂 返回值中加入下面的配置记录，并把 `AgentToolsPlugin`、命令提供者和 adapter 加入 `plugins` 清单。让 adapter 自动启动，它的构造函数依赖会启动 Agent Tools。

```ts no-twoslash
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { pluginNodeAddressOf } from '@pluxel/core'

const agentToolsRecord = {
	owner: pluginNodeAddressOf(AgentToolsPlugin),
	config: {
		toolsets: [
			{ id: 'notes-read', label: 'Notes read', commandNames: ['notes.read'] },
			{ id: 'notes-write', label: 'Notes write', commandNames: ['notes.create'] },
		],
		agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['notes-read'] }],
	},
}

// 合入 配置工厂 的其他配置和已有记录：
// configRecords: { initial: [agentToolsRecord] }
```

`notes.read` 与 `notes.create` 是你的业务命令，必须先由对应插件注册，定义方式见 [Commands](../runtime/commands.md)。配置由 ConfigService 校验、持久化与更新，也可以在 Workbench 的通用配置页编辑。

Workbench 启用时，插件还会发布只读 Agent tools 页面，分组展示当前 commands、Toolsets、缺失 command、
Agent assignments 与未分组 command。该页面不保存第二份策略，修改仍进入通用 Config 页面；headless host 的行为不变。

暂时没有注册的 command name 会保留在 Toolset；以后有 Plugin 发布同名 command 时，受限 catalog 自动更新。

## 编写外部 Agent adapter

MCP、OpenAI、Claude 或其他 provider adapter 应建模为普通 Plugin，并把 `AgentToolsPlugin` 写成 constructor required dependency：

```ts no-twoslash
import { AgentToolsPlugin, type AgentCommandCatalog } from '@pluxel/agent-tools'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ExampleAgentPlugin extends BasePlugin {
	private catalog!: AgentCommandCatalog

	constructor(private readonly agentTools: AgentToolsPlugin) {
		super()
	}

	protected override init() {
		this.catalog = this.agentTools.catalog('assistant')
		publishProviderTools(this.catalog.list())
		return this.catalog.subscribe((snapshot) => {
			// available=false 时从 provider 撤销全部 tools。
			publishProviderTools(snapshot.descriptors)
		})
	}

	executeTool(name: string, input: unknown) {
		return this.catalog.execute(name, input)
	}
}
```

`publishProviderTools()` 代表 adapter 自己的同步工具注册函数；先发布 `list()` 当前快照，再订阅后续变化。配置上面的只读 assignment 后，`assistant` 应只看到 `notes.read`，执行 `notes.create` 应被拒绝。

发布工具和执行 tool call 必须使用同一个 bound catalog。`execute()` 会在 dispatch 前重新检查当前 assignment；
`AgentToolsPlugin` stop/replacement 后，旧 catalog 投影为空并以 `ABORTED` 拒绝执行。已经通过检查并进入目标
command owner admission 的调用不会被配置更新追溯取消。

adapter 自己负责 provider schema 与 annotations、tool name 映射、principal、授权、确认、rate limit、审计和输出呈现。
这些概念不会进入 `@pluxel/commands` 或 Host。

provider 需要构建 tool setup 选择器时，可以读取 `agentTools.snapshot()`。返回值是 detached 的诊断投影，包含
policy/catalog revision、Toolsets、assignments 和命令摘要；选择之后仍应创建 `catalog(agentId)`，并让发现与执行都走该 catalog。

Workbench 的状态页面使用独立显示投影：缺省标题与说明显示为空值，command behavior 展开为固定字段。
业务 snapshot 与 Agent command catalog 保留原有可选字段和 query/mutation 契约。

## 业务 Result 与 Command 边界

Result 留在本地业务方法里，command handler 显式消费两支：成功返回 output schema 能验证的普通 JSON，
业务失败映射到现有 CommandError 协议。这个例子将不存在的笔记 ID 标为带稳定 issue code 的输入错误。

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { CommandError, defineCommand, validation } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { Commands } from '@pluxel/services/commands'

export class NoteNotFound extends TaggedError('NoteNotFound')<{ id: string }> {}
type Note = Readonly<{ id: string; text: string }>

@Plugin()
export class NotesWithResults extends BasePlugin {
	find(id: string): Result<Note, NoteNotFound> {
		return id === 'welcome'
			? Result.ok({ id, text: 'Welcome' })
			: Result.err(new NoteNotFound({ id }))
	}

	protected override init(): void {
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'notes.lookup',
				description: 'Read a note, including explicit absence.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ id: Type.String() }),
				output: obj({ id: Type.String(), text: Type.String() }),
				execute: ({ id }) => {
					const result = this.find(id)
					if (result.isErr()) {
						throw new CommandError('INPUT_VALIDATION', 'Note not found', {
							details: {
								issues: [validation.constraint('id', 'Note not found', { code: 'note_not_found' })],
							},
						})
					}
					return result.value
				},
			}),
		)
	}
}
```

把 `notes.lookup` 加入 assignment 后，Agent adapter 继续使用同一个 `catalog(agentId).execute()`。
成功返回笔记 JSON，缺失以 `INPUT_VALIDATION` 拒绝，其 `details.issues[].code` 为 `note_not_found`；
未获授权仍以 `FORBIDDEN` 拒绝，未知 handler 异常仍由 command pipeline 分类为 `INTERNAL`。
Adapter 按 CommandError 的 `code` / `publicMessage` 与领域 issue code 呈现，不能把所有失败都降级为
“笔记不存在”，也不能绕过 catalog 直接调用业务方法。

在普通 `if` 分支中抛 CommandError，不能放进会把 throw 转成 Panic 的 Result `match()` / `map()` 回调。
这样保留 command 的 expected/fault 分类，也不把 Result/Error 实例作为 JSON output 返回。

[可执行示例](https://github.com/PluxelJS/pluxel/blob/main/plugins/agent-tools/tests/fixtures/result-consumer.ts)与[回归测试](https://github.com/PluxelJS/pluxel/blob/main/plugins/agent-tools/tests/result-example.test.ts)。
