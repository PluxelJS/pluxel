import type { PluginDefinitionAddress } from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import {
	applyHostStatePatch,
	type HostStateCoordinatorStore,
	type HostStateSnapshot,
} from '@pluxel/host/internal'
import type { HostPolicyInput } from '../../src/policy'

/** The coordinator fixtures model persistence of positive graph choices in memory. */
function positivePolicyInput(snapshot: HostStateSnapshot): HostPolicyInput {
	return {
		autoStart: snapshot.autoStart.map((node) => ({ node, autoStart: true })),
		forks: snapshot.forks.map((node) => ({ node, deploy: true })),
		providerDefaults: snapshot.providerDefaults,
		dependencyOverrides: snapshot.dependencyOverrides,
	}
}

function graphFromPolicyInput(saved: HostPolicyInput): HostStateSnapshot {
	return {
		autoStart: saved.autoStart?.flatMap(({ node, autoStart }) => (autoStart ? [node] : [])) ?? [],
		forks: saved.forks?.flatMap(({ node, deploy }) => (deploy ? [node] : [])) ?? [],
		providerDefaults: saved.providerDefaults ?? [],
		dependencyOverrides:
			saved.dependencyOverrides?.flatMap(({ providerAddress, ...target }) =>
				providerAddress === null ? [] : [{ ...target, providerAddress }],
			) ?? [],
	}
}

export function candidate(
	address: PluginDefinitionAddress,
	options: {
		requires?: readonly PluginDefinitionAddress[]
		optional?: readonly PluginDefinitionAddress[]
		provides?: PluginDefinitionAddress
		forkable?: boolean
	} = {},
): ConcretePluginDefinitionCandidate {
	class Implementation {}
	return Object.freeze({
		implementation: Implementation,
		declaration: Object.freeze({
			address,
			displayName: address.exportName,
			requires: Object.freeze([...(options.requires ?? [])]),
			optional: Object.freeze([...(options.optional ?? [])]),
			...(options.provides ? { provides: options.provides } : {}),
			parts: Object.freeze([]),
			forkable: options.forkable ?? false,
		}),
	}) as unknown as ConcretePluginDefinitionCandidate
}

export function state(input: Partial<HostStateSnapshot> = {}): HostStateSnapshot {
	return Object.freeze({
		autoStart: Object.freeze([...(input.autoStart ?? [])]),
		forks: Object.freeze([...(input.forks ?? [])]),
		providerDefaults: Object.freeze([...(input.providerDefaults ?? [])]),
		dependencyOverrides: Object.freeze([...(input.dependencyOverrides ?? [])]),
	})
}

export function memoryStateStore(
	initial: HostStateSnapshot,
	beforeCommit?: () => Promise<void>,
): HostStateCoordinatorStore {
	let current = Object.freeze({ revision: 0 as number, state: initial })
	return {
		ready: Promise.resolve(),
		versionedSnapshot: () => current,
		managedSnapshot: () => positivePolicyInput(current.state),
		prepareAction: (patch) => positivePolicyInput(applyHostStatePatch(current.state, patch)),
		assertManagedRevision() {},
		persistence: (changed) =>
			changed ? { status: 'confirmed', retention: 'session' } : { status: 'unchanged' },
		effectiveSnapshot: (saved) => graphFromPolicyInput(saved),
		assertPatchMutable() {},
		commitVersioned: async (expectedRevision, next) => {
			if (expectedRevision !== current.revision) throw new Error('unexpected revision conflict')
			if (beforeCommit) await beforeCommit()
			current = Object.freeze({ revision: current.revision + 1, state: graphFromPolicyInput(next) })
			return current
		},
	}
}
