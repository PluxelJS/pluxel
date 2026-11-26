import {
	parsePluginNodeAddress,
	pluginDefinitionAddressEqual,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { readPluginNodeAddressEvidence } from '@pluxel/core/internal/plugin-address-evidence'
import { parsePluginControlDescriptor, type PluginControlDescriptorData } from '../control-manifest'

/** Capture evidence before normalizing identity; never restore it by looking up a definition. */
export function normalizePluginTarget(target: PluginNodeAddress): Readonly<{
	address: PluginNodeAddress
	node: PluginNodeAddress
	descriptor?: PluginControlDescriptorData
	implementation?: PluginConstructor
}> {
	const evidence = readPluginNodeAddressEvidence(target)
	const node = parsePluginNodeAddress(target)
	if (evidence === undefined) return Object.freeze({ address: node, node })
	if (!evidence || typeof evidence !== 'object' || !('kind' in evidence))
		throw new TypeError('Unrecognized Plugin address evidence')
	if (evidence.kind === 'control' && 'descriptor' in evidence) {
		const descriptor = parsePluginControlDescriptor(evidence.descriptor)
		if (!pluginDefinitionAddressEqual(node.definition, descriptor.definition))
			throw new TypeError('Plugin address and control evidence must identify the same definition')
		return Object.freeze({ address: target, node, descriptor })
	}
	if (
		evidence.kind === 'constructor' &&
		'implementation' in evidence &&
		typeof evidence.implementation === 'function'
	) {
		const implementation = evidence.implementation as PluginConstructor
		if (!pluginDefinitionAddressEqual(node.definition, implementation.address()))
			throw new TypeError(
				'Plugin address and constructor evidence must identify the same definition',
			)
		return Object.freeze({ address: target, node, implementation })
	}
	throw new TypeError('Unrecognized Plugin address evidence')
}
