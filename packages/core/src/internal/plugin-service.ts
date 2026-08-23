import { resolveContextCapability, type Context } from '../context/Context'
import { PLUGIN_SERVICE_CAPABILITY_IDENTITY } from '../context/core-capabilities'
import type { PluginService } from '../plugins/runtime/PluginService'

/** @internal Explicit authority boundary for Core/runtime hosts. */
export function requirePluginService(ctx: Context): PluginService {
	return resolveContextCapability(ctx.root, PLUGIN_SERVICE_CAPABILITY_IDENTITY) as PluginService
}
