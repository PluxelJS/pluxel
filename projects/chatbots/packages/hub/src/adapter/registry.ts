export type BotRegistryChange<Bot> =
	| { type: 'added'; id: string; bot: Bot }
	| { type: 'removed'; id: string; bot: Bot }

export type BotRegistryObserver<Bot> = (change: BotRegistryChange<Bot>) => void

/** Read-only live view exposed by platform capability plugins. */
export interface BotRegistry<Bot> extends Iterable<Bot> {
	readonly size: number
	get(id: string): Bot | undefined
	require(id: string): Bot
	has(id: string): boolean
	keys(): IterableIterator<string>
	values(): IterableIterator<Bot>
	entries(): IterableIterator<[string, Bot]>
	observe(observer: BotRegistryObserver<Bot>): () => void
}

/** Mutation authority retained privately by the owning platform plugin. */
export interface BotRegistryController<Bot> {
	register(id: string, bot: Bot): () => void
	remove(id: string, expected?: Bot): boolean
	clear(): void
}

export type BotRegistryOptions = {
	onObserverError?: (error: unknown) => void
}

export function createBotRegistry<Bot>(options: BotRegistryOptions = {}): {
	readonly registry: BotRegistry<Bot>
	readonly controller: BotRegistryController<Bot>
} {
	const state = new RegistryState<Bot>(options.onObserverError ?? (() => {}))
	return {
		registry: state.view,
		controller: state.controller,
	}
}

class RegistryState<Bot> {
	private readonly bots = new Map<string, Bot>()
	private readonly observers = new Set<BotRegistryObserver<Bot>>()

	constructor(private readonly onObserverError: (error: unknown) => void) {}

	readonly view: BotRegistry<Bot> = Object.freeze(
		new ReadonlyBotRegistryView(this.bots, this.observers),
	)

	readonly controller: BotRegistryController<Bot> = Object.freeze({
		register: (id: string, bot: Bot) => {
			const normalized = normalizeBotId(id)
			if (this.bots.has(normalized)) throw new Error(`Bot is already registered: ${normalized}`)
			this.bots.set(normalized, bot)
			this.emit({ type: 'added', id: normalized, bot })
			let active = true
			return () => {
				if (!active) return
				active = false
				this.remove(normalized, bot)
			}
		},
		remove: (id: string, expected?: Bot) => this.remove(normalizeLookupId(id), expected),
		clear: () => {
			for (const [id, bot] of this.bots) this.remove(id, bot)
		},
	})

	private remove(id: string, expected?: Bot): boolean {
		const bot = this.bots.get(id)
		if (!bot || (expected !== undefined && bot !== expected)) return false
		this.bots.delete(id)
		this.emit({ type: 'removed', id, bot })
		return true
	}

	private emit(change: BotRegistryChange<Bot>): void {
		for (const observer of this.observers) {
			try {
				observer(change)
			} catch (error) {
				this.onObserverError(error)
			}
		}
	}
}

class ReadonlyBotRegistryView<Bot> implements BotRegistry<Bot> {
	constructor(
		private readonly bots: Map<string, Bot>,
		private readonly observers: Set<BotRegistryObserver<Bot>>,
	) {}

	get size(): number {
		return this.bots.size
	}
	get(id: string): Bot | undefined {
		return this.bots.get(normalizeLookupId(id))
	}
	require(id: string): Bot {
		const normalized = normalizeLookupId(id)
		const bot = this.bots.get(normalized)
		if (!bot) throw new Error(`Bot is not configured: ${normalized}`)
		return bot
	}
	has(id: string): boolean {
		return this.bots.has(normalizeLookupId(id))
	}
	keys(): IterableIterator<string> {
		return this.bots.keys()
	}
	values(): IterableIterator<Bot> {
		return this.bots.values()
	}
	entries(): IterableIterator<[string, Bot]> {
		return this.bots.entries()
	}
	[Symbol.iterator](): IterableIterator<Bot> {
		return this.bots.values()
	}
	observe(observer: BotRegistryObserver<Bot>): () => void {
		this.observers.add(observer)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.observers.delete(observer)
		}
	}
}

export function normalizeBotId(value: string): string {
	const id = value.trim()
	if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id))
		throw new Error(
			'Bot id must be 1-64 lowercase ASCII letters, digits, dots, underscores, or hyphens',
		)
	return id
}

function normalizeLookupId(value: string): string {
	return value.trim()
}
