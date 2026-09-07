import {
	formatPluginDefinitionReference,
	formatPluginNodeRoute,
	parsePluginDefinitionReference,
	parsePluginNodeRoute,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'

export const PLUGIN_GRAPH_ROUTE = '/plugin-graph'

export type PluginGraphFocus =
	| Readonly<{ kind: 'node'; address: PluginNodeAddress }>
	| Readonly<{
			kind: 'edge'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
	  }>

export function buildPluginGraphNodeHref(address: PluginNodeAddress): string {
	return `${PLUGIN_GRAPH_ROUTE}/node/${formatPluginNodeRoute(address)}`
}

export function buildPluginGraphEdgeHref(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): string {
	return `${PLUGIN_GRAPH_ROUTE}/edge/${formatPluginNodeRoute(consumer)}/requires/${encodeURIComponent(formatPluginDefinitionReference(requirement))}`
}

export function parsePluginGraphFocus(pathname: string): PluginGraphFocus | null {
	try {
		if (
			!pathname.startsWith('/') ||
			pathname.endsWith('/') ||
			pathname.includes('//') ||
			pathname.includes('?') ||
			pathname.includes('#')
		) {
			return null
		}
		const segments = pathname.slice(1).split('/')
		if (segments[0] !== 'plugin-graph') return null
		const kind = segments[1]
		if (kind !== 'node' && kind !== 'edge') return null
		const parsedNode = parsePluginNodeRoute(segments.slice(2))
		const offset = 2 + parsedNode.consumedSegments
		const rawNodeRoute = segments.slice(2, offset).join('/')
		if (formatPluginNodeRoute(parsedNode.nodeAddress) !== rawNodeRoute) return null
		if (kind === 'node') {
			return offset === segments.length
				? Object.freeze({ kind: 'node', address: parsedNode.nodeAddress })
				: null
		}
		if (segments[offset] !== 'requires' || offset + 2 !== segments.length) return null
		const rawRequirement = segments[offset + 1] ?? ''
		const requirement = parsePluginDefinitionReference(decodeURIComponent(rawRequirement))
		if (encodeURIComponent(formatPluginDefinitionReference(requirement)) !== rawRequirement) {
			return null
		}
		return Object.freeze({
			kind: 'edge',
			consumer: parsedNode.nodeAddress,
			requirement,
		})
	} catch {
		return null
	}
}
