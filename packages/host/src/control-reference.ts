import type { PluginNodeAddress } from '@pluxel/core'
import { createServiceReference } from '@pluxel/core/internal'
import { __defineServiceRef } from '@pluxel/core/toolchain'
import { createPluginNodeAddressEvidence } from '@pluxel/core/internal/plugin-address-evidence'
import type { PluginDescriptor } from './agent/control'
import { parsePluginControlDescriptor, parseServiceControlDescriptor } from './control-manifest'

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

/** Required service reference reconstructed with the receiver's native Context registry. */
export function createServiceControlReference(data: unknown) {
	const descriptor = parseServiceControlDescriptor(data)
	return createServiceReference({
		definition: descriptor.definition,
		contract: descriptor.contract,
		access: descriptor.access,
	})
}

/** Optional lookup retains the same verified service identity and contract as its required form. */
export function createServiceControlRef(data: unknown) {
	const descriptor = parseServiceControlDescriptor(data)
	return __defineServiceRef({
		format: 1,
		definition: descriptor.definition,
		contract: descriptor.contract,
		access: descriptor.access,
	})
}
