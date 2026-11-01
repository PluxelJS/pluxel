import { BasePlugin, Plugin } from '@pluxel/core'
import { BotWorkspacePlugin } from './BotWorkspacePlugin'
import { BotStore, simulatedBots } from './BotStore'

@Plugin({ displayName: 'Telegram · 模拟机器人来源' })
export class TelegramBotPlugin extends BasePlugin {
	constructor(private readonly workspace: BotWorkspacePlugin) {
		super()
	}
	override async init(): Promise<() => void> {
		const store = await this.ctx.tinybase.open()
		return this.workspace.registerSource({
			id: 'telegram',
			label: 'Telegram',
			capability: '模拟 Telegram 私聊与群组；不连接外部平台',
			store: new BotStore(simulatedBots('telegram'), store),
		})
	}
}

@Plugin({ displayName: 'Discord · 模拟机器人来源' })
export class DiscordBotPlugin extends BasePlugin {
	constructor(private readonly workspace: BotWorkspacePlugin) {
		super()
	}
	override async init(): Promise<() => void> {
		const store = await this.ctx.tinybase.open()
		return this.workspace.registerSource({
			id: 'discord',
			label: 'Discord',
			capability: '模拟 Discord 社区频道；不连接外部平台',
			store: new BotStore(simulatedBots('discord'), store),
		})
	}
}

@Plugin({ displayName: '企业微信 · 模拟机器人来源' })
export class WeComBotPlugin extends BasePlugin {
	constructor(private readonly workspace: BotWorkspacePlugin) {
		super()
	}
	override async init(): Promise<() => void> {
		const store = await this.ctx.tinybase.open()
		return this.workspace.registerSource({
			id: 'wecom',
			label: '企业微信',
			capability: '模拟企业微信内部通知；不连接外部平台',
			store: new BotStore(simulatedBots('wecom'), store),
		})
	}
}
