import { expect, it } from 'vitest'
import {
	parseControlCatalog,
	parsePluginControlDependencies,
	parsePluginControlDependencyFacts,
	renderControlCatalog,
	type PluginControlManifest,
} from '../../src/internal/control-manifest'
import { pluginDefinitionIndexKey } from '../../src/plugins/runtime/identity'

it('binds complete dependency declarations to the listed definitions and preserves unavailable facts', () => {
	const entry = { kind: 'package-root', packageName: 'orders' } as const
	const order = { entry, exportName: 'Order' }
	const audit = { entry, exportName: 'Audit' }
	const other = { entry, exportName: 'Receipt' }
	const manifest = {
		definitions: [order, audit].map<PluginControlManifest['definitions'][number]>((definition) => ({
			definition,
			module: 'index.mjs',
			exportName: definition.exportName,
			contracts: { config: null, instance: 'digest' },
			source: 'root.ts',
		})),
	} satisfies Pick<PluginControlManifest, 'definitions'>
	const row = { definition: order, requires: [other], optional: [audit] }
	const parse = (definitions: readonly unknown[]) =>
		parsePluginControlDependencies(JSON.stringify({ format: 1, definitions }), manifest)
	expect(parse([row]).get(pluginDefinitionIndexKey(order))).toEqual({
		requires: [other],
		optional: [audit],
	})
	expect(parse([row]).has(pluginDefinitionIndexKey(audit))).toBe(false)
	expect(
		parsePluginControlDependencyFacts({ requires: [audit, other], optional: [] }).requires,
	).toEqual([audit, other])
	const sparse: unknown[] = []
	sparse.length = 1
	const invalidFacts: Record<string, unknown>[] = [
		{ requires: sparse, optional: [] },
		{ requires: [], optional: [], provides: undefined },
		{ requires: [], optional: [], forkable: undefined },
		{ requires: [], optional: [], definition: order },
	]
	for (const invalid of invalidFacts)
		expect(() => parsePluginControlDependencyFacts(invalid)).toThrow(/Plugin/)
	for (const invalid of [
		[row, row],
		[{ ...row, definition: other }],
		[{ ...row, optional: [other] }],
		[{ ...row, requires: {} }],
		[{ ...row, forkable: 'true' }],
		[{ ...row, provides: {} }],
	])
		expect(() => parse(invalid)).toThrow(/Plugin/i)
})

it('preserves searchable row order, distinguishes old member indexes, and binds canonical identities', () => {
	const definitions = ['first', 'second'].map<PluginControlManifest['definitions'][number]>(
		(packageName) => ({
			definition: { entry: { kind: 'package-root', packageName }, exportName: 'Counter' },
			module: 'index.mjs',
			exportName: packageName === 'first' ? 'Counter' : 'SecondCounter',
			source: 'index.ts',
			contracts: { config: null, instance: `sha256:${'0'.repeat(64)}` },
		}),
	)
	const first = {
		kind: 'plugin' as const,
		reference: 'package:first::Counter',
		exportName: 'Counter',
		hasConfig: false,
	}
	const second = {
		kind: 'plugin' as const,
		reference: 'package:second::Counter',
		exportName: 'SecondCounter',
		hasConfig: false,
		documentation: 'Two\nlines',
		members: ['load', 'save'],
	}
	const service = {
		kind: 'service' as const,
		reference: first.reference,
		exportName: 'CounterService',
		access: 'owner' as const,
	}
	const manifest = {
		definitions,
		services: [
			{
				definition: definitions[0]!.definition,
				module: 'index.mjs',
				exportName: service.exportName,
				access: service.access,
				contract: definitions[0]!.contracts.instance,
				source: 'index.ts',
			},
		],
	}
	const text = renderControlCatalog([service, second, first])
	expect(text.trimEnd().split('\n')).toHaveLength(5)
	expect(parseControlCatalog(text, manifest)).toEqual([service, second, first])
	const { kind: _first, ...legacyFirst } = first
	const { kind: _second, ...legacySecond } = second
	expect(parseControlCatalog(JSON.stringify([legacySecond, legacyFirst]), manifest)).toEqual([
		second,
		first,
		service,
	])
	expect(parseControlCatalog(undefined, manifest)).toEqual([
		first,
		{
			kind: 'plugin',
			reference: second.reference,
			exportName: second.exportName,
			hasConfig: false,
		},
		service,
	])
	expect(parseControlCatalog('[]', { ...manifest, definitions: [] })).toEqual([service])
	for (const rows of [
		[first, second],
		[first, first, service],
		[first, second, second, service],
		[first, { ...second, hasConfig: true }, service],
		[first, { ...second, exportName: 'Counter' }, service],
		[first, { ...second, members: ['load', 'load'] }, service],
		[first, { ...second, members: [1] }, service],
		[first, second, { ...service, access: 'all' }],
		[first, second, { ...service, hasConfig: false }],
		[first, legacySecond, service],
		[legacyFirst],
	])
		expect(() => parseControlCatalog(JSON.stringify(rows), manifest)).toThrow(/control catalog/i)
})
