import { Context } from '@pluxel/context'
import { describe, expect, it } from 'vitest'
import { BasePlugin } from '../src/plugins/composition/BasePlugin'
import type { PluginConstructor } from '../src/plugins/types'
import {
	PluginDefinitions,
	type ConcretePluginDefinitionRecord,
} from '../src/plugins/runtime/PluginDefinitions'
import type { ConcretePluginDefinitionCandidate } from '../src/plugins/runtime/definition'
import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionSlot,
	type PluginNodeSlot,
} from '../src/plugins/runtime/identity'

class FamilyIndexGuard<K, V> extends Map<K, V> {
	iterations = 0
	gets = 0

	override get(key: K): V | undefined {
		this.gets++
		return super.get(key)
	}

	override entries(): MapIterator<[K, V]> {
		this.iterations++
		throw new Error('definition replacement scanned the complete family index')
	}

	override keys(): MapIterator<K> {
		this.iterations++
		throw new Error('definition replacement scanned the complete family index')
	}

	override values(): MapIterator<V> {
		this.iterations++
		throw new Error('definition replacement scanned the complete family index')
	}

	override forEach(): void {
		this.iterations++
		throw new Error('definition replacement scanned the complete family index')
	}

	override [Symbol.iterator](): MapIterator<[K, V]> {
		this.iterations++
		throw new Error('definition replacement scanned the complete family index')
	}
}

class FamilyVisitSet<T> extends Set<T> {
	visits = 0;

	override *[Symbol.iterator](): SetIterator<T> {
		for (const value of super.values()) {
			this.visits += 1
			yield value
		}
	}
}

function definition(exportName: string) {
	return parsePluginDefinitionAddress({
		entry: {
			kind: 'source-entry',
			sourceSpace: 'app',
			path: `core-cost-model/${exportName}.ts`,
		},
		exportName,
	})
}

function candidate(
	implementation: PluginConstructor,
	address: ReturnType<typeof definition>,
	forkable = false,
): ConcretePluginDefinitionCandidate {
	return Object.freeze({
		implementation,
		declaration: Object.freeze({
			address,
			displayName: address.exportName,
			requires: Object.freeze([]),
			optional: Object.freeze([]),
			parts: Object.freeze([]),
			forkable,
		}),
	})
}

describe('Plugin definition cost model', () => {
	it('records 1,000 fork additions and removals as one O(k) family delta', () => {
		const definitions = new PluginDefinitions(() => new Context({ name: 'family-delta' }))
		const targetAddress = definition('LargeFamily')
		const definitionSlot = definitions.internDefinition(targetAddress)
		class Target extends BasePlugin {}
		const target = candidate(Target, targetAddress, true)
		const addresses = Array.from({ length: 1_000 }, (_, index) =>
			parsePluginNodeAddress({
				definition: targetAddress,
				variant: 'fork',
				forkId: `fork-${index}`,
			}),
		)

		for (const address of addresses) definitions.materializeNode(address, target)

		const internals = definitions as unknown as {
			pendingNodeFamilyDeltas: Map<
				PluginDefinitionSlot,
				{ added: Set<PluginNodeSlot>; removed: Set<PluginNodeSlot> }
			>
			nodesByDefinition: Map<PluginDefinitionSlot, Set<PluginNodeSlot>>
			definitions: Map<PluginDefinitionSlot, ConcretePluginDefinitionRecord>
			nodes: Map<PluginNodeSlot, { definition: ConcretePluginDefinitionRecord }>
		}
		expect(internals.pendingNodeFamilyDeltas).toHaveLength(1)
		expect(internals.pendingNodeFamilyDeltas.get(definitionSlot)?.added).toHaveLength(1_000)
		expect(internals.pendingNodeFamilyDeltas.get(definitionSlot)?.removed).toHaveLength(0)

		const added = definitions.build()
		if (!added.ok) throw added.err.err
		added.val.confirm()
		expect(internals.nodesByDefinition.get(definitionSlot)).toHaveLength(1_000)
		expect(internals.definitions).toHaveLength(1)
		expect(internals.nodes).toHaveLength(1_000)
		expect(new Set([...internals.nodes.values()].map((record) => record.definition))).toHaveLength(
			1,
		)

		for (const address of addresses) definitions.dematerializeNode(address)
		expect(internals.pendingNodeFamilyDeltas).toHaveLength(1)
		expect(internals.pendingNodeFamilyDeltas.get(definitionSlot)?.added).toHaveLength(0)
		expect(internals.pendingNodeFamilyDeltas.get(definitionSlot)?.removed).toHaveLength(1_000)

		const removed = definitions.build()
		if (!removed.ok) throw removed.err.err
		removed.val.confirm()
		expect(internals.nodesByDefinition.has(definitionSlot)).toBe(false)
	})

	it('replaces one definition through its O(k) materialized-node index without scanning families', () => {
		const definitions = new PluginDefinitions(() => new Context({ name: 'cost-model' }))
		const targetAddress = definition('Target')
		class Target extends BasePlugin {}
		class TargetReplacement extends BasePlugin {}
		const target = candidate(Target, targetAddress, true)

		const targetNodes: PluginNodeSlot[] = []
		for (const variant of [
			{ variant: 'default' as const },
			{ variant: 'fork' as const, forkId: 'a' },
			{ variant: 'fork' as const, forkId: 'b' },
		]) {
			targetNodes.push(
				definitions.materializeNode(
					parsePluginNodeAddress({ definition: targetAddress, ...variant }),
					target,
				),
			)
		}
		for (let index = 0; index < 64; index++) {
			const address = definition(`Unrelated${index}`)
			class Unrelated extends BasePlugin {}
			definitions.materializeNode(
				parsePluginNodeAddress({ definition: address, variant: 'default' }),
				candidate(Unrelated, address),
			)
		}
		const built = definitions.build()
		if (!built.ok) throw built.err.err
		built.val.confirm()

		const internals = definitions as unknown as {
			nodesByDefinition: Map<PluginDefinitionSlot, ReadonlySet<PluginNodeSlot>>
		}
		const targetFamily = new FamilyVisitSet(
			internals.nodesByDefinition.get(targetNodes[0]!.definition),
		)
		internals.nodesByDefinition.set(targetNodes[0]!.definition, targetFamily)
		const guarded = new FamilyIndexGuard(internals.nodesByDefinition)
		internals.nodesByDefinition = guarded

		definitions.replaceDefinition(targetAddress, candidate(TargetReplacement, targetAddress, true))

		expect(guarded.gets).toBe(1)
		expect(guarded.iterations).toBe(0)
		expect(targetFamily.visits).toBe(targetNodes.length)
		for (const node of targetNodes) {
			const record = definitions.planningNodeRecord(node) as
				| { definition: ConcretePluginDefinitionRecord }
				| undefined
			expect(record?.definition.implementation).toBe(TargetReplacement)
		}
	})
})
