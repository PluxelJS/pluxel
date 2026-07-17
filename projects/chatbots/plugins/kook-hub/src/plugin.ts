import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { KookPlugin, type KookBot } from '@repo/chatbots-kook'
import { KOOK_TRANSPORT_CAPABILITIES, normalizeKookEvent, sendKook } from './codec.ts'

/** Opt-in bridge from the native KOOK capability into the cross-platform ChatHub. */
@Plugin({ name: 'KookHubBridgePlugin' })
export class KookHubBridgePlugin extends BasePlugin {
	private readonly transports = new Map<KookBot, () => void>()
	private readonly lifetime = new AbortController()

	constructor(
		private readonly kook: KookPlugin,
		private readonly hub: ChatHubPlugin,
	) {
		super()
	}

	override init(): void {
		this.ctx.effects.defer(() => this.lifetime.abort(new Error('KOOK ChatHub bridge stopped')), {
			phase: 'shutdown',
		})
		this.ctx.effects.defer(() => {
			for (const bot of this.transports.keys()) this.detach(bot)
		})
		for (const bot of this.kook.bots) this.attach(bot)
		this.ctx.effects.defer(
			this.kook.bots.observe((change) => {
				if (change.type === 'added') this.attach(change.bot)
				else this.detach(change.bot)
			}),
		)
		this.ctx.effects.defer(
			this.kook.registerEventProjection('chatbots.hub', async (bot, event, signal) => {
				const message = normalizeKookEvent(event, bot.selfInfo?.id, bot.id)
				if (message) await this.hub.receive(message, this.ownedSignal(signal))
			}),
		)
	}

	private attach(bot: KookBot): void {
		if (this.transports.has(bot)) return
		this.transports.set(
			bot,
			this.hub.registerTransport({
				platform: 'kook',
				accountId: bot.id,
				capabilities: KOOK_TRANSPORT_CAPABILITIES,
				send: (request, signal) => sendKook(bot, request, this.ownedSignal(signal)),
			}),
		)
	}

	private detach(bot: KookBot): void {
		this.transports.get(bot)?.()
		this.transports.delete(bot)
	}

	private ownedSignal(signal?: AbortSignal): AbortSignal {
		return !signal || signal === this.lifetime.signal
			? this.lifetime.signal
			: AbortSignal.any([signal, this.lifetime.signal])
	}
}
