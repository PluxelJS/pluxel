---
title: MCP tools
description: 通过已安装的 MCP SDK server 显式发布 Command。
---

`@pluxel/services/mcp` 将指定的 Command 发布为 MCP tool。安装时，宿主提供已选定传输的 `@modelcontextprotocol/sdk` `Server` 和每次请求的身份解析函数。该服务不创建监听器，也不会自动公开 root Commands 目录。

```ts no-twoslash
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { mcp } from '@pluxel/services/mcp'

const server = new Server({ name: 'my-app', version: '1.0.0' }, { capabilities: {} })
const mcpService = mcp({
	server,
	authenticate: ({ authInfo }) => {
		const id = authInfo?.extra?.actorId
		if (typeof id !== 'string' || !id) throw new Error('Unauthenticated MCP request')
		return { id }
	},
})
// 将 mcpService 放入 Host 的 services，再把 server 连接到宿主选择的 SDK transport。
```

`authenticate` 在发现和调用时运行，必须返回已认证的非空 principal；返回 `null` 或 `undefined` 会拒绝本次请求。宿主负责建立传输、认证来源、连接和关闭 `server`；MCP 服务在 Host 关闭时移除自己安装的 `tools/list` 和 `tools/call` handler。`maxOutputBytes` 可在安装时设置，默认 1 MiB，必须为正整数。

## 在 Plugin 中发布

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { Mcp } from '@pluxel/services/mcp'
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

interface NoteContext extends CommandContext {
	actorId: string
}

function requireActorId(principal: unknown): string {
	if (
		typeof principal !== 'object' ||
		principal === null ||
		!('id' in principal) ||
		typeof principal.id !== 'string' ||
		!principal.id
	) {
		throw new TypeError('Authenticated principal must have an id')
	}
	return principal.id
}

const readNote = defineCommand({
	name: 'notes.read',
	description: '读取当前用户的笔记；不存在时返回 not_found。',
	input: obj({ id: Type.String() }),
	execute({ id }, context: NoteContext) {
		return id === 'one'
			? Result.ok({ id, actorId: context.actorId })
			: Result.err({ code: 'REJECTED', reason: 'not_found', message: '笔记不存在' })
	},
})

@Plugin()
export class NotesPlugin extends BasePlugin {
	protected override init() {
		this.ctx.require(Mcp).expose(readNote, {
			context: ({ principal }) => ({ actorId: requireActorId(principal) }),
			authorize: ({ principal }) => requireActorId(principal) === 'alice',
			annotations: { readOnlyHint: true },
			outputSchema: obj({ id: Type.String(), actorId: Type.String() }),
		})
	}
}
```

`expose()` 返回同步 `dispose()` / `Symbol.dispose` 句柄，发布也自动归当前 Plugin generation 的 effects。手动撤销立即阻止新的发现和调用；已接纳的调用继续结算。Plugin 停止会取消并等待真实工作退出。相同名称不能同时发布两次，撤销后旧句柄不会跟随同名新发布。

`context` 每次调用从已认证 principal 构造业务字段，并继承本次 signal；它必须返回只含自有数据字段的普通对象，不得返回 `signal`、`deadlineMs` 或 `meta`。载体在检查调用权限前固定这些顶层字段；借用的业务服务仍由应用管理。Command 有必需业务 context 字段时，发布处必须提供 factory。`authorize` 在发现和每次调用时重新检查；返回 false 会隐藏 tool 或拒绝调用。输入中的资源 ID 仍由领域 handler 检查。发现过程中任一授权检查异常会让整个列表失败，不返回不完整列表。

MCP 先检查 Command Result。`Err` 返回 `isError` 和公开的 `code`、`message`，以及适用的 `reason` 或 `issues`；`cause` 不会发送。普通 Ok 的字符串成为文本，对象成为 JSON 文本，`void` 使用固定成功文本。配置 `outputSchema` 时，仅验证 Ok 中的业务对象，成功返回 `structuredContent`；不补默认值，并拒绝含 TypeBox Transform 的 schema。非 JSON 值、超限值和 schema 不匹配分别返回 `OUTPUT_ENCODING`、`OUTPUT_LIMIT` 和 `INTERNAL`，不会重跑 Command。
