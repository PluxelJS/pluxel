export type InboundConsumer<Source, Event> = (
	source: Source,
	event: Event,
	signal: AbortSignal,
) => void | Promise<void>

/**
 * Ordered, fail-fast consumers that participate in a platform input checkpoint.
 * Each dispatch freezes its plan; registration changes apply to the next event.
 */
export class InboundConsumerRegistry<Source, Event> {
	private readonly consumers = new Map<string, InboundConsumer<Source, Event>>()

	constructor(private readonly label: string) {}

	get size(): number {
		return this.consumers.size
	}

	register(idInput: string, consumer: InboundConsumer<Source, Event>): () => void {
		const id = normalizeId(idInput, this.label)
		if (this.consumers.has(id)) throw new Error(`${this.label} is already registered: ${id}`)
		this.consumers.set(id, consumer)
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.consumers.get(id) === consumer) this.consumers.delete(id)
		}
	}

	async dispatch(source: Source, event: Event, signal: AbortSignal): Promise<void> {
		// oxlint-disable-next-line unicorn/no-useless-spread -- checkpoint semantics freeze this dispatch plan.
		for (const consumer of [...this.consumers.values()]) {
			if (signal.aborted) throw signal.reason
			await consumer(source, event, signal)
		}
	}

	clear(): void {
		this.consumers.clear()
	}
}

function normalizeId(value: string, label: string): string {
	const id = value.trim()
	if (!id) throw new Error(`${label} id is required`)
	return id
}
