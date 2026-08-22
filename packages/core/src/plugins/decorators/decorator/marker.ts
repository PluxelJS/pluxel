import type { PluginMarker } from './types'

const markers = new WeakMap<Function, PluginMarker>()

export function registerPluginMarker(ctor: Function, marker: PluginMarker): void {
	if (markers.has(ctor)) throw new Error('[pluxel/core] Plugin constructor is already decorated')
	markers.set(ctor, marker)
}

export function getPluginMarker(ctor: Function): PluginMarker | undefined {
	return markers.get(ctor)
}

/** Candidate ingestion consumes the decorator marker exactly once. */
export function consumePluginMarker(ctor: Function): PluginMarker | undefined {
	const marker = markers.get(ctor)
	if (marker) markers.delete(ctor)
	return marker
}
