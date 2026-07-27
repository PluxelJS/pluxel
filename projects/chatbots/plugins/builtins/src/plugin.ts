import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import { ChatCommandsPlugin, type ChatCommandContext } from '@repo/chatbots-commands'
import { ChatHubPlugin } from '@repo/chatbots-hub'

const emptyInput = obj({})
const textOutput = obj({ text: Type.String() })
const publicTextBinding = {
	permission: false as const,
	respond: ({ text }: { text: string }) => text,
}

@Plugin({ name: 'ChatBuiltinsPlugin' })
export class ChatBuiltinsPlugin extends BasePlugin {
	constructor(
		private readonly commands: ChatCommandsPlugin,
		private readonly hub: ChatHubPlugin,
		private readonly access: ChatAccessPlugin,
	) {
		super()
	}

	override init(): void {
		const ping = defineCommand({
			name: 'chat.ping',
			description: '检查机器人是否可用',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			execute: () => ({ text: 'pong' }),
		})
		this.ctx.effects.own(
			this.commands.register(ping, {
				...publicTextBinding,
				routes: ['ping'],
			}),
		)

		const help = defineCommand({
			name: 'chat.help',
			description: '列出可用命令',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			execute: () => ({
				text: this.commands
					.list()
					.filter((command) => !command.hidden)
					.map((command) => `/${command.routes[0]} — ${command.description}`)
					.join('\n'),
			}),
		})
		this.ctx.effects.own(
			this.commands.register(help, {
				...publicTextBinding,
				routes: ['help', 'commands'],
			}),
		)

		const account = defineCommand<typeof emptyInput, typeof textOutput, ChatCommandContext>({
			name: 'chat.account',
			description: '显示统一用户与平台身份',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			execute: (_input, { user }) => ({
				text: [
					`user: ${user.id}`,
					...user.identities.map((identity) => `${identity.platform}: ${identity.actorId}`),
				].join('\n'),
			}),
		})
		this.ctx.effects.own(
			this.commands.register(account, {
				...publicTextBinding,
				routes: ['account'],
			}),
		)

		const linkInput = obj({
			code: Type.Optional(Type.String({ minLength: 1, description: '另一个平台生成的身份关联码' })),
		})
		const link = defineCommand<typeof linkInput, typeof textOutput, ChatCommandContext>({
			name: 'chat.link',
			description: '生成或消费跨平台身份关联码',
			behavior: {
				kind: 'mutation',
				destructive: false,
				idempotent: false,
				world: 'closed',
			},
			input: linkInput,
			output: textOutput,
			execute: ({ code }, { user }) => {
				if (code) {
					const linked = this.access.consumeLinkCode(user.id, code)
					return { text: `身份已关联到 ${linked.id}。` }
				}
				const created = this.access.createLinkCode(user.id)
				return {
					text: `关联码：${created.code}\n请在另一个平台 5 分钟内发送 /link ${created.code}`,
				}
			},
		})
		this.ctx.effects.own(
			this.commands.register(link, {
				...publicTextBinding,
				routes: ['link'],
				positionals: ['code'],
			}),
		)

		const status = defineCommand({
			name: 'chat.status',
			description: '显示传输与处理器状态',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			execute: () => {
				const snapshot = this.hub.snapshot()
				return {
					text: [
						`transports: ${
							snapshot.transports
								.map(({ platform, accountId }) => `${platform}/${accountId}`)
								.join(', ') || 'none'
						}`,
						`handlers: ${snapshot.handlers.map((item) => item.id).join(', ') || 'none'}`,
						`received: ${snapshot.received} (pending ${snapshot.pendingReceives}, rejected ${snapshot.rejectedReceives})`,
						`dispatch failures: handlers ${snapshot.failedHandlers}, observers ${snapshot.failedObservers}`,
						`sent: ${snapshot.sent} (pending ${snapshot.pendingSends}, failed ${snapshot.failedSends}, rejected ${snapshot.rejectedSends})`,
					].join('\n'),
				}
			},
		})
		this.ctx.effects.own(
			this.commands.register(status, {
				...publicTextBinding,
				routes: ['status'],
			}),
		)
	}
}
