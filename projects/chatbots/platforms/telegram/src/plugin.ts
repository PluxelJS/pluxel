import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { WretchPlugin } from '@pluxel/wretch'
import type { BotRegistry } from '@repo/chatbots-platform-kit/registry'
import { TelegramBot } from './bot/bot.ts'
import {
	TelegramBotManager,
	type TelegramBotConfigInput,
	type TelegramUpdateConsumer,
} from './bot/manager.ts'
import { createTelegramPluginEvents } from './bot/events.factory.ts'
import type { TelegramBotStatus } from './bot/status.ts'
import type { TelegramWorkbenchEvents } from './workbench/contract.ts'
import { TelegramWorkbench } from './workbench/extension.ts'
import { attachTelegramWorkbenchState, TelegramWorkbenchRpc } from './workbench/service.ts'

export type { TelegramBotConfigInput, TelegramUpdateConsumer } from './bot/manager.ts'

@Plugin({ name: 'TelegramPlugin' })
export class TelegramPlugin extends BasePlugin {
	private manager?: TelegramBotManager
	readonly events = createTelegramPluginEvents(this.ctx)

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	get bots(): BotRegistry<TelegramBot> {
		return this.ready().bots
	}

	override async init(): Promise<void> {
		const manager = new TelegramBotManager({
			ctx: this.ctx,
			http: this.http.client,
			events: this.events,
		})
		this.manager = manager
		this.ctx.effects.defer(() => manager.dispose())
		await manager.start()

		if (this.ctx.workbench.enabled) {
			await this.http.enableManagedSettings()
			this.ctx.workbench.mount(TelegramWorkbench, {
				commands: workbench.bind.rpc(() => new TelegramWorkbenchRpc(manager)),
				state: workbench.bind.events<TelegramWorkbenchEvents>((events) =>
					attachTelegramWorkbenchState(manager, events),
				),
				httpSettings: workbench.bind.rpc(() => this.http.workbenchSettings()),
			})
		}
	}

	/** Registers ordered work that must finish before the polling offset advances. */
	registerUpdateConsumer(id: string, consumer: TelegramUpdateConsumer): () => void {
		return this.ready().registerUpdateConsumer(id, consumer)
	}

	upsertBot(input: TelegramBotConfigInput): Promise<TelegramBot> {
		return this.ready().upsert(input)
	}

	removeBot(id: string): Promise<void> {
		return this.ready().remove(id)
	}

	reconnectBot(id: string): Promise<TelegramBotStatus> {
		return this.ready().reconnect(id)
	}

	disconnectBot(id: string): Promise<TelegramBotStatus> {
		return this.ready().disconnect(id)
	}

	private ready(): TelegramBotManager {
		if (!this.manager) throw new Error('TelegramPlugin is not running')
		return this.manager
	}
}
