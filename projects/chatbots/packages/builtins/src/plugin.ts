import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import { ChatCommandsPlugin } from '@repo/chatbots-commands'
import { ChatHubPlugin } from '@repo/chatbots-hub'

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
		const disposers = [
			this.commands.register({
				name: 'ping',
				description: '检查机器人是否可用',
				permission: false,
				execute: () => 'pong',
			}),
			this.commands.register({
				name: 'help',
				aliases: ['commands'],
				description: '列出可用命令',
				permission: false,
				execute: () =>
					this.commands
						.list()
						.filter((command) => !command.hidden)
						.map((command) => `/${command.name} — ${command.description}`)
						.join('\n'),
			}),
			this.commands.register({
				name: 'account',
				description: '显示统一用户与平台身份',
				permission: false,
				execute: ({ user }) =>
					[
						`user: ${user.id}`,
						...user.identities.map((identity) => `${identity.platform}: ${identity.actorId}`),
					].join('\n'),
			}),
			this.commands.register({
				name: 'link',
				description: '生成或消费跨平台身份关联码',
				usage: '/link [code]',
				permission: false,
				execute: ({ user, args }) => {
					if (args[0]) {
						const linked = this.access.consumeLinkCode(user.id, args[0])
						return `身份已关联到 ${linked.id}。`
					}
					const link = this.access.createLinkCode(user.id)
					return `关联码：${link.code}\n请在另一个平台 5 分钟内发送 /link ${link.code}`
				},
			}),
			this.commands.register({
				name: 'status',
				description: '显示传输与处理器状态',
				permission: false,
				execute: () => {
					const snapshot = this.hub.snapshot()
					return [
						`transports: ${
							snapshot.transports
								.map(({ platform, accountId }) => `${platform}/${accountId}`)
								.join(', ') || 'none'
						}`,
						`handlers: ${snapshot.handlers.map((item) => item.id).join(', ') || 'none'}`,
						`received: ${snapshot.received} (pending ${snapshot.pendingReceives}, rejected ${snapshot.rejectedReceives})`,
						`sent: ${snapshot.sent} (pending ${snapshot.pendingSends}, failed ${snapshot.failedSends}, rejected ${snapshot.rejectedSends})`,
					].join('\n')
				},
			}),
		]
		this.ctx.effects.defer(() => {
			for (const dispose of disposers.toReversed()) dispose()
		})
	}
}
