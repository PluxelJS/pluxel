import type { Context } from '@pluxel/context'
import type { PluginService } from '../plugins/runtime/PluginService'

const PLUGIN_SERVICE_KEY = 'registry' as const

/** @internal Explicit authority boundary for Core/runtime hosts. */
export function requirePluginService(ctx: Context): PluginService {
	const service = (ctx.root as unknown as Record<PropertyKey, unknown>)[PLUGIN_SERVICE_KEY]
	if (
		!service ||
		typeof service !== 'object' ||
		typeof (service as { beginUpdate?: unknown }).beginUpdate !== 'function' ||
		typeof (service as { getInstance?: unknown }).getInstance !== 'function'
	) {
		throw new Error('[pluxel/core] PluginService is not installed on this Context')
	}
	return service as PluginService
}
