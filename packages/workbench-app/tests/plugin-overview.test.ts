import { describe, expect, it, vi } from 'vitest'
import type { PluginCatalogSnapshot, RuntimeManagementClient } from '@pluxel/runtime/web'
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
			source: {
				kind: 'package',
				moduleId: '@pluxel/example',
				packageName: '@pluxel/example',
				version: '1.0.0',
				tag: null,
			},
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

describe('plugin overview resource', () => {
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

	it('deduplicates in-flight reads, honors TTL, and keeps the last good snapshot', async () => {
		let now = 1_000
		let catalogReads = 0
		let fail = false
		const client = {
			catalog: {
				snapshot: async () => {
					catalogReads += 1
					if (fail) throw new Error('offline')
					return catalog
				},
			},
		} as unknown as RuntimeManagementClient
		const resource = new PluginOverviewResource(client, () => now)

		const first = resource.load()
		const duplicate = resource.load()
		expect(duplicate).toBe(first)
		await first
		expect(catalogReads).toBe(1)

		now += 10_000
		await resource.load()
		expect(catalogReads).toBe(1)

		fail = true
		await resource.load(true)
		expect(resource.getSnapshot()).toMatchObject({
			overview: expect.any(Object),
			isLoading: false,
			error: 'offline',
		})
	})

	it('queues a fresh read when invalidated during an in-flight overview request', async () => {
		let release!: (value: PluginCatalogSnapshot) => void
		const firstCatalog = new Promise<PluginCatalogSnapshot>((resolve) => {
			release = resolve
		})
		const catalogSnapshot = vi
			.fn<() => Promise<PluginCatalogSnapshot>>()
			.mockReturnValueOnce(firstCatalog)
			.mockResolvedValueOnce(catalog)
		const resource = new PluginOverviewResource({
			catalog: { snapshot: catalogSnapshot },
		} as unknown as RuntimeManagementClient)
		const unsubscribe = resource.subscribe(() => undefined)

		void resource.load()
		resource.markStale()
		const refreshed = resource.load(true)
		release(catalog)
		await refreshed
		unsubscribe()

		expect(catalogSnapshot).toHaveBeenCalledTimes(2)
		expect(resource.getSnapshot()).toMatchObject({ isLoading: false, isStale: false })
	})

	it('does not lose an invalidation when the old overview request rejects', async () => {
		let rejectOld!: (reason: Error) => void
		const firstCatalog = new Promise<PluginCatalogSnapshot>((_resolve, reject) => {
			rejectOld = reject
		})
		const catalogSnapshot = vi
			.fn<() => Promise<PluginCatalogSnapshot>>()
			.mockReturnValueOnce(firstCatalog)
			.mockResolvedValueOnce(catalog)
		const resource = new PluginOverviewResource({
			catalog: { snapshot: catalogSnapshot },
		} as unknown as RuntimeManagementClient)
		const unsubscribe = resource.subscribe(() => undefined)

		void resource.load()
		resource.markStale()
		const refreshed = resource.load(true)
		rejectOld(new Error('old request failed'))
		await refreshed
		unsubscribe()

		expect(catalogSnapshot).toHaveBeenCalledTimes(2)
		expect(resource.getSnapshot()).toMatchObject({
			overview: expect.any(Object),
			isLoading: false,
			isStale: false,
		})
	})
})
