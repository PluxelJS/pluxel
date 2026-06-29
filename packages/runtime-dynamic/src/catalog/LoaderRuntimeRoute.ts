import { type Context, type PluginConstructor } from '@pluxel/core'
import {
	ensureForkBaseFromCatalog,
	type RuntimePluginSource,
	type RuntimeRouteCapabilities,
} from '@pluxel/runtime/plugin-catalog'
import { createPackageManagerResolver } from '../api/features/package-manager/resolver'
import { PackageManagerHandle } from '../api/http/rpc/PackageManagerHandle'
import type { LoaderApi } from '../loader/LoaderService'

export function createLoaderRuntimeRoute(ctx: Context, api: LoaderApi): RuntimeRouteCapabilities {
	const findModuleId = (name: string, ctor?: PluginConstructor): string | null =>
		api.registry.findModuleId(name, ctor)

	const resolveSource = (name: string, ctor?: PluginConstructor): RuntimePluginSource => {
		const moduleId = findModuleId(name, ctor)
		if (moduleId) {
			const packageSpec = ctx.packageService?.getPackageSpecByModuleId?.(moduleId)
			if (packageSpec) {
				return {
					__typename: 'PluginSourceInfo',
					kind: 'package',
					packageName: packageSpec.name,
					version: packageSpec.version ?? null,
					tag: packageSpec.tag ?? null,
					moduleId,
				}
			}
			return {
				__typename: 'PluginSourceInfo',
				kind: 'hmr',
				moduleId,
				packageName: null,
				version: null,
				tag: null,
			}
		}
		return {
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
			resolve: (target) => api.runtime.resolve(target),
			resolveOrRegistered: (name) => api.runtime.resolve(name) ?? api.registry.getCtor(name),
			require: (name) => {
				const ctor = api.runtime.resolve(name) ?? api.registry.getCtor(name)
				if (!ctor) throw new Error(`Plugin not found: ${name}`)
				return ctor
			},
			listRegistered: () => api.registry.listRegistered(),
			listLoadedNames: () => api.registry.listLoadedNames(),
		},
		lifecycle: {
			isRunning: (target) => api.runtime.isRunning(target),
			enable: (name, ctor) => api.control.enable(name, ctor),
			enablePersisted: (name) => api.control.enablePersisted(name),
			deactivate: (name, ctor, options) => api.control.deactivate(name, ctor, options),
			stop: (name, ctor) => api.control.stop(name, ctor),
		},
		configMetadata: {
			getSchema: (name) => api.registry.getSchema(name),
			getSchemaSource: (name) => api.registry.getSchemaSource(name),
			getConfigLayout: (name) => api.registry.getConfigLayout(name),
		},
		dependencies: {
			listDependencies: (ctor) => api.deps.list(ctor),
			ensureForkBase: (baseName) => ensureForkBaseFromCatalog(ctx, baseName),
		},
		source: {
			resolveSource,
		},
		api: {
			resolvers: [createPackageManagerResolver],
			rpcHandles: {
				package: (rpcCtx) => new PackageManagerHandle(rpcCtx),
			},
		},
	}
}
