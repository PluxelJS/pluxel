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
const pendingByTopic = new Map<InvalidationTopic, InvalidationEvent>()
let flushScheduled = false

function mergeEvent(prev: InvalidationEvent, next: InvalidationEvent): InvalidationEvent {
	return {
		topic: next.topic,
		pluginName: prev.pluginName === next.pluginName ? next.pluginName : undefined,
		reason: prev.reason === next.reason ? next.reason : undefined,
	}
}

function flushInvalidations() {
	flushScheduled = false
	if (pendingByTopic.size === 0) return
	const batch = Array.from(pendingByTopic.values())
	pendingByTopic.clear()

	for (const payload of batch) {
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
}

export function subscribeInvalidations(listener: Listener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function invalidate(event: InvalidationEvent | InvalidationTopic): void {
	const payload: InvalidationEvent =
		typeof event === 'string' ? { topic: event } : event
	const prev = pendingByTopic.get(payload.topic)
	pendingByTopic.set(payload.topic, prev ? mergeEvent(prev, payload) : payload)
	if (flushScheduled) return
	flushScheduled = true
	queueMicrotask(flushInvalidations)
}
