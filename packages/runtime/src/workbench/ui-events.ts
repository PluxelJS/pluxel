import { useSyncExternalStore } from 'react'
import type { SseClientWithNamespaces, SseMessage } from '../web/sse'

export type WorkbenchEventConnectionState = Readonly<{
	state: 'connecting' | 'connected' | 'error'
	error: Error | null
}>

export interface WorkbenchEventsClient<TEvents extends Record<string, unknown>> {
	subscribe<Key extends keyof TEvents & string>(
		event: Key,
		listener: (payload: TEvents[Key]) => void,
	): () => void
	useConnectionState(): WorkbenchEventConnectionState
}

export function createEventsClient<TEvents extends Record<string, unknown>>(
	getStream: () => SseClientWithNamespaces,
): WorkbenchEventsClient<TEvents> {
	let state: WorkbenchEventConnectionState = Object.freeze({ state: 'connecting', error: null })
	const listeners = new Set<() => void>()
	let observed = false
	const notify = (next: WorkbenchEventConnectionState) => {
		state = Object.freeze(next)
		for (const listener of listeners) listener()
	}
	const observe = () => {
		const stream = getStream()
		if (!observed) {
			observed = true
			stream.onOpen(() => notify({ state: 'connected', error: null }))
			stream.onError(() =>
				notify({ state: 'error', error: new Error('event stream disconnected') }),
			)
		}
		return stream
	}
	return Object.freeze({
		subscribe<Key extends keyof TEvents & string>(
			event: Key,
			listener: (payload: TEvents[Key]) => void,
		) {
			return observe().onAny((message: SseMessage<string>) => {
				if (message.event === event) listener(message.payload as TEvents[Key])
			})
		},
		useConnectionState() {
			return useSyncExternalStore(
				(listener) => {
					listeners.add(listener)
					observe()
					return () => listeners.delete(listener)
				},
				() => state,
				() => state,
			)
		},
	})
}
