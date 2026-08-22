import type { Context, PluginConstructor, PluginNodeAddress } from '@pluxel/core'
import {
	ensureForkBaseFromCatalog,
	type RuntimePluginSource,
	type RuntimeRouteCapabilities,
} from '@pluxel/runtime/internal'
import type { LoaderApi } from '../loader/LoaderService'

export function createLoaderRuntimeRoute(ctx: Context, api: LoaderApi): RuntimeRouteCapabilities {
	const resolveSource = (
		address: PluginNodeAddress,
		_ctor?: PluginConstructor,
	): RuntimePluginSource => {
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

	return {
		catalog: {
			resolve: (address) => api.runtime.resolve(address),
			resolveDefinition: (address) => api.runtime.resolveDefinition(address),
			require: (address) => {
				const ctor = api.runtime.resolve(address)
				if (!ctor) throw new Error('Plugin node is not present in the dynamic catalog')
				return ctor
			},
			listRegistered: () => api.registry.listRegistered(),
		},
		lifecycle: {
			isRunning: (address) => api.runtime.isRunning(address),
			enable: (address, ctor) => api.control.enable(address, ctor),
			enablePersisted: (address) => api.control.enablePersisted(address),
			deactivate: (address, ctor, options) => api.control.deactivate(address, ctor, options),
			stop: (address, ctor) => api.control.stop(address, ctor),
		},
		configMetadata: {
			getConfig: (address) => api.registry.getConfig(address),
		},
		dependencies: {
			listDependencies: (address) => api.deps.list(address),
			ensureForkBase: (definition) => ensureForkBaseFromCatalog(ctx, definition),
		},
		source: { resolveSource },
	}
}
