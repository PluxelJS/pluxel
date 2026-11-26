import { BasePlugin, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/test/unsafe'
import { expect, it, onTestFinished } from 'vitest'
import { createHost } from '../../src/index'
import { readHostCatalogProvenance, setHostCatalogProvenance } from '../../src/catalog-provenance'
import type { PluginCatalogProvenance } from '../../src/catalog'
import { readPluginSourceImpact } from '../../src/sources'

it('snapshots route execution facts only with accepted catalogs and releases the input binding on close', async () => {
	@Plugin()
	class Original extends BasePlugin {}
	@Plugin()
	class Replacement extends BasePlugin {}
	for (const plugin of [Original, Replacement])
		__setPluginDefinition(plugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'package-root', packageName: '@test/provenance' },
				exportName: 'Original',
			},
		})
	const source: PluginCatalogProvenance = {
		execution: {
			kind: 'vite',
			origin: 'fixed',
			artifact: { kind: 'source-module' },
			update: { kind: 'host-reload' },
		},
	}
	const built: PluginCatalogProvenance = {
		execution: {
			kind: 'vite',
			origin: 'fixed',
			artifact: { kind: 'built-module' },
			update: { kind: 'host-reload' },
		},
	}
	const host = await createHost({
		plugins: [
			{
				plugin: Original,
			},
		],
	})
	try {
		const input = new Map([[Original, source]])
		setHostCatalogProvenance(host.ctx, input)
		input.clear()
		await host.start()
		const sourceStatus = await host.status()
		expect(sourceStatus.statuses[0]?.execution).toEqual(source.execution)
		setHostCatalogProvenance(
			host.ctx,
			new Map([
				[Original, built],
				[Replacement, built],
			]),
		)
		await expect(host.updateCatalog([Original, Replacement])).rejects.toMatchObject({
			code: 'plugin_definition_collision',
		})
		const retainedStatus = await host.status()
		expect(retainedStatus.statuses[0]?.execution).toEqual(source.execution)
		await host.updateCatalog([Replacement])
		const builtStatus = await host.status()
		expect(builtStatus.statuses[0]?.execution).toEqual(built.execution)
	} finally {
		await host.close()
	}
	expect(readHostCatalogProvenance(host.ctx, Replacement)).toBeUndefined()
})

async function sourceImpactFixture() {
	@Plugin({ forkable: true })
	class Provider extends BasePlugin {}
	@Plugin()
	class Required extends BasePlugin {}
	@Plugin()
	class Optional extends BasePlugin {}
	const definition = (name: string) => ({
		entry: { kind: 'package-root' as const, packageName: `@fixture/${name.toLowerCase()}` },
		exportName: name,
	})
	for (const plugin of [Provider, Required, Optional])
		__setPluginDefinition(plugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: definition(plugin.name),
			constructorRequires: plugin === Required ? [definition('Provider')] : [],
			optional: plugin === Optional ? [definition('Provider')] : [],
		})
	const host = await createHost({
		plugins: [
			{ plugin: Provider, forks: { east: {} } },
			{ plugin: Required, autoStart: true },
			{ plugin: Optional, autoStart: true },
		],
	})
	onTestFinished(() => host.close())
	setHostCatalogProvenance(
		host.ctx,
		new Map<typeof Provider, PluginCatalogProvenance>([
			[
				Provider,
				{
					sourceFiles: ['/app/provider.mjs'],
					execution: {
						kind: 'native',
						origin: 'source',
						artifact: { kind: 'built-module' },
						update: { kind: 'next-start' },
					},
				},
			],
			[
				Required,
				{
					execution: {
						kind: 'native',
						origin: 'fixed',
						artifact: { kind: 'built-module' },
						update: { kind: 'next-start' },
					},
				},
			],
		]),
	)
	await host.start()
	const packages = [
		{ name: '@fixture/provider', file: '/app/provider.mjs' },
		{ name: '@fixture/required', file: '/app/required.mjs' },
	]
	const provider = parsePluginNodeAddress(Provider.nodeAddress())
	const required = parsePluginNodeAddress(Required.nodeAddress())
	const optional = parsePluginNodeAddress(Optional.nodeAddress())
	return { host, packages, provider, required, optional, Provider, Required, Optional, definition }
}

it('reports fixed imports, stopped forks and the direct required and optional bindings from the admitted graph', async () => {
	const { host, packages, provider, optional, required, Provider, Required, Optional } =
		await sourceImpactFixture()
	const impact = readPluginSourceImpact(host.ctx, packages)
	expect(impact.definitions).toEqual([
		{
			packageName: '@fixture/provider',
			address: Provider.address(),
			origin: 'owned',
			nodes: [
				{
					address: provider,
					running: true,
					requiredConsumers: [required],
					optionalConsumers: [optional],
				},
				{
					address: parsePluginNodeAddress(Provider.nodeAddress('east')),
					running: false,
					requiredConsumers: [],
					optionalConsumers: [],
				},
			],
		},
		{
			packageName: '@fixture/required',
			address: Required.address(),
			origin: 'fixed',
			nodes: [
				{
					address: required,
					running: true,
					requiredConsumers: [],
					optionalConsumers: [],
				},
			],
		},
	])
	await host.stopNode(Optional.nodeAddress())
	const settled = readPluginSourceImpact(host.ctx, packages)
	expect(settled.catalogRevision).toEqual(impact.catalogRevision)
	expect(settled.definitions[0]!.nodes[0]!.optionalConsumers).toEqual([])
})

it('projects a batch using current policy, including transitive blocks, without changing the running Host', async () => {
	const { host, packages, provider, required, Provider, Required, definition } =
		await sourceImpactFixture()
	const impact = readPluginSourceImpact(host.ctx, packages)
	const token = definition('Token')
	const publication = {
		name: '@fixture/provider',
		file: '/app/provider.mjs',
		action: 'publish',
	} as const
	const candidate = {
		address: Provider.address(),
		dependencies: { requires: [token], optional: [], forkable: true } as const,
	}
	const change = { ...publication, definitions: [candidate] }
	const blocked = readPluginSourceImpact(host.ctx, [change]).dependencyReview
	expect(blocked).toMatchObject({
		status: 'projected',
		liveRejections: [
			expect.objectContaining({
				kind: 'missing_required_provider',
				consumer: provider,
				requirement: token,
			}),
		],
		introduced: expect.arrayContaining([
			expect.objectContaining({
				kind: 'missing_required_provider',
				consumer: provider,
				requirement: token,
			}),
			expect.objectContaining({
				kind: 'missing_required_provider',
				consumer: required,
				requirement: Provider.address(),
			}),
		]),
		bindings: [
			{ consumer: required, requirement: Provider.address(), previous: provider, selected: null },
		],
	})
	const alt = definition('Alternate')
	const available = readPluginSourceImpact(host.ctx, [
		change,
		{
			name: '@fixture/alternate',
			file: '/app/alternate.mjs',
			action: 'publish',
			definitions: [
				{ address: alt, dependencies: { requires: [], optional: [], provides: token } },
			],
		},
	]).dependencyReview
	expect(available).toEqual({
		status: 'projected',
		liveRejections: [],
		unprovided: [],
		introduced: [],
		resolved: [],
		bindings: [
			{
				consumer: provider,
				requirement: token,
				previous: null,
				selected: { definition: alt, variant: 'default' },
			},
		],
	})
	expect(
		readPluginSourceImpact(host.ctx, [
			{
				...publication,
				definitions: [
					{
						address: Provider.address(),
						dependencies: {
							requires: [],
							optional: [],
							provides: Required.address(),
							forkable: true,
						},
					},
				],
			},
		]).dependencyReview,
	).toMatchObject({ status: 'invalid', code: 'plugin_definition_role_conflict' })
	expect(
		readPluginSourceImpact(host.ctx, [
			{
				...publication,
				definitions: [
					{
						address: Provider.address(),
						dependencies: { requires: [], optional: [] },
					},
				],
			},
		]).dependencyReview,
	).toMatchObject({ status: 'incomplete', missing: [{ reason: 'forkability' }] })
	expect(
		readPluginSourceImpact(host.ctx, [
			{ ...publication, definitions: [{ address: Provider.address() }] },
		]).dependencyReview,
	).toMatchObject({ status: 'incomplete', missing: [{ reason: 'dependencies' }] })
	const unreported = definition('Optional')
	expect(
		readPluginSourceImpact(host.ctx, [
			{
				name: '@fixture/optional',
				file: '/app/optional.mjs',
				action: 'publish',
				definitions: [{ address: unreported, dependencies: { requires: [], optional: [] } }],
			},
		]).dependencyReview,
	).toEqual({
		status: 'incomplete',
		missing: [
			{ packageName: '@fixture/optional', definition: unreported, reason: 'source-ownership' },
		],
	})
	const inactive = readPluginSourceImpact(host.ctx, [
		{
			name: '@fixture/alternate',
			file: '/app/alternate.mjs',
			action: 'publish',
			definitions: [
				{ address: alt, dependencies: { requires: [token], optional: [definition('Metrics')] } },
			],
		},
	]).dependencyReview
	expect(inactive).toEqual({
		status: 'projected',
		introduced: [],
		resolved: [],
		bindings: [],
		liveRejections: [],
		unprovided: [
			{ definition: alt, requirement: token, kind: 'required' },
			{ definition: alt, requirement: definition('Metrics'), kind: 'optional' },
		],
	})
	expect(readPluginSourceImpact(host.ctx, packages)).toEqual(impact)
})
