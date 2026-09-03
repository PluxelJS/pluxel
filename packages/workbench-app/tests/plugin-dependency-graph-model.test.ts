import {
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginDependencyGraphSnapshot, PluginStatusSnapshot } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import { buildPluginDependencyGraphProjection } from '../src/app/plugins/pluginDependencyGraphModel'

const provider = node('ProviderPlugin')
const consumer = node('ConsumerPlugin')
const missing = definition('MissingPlugin')
const graph = Object.freeze({
	nodes: Object.freeze([
		Object.freeze({ status: status(provider), effective: true }),
		Object.freeze({ status: status(consumer), effective: true }),
	]),
	edges: Object.freeze([
		Object.freeze({
			consumer,
			requirement: provider.definition,
			mode: 'required' as const,
			resolution: Object.freeze({ state: 'resolved' as const, provider, via: 'direct' as const }),
			effective: true,
		}),
		Object.freeze({
			consumer,
			requirement: missing,
			mode: 'required' as const,
			resolution: Object.freeze({ state: 'unresolved' as const }),
			effective: false as const,
		}),
	]),
}) satisfies PluginDependencyGraphSnapshot

describe('plugin dependency graph projection', () => {
	it('builds canonical node, outgoing, and incoming indices once per snapshot', () => {
		const projected = buildPluginDependencyGraphProjection(graph)

		expect(projected.snapshot).toBe(graph)
		expect(projected.byNode.get(pluginNodeIndexKey(provider))?.status.address).toEqual(provider)
		expect(projected.outgoing.get(pluginNodeIndexKey(consumer))).toEqual(graph.edges)
		expect(projected.incoming.get(pluginNodeIndexKey(provider))).toEqual([graph.edges[0]])
		expect(projected.incoming.has(pluginNodeIndexKey(consumer))).toBe(false)
		expect(Object.isFrozen(projected)).toBe(true)
		expect(Object.isFrozen(projected.outgoing.get(pluginNodeIndexKey(consumer)))).toBe(true)
	})
})

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/dependency-graph' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function status(address: PluginNodeAddress): PluginStatusSnapshot {
	const name = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/dependency-graph::${name}`,
		route: `v1/package/${name}/@fixture/dependency-graph`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		availability: 'available',
		issues: [],
		source: {
			kind: 'unknown',
			moduleId: null,
			packageName: null,
			version: null,
			tag: null,
		},
	}
}
