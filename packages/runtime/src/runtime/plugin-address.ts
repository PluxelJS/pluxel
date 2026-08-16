import { createHash } from 'node:crypto'
import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'

/** Canonical physical index only; Core graph identity remains the interned opaque slot. */
export function pluginDefinitionAddressKey(input: PluginDefinitionAddressSnapshot): string {
	const address = parsePluginDefinitionAddress(input)
	const entry = address.entry
	return JSON.stringify([
		entry.kind,
		entry.kind === 'package-root' ? entry.packageName : entry.source,
		address.exportName,
	])
}

/** Canonical physical index only; persistent contracts must retain the structured address. */
export function pluginNodeAddressKey(input: PluginNodeAddressSnapshot): string {
	const address = parsePluginNodeAddress(input)
	return JSON.stringify([
		pluginDefinitionAddressKey(address.definition),
		address.instance,
		address.instance === 'fork' ? address.forkId : null,
	])
}

export function pluginNodePhysicalKey(input: PluginNodeAddressSnapshot, length = 32): string {
	return createHash('sha256').update(pluginNodeAddressKey(input)).digest('hex').slice(0, length)
}
