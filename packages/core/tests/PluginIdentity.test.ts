import { describe, expect, it } from 'vitest'
import {
	encodePluginNodeAddressBytes,
	formatPluginNodeReference,
	formatPluginNodeRoute,
	parsePluginDefinitionAddress,
	parsePluginEntryAddress,
	parsePluginNodeAddress,
	parsePluginNodeReference,
	parsePluginNodeRoute,
	PluginSlotRegistry,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '../src/plugins/runtime/identity'
import { pluginNodeAddressOf } from '../src/plugins/runtime/definition'
import { __setPluginDefinition } from '../src/toolchain'

const packageDefault = parsePluginNodeAddress({
	definition: {
		entry: { kind: 'package-root', packageName: '@acme/orders' },
		exportName: 'OrdersPlugin',
	},
	variant: 'default',
})

const sourceFork = parsePluginNodeAddress({
	definition: {
		entry: {
			kind: 'source-entry',
			sourceSpace: 'app',
			path: 'plugins/orders.ts',
		},
		exportName: 'OrdersPlugin',
	},
	variant: 'fork',
	forkId: 'east',
})

describe('Plugin identity', () => {
	it('parses only the canonical address shape', () => {
		expect(Object.isFrozen(packageDefault)).toBe(true)
		expect(Object.isFrozen(packageDefault.definition)).toBe(true)
		expect(Object.isFrozen(packageDefault.definition.entry)).toBe(true)
		expect(() =>
			parsePluginNodeAddress({
				definition: packageDefault.definition,
				instance: 'default',
			}),
		).toThrow(/variant/)
		expect(() =>
			parsePluginNodeAddress({
				definition: {
					entry: { kind: 'source-entry', source: 'plugins/orders.ts' },
					exportName: 'OrdersPlugin',
				},
				variant: 'default',
			}),
		).toThrow(/source/)
	})

	it('reuses only addresses canonicalized by this evaluated kernel', () => {
		expect(parsePluginEntryAddress(packageDefault.definition.entry)).toBe(
			packageDefault.definition.entry,
		)
		expect(parsePluginDefinitionAddress(packageDefault.definition)).toBe(packageDefault.definition)
		expect(parsePluginNodeAddress(packageDefault)).toBe(packageDefault)

		const merelyFrozen = Object.freeze({
			definition: packageDefault.definition,
			variant: 'default' as const,
		})
		const canonical = parsePluginNodeAddress(merelyFrozen)
		expect(canonical).not.toBe(merelyFrozen)
		expect(parsePluginNodeAddress(canonical)).toBe(canonical)

		const mutable = {
			definition: {
				entry: { kind: 'package-root' as const, packageName: '@acme/first' },
				exportName: 'MutablePlugin',
			},
			variant: 'default' as const,
		}
		const first = parsePluginNodeAddress(mutable)
		mutable.definition.entry.packageName = '@acme/second'
		const second = parsePluginNodeAddress(mutable)
		expect(second).not.toBe(first)
		expect(second.definition.entry).toMatchObject({ packageName: '@acme/second' })
	})

	it('requires every address field to be an own property', () => {
		const inherited = Object.create({
			definition: packageDefault.definition,
			variant: 'default',
		})
		expect(() => parsePluginNodeAddress(inherited)).toThrow(/missing field definition/)
	})

	it('rejects non-canonical source paths and fork ids', () => {
		for (const path of ['/plugins/orders.ts', '../orders.ts', 'plugins\\orders.ts']) {
			expect(() => sourceAddress(path)).toThrow(/source path/)
		}
		expect(() =>
			parsePluginNodeAddress({
				definition: packageDefault.definition,
				variant: 'fork',
				forkId: 'tenant/acme',
			}),
		).toThrow(/fork id/)
	})

	it('interns equal addresses and keeps source spaces distinct', () => {
		const slots = new PluginSlotRegistry()
		const first = slots.internNode(sourceAddress('plugins/orders.ts'))
		const same = slots.internNode(sourceAddress('plugins/orders.ts'))
		const otherSpace = slots.internNode(sourceAddress('plugins/orders.ts', 'managed'))
		expect(same).toBe(first)
		expect(otherSpace).not.toBe(first)
		expect(first.variant).toBe('default')
	})

	it('keeps constructor and slot address projections referentially stable', () => {
		class StableProjection {}
		__setPluginDefinition(StableProjection as never, {
			abiVersion: 1,
			kind: 'plugin',
			definition: sourceFork.definition,
		})

		const projected = pluginNodeAddressOf(StableProjection as never)
		expect(pluginNodeAddressOf(StableProjection as never)).toBe(projected)
		const slots = new PluginSlotRegistry()
		const node = slots.internNode(projected)
		expect(slots.definitionAddress(node.definition)).toBe(slots.definitionAddress(node.definition))
		expect(slots.nodeAddress(node)).toBe(slots.nodeAddress(node))
		expect(parsePluginNodeAddress(slots.nodeAddress(node))).toBe(slots.nodeAddress(node))
	})

	it('looks up canonical addresses without creating definition or node slots', () => {
		const slots = new PluginSlotRegistry()
		expect(slots.lookupDefinition(sourceFork.definition)).toBeUndefined()
		expect(slots.lookupNode(sourceFork)).toBeUndefined()

		const node = slots.internNode(sourceFork)
		expect(slots.lookupDefinition(sourceFork.definition)).toBe(node.definition)
		expect(slots.lookupNode(sourceFork)).toBe(node)
	})

	it('rejects slots from another registry', () => {
		const first = new PluginSlotRegistry()
		const second = new PluginSlotRegistry()
		const definition = first.internDefinition(packageDefault.definition)
		const node = first.defaultNode(definition)

		expect(() => second.defaultNode(definition)).toThrow(/another registry/)
		expect(() => second.definitionAddress(definition)).toThrow(/another registry/)
		expect(() => second.nodeAddress(node)).toThrow(/another registry/)
		expect(() => first.forkNode(definition, 'bad/id')).toThrow(/fork id/)
	})

	it('keeps versioned canonical bytes and index keys stable', () => {
		expect(hex(encodePluginNodeAddressBytes(packageDefault))).toBe(
			'01210000000c4061636d652f6f72646572730000000c4f7264657273506c7567696e',
		)
		expect(pluginNodeIndexKey(packageDefault)).toBe(
			'01210000000c4061636d652f6f72646572730000000c4f7264657273506c7567696e',
		)
		expect(pluginNodeIndexKey(sourceFork)).not.toBe(pluginNodeIndexKey(packageDefault))
	})

	it('round-trips canonical node references', () => {
		expect(formatPluginNodeReference(packageDefault)).toBe('package:@acme/orders::OrdersPlugin')
		expect(formatPluginNodeReference(sourceFork)).toBe(
			'source:app/plugins/orders.ts::OrdersPlugin#fork=east',
		)
		const parsedSourceFork = parsePluginNodeReference(formatPluginNodeReference(sourceFork))
		expect(pluginNodeAddressEqual(parsedSourceFork, sourceFork)).toBe(true)
		expect(parsePluginNodeAddress(parsedSourceFork)).toBe(parsedSourceFork)
		const parsedPackageDefault = parsePluginNodeReference(formatPluginNodeReference(packageDefault))
		expect(parsePluginNodeAddress(parsedPackageDefault)).toBe(parsedPackageDefault)
		expect(() => parsePluginNodeReference('package:%40acme/orders::OrdersPlugin')).toThrow(
			/canonical/,
		)
	})

	it('round-trips node routes and leaves suffix segments unconsumed', () => {
		const route = formatPluginNodeRoute(sourceFork)
		expect(route).toBe('v1/fork/east/source/OrdersPlugin/app/2/plugins/orders.ts')
		const rawSegments = [...route.split('/'), 'view', 'details']
		const parsed = parsePluginNodeRoute(rawSegments)
		expect(parsed.consumedSegments).toBe(9)
		expect(rawSegments.slice(parsed.consumedSegments)).toEqual(['view', 'details'])
		expect(pluginNodeAddressEqual(parsed.nodeAddress, sourceFork)).toBe(true)
		expect(() =>
			parsePluginNodeRoute(['v1', 'source', 'OrdersPlugin', 'app', '1', 'plugins%2Forders.ts']),
		).toThrow(/encoded separator/)
	})

	it('rejects duplicate required definition tokens', () => {
		class DuplicateRequirement {}

		expect(() =>
			__setPluginDefinition(DuplicateRequirement as never, {
				abiVersion: 1,
				kind: 'plugin',
				definition: sourceFork.definition,
				requires: [packageDefault.definition, packageDefault.definition],
			}),
		).toThrow(/required definition facts.*duplicate/i)
	})
})

function sourceAddress(path: string, sourceSpace = 'app'): PluginNodeAddress {
	return parsePluginNodeAddress({
		definition: {
			entry: { kind: 'source-entry', sourceSpace, path },
			exportName: 'OrdersPlugin',
		},
		variant: 'default',
	})
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
