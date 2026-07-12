import type { TelegramUpdate } from '@gramio/types'
import type { TelegramBot } from './bot.ts'

export type TelegramUpdateHandler = (
	update: TelegramUpdate,
	signal: AbortSignal,
) => void | Promise<void>
export type TelegramPluginUpdate = {
	bot: TelegramBot
	update: TelegramUpdate
	signal: AbortSignal
}
export type TelegramPluginUpdateHandler = (context: TelegramPluginUpdate) => void | Promise<void>

/** Telegram-native observation surface for plugins that intentionally need raw updates. */
export class TelegramUpdateObservers {
	private readonly handlers = new Map<string, TelegramUpdateHandler>()

	register(id: string, handler: TelegramUpdateHandler): () => void {
		if (this.handlers.has(id)) throw new Error(`Telegram update handler already registered: ${id}`)
		this.handlers.set(id, handler)
		return () => {
			if (this.handlers.get(id) === handler) this.handlers.delete(id)
		}
	}

	on(id: string, handler: TelegramUpdateHandler): () => void {
		return this.register(id, handler)
	}

	async dispatch(
		update: TelegramUpdate,
		signal: AbortSignal,
		onError: (id: string, error: unknown) => void,
	): Promise<void> {
		await Promise.all(
			[...this.handlers].map(async ([id, handler]) => {
				try {
					await handler(update, signal)
				} catch (error) {
					onError(id, error)
				}
			}),
		)
	}
}

/** Observes native updates from every configured Telegram Bot. */
export class TelegramPluginUpdates {
	private readonly handlers = new Map<string, TelegramPluginUpdateHandler>()

	observe(id: string, handler: TelegramPluginUpdateHandler): () => void {
		if (this.handlers.has(id))
			throw new Error(`Telegram plugin update handler already registered: ${id}`)
		this.handlers.set(id, handler)
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.handlers.get(id) === handler) this.handlers.delete(id)
		}
	}

	async dispatch(
		context: TelegramPluginUpdate,
		onError: (id: string, error: unknown) => void,
	): Promise<void> {
		await Promise.all(
			[...this.handlers].map(async ([id, handler]) => {
				try {
					await handler(context)
				} catch (error) {
					onError(id, error)
				}
			}),
		)
	}
}
