import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createHost } from '../src/host'
import { readHostCatalogProvenance, setHostCatalogProvenance } from '../src/catalog-provenance'
import type { PluginCatalogProvenance } from '../src/catalog'

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
			kind: 'static-catalog',
			artifact: { kind: 'source-module' },
			update: { kind: 'host-reload' },
		},
	}
	const built: PluginCatalogProvenance = {
		execution: {
			kind: 'static-catalog',
			artifact: { kind: 'built-module' },
			update: { kind: 'host-reload' },
		},
	}
	const host = await createHost({ plugins: [Original] })
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
