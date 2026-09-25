---
title: Pi Agent
description: 在应用内运行 Pi 会话，并显式选择 Command 工具。
---

`@pluxel/pi-agent` 是可选的模型会话载体，让应用运行 Pi 会话、流式输出和业务工具调用。目前它是工作区内部插件。会话只获得 `createSession({ tools })` 明确选择的 Command；省略 `tools` 时没有业务工具。Pi 的内置文件与 shell 工具保持关闭。Commands 和 RPC 均可独立使用，无需启动 Pi。

## 直接选择工具

模型后端与凭据按 Pi 的配置准备，应用启动 `PiAgentPlugin` 后创建会话：

```ts no-twoslash
import { defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { PiAgentPlugin } from '@pluxel/pi-agent'

const echo = defineCommand({
	name: 'text.echo',
	description: '返回输入的文本。',
	input: obj({ text: Type.String() }),
	execute({ text }) {
		return Result.ok(text)
	},
})

const pi = host.require(PiAgentPlugin)
await using session = await pi.createSession({ tools: [echo] })
const result = await session.prompt('用 text.echo 回显“你好”')
if (result.ok) console.log(result.text)
else console.error(result.reason, result.message)
```

`createSession()` 是异步资源创建；模型或工具 schema 不可用时，它会失败并清理已取得的资源。会话支持 `await using` 或显式 `await session.dispose()`。直接 Command 由本次会话拥有，工具列表在会话创建时固定；新增工具需要新会话。模型只填写 Command 的 wire input，Command 自己校验并 Decode。

需要业务 context 的直接 Command，在同一调用传入 `context`。类型要求该对象满足所有直接工具的必需字段；模型无法填写身份、store、signal 或 deadline。只选已发布的工具名称时不接受会话 context 覆盖。

## 从 Plugin 发布工具

跨 Plugin 使用 `agent.expose(command, options)`。发布由实际调用它的 Plugin generation 拥有，`init()` 中的发布自动进入 effects；手动 `dispose()` 或 `using` 可提前撤销。

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { PiAgentPlugin } from '@pluxel/pi-agent'

interface NoteContext extends CommandContext {
	readonly actorId: string
	readonly read: (id: string, actorId: string, signal?: AbortSignal) => Promise<string | null>
}

const readNote = defineCommand({
	name: 'notes.read',
	description: '读取当前用户的笔记；不存在时 reason 为 not_found。',
	input: obj({ id: Type.String() }),
	async execute({ id }, context: NoteContext) {
		const text = await context.read(id, context.actorId, context.signal)
		return text === null
			? Result.err({ code: 'REJECTED', reason: 'not_found', message: '笔记不存在' })
			: Result.ok({ id, text })
	},
})

@Plugin()
export class NotesPlugin extends BasePlugin {
	constructor(private readonly agent: PiAgentPlugin) {
		super()
	}

	protected override init() {
		this.agent.expose(readNote, {
			context: ({ principal }) => ({
				actorId: requireActorId(principal),
				read: (id, actorId, signal) => this.read(id, actorId, signal),
			}),
		})
	}

	async read(id: string, actorId: string, signal?: AbortSignal): Promise<string | null> {
		signal?.throwIfAborted()
		return id === 'one' && actorId === 'alice' ? '你好' : null
	}
}

function requireActorId(principal: unknown): string {
	if (
		typeof principal !== 'object' ||
		principal === null ||
		!('id' in principal) ||
		typeof principal.id !== 'string'
	) {
		throw new TypeError('Authenticated principal must contain an id')
	}
	return principal.id
}
```

宿主在已认证身份下明确选择发布名称：

```ts no-twoslash
await using session = await pi.createSession({
	principal: { id: 'alice' },
	tools: ['notes.read'],
	authorize: ({ name, principal }) => policy.allows(principal, name),
})
```

`tools` 中的字符串只选择 `pi.expose()` 的已有发布，不查询 Commands root catalog。创建时固定每个发布的 generation；撤销后，旧会话和缓存的 SDK callback 都不能跟随同名新发布复活。`authorize` 在发现与每次调用时重新检查；异步发现授权会持有发布者与 Pi provider 的调用占用，停止会等待它退出。领域 `read()` 仍负责对象级授权。`context` 由可信应用构造业务字段；直接工具在创建会话时固定顶层业务字段，已发布工具在每次调用的授权前固定这些字段，嵌套服务引用仍由应用持有。signal、deadline 与 meta 由载体填写。`pi.tools()` 向可信宿主列出当前发布描述，列表本身不授予模型权限。

`principal` 应是本次会话的已认证、不可变身份快照；需要切换身份时创建新会话。Pi 保留应用传入的身份对象，不复制任意自定义对象或从模型输入猜测身份。

工具执行时先处理 Command 的 Err，再将成功值变成 Pi 原生工具内容。普通字符串成为文本，JSON 值成为 JSON 文本，`void` 使用固定成功回复。不可编码的成功值与过大结果明确失败；不会再次执行 handler 来重试输出。直接工具默认串行，跨会话并发控制仍归业务服务。
失败工具向模型交付有界的公开字段：Command 的 `code`、`message`、可恢复拒绝的 `reason` 与输入 `issues`。`cause` 与 stack 只留在本地，不进入模型内容。

发布者与 Pi provider 的调用占用持续到工具结果呈现完成；Plugin 停止会等待这一步结束，再释放业务资源。

## Goal、子会话和结果

`session.setGoal()`、`completeGoal()`、`clearGoal()` 管理会话内的 goal；模型也可通过 `pluxel_goal` 工具操作。`session.spawnSubagent(task, { signal })` 与模型可用的 `pluxel_subagent` 创建真实子会话，固定继承父会话的工具上限、身份和授权规则。`maxSubagentDepth`、`maxSubagentsPerSession`、`maxConcurrentSubagents` 与 `maxSessions` 限制数量；释放父会话会取消并等待子会话退出。

`prompt()` 返回自身的 outcome，直接按 `ok` 和 `reason` 处理。取消或模型错误在回执中；会话繁忙、参数错误和资源已释放等调用错误仍会 reject。`AbortSignal` 是协作取消，已发生的业务写入不会自动回滚。

Pi 固定使用 `noTools: 'builtin'`，关闭 extensions、skills、prompt templates、themes 和 context file discovery。会话、goal 与子会话记录仅存内存，不承诺恢复。当前没有专用 Workbench 会话管理页。

[回归测试](https://github.com/PluxelJS/pluxel/blob/main/plugins/pi-agent/tests/controller.test.ts)覆盖工具选择、撤销、权限变化、取消和释放。
