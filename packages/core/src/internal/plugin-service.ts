import { resolveContextService } from '@pluxel/context/internal'
import type { Context } from '../context/Context'
import { PluginRuntimeService } from '../context/core-capabilities'
import type { PluginService } from '../plugins/runtime/PluginService'

/** @internal Explicit authority boundary for Core/runtime hosts. */
export function requirePluginService(ctx: Context): PluginService {
	return resolveContextService(ctx.root, PluginRuntimeService) as PluginService
}
