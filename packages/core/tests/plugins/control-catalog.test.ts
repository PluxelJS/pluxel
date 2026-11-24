import { expect, it } from 'vitest'
import {
	parseControlCatalog,
	renderControlCatalog,
	type PluginControlManifest,
} from '../../src/internal/control-manifest'

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
