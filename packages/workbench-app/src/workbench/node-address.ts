import { parsePluginNodeAddress, type PluginNodeAddressSnapshot } from '@pluxel/core'

/** Browser-side canonical key for ephemeral maps only. Transport keeps the structured address. */
export function workbenchNodeKey(input: PluginNodeAddressSnapshot): string {
	const address = parsePluginNodeAddress(input)
	const entry = address.definition.entry
	return JSON.stringify([
		entry.kind,
		entry.kind === 'package-root' ? entry.packageName : entry.source,
		address.definition.exportName,
		address.instance,
		address.instance === 'fork' ? address.forkId : null,
	])
}

export function encodeWorkbenchNodeSegment(input: PluginNodeAddressSnapshot): string {
	return encodeURIComponent(JSON.stringify(parsePluginNodeAddress(input)))
}

export function decodeWorkbenchNodeSegment(segment: string): PluginNodeAddressSnapshot {
	return parsePluginNodeAddress(JSON.parse(decodeURIComponent(segment)) as unknown)
}
