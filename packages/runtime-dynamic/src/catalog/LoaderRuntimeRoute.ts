import type { PluginNodeAddress } from '@pluxel/core'
import type { RuntimePluginSource, RuntimeRouteCapabilities } from '@pluxel/runtime/internal'
import type { LoaderApi } from '../loader/LoaderService'

/** Dynamic and static routes differ only in source/provenance projection. */
export function createLoaderRuntimeRoute(api: LoaderApi): RuntimeRouteCapabilities {
	const resolveSource = (address: PluginNodeAddress): RuntimePluginSource => {
		const moduleId = api.registry.findModuleId(address)
		return moduleId
			? {
					__typename: 'PluginSourceInfo',
					kind: 'hmr',
					moduleId,
					packageName: null,
					version: null,
					tag: null,
				}
			: {
					__typename: 'PluginSourceInfo',
					kind: 'unknown',
					moduleId: null,
					packageName: null,
					version: null,
					tag: null,
				}
	}

	return { source: { resolveSource } }
}
