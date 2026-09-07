import {
	formatPluginNodeRoute,
	parsePluginNodeRoute,
	type PluginNodeAddress,
} from '../plugins/runtime/identity'

export type PluginLogIdentity = Readonly<{
	rootId: string
	node: PluginNodeAddress
	topicOffset: number
}>

const pluginIdentityByCategory = new WeakMap<readonly string[], PluginLogIdentity | null>()

export const pluxelCategoryFamilies = {
	runtime: ['pluxel', 'runtime'],
	plugins: ['pluxel', 'plugins'],
	debug: ['pluxel', 'debug'],
} as const

export type PluxelCategoryFamily =
	(typeof pluxelCategoryFamilies)[keyof typeof pluxelCategoryFamilies]

export function runtimeLogCategory(rootId: string): readonly ['pluxel', 'runtime', string] {
	return Object.freeze(['pluxel', 'runtime', rootId])
}

function addressSegments(address: PluginNodeAddress): string[] {
	return formatPluginNodeRoute(address).split('/')
}

export function pluginLogCategory(rootId: string, address: PluginNodeAddress): readonly string[] {
	return Object.freeze(['pluxel', 'plugins', rootId, ...addressSegments(address)])
}

export function debugLogCategory(
	rootId: string,
	topic: string,
	address?: PluginNodeAddress,
): readonly string[] {
	const segments = splitDebugTopic(topic)
	return Object.freeze(
		address
			? ['pluxel', 'debug', rootId, 'plugin', ...addressSegments(address), ...segments]
			: ['pluxel', 'debug', rootId, 'runtime', ...segments],
	)
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

export function readPluginLogIdentity(category: readonly string[]): PluginLogIdentity | undefined {
	const cached = pluginIdentityByCategory.get(category)
	if (cached !== undefined) return cached ?? undefined
	if (category[0] !== 'pluxel') {
		pluginIdentityByCategory.set(category, null)
		return undefined
	}
	let offset: number
	if (category[1] === 'plugins') offset = 3
	else if (category[1] === 'debug' && category[3] === 'plugin') offset = 4
	else {
		pluginIdentityByCategory.set(category, null)
		return undefined
	}
	try {
		const parsed = parsePluginNodeRoute(category.slice(offset))
		const identity = Object.freeze({
			rootId: category[2]!,
			node: parsed.nodeAddress,
			topicOffset: offset + parsed.consumedSegments,
		})
		pluginIdentityByCategory.set(category, identity)
		return identity
	} catch {
		pluginIdentityByCategory.set(category, null)
		return undefined
	}
}
