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

export function pluginLogCategory(
	rootId: string,
	pluginId: string,
): readonly ['pluxel', 'plugins', string, string] {
	return ['pluxel', 'plugins', rootId, pluginId]
}

export function debugLogCategory(
	rootId: string,
	topic: string,
	pluginId?: string,
): readonly string[] {
	const segments = splitDebugTopic(topic)
	return pluginId
		? ['pluxel', 'debug', rootId, 'plugin', pluginId, ...segments]
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
): { rootId: string; pluginId: string } | undefined {
	if (category[0] !== 'pluxel') return undefined
	if (category.length === 4 && category[1] === 'plugins') {
		return { rootId: category[2]!, pluginId: category[3]! }
	}
	if (category.length >= 6 && category[1] === 'debug' && category[3] === 'plugin') {
		return { rootId: category[2]!, pluginId: category[4]! }
	}
	return undefined
}
