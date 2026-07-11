import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatCommandsPlugin } from '@repo/chatbots-commands'
import { ChatHubPlugin } from '@repo/chatbots-hub'

@Plugin({ name: 'ChatBuiltinsPlugin', dependencies: [ChatCommandsPlugin, ChatHubPlugin] })
export class ChatBuiltinsPlugin extends BasePlugin {
	constructor(
		private readonly commands: ChatCommandsPlugin,
		private readonly hub: ChatHubPlugin,
	) {
		super()
	}

	override init(): void {
		const disposers = [
			this.commands.register({
				name: 'ping',
				description: '检查机器人是否可用',
				execute: () => 'pong',
			}),
			this.commands.register({
				name: 'help',
				aliases: ['commands'],
				description: '列出可用命令',
				execute: () =>
					this.commands
						.list()
						.map((command) => `/${command.name} — ${command.description}`)
						.join('\n'),
			}),
			this.commands.register({
				name: 'status',
				description: '显示传输与处理器状态',
				execute: () =>
					[
						`transports: ${this.hub.listTransports().join(', ') || 'none'}`,
						`handlers: ${
							this.hub
								.listHandlers()
								.map((item) => item.id)
								.join(', ') || 'none'
						}`,
					].join('\n'),
			}),
		]
		this.ctx.effects.defer(() => {
			for (const dispose of disposers.toReversed()) dispose()
		})
	}
}
