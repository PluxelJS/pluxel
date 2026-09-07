import {
	comparePluginDefinitionAddress,
	comparePluginNodeAddress,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import { parsePluginDependencyGraphSnapshot } from '../../src/web/management-validation'
import { RuntimeProtocolValidationError } from '../../src/web/validation'

function definition(name: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: `@fixture/${name.toLowerCase()}` },
		exportName: name,
	}
}

function node(definitionAddress: PluginDefinitionAddress): PluginNodeAddress {
	return { definition: definitionAddress, variant: 'default' }
}

function status(
	address: PluginNodeAddress,
	options: { desired?: boolean; available?: boolean } = {},
) {
	const desired = options.desired ?? true
	const available = options.available ?? true
	return {
		address,
		reference: `package:${address.definition.entry.kind === 'package-root' ? address.definition.entry.packageName : 'source'}::${address.definition.exportName}`,
		route: `plugins/v1/package/${address.definition.exportName}`,
		displayName: address.definition.exportName,
		label: { title: address.definition.exportName, text: address.definition.exportName },
		rootExportName: address.definition.exportName,
		autoStart: desired,
		sessionIntent: 'inherit' as const,
		desiredState: desired ? ('running' as const) : ('stopped' as const),
		activationReason: desired ? ('auto-start' as const) : null,
		lifecycleState: 'stopped' as const,
		availability: available ? ('available' as const) : ('unavailable' as const),
		issues: [],
		execution: {
			kind: 'unreported' as const,
			artifact: { kind: 'unreported' as const },
			update: { kind: 'unreported' as const },
		},
		recentUpdate: null,
	}
}

function graphNode(
	address: PluginNodeAddress,
	effective: boolean,
	options?: { desired?: boolean; available?: boolean },
) {
	return { status: status(address, options), effective }
}

function resolvedEdge(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
	provider: PluginNodeAddress,
	options: {
		mode?: 'required' | 'optional'
		via?: 'direct' | 'provider-default' | 'dependency-override'
		effective?: boolean
	} = {},
) {
	return {
		consumer,
		requirement,
		mode: options.mode ?? ('required' as const),
		resolution: {
			state: 'resolved' as const,
			provider,
			via: options.via ?? ('direct' as const),
		},
		effective: options.effective ?? false,
	}
}

function unresolvedEdge(consumer: PluginNodeAddress, requirement: PluginDefinitionAddress) {
	return {
		consumer,
		requirement,
		mode: 'required' as const,
		resolution: { state: 'unresolved' as const },
		effective: false as const,
	}
}

function sortNodes<T extends { status: { address: PluginNodeAddress } }>(nodes: T[]): T[] {
	return nodes.sort((left, right) =>
		comparePluginNodeAddress(left.status.address, right.status.address),
	)
}

function sortEdges<T extends { consumer: PluginNodeAddress; requirement: PluginDefinitionAddress }>(
	edges: T[],
): T[] {
	return edges.sort((left, right) => {
		const consumerOrder = comparePluginNodeAddress(left.consumer, right.consumer)
		return consumerOrder || comparePluginDefinitionAddress(left.requirement, right.requirement)
	})
}

const consumer = node(definition('ConsumerPlugin'))
const directProvider = node(definition('DirectProvider'))
const selectedProvider = node(definition('SelectedProvider'))
const optionalProvider = node(definition('OptionalProvider'))
const missingRequirement = definition('MissingRequirement')

describe('Plugin dependency graph browser validation', () => {
	it('accepts every closed edge state and deeply freezes the snapshot', () => {
		const wire = {
			nodes: sortNodes([
				graphNode(consumer, true),
				graphNode(directProvider, true),
				graphNode(selectedProvider, false, { desired: false }),
			]),
			edges: sortEdges([
				resolvedEdge(consumer, directProvider.definition, directProvider, {
					effective: true,
				}),
				resolvedEdge(consumer, selectedProvider.definition, selectedProvider, {
					via: 'provider-default',
				}),
				unresolvedEdge(consumer, missingRequirement),
				resolvedEdge(consumer, optionalProvider.definition, optionalProvider, {
					mode: 'optional',
				}),
			]),
		}

		const snapshot = parsePluginDependencyGraphSnapshot(wire)
		expect(snapshot).toEqual(wire)
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.nodes)).toBe(true)
		expect(Object.isFrozen(snapshot.edges)).toBe(true)
		expect(Object.isFrozen(snapshot.nodes[0]!.status.address.definition.entry)).toBe(true)
		expect(Object.isFrozen(snapshot.edges[0]!.resolution)).toBe(true)
	})

	it('rejects unknown fields, union tags, resolution modes, and dangerous keys', () => {
		const baseNode = graphNode(consumer, false)
		const baseEdge = resolvedEdge(consumer, directProvider.definition, directProvider)

		expect(() =>
			parsePluginDependencyGraphSnapshot({ nodes: [baseNode], edges: [], revision: 1 }),
		).toThrow(/unsupported field revision/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [{ ...baseNode, generation: 1 }],
				edges: [],
			}),
		).toThrow(/unsupported field generation/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([baseNode, graphNode(directProvider, false)]),
				edges: [{ ...baseEdge, mode: 'soft' }],
			}),
		).toThrow(/mode must be one of required, optional/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [baseNode],
				edges: [
					{
						...unresolvedEdge(consumer, missingRequirement),
						resolution: { state: 'pending' },
					},
				],
			}),
		).toThrow(/resolution.state must be one of resolved, unresolved/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([baseNode, graphNode(directProvider, false)]),
				edges: [{ ...baseEdge, resolution: { ...baseEdge.resolution, via: 'fallback' } }],
			}),
		).toThrow(/resolution.via must be one of/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([baseNode, graphNode(directProvider, false)]),
				edges: [{ ...baseEdge, resolution: { ...baseEdge.resolution, reason: 'historical' } }],
			}),
		).toThrow(/resolution contains unsupported field reason/)

		const dangerousResolution = Object.assign(Object.create(null), baseEdge.resolution, {
			constructor: 'poison',
		})
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([baseNode, graphNode(directProvider, false)]),
				edges: [{ ...baseEdge, resolution: dangerousResolution }],
			}),
		).toThrow(/reserved field constructor/)
	})

	it('rejects duplicate or non-canonically sorted nodes and edges', () => {
		const firstNode = graphNode(consumer, false)
		const secondNode = graphNode(directProvider, false)
		const orderedNodes = sortNodes([firstNode, secondNode])
		expect(() =>
			parsePluginDependencyGraphSnapshot({ nodes: [firstNode, firstNode], edges: [] }),
		).toThrow(/duplicate node address/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({ nodes: orderedNodes.toReversed(), edges: [] }),
		).toThrow(/sorted by canonical node identity/)

		const firstEdge = resolvedEdge(consumer, directProvider.definition, directProvider)
		const secondEdge = unresolvedEdge(consumer, missingRequirement)
		const edgeNodes = sortNodes([firstNode, secondNode])
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: edgeNodes,
				edges: [firstEdge, firstEdge],
			}),
		).toThrow(/duplicate consumer and requirement/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: edgeNodes,
				edges: sortEdges([firstEdge, secondEdge]).toReversed(),
			}),
		).toThrow(/sorted by canonical consumer and requirement identity/)
	})

	it('rejects dishonest node, resolution, and membership combinations', () => {
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, true, { desired: false })],
				edges: [],
			}),
		).toThrow(/effective node must be desired running and available/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, true, { available: false })],
				edges: [],
			}),
		).toThrow(/effective node must be desired running and available/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, false)],
				edges: [{ ...unresolvedEdge(consumer, missingRequirement), effective: true }],
			}),
		).toThrow(/unresolved edge must be inactive/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, false)],
				edges: [
					{
						...unresolvedEdge(consumer, missingRequirement),
						mode: 'optional',
					},
				],
			}),
		).toThrow(/optional edge must be resolved/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, false)],
				edges: [resolvedEdge(consumer, directProvider.definition, directProvider)],
			}),
		).toThrow(/resolved required edge provider must exist/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(directProvider, false)],
				edges: [resolvedEdge(consumer, directProvider.definition, directProvider)],
			}),
		).toThrow(/edge consumer must exist/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([graphNode(consumer, false), graphNode(directProvider, true)]),
				edges: [
					resolvedEdge(consumer, directProvider.definition, directProvider, {
						effective: true,
					}),
				],
			}),
		).toThrow(/effective edge consumer must be an effective node/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([graphNode(consumer, true), graphNode(directProvider, false)]),
				edges: [
					resolvedEdge(consumer, directProvider.definition, directProvider, {
						effective: true,
					}),
				],
			}),
		).toThrow(/effective edge provider must be an effective node/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [graphNode(consumer, true)],
				edges: [
					resolvedEdge(consumer, optionalProvider.definition, optionalProvider, {
						mode: 'optional',
						via: 'direct',
						effective: true,
					}),
				],
			}),
		).toThrow(/effective edge provider must be an effective node/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: sortNodes([graphNode(consumer, false), graphNode(directProvider, false)]),
				edges: [
					resolvedEdge(consumer, directProvider.definition, directProvider, {
						mode: 'optional',
						via: 'provider-default',
					}),
				],
			}),
		).toThrow(/resolution.via must be one of direct/)
	})

	it('rejects a cycle in the effective subset while allowing inactive relations', () => {
		const left = node(definition('CycleLeft'))
		const right = node(definition('CycleRight'))
		const nodes = sortNodes([graphNode(left, true), graphNode(right, true)])
		const cycle = sortEdges([
			resolvedEdge(left, right.definition, right, { effective: true }),
			resolvedEdge(right, left.definition, left, { effective: true }),
		])
		expect(() => parsePluginDependencyGraphSnapshot({ nodes, edges: cycle })).toThrow(
			/effective node and edge subset must be a DAG/,
		)

		const declarationCycle = sortEdges([
			resolvedEdge(left, right.definition, right),
			resolvedEdge(right, left.definition, left),
		])
		expect(
			parsePluginDependencyGraphSnapshot({ nodes, edges: declarationCycle }).edges,
		).toHaveLength(2)
	})

	it('applies the shared array, object, text, and total portable-tree budgets first', () => {
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: Array.from({ length: 10_001 }, () => null),
				edges: [],
			}),
		).toThrow(/10000 items/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [],
				edges: [],
				extra: Object.fromEntries(
					Array.from({ length: 10_001 }, (_, index) => [`field${index}`, null]),
				),
			}),
		).toThrow(/too many fields/)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [
					{
						...graphNode(consumer, false),
						status: { ...status(consumer), reference: 'x'.repeat(1_000_001) },
					},
				],
				edges: [],
			}),
		).toThrow(/maximum string length/)

		const repeatedEdge = resolvedEdge(consumer, directProvider.definition, directProvider)
		expect(() =>
			parsePluginDependencyGraphSnapshot({
				nodes: [],
				edges: Array.from({ length: 10_000 }, () => repeatedEdge),
			}),
		).toThrow(/total node budget/)
	})

	it('rejects cyclic wire objects before graph interpretation', () => {
		const cyclic: Record<string, unknown> = { nodes: [], edges: [] }
		cyclic.self = cyclic
		expect(() => parsePluginDependencyGraphSnapshot(cyclic)).toThrow(RuntimeProtocolValidationError)
	})
})
