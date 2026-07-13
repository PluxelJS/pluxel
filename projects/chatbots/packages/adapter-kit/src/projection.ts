export type AcknowledgedProjection<Source, Event> = (
	source: Source,
	event: Event,
	signal: AbortSignal,
) => void | Promise<void>

/**
 * Ordered fail-fast projections that participate in a platform checkpoint.
 * A dispatch snapshots its plan so registration changes only affect the next event.
 */
export class AcknowledgedProjectionRegistry<Source, Event> {
	private readonly projections = new Map<string, AcknowledgedProjection<Source, Event>>()

	constructor(private readonly label: string) {}

	get size(): number {
		return this.projections.size
	}

	register(idInput: string, projection: AcknowledgedProjection<Source, Event>): () => void {
		const id = normalizeProjectionId(idInput, this.label)
		if (this.projections.has(id)) throw new Error(`${this.label} is already registered: ${id}`)
		this.projections.set(id, projection)
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.projections.get(id) === projection) this.projections.delete(id)
		}
	}

	async dispatch(source: Source, event: Event, signal: AbortSignal): Promise<void> {
		const plan = [...this.projections.values()]
		for (const projection of plan) {
			if (signal.aborted) throw signal.reason
			await projection(source, event, signal)
		}
	}
}

function normalizeProjectionId(value: string, label: string): string {
	const id = value.trim()
	if (!id) throw new Error(`${label} id is required`)
	return id
}
