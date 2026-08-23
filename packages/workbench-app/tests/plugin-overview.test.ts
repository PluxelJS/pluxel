import { describe, expect, it } from 'vitest'
import type { PluginGroup, PluginsListOutput, RuntimeManagementClient } from '@pluxel/runtime/web'
import {
	buildPluginOverview,
	PluginOverviewResource,
} from '../src/app/plugins/pluginOverviewResource'

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@pluxel/example' },
		exportName: 'ExamplePlugin',
	},
	variant: 'default',
} as const

const plugins = {
	plugins: [
		{
			address,
			reference: '@pluxel/example#ExamplePlugin',
			route: 'v1/package/ExamplePlugin/@pluxel/example',
			displayName: 'ExamplePlugin',
			label: { title: 'Example', qualifier: '@pluxel/example', text: 'Example' },
			rootExportName: 'ExamplePlugin',
			isRunning: true,
			isEnabled: true,
			lifecycleStage: 'running',
			availability: 'available',
			issues: [],
			source: {
				kind: 'package',
				moduleId: '@pluxel/example',
				packageName: '@pluxel/example',
				version: '1.0.0',
				tag: null,
			},
		},
	],
	summary: { total: 1, running: 1, stopped: 0, disabled: 0 },
} satisfies PluginsListOutput

const groups = [
	{
		groupId: 'examples',
		name: 'Examples',
		nodes: [
			{
				address,
				reference: '@pluxel/example#ExamplePlugin',
				route: 'v1/package/ExamplePlugin/@pluxel/example',
				displayName: 'ExamplePlugin',
				label: 'Example',
				rootExportName: 'ExamplePlugin',
			},
		],
	},
] satisfies readonly PluginGroup[]

describe('plugin overview resource', () => {
	it('uses canonical routes as ids and catalog labels as display text', () => {
		const overview = buildPluginOverview(plugins, groups)

		expect(overview.status.statuses[0]).toMatchObject({
			id: 'v1/package/ExamplePlugin/@pluxel/example',
			label: 'Example',
			address,
		})
		expect(overview.groups).toEqual(groups)
		expect(Object.isFrozen(overview)).toBe(true)
		expect(Object.isFrozen(overview.status.statuses)).toBe(true)
	})

	it('deduplicates in-flight reads, honors TTL, and keeps the last good snapshot', async () => {
		let now = 1_000
		let pluginReads = 0
		let groupReads = 0
		let fail = false
		const client = {
			plugins: {
				list: async () => {
					pluginReads += 1
					if (fail) throw new Error('offline')
					return plugins
				},
			},
			groups: {
				list: async () => {
					groupReads += 1
					return groups
				},
			},
		} as unknown as RuntimeManagementClient
		const resource = new PluginOverviewResource(client, () => now)

		const first = resource.load()
		const duplicate = resource.load()
		expect(duplicate).toBe(first)
		await first
		expect([pluginReads, groupReads]).toEqual([1, 1])

		now += 10_000
		await resource.load()
		expect([pluginReads, groupReads]).toEqual([1, 1])

		fail = true
		await resource.load(true)
		expect(resource.getSnapshot()).toMatchObject({
			overview: expect.any(Object),
			isLoading: false,
			error: 'offline',
		})
	})
})
