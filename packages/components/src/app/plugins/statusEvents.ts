// statusEvents.ts
import type { PluginStatusAction } from '../../../../hmr/src/api/hono/rpc/types'

export interface PluginStatusEvent {
	pluginName?: string
	action?: PluginStatusAction
}

type Listener = (event?: PluginStatusEvent) => void

const listeners = new Set<Listener>()

export function subscribePluginStatusEvents(listener: Listener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function emitPluginStatusEvent(event?: PluginStatusEvent): void {
	for (const listener of listeners) {
		try {
			listener(event)
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.error('[PluginStatusEvents] listener failed', error)
			}
		}
	}
}
