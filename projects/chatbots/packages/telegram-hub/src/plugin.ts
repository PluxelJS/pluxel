import { TelegramPlugin, type TelegramBot } from '@repo/chatbots-telegram'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { normalizeTelegramUpdate, sendTelegram, TELEGRAM_TRANSPORT_CAPABILITIES } from './codec.ts'

/** Opt-in bridge from the native Telegram capability into the cross-platform ChatHub. */
@Plugin({ name: 'TelegramHubBridgePlugin' })
export class TelegramHubBridgePlugin extends BasePlugin {
	private readonly transports = new Map<TelegramBot, () => void>()
	private readonly lifetime = new AbortController()

	constructor(
		private readonly telegram: TelegramPlugin,
		private readonly hub: ChatHubPlugin,
	) {
		super()
	}

	override init(): void {
		this.ctx.effects.defer(
			() => this.lifetime.abort(new Error('Telegram ChatHub bridge stopped')),
			{ phase: 'shutdown' },
		)
		this.ctx.effects.defer(() => {
			for (const bot of this.transports.keys()) this.detach(bot)
		})
		for (const bot of this.telegram.bots) this.attach(bot)
		this.ctx.effects.defer(
			this.telegram.bots.observe((change) => {
				if (change.type === 'added') this.attach(change.bot)
				else this.detach(change.bot)
			}),
		)
		this.ctx.effects.defer(
			this.telegram.registerUpdateProjection('chatbots.hub', async (bot, update, signal) => {
				const message = normalizeTelegramUpdate(update, bot.id)
				if (message) await this.hub.receive(message, this.ownedSignal(signal))
			}),
		)
	}

	private attach(bot: TelegramBot): void {
		if (this.transports.has(bot)) return
		this.transports.set(
			bot,
			this.hub.registerTransport({
				platform: 'telegram',
				accountId: bot.id,
				capabilities: TELEGRAM_TRANSPORT_CAPABILITIES,
				send: (request, signal) => sendTelegram(bot, request, this.ownedSignal(signal)),
			}),
		)
	}

	private detach(bot: TelegramBot): void {
		this.transports.get(bot)?.()
		this.transports.delete(bot)
	}

	private ownedSignal(signal?: AbortSignal): AbortSignal {
		return !signal || signal === this.lifetime.signal
			? this.lifetime.signal
			: AbortSignal.any([signal, this.lifetime.signal])
	}
}
