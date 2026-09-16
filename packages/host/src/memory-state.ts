import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import type { HostStateCoordinatorStore } from './coordinator'
import {
	freezeTrustedHostStateSnapshot,
	HostStateRevisionConflictError,
	type HostStateSnapshot,
	type HostStateVersionedSnapshot,
} from './policy'

/** Validates and detaches an application-owned initial policy. */
export function createMemoryHostState(
	input: Partial<HostStateSnapshot> = {},
): HostStateCoordinatorStore {
	const initial = freezeTrustedHostStateSnapshot({
		autoStart: (input.autoStart ?? []).map(parsePluginNodeAddress),
		forks: (input.forks ?? []).map(({ definition, forkIds }) => ({
			definition: parsePluginDefinitionAddress(definition),
			forkIds: forkIds.map((forkId) => {
				const node = parsePluginNodeAddress({ definition, variant: 'fork', forkId })
				if (node.variant !== 'fork') throw new TypeError('[host] expected fork node')
				return node.forkId
			}),
		})),
		providerDefaults: (input.providerDefaults ?? []).map(({ token, provider }) => ({
			token: parsePluginDefinitionAddress(token),
			provider: parsePluginNodeAddress(provider),
		})),
		dependencyOverrides: (input.dependencyOverrides ?? []).map(
			({ consumerAddress, requirementAddress, providerAddress }) => ({
				consumerAddress: parsePluginNodeAddress(consumerAddress),
				requirementAddress: parsePluginDefinitionAddress(requirementAddress),
				providerAddress: parsePluginNodeAddress(providerAddress),
			}),
		),
	})
	let current: HostStateVersionedSnapshot = Object.freeze({ revision: 0, state: initial })
	return {
		ready: Promise.resolve(),
		versionedSnapshot: () => current,
		async commitVersioned(expectedRevision, state) {
			if (expectedRevision !== current.revision)
				throw new HostStateRevisionConflictError(expectedRevision, current.revision)
			current = Object.freeze({
				revision: current.revision + 1,
				state: freezeTrustedHostStateSnapshot(state),
			})
			return current
		},
	}
}
