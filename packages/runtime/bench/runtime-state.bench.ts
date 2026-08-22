import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import { bench, describe } from 'vitest'
import {
	createPluginRouteCatalogSnapshot,
	reconcilePluginGraph,
} from '../src/internal/reconciliation/index'
import { applyRuntimeStatePatch, runtimeStatePatch } from '../src/internal/reconciliation/state'
import type { RuntimeStateSnapshot } from '../src/services/RuntimeStateStore'

const definition = (name: string): PluginDefinitionAddress => ({
	entry: { kind: 'package-root', packageName: `@bench/${name}` },
	exportName: 'Plugin',
})

const Consumer = definition('consumer')
const Requirement = definition('requirement')
const provider: PluginNodeAddress = {
	definition: definition('provider'),
	variant: 'default',
}
const forkProjectionDefinition = definition('fork-projection')
const forkProjectionCandidate = Object.freeze({
	implementation: class ForkProjectionProvider {},
	declaration: Object.freeze({
		address: forkProjectionDefinition,
		displayName: 'ForkProjectionProvider',
		requires: Object.freeze([]),
		optional: Object.freeze([]),
		parts: Object.freeze([]),
		forkable: true,
	}),
}) as unknown as ConcretePluginDefinitionCandidate
const forkProjectionCatalog = createPluginRouteCatalogSnapshot(1, [
	{ candidate: forkProjectionCandidate },
])
const forkProjectionSizes = [1, 10, 100, 1_000] as const
const consumerCount = 5_000
const removalCount = 1_000
const consumers: PluginNodeAddress[] = Array.from({ length: consumerCount }, (_, index) => ({
	definition: Consumer,
	variant: 'fork',
	forkId: `consumer-${index}`,
}))
const state: RuntimeStateSnapshot = Object.freeze({
	enabled: Object.freeze([...consumers]),
	forks: Object.freeze([]),
	providerDefaults: Object.freeze([]),
	dependencyOverrides: Object.freeze(
		consumers.map((consumerAddress) =>
			Object.freeze({
				consumerAddress,
				requirementAddress: Requirement,
				providerAddress: provider,
			}),
		),
	),
})
const removal = runtimeStatePatch(
	...consumers.slice(0, removalCount).map((node) => ({
		type: 'remove-node-policy' as const,
		node,
	})),
)

describe('RuntimeState indexed mutation', () => {
	bench(
		'remove 1,000 consumers from 5,000 overrides',
		() => {
			const next = applyRuntimeStatePatch(state, removal)
			if (next.dependencyOverrides.length !== consumerCount - removalCount) {
				throw new Error('RuntimeState benchmark produced an invalid result')
			}
		},
		{ iterations: 5, warmupIterations: 1 },
	)
})

describe('disabled durable fork projection', () => {
	for (const size of forkProjectionSizes) {
		const runtimeState: RuntimeStateSnapshot = Object.freeze({
			enabled: Object.freeze([]),
			forks: Object.freeze([
				Object.freeze({
					definition: forkProjectionDefinition,
					forkIds: Object.freeze(Array.from({ length: size }, (_, index) => `disabled-${index}`)),
				}),
			]),
			providerDefaults: Object.freeze([]),
			dependencyOverrides: Object.freeze([]),
		})

		bench(
			`project ${size} disabled durable fork${size === 1 ? '' : 's'} without Core operations`,
			() => {
				const plan = reconcilePluginGraph({
					catalog: forkProjectionCatalog,
					runtimeState,
					runtimeStateRevision: 1,
				})
				if (
					plan.coreOperations.length > 0 ||
					plan.applied.nodes.size > 0 ||
					plan.blocked.length > 0
				) {
					throw new Error('Disabled durable fork projection allocated applied Core work')
				}
			},
			{ iterations: 10, warmupIterations: 2 },
		)
	}
})
