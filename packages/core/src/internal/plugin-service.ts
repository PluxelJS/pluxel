import { requireCoreRuntime } from '../context/core-context'
import type { Context } from '../context/Context'
import type { PluginService } from '../plugins/runtime/PluginService'

/** @internal Explicit authority boundary for Core/runtime hosts. */
export function requirePluginService(ctx: Context): PluginService {
	return requireCoreRuntime(ctx).plugins
}
