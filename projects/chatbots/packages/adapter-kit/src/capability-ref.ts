export interface CapabilityRef<Capability> {
	readonly current: Capability | undefined
	observe(observer: (current: Capability | undefined) => void): () => void
}

export interface CapabilityRefController<Capability> {
	set(current: Capability | undefined): void
}

export type CapabilityRefOptions = {
	onObserverError?: (error: unknown) => void
}

/** Mutable authority + read-only live view for optional plugin integrations. */
export function createCapabilityRef<Capability>(options: CapabilityRefOptions = {}): {
	readonly ref: CapabilityRef<Capability>
	readonly controller: CapabilityRefController<Capability>
} {
	let current: Capability | undefined
	const observers = new Set<(current: Capability | undefined) => void>()
	const ref: CapabilityRef<Capability> = Object.freeze({
		get current() {
			return current
		},
		observe(observer) {
			observers.add(observer)
			let active = true
			return () => {
				if (!active) return
				active = false
				observers.delete(observer)
			}
		},
	})
	return {
		ref,
		controller: Object.freeze({
			set(next: Capability | undefined) {
				if (next === current) return
				current = next
				for (const observer of observers) {
					try {
						observer(next)
					} catch (error) {
						options.onObserverError?.(error)
					}
				}
			},
		}),
	}
}
