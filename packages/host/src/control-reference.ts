import type { PluginNodeAddress } from '@pluxel/core'
import { createPluginNodeAddressEvidence } from '@pluxel/core/internal/plugin-address-evidence'
import type { PluginDescriptor } from './agent/control'
import { parsePluginControlDescriptor } from './control-manifest'

/** Framework binding for the verified control-module template. Never loads a Plugin. */
export function createPluginControlReference(data: unknown): PluginDescriptor {
	const descriptor = parsePluginControlDescriptor(data)
	const evidence = Object.freeze({ kind: 'control' as const, descriptor })
	return Object.freeze({
		definitionAddress: () => descriptor.definition,
		nodeAddress: (forkId?: string) => {
			const node: PluginNodeAddress =
				forkId === undefined
					? { definition: descriptor.definition, variant: 'default' }
					: { definition: descriptor.definition, variant: 'fork', forkId }
			return createPluginNodeAddressEvidence(node, evidence)
		},
	}) as PluginDescriptor
}
