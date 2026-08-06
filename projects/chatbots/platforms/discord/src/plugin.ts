import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { workbench } from '@pluxel/runtime/workbench'
import type { BotRegistry } from '@repo/chatbots-platform-kit/registry'
import { DiscordCommandCarrier, type DiscordCommands } from './commands.ts'
import { DiscordInteractionCarrier, type DiscordInteractions } from './interactions.ts'
import { DiscordBotManager } from './bot/manager.ts'
import type { DiscordBot, DiscordBotConfigInput } from './protocol.ts'
import type { DiscordBotStatus } from './bot/status.ts'
import type { DiscordWorkbenchEvents } from './workbench/contract.ts'
import { DiscordWorkbench } from './workbench/extension.ts'
import { attachDiscordAdminState, DiscordWorkbenchRpc } from './workbench/service.ts'

const DiscordConfig = v.object({
	commandGuildIds: v.optional(
		v.pipe(v.array(v.pipe(v.string(), v.regex(/^\d{17,20}$/))), v.maxLength(100)),
		[],
	),
	readyTimeoutMs: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(120_000)),
		20_000,
	),
})

@Plugin({ name: 'DiscordPlugin', startTimeoutMs: 30_000 })
export class DiscordPlugin extends BasePlugin {
	private readonly config = this.configs.use(DiscordConfig)
	private readonly commandCarrier = new DiscordCommandCarrier(this.ctx, () =>
		this.scheduleCommandSync(),
	)
	private readonly interactionCarrier = new DiscordInteractionCarrier(this.ctx)
	private manager?: DiscordBotManager
	private commandSyncScheduled = false

	get commands(): DiscordCommands {
		return this.commandCarrier.forOwner(this.ctx.caller ?? this.ctx)
	}

	get interactions(): DiscordInteractions {
		return this.interactionCarrier.forOwner(this.ctx.caller ?? this.ctx)
	}

	get bots(): BotRegistry<DiscordBot> {
		return this.ready().bots
	}

	override async init(): Promise<void> {
		this.ctx.effects.own(this.commandCarrier, { tag: 'DiscordCommands' })
		this.ctx.effects.own(this.interactionCarrier, { tag: 'DiscordInteractions' })
		const manager = new DiscordBotManager({
			ctx: this.ctx,
			commandGuildIds: this.config.commandGuildIds,
			readyTimeoutMs: this.config.readyTimeoutMs,
			commandCatalog: () => this.commandCarrier.snapshot(),
			dispatchCommand: (context) => this.commandCarrier.dispatch(context),
			matchesInteraction: (customId) => this.interactionCarrier.matches(customId),
			dispatchInteraction: (context) => this.interactionCarrier.dispatch(context),
		})
		this.manager = manager
		this.ctx.effects.defer(async () => {
			await manager.dispose()
			if (this.manager === manager) this.manager = undefined
		})
		await manager.start()
		if (this.ctx.workbench.enabled) {
			this.ctx.workbench.mount(DiscordWorkbench, {
				commands: workbench.bind.rpc(() => new DiscordWorkbenchRpc(manager)),
				state: workbench.bind.events<DiscordWorkbenchEvents>((events) =>
					attachDiscordAdminState(manager, events),
				),
			})
		}
		this.ctx.http.plugin.routes(
			(app) =>
				app.get('/health', () => {
					const bots = [...manager.bots].map((bot) => ({ id: bot.id, ...bot.$.status }))
					return { ok: bots.every((bot) => bot.phase !== 'error'), bots }
				}),
			{ path: '/api', id: 'DiscordPlugin:api' },
		)
	}

	upsertBot(input: DiscordBotConfigInput): Promise<DiscordBot> {
		return this.ready().upsert(input)
	}

	removeBot(id: string): Promise<void> {
		return this.ready().remove(id)
	}

	reconnectBot(id: string): Promise<DiscordBotStatus> {
		return this.ready().reconnect(id)
	}

	disconnectBot(id: string): Promise<DiscordBotStatus> {
		return this.ready().disconnect(id)
	}

	private scheduleCommandSync(): void {
		if (this.commandSyncScheduled) return
		this.commandSyncScheduled = true
		queueMicrotask(() => {
			this.commandSyncScheduled = false
			void this.manager
				?.syncCommands()
				.catch((error: unknown) =>
					this.ctx.logger.warn('Discord command synchronization failed', { error }),
				)
		})
	}

	private ready(): DiscordBotManager {
		if (!this.manager) throw new Error('DiscordPlugin is not running')
		return this.manager
	}
}
