import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { workbench } from '@pluxel/runtime/workbench'
import { WretchPlugin } from '@pluxel/wretch'
import type { BotRegistry } from '@repo/chatbots-platform-kit/registry'
import { KookBot } from './bot/bot.ts'
import { KookBotManager, type KookBotConfigInput, type KookEventConsumer } from './bot/manager.ts'
import { createKookPluginEvents } from './bot/events.factory.ts'
import type { KookBotStatus } from './bot/status.ts'
import type { KookWorkbenchEvents } from './workbench/contract.ts'
import { KookWorkbench } from './workbench/extension.ts'
import { attachKookWorkbenchState, KookWorkbenchRpc } from './workbench/service.ts'

export type { KookBotConfigInput, KookEventConsumer } from './bot/manager.ts'

@Plugin({ name: 'KookPlugin', startTimeoutMs: 10_000 })
export class KookPlugin extends BasePlugin {
	private manager?: KookBotManager
	readonly events = createKookPluginEvents(this.ctx)

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	get bots(): BotRegistry<KookBot> {
		return this.ready().bots
	}

	override async init(): Promise<void> {
		const manager = new KookBotManager({
			ctx: this.ctx,
			http: this.http.client,
			events: this.events,
		})
		this.manager = manager
		this.ctx.effects.defer(() => manager.dispose())
		await manager.start()

		if (this.ctx.workbench.enabled) {
			await this.http.enableManagedSettings()
			this.ctx.workbench.mount(KookWorkbench, {
				commands: workbench.bind.rpc(() => new KookWorkbenchRpc(manager)),
				httpSettings: workbench.bind.rpc(() => this.http.workbenchSettings()),
				state: workbench.bind.events<KookWorkbenchEvents>((events) =>
					attachKookWorkbenchState(manager, events),
				),
			})
		}
	}

	/** Registers ordered work that must finish before the gateway checkpoint advances. */
	registerEventConsumer(id: string, consumer: KookEventConsumer): () => void {
		return this.ready().registerEventConsumer(id, consumer)
	}

	upsertBot(input: KookBotConfigInput): Promise<KookBot> {
		return this.ready().upsert(input)
	}

	removeBot(id: string): Promise<void> {
		return this.ready().remove(id)
	}

	reconnectBot(id: string): Promise<KookBotStatus> {
		return this.ready().reconnect(id)
	}

	disconnectBot(id: string): Promise<KookBotStatus> {
		return this.ready().disconnect(id)
	}

	private ready(): KookBotManager {
		if (!this.manager) throw new Error('KookPlugin is not running')
		return this.manager
	}
}
