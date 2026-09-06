import type { PluginCatalogSnapshot } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import { buildPluginOverview } from '../src/app/plugins/pluginOverviewModel'

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
				kind: 'static-catalog',
				artifact: { kind: 'built-module' },
				update: { kind: 'catalog-hmr' },
			},
			recentUpdate: null,
		},
	],
	sections: [
		{
			sectionId: 'package:@pluxel/example',
			name: '@pluxel/example',
			basis: { kind: 'package', packageName: '@pluxel/example' },
			nodes: [address],
		},
	],
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
		expect(Object.isFrozen(overview)).toBe(true)
		expect(Object.isFrozen(overview.status.statuses)).toBe(true)
	})
})
