import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'
import { BotWorkspacePlugin } from './BotWorkspacePlugin'
import { BotStore, simulatedBots } from './BotStore'
import { DiscordBotWorkbench } from './DiscordBot.workbench'
import { channelTable, DiscordChannelTarget, validateDiscordChannels } from './DiscordChannels'

const WorkbenchRef = defineServiceRef<Workbench>()

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
		const bots = simulatedBots('discord')
		const botStore = new BotStore(bots, store, [channelTable])
		validateDiscordChannels(store, bots)
		const publication = this.ctx.service(WorkbenchRef)?.publish(DiscordBotWorkbench, {
			editor: ({ params }) => {
				const bot = bots.find(({ id }) => id === params.bot)
				if (!bot) throw new Error(`Unknown Discord bot: ${params.bot}`)
				return new DiscordChannelTarget(bot, store, () => this.ctx.tinybase.flush())
			},
		})
		return this.workspace.registerSource({
			id: 'discord',
			label: 'Discord',
			capability: '模拟 Discord 社区频道；不连接外部平台',
			store: botStore,
			...(publication && {
				editor: (bot) => publication.link('editor', { bot: bot.id }),
			}),
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
