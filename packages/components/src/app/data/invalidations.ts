export type InvalidationTopic =
	| 'plugin-status'
	| 'plugin-groups'
	| 'package-data'
	| 'plugin-manifest'

export type InvalidationEvent = {
	topic: InvalidationTopic
	pluginName?: string
	reason?: string
}

type Listener = (event: InvalidationEvent) => void

const listeners = new Set<Listener>()

export function subscribeInvalidations(listener: Listener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function invalidate(event: InvalidationEvent | InvalidationTopic): void {
	const payload: InvalidationEvent =
		typeof event === 'string' ? { topic: event } : event
	for (const listener of listeners) {
		try {
			listener(payload)
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.error('[Invalidations] listener failed', error)
			}
		}
	}
}
