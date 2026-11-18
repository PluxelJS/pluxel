import type { PluginCatalogSnapshot } from '@pluxel/services/management/client'
import { describe, expect, it } from 'vitest'
import { buildPluginOverview, readPluginPolicyTarget } from '../src/app/plugins/pluginOverviewModel'
import { controlCatalog, controlNode } from './pluginControlFixtures'

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@pluxel/example' },
		exportName: 'ExamplePlugin',
	},
	variant: 'default',
} as const

const catalog = {
	plugins: [
		{
			address,
			reference: '@pluxel/example#ExamplePlugin',
			route: 'v1/package/ExamplePlugin/@pluxel/example',
			displayName: 'ExamplePlugin',
			label: { title: 'Example', qualifier: '@pluxel/example', text: 'Example' },
			rootExportName: 'ExamplePlugin',
			autoStart: true,
			sessionIntent: 'inherit',
			desiredState: 'running',
			activationReason: 'auto-start',
			lifecycleState: 'running',
			availability: 'available',
			issues: [],
			execution: {
				kind: 'vite',
				origin: 'fixed',
				artifact: { kind: 'built-module' },
				update: { kind: 'host-reload' },
			},
			recentUpdate: null,
		},
	],
	sections: [
		{
			sectionId: 'package:@pluxel/example',
			name: '@pluxel/example',
			basis: { kind: 'dependency', definition: address.definition },
			nodes: [address],
		},
	],
	statePolicy: controlCatalog().statePolicy,
	summary: { total: 1, running: 1, stopped: 0, autoStart: 1 },
} satisfies PluginCatalogSnapshot

describe('plugin overview projection', () => {
	it('uses canonical routes as ids and catalog labels as display text', () => {
		const overview = buildPluginOverview(catalog)

		expect(overview.status.statuses[0]).toMatchObject({
			id: 'v1/package/ExamplePlugin/@pluxel/example',
			label: 'Example',
			address,
		})
		expect(overview.sections).toEqual(catalog.sections)
		expect(overview.statePolicy).toEqual(catalog.statePolicy)
		expect(Object.isFrozen(overview)).toBe(true)
		expect(Object.isFrozen(overview.status.statuses)).toBe(true)
	})
})

it('locks only the addressed policy target and applies node modes to absent choices', () => {
	const other = controlNode('Other')
	const policy = {
		...controlCatalog().statePolicy,
		providerDefaultsSource: 'declared',
		nodeModes: [{ node: other, mode: 'declared-only' }],
		selections: [
			{
				target: {
					field: 'dependencyOverrides',
					consumerAddress: address,
					requirementAddress: other.definition,
				},
				mode: 'declared-first',
				source: 'declared',
				shadowed: true,
			},
		],
	} as const
	expect(readPluginPolicyTarget(policy, 'providerDefaults')?.canWrite).toBe(false)
	expect(readPluginPolicyTarget(policy, { field: 'autoStart', node: address })?.canWrite).toBe(true)
	expect(readPluginPolicyTarget(policy, { field: 'autoStart', node: other })).toEqual({
		mode: 'declared-only',
		source: 'default',
		shadowed: false,
		canWrite: false,
	})
	expect(
		readPluginPolicyTarget(policy, {
			field: 'dependencyOverrides',
			consumerAddress: address,
			requirementAddress: other.definition,
		}),
	).toMatchObject({ source: 'declared', shadowed: true, canWrite: false })
	expect(
		readPluginPolicyTarget(policy, {
			field: 'dependencyOverrides',
			consumerAddress: address,
			requirementAddress: address.definition,
		})?.canWrite,
	).toBe(true)
	expect(
		readPluginPolicyTarget({ ...policy, readonly: true }, { field: 'autoStart', node: address })
			?.canWrite,
	).toBe(false)
	expect(readPluginPolicyTarget(undefined, 'providerDefaults')).toBeUndefined()
})
