import type { KookEvent } from './protocol.ts'
import type { KookBot } from './bot.ts'

export type KookEventHandler = (event: KookEvent, signal: AbortSignal) => void | Promise<void>
export type KookPluginEvent = { bot: KookBot; event: KookEvent; signal: AbortSignal }
export type KookPluginEventHandler = (context: KookPluginEvent) => void | Promise<void>

/** KOOK-native event surface; it deliberately does not pretend to be a ChatMessage handler. */
export class KookEventObservers {
	private readonly handlers = new Map<string, KookEventHandler>()

	register(id: string, handler: KookEventHandler): () => void {
		if (this.handlers.has(id)) throw new Error(`KOOK event handler already registered: ${id}`)
		this.handlers.set(id, handler)
		return () => {
			if (this.handlers.get(id) === handler) this.handlers.delete(id)
		}
	}

	on(id: string, handler: KookEventHandler): () => void {
		return this.register(id, handler)
	}

	async dispatch(
		event: KookEvent,
		signal: AbortSignal,
		onError: (id: string, error: unknown) => void,
	): Promise<void> {
		await Promise.all(
			[...this.handlers].map(async ([id, handler]) => {
				try {
					await handler(event, signal)
				} catch (error) {
					onError(id, error)
				}
			}),
		)
	}
}

/** Observes native events from every configured KOOK Bot. */
export class KookPluginEvents {
	private readonly handlers = new Map<string, KookPluginEventHandler>()

	observe(id: string, handler: KookPluginEventHandler): () => void {
		if (this.handlers.has(id))
			throw new Error(`KOOK plugin event handler already registered: ${id}`)
		this.handlers.set(id, handler)
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.handlers.get(id) === handler) this.handlers.delete(id)
		}
	}

	async dispatch(
		context: KookPluginEvent,
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
