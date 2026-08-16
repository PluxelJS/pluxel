import {
	createPluginNodeAddress,
	type PluginNodeAddressSnapshot,
} from '../plugins/runtime/identity'

export const pluxelCategoryFamilies = {
	runtime: ['pluxel', 'runtime'],
	plugins: ['pluxel', 'plugins'],
	debug: ['pluxel', 'debug'],
} as const

export type PluxelCategoryFamily =
	(typeof pluxelCategoryFamilies)[keyof typeof pluxelCategoryFamilies]

export function runtimeLogCategory(rootId: string): readonly ['pluxel', 'runtime', string] {
	return ['pluxel', 'runtime', rootId]
}

function addressSegments(address: PluginNodeAddressSnapshot): string[] {
	const entry = address.definition.entry
	return [
		entry.kind,
		entry.kind === 'package-root' ? entry.packageName : entry.source,
		address.definition.exportName,
		address.instance,
		...(address.instance === 'fork' ? [address.forkId] : []),
	]
}

export function pluginLogCategory(
	rootId: string,
	address: PluginNodeAddressSnapshot,
): readonly string[] {
	return ['pluxel', 'plugins', rootId, ...addressSegments(address)]
}

export function debugLogCategory(
	rootId: string,
	topic: string,
	address?: PluginNodeAddressSnapshot,
): readonly string[] {
	const segments = splitDebugTopic(topic)
	return address
		? ['pluxel', 'debug', rootId, 'plugin', ...addressSegments(address), ...segments]
		: ['pluxel', 'debug', rootId, 'runtime', ...segments]
}

export function splitDebugTopic(topic: string): string[] {
	const value = String(topic).trim()
	if (!value) throw new Error('Debug topic must not be empty')
	if (value === '*' || value.endsWith(':*')) {
		throw new Error(`Debug logger topic must not contain a wildcard: ${value}`)
	}
	const segments = value.split(':')
	if (segments.length > 16) throw new Error(`Debug topic has too many segments: ${value}`)
	for (const segment of segments) {
		if (!segment || segment === '*' || segment.length > 80) {
			throw new Error(`Invalid debug topic segment in: ${value}`)
		}
	}
	return segments
}

export function readPluginLogIdentity(
	category: readonly string[],
): { rootId: string; node: PluginNodeAddressSnapshot; topicOffset: number } | undefined {
	if (category[0] !== 'pluxel') return undefined
	let offset: number
	if (category[1] === 'plugins') offset = 3
	else if (category[1] === 'debug' && category[3] === 'plugin') offset = 4
	else return undefined
	const kind = category[offset]
	const locator = category[offset + 1]
	const exportName = category[offset + 2]
	const instance = category[offset + 3]
	if (!locator || !exportName || (kind !== 'package-root' && kind !== 'source-entry'))
		return undefined
	if (instance !== 'default' && instance !== 'fork') return undefined
	const definition = {
		entry: kind === 'package-root' ? { kind, packageName: locator } : { kind, source: locator },
		exportName,
	} as const
	const node = createPluginNodeAddress(
		instance === 'default'
			? { definition, instance }
			: { definition, instance, forkId: category[offset + 4] ?? '' },
	)
	return { rootId: category[2]!, node, topicOffset: offset + (instance === 'fork' ? 5 : 4) }
}
